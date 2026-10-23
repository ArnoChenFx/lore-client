use super::*;
use std::future::Future;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::task::{Context, Waker};

fn workspace_context(path: &Path) -> OperationContext {
    OperationContext {
        workspace_key: Some(display_path_without_windows_verbatim_prefix(
            &std::fs::canonicalize(path).unwrap(),
        )),
        ..test_operation_context()
    }
}

#[test]
fn operation_context_requires_both_wire_fields_and_preserves_explicit_null() {
    for value in [
        serde_json::json!({}),
        serde_json::json!({ "requestId": "request-1" }),
        serde_json::json!({ "workspaceKey": null }),
        serde_json::json!({ "requestId": null, "workspaceKey": null }),
        serde_json::json!({ "requestId": "request-1", "workspaceKey": [] }),
    ] {
        assert!(serde_json::from_value::<OperationContext>(value).is_err());
    }
    let wire = serde_json::json!({ "requestId": "request-1", "workspaceKey": null });
    let context: OperationContext = serde_json::from_value(wire.clone()).unwrap();
    context.validate().unwrap();
    assert_eq!(context.workspace_key, None);
    assert_eq!(serde_json::to_value(context).unwrap(), wire);
}

#[test]
fn operation_context_rejects_invalid_ids_before_scheduling_any_work() {
    for request_id in [
        String::new(),
        " ".to_owned(),
        "request\n1".to_owned(),
        "request/1".to_owned(),
        "请求-1".to_owned(),
        "x".repeat(129),
    ] {
        let ran = Arc::new(AtomicBool::new(false));
        let task_ran = Arc::clone(&ran);
        let error = tauri::async_runtime::block_on(run_lore_task(
            OperationContext {
                request_id,
                workspace_key: None,
            },
            move || {
                task_ran.store(true, Ordering::SeqCst);
                Ok(())
            },
        ))
        .unwrap_err();
        assert_eq!(error.code, "operation_request_id_invalid");
        assert!(!ran.load(Ordering::SeqCst));
    }
    for request_id in ["a".to_owned(), "A-z_09".to_owned(), "x".repeat(128)] {
        OperationContext {
            request_id,
            workspace_key: None,
        }
        .validate()
        .unwrap();
    }
}

#[test]
fn operation_workspace_validation_preserves_canonical_owner_and_rejects_aliases() {
    let directory = tempfile::tempdir().unwrap();
    let context = workspace_context(directory.path());
    assert_eq!(context.clone().validate_workspace().unwrap(), context);

    let mut alias = context.clone();
    alias.workspace_key = Some(format!(
        "{}{}.",
        context.workspace_key.as_deref().unwrap(),
        std::path::MAIN_SEPARATOR
    ));
    assert_eq!(
        alias.validate_workspace().unwrap_err().code,
        "operation_workspace_not_canonical"
    );

    let global = test_operation_context();
    assert_eq!(global.clone().validate_workspace().unwrap(), global);
}

#[cfg(unix)]
#[test]
fn operation_workspace_keeps_legal_trailing_spaces_and_rejects_symlink_aliases() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace ");
    std::fs::create_dir(&workspace).unwrap();
    let context = workspace_context(&workspace);
    assert!(context.workspace_key.as_deref().unwrap().ends_with(' '));
    assert_eq!(context.clone().validate_workspace().unwrap(), context);

    let alias = directory.path().join("alias");
    std::os::unix::fs::symlink(&workspace, &alias).unwrap();
    let context = OperationContext {
        workspace_key: Some(alias.to_string_lossy().into_owned()),
        ..test_operation_context()
    };
    assert_eq!(
        context.validate_workspace().unwrap_err().code,
        "operation_workspace_not_canonical"
    );
}

#[test]
fn operation_scope_restores_nested_error_and_panic_context_on_a_reused_thread() {
    std::thread::spawn(|| {
        assert_eq!(
            current_operation_context().unwrap_err().code,
            "operation_context_missing"
        );
        let outer = test_operation_context();
        let outer_scope = OperationContextScope::enter(outer.clone());
        let nested = test_operation_context();
        {
            let _nested_scope = OperationContextScope::enter(nested.clone());
            assert_eq!(current_operation_context().unwrap(), nested);
        }
        assert_eq!(current_operation_context().unwrap(), outer);

        let error: Result<(), LoreCommandError> = (|| {
            let _scope = OperationContextScope::enter(test_operation_context());
            Err(LoreCommandError::new("expected_error", "Test failure"))
        })();
        assert_eq!(error.unwrap_err().code, "expected_error");
        assert_eq!(current_operation_context().unwrap(), outer);

        assert!(std::panic::catch_unwind(|| {
            let _scope = OperationContextScope::enter(test_operation_context());
            panic!("expected scope unwind");
        })
        .is_err());
        assert_eq!(current_operation_context().unwrap(), outer);
        drop(outer_scope);
        assert!(current_operation_context().is_err());

        // Reuse the same OS thread after both failure paths, with no previous owner.
        let next = test_operation_context();
        {
            let _scope = OperationContextScope::enter(next.clone());
            assert_eq!(current_operation_context().unwrap(), next);
        }
        assert!(current_operation_context().is_err());
    })
    .join()
    .unwrap();
}

#[test]
fn unscoped_operations_fail_without_calling_lore_or_creating_an_identity() {
    let mut called = false;
    let error = run_operation("test.unscoped", |_| {
        called = true;
        0
    })
    .unwrap_err();
    assert_eq!(error.code, "operation_context_missing");
    assert!(!called);
}

#[test]
fn background_task_error_and_panic_do_not_replace_the_callers_context() {
    let caller = test_operation_context();
    let _scope = OperationContextScope::enter(caller.clone());
    let error = tauri::async_runtime::block_on(run_lore_task(test_operation_context(), || {
        Err::<(), _>(LoreCommandError::new("task_failed", "Test failure"))
    }))
    .unwrap_err();
    assert_eq!(error.code, "task_failed");
    assert_eq!(current_operation_context().unwrap(), caller);

    let panic =
        tauri::async_runtime::block_on(run_lore_task::<()>(test_operation_context(), || {
            panic!("expected background task panic")
        }))
        .unwrap_err();
    assert_eq!(panic.code, "lore_task_join_failed");
    assert_eq!(current_operation_context().unwrap(), caller);

    let next = test_operation_context();
    let observed =
        tauri::async_runtime::block_on(run_lore_task(next.clone(), current_operation_context))
            .unwrap();
    assert_eq!(observed, next);
    assert_eq!(current_operation_context().unwrap(), caller);
}

#[test]
fn heavy_queue_keeps_explicit_context_and_never_executes_superseded_work() {
    static LANE: HeavyReadLane = HeavyReadLane::new();
    let first = test_operation_context();
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let active =
        tauri::async_runtime::spawn(run_heavy_lore_task(first.clone(), &LANE, move || {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            current_operation_context()
        }));
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();

    let superseded_ran = Arc::new(AtomicBool::new(false));
    let task_ran = Arc::clone(&superseded_ran);
    let mut superseded = Box::pin(run_heavy_lore_task(
        test_operation_context(),
        &LANE,
        move || {
            task_ran.store(true, Ordering::SeqCst);
            current_operation_context()
        },
    ));
    let latest_context = test_operation_context();
    let mut latest = Box::pin(run_heavy_lore_task(
        latest_context.clone(),
        &LANE,
        current_operation_context,
    ));
    let mut poll_context = Context::from_waker(Waker::noop());
    assert!(superseded.as_mut().poll(&mut poll_context).is_pending());
    assert!(latest.as_mut().poll(&mut poll_context).is_pending());

    let unrelated = test_operation_context();
    let _scope = OperationContextScope::enter(unrelated.clone());
    release_tx.send(()).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(active).unwrap().unwrap(),
        first
    );
    assert_eq!(
        tauri::async_runtime::block_on(superseded).unwrap_err().code,
        "heavy_read_superseded"
    );
    assert!(!superseded_ran.load(Ordering::SeqCst));
    assert_eq!(
        tauri::async_runtime::block_on(latest).unwrap(),
        latest_context
    );
    assert_eq!(current_operation_context().unwrap(), unrelated);
}

#[test]
fn notification_queue_preserves_each_request_owner_across_awaits() {
    let directory_a = tempfile::tempdir().unwrap();
    let directory_b = tempfile::tempdir().unwrap();
    let first = test_operation_context();
    let context_a = workspace_context(directory_a.path());
    let context_b = workspace_context(directory_b.path());
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let active =
        tauri::async_runtime::spawn(run_notification_lore_task(first.clone(), move || {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            current_operation_context()
        }));
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let mut queued_a = Box::pin(run_notification_lore_task(
        context_a.clone(),
        current_operation_context,
    ));
    let mut queued_b = Box::pin(run_notification_lore_task(
        context_b.clone(),
        current_operation_context,
    ));
    let mut poll_context = Context::from_waker(Waker::noop());
    assert!(queued_a.as_mut().poll(&mut poll_context).is_pending());
    assert!(queued_b.as_mut().poll(&mut poll_context).is_pending());

    release_tx.send(()).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(active).unwrap().unwrap(),
        first
    );
    assert_eq!(tauri::async_runtime::block_on(queued_a).unwrap(), context_a);
    assert_eq!(tauri::async_runtime::block_on(queued_b).unwrap(), context_b);
    assert!(current_operation_context().is_err());
}

// 暂存事件夹具见 test_events：数值录自真实本地暂存协议（含最终聚合计数），
// Lore 0.11 起事件类型不再实现 Deserialize，改为直接构造类型化事件。
use crate::lore_adapter::test_events::{stage_begin, stage_end, stage_tick};

type CallbackRendezvous = (SyncSender<()>, Receiver<()>);

fn run_two_child_operations(
    rendezvous: Vec<CallbackRendezvous>,
) -> Result<Vec<LoreOperationResult>, LoreCommandError> {
    rendezvous
        .into_iter()
        .map(|(ready, peer_ready)| {
            run_operation("file.stage", move |callback| {
                std::thread::spawn(move || {
                    let context_missing = current_operation_context().is_err();
                    let callback = callback.expect("Lore must receive a callback");
                    callback(&stage_begin());
                    // Both root tasks must have reached this child before progress advances.
                    ready.send(()).unwrap();
                    peer_ready.recv_timeout(Duration::from_secs(10)).unwrap();
                    std::thread::sleep(Duration::from_millis(320));
                    callback(&stage_tick());
                    callback(&stage_end());
                    assert!(
                        context_missing,
                        "Callback threads must not inherit a TLS owner"
                    );
                })
                .join()
                .unwrap();
                0
            })
        })
        .collect()
}

#[test]
fn concurrent_roots_keep_results_and_callback_streams_associated_with_each_child() {
    let directory_a = tempfile::tempdir().unwrap();
    let directory_b = tempfile::tempdir().unwrap();
    let context_a = workspace_context(directory_a.path());
    let context_b = workspace_context(directory_b.path());
    let mut rendezvous_a = Vec::new();
    let mut rendezvous_b = Vec::new();
    for _ in 0..2 {
        let (a_tx, a_rx) = mpsc::sync_channel(1);
        let (b_tx, b_rx) = mpsc::sync_channel(1);
        rendezvous_a.push((a_tx, b_rx));
        rendezvous_b.push((b_tx, a_rx));
    }
    let task_a = tauri::async_runtime::spawn(run_lore_task(context_a.clone(), move || {
        run_two_child_operations(rendezvous_a)
    }));
    let task_b = tauri::async_runtime::spawn(run_lore_task(context_b.clone(), move || {
        run_two_child_operations(rendezvous_b)
    }));
    let results_a = tauri::async_runtime::block_on(task_a).unwrap().unwrap();
    let results_b = tauri::async_runtime::block_on(task_b).unwrap().unwrap();
    let captured = CAPTURED_OPERATION_STREAM
        .lock()
        .unwrap()
        .iter()
        .filter(|event| {
            event["requestId"] == context_a.request_id || event["requestId"] == context_b.request_id
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut all_child_ids = BTreeSet::new();
    for (context, results) in [(&context_a, results_a), (&context_b, results_b)] {
        assert_eq!(results.len(), 2);
        for result in results {
            assert_eq!(result.request_id, context.request_id);
            assert_eq!(result.workspace_key, context.workspace_key);
            assert_eq!(result.status, 0);
            assert!(result
                .events
                .iter()
                .any(|event| event["tagName"] == "fileStageEnd"));
            assert!(!result
                .events
                .iter()
                .any(|event| event["tagName"] == "fileStageProgress"));
        }
        let mut children = BTreeMap::<String, Vec<&Value>>::new();
        for event in captured
            .iter()
            .filter(|event| event["requestId"] == context.request_id)
        {
            assert_eq!(
                event["workspaceKey"],
                serde_json::to_value(&context.workspace_key).unwrap()
            );
            children
                .entry(event["operationId"].as_str().unwrap().to_owned())
                .or_default()
                .push(event);
        }
        assert_eq!(
            children.len(),
            2,
            "Each root must own two distinct native operations"
        );
        for (child_id, events) in children {
            assert!(
                all_child_ids.insert(child_id),
                "Native child IDs must also differ across roots"
            );
            let phases = events
                .iter()
                .map(|event| event["phase"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(&phases[..2], ["queued", "running"]);
            assert!(phases.contains(&"streaming"));
            assert_eq!(phases.last(), Some(&"succeeded"));
            assert_eq!(
                phases.iter().filter(|&&phase| phase == "succeeded").count(),
                1
            );
        }
    }
    assert_eq!(all_child_ids.len(), 4);
    assert!(current_operation_context().is_err());
}

#[test]
fn retained_callback_cannot_open_a_stream_after_its_operation_panics() {
    let context = test_operation_context();
    let scope = OperationContextScope::enter(context.clone());
    let retained: Mutex<LoreEventCallback> = Mutex::new(None);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_operation("file.stage", |callback| {
            callback.as_ref().unwrap()(&stage_begin());
            *retained.lock().unwrap() = callback;
            panic!("expected Lore operation unwind");
        })
    }));
    assert!(outcome.is_err());
    drop(scope);

    std::thread::spawn(move || {
        assert!(current_operation_context().is_err());
        std::thread::sleep(Duration::from_millis(320));
        let callback = retained.into_inner().unwrap().unwrap();
        callback(&stage_end());
    })
    .join()
    .unwrap();
    assert!(CAPTURED_OPERATION_STREAM
        .lock()
        .unwrap()
        .iter()
        .all(|event| event["requestId"] != context.request_id));
}
