//! Lore 适配层的行为、安全边界与真实仓库回归测试。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
use super::{
    auth::invalidate_authentication_connections_with,
    composition::{
        build_layer_add_args, build_layer_remove_args, build_link_add_args, build_link_update_args,
    },
    operations::lore_commit,
    workspace::{
        lore_revision_changes, lore_stage, lore_stage_move, lore_unstage, lore_write_patch_file,
    },
};

const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/** 从 Commit 的稳定结构化事件中取得新 Revision，供真实仓库回归测试继续读取不可变树。 */
fn committed_revision(result: &LoreOperationResult) -> String {
    result
        .events
        .iter()
        .find(|event| event["tagName"] == "revisionCommitRevision")
        .and_then(|event| event["data"]["revision"].as_str())
        .expect("The commit event should provide the created revision")
        .to_owned()
}

#[test]
fn status_omits_uncommitted_copy_removed_between_scans() {
    let source_name = "source-document.txt";
    let target_name = "target-document.txt";
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let repository_path = std::env::temp_dir().join(format!("lore-client-transient-copy-{unique}"));
    let _cleanup = TemporaryRepository::new(repository_path.clone());
    std::fs::create_dir_all(&repository_path)
        .expect("The temporary test directory should be created");
    let repository_path_string = repository_path.to_string_lossy().into_owned();

    initialize_repository(
        &repository_path_string,
        "transient-copy",
        "Transient copy status regression",
        "lore-client-test",
        None,
    )
    .expect("The temporary Lore repository should be initialized");
    std::fs::write(repository_path.join(source_name), "same contents")
        .expect("The committed source file should be created");
    tauri::async_runtime::block_on(lore_stage(
        repository_path_string.clone(),
        vec![source_name.to_owned()],
    ))
    .expect("The source file should be staged");
    let baseline_commit = tauri::async_runtime::block_on(lore_commit(
        repository_path_string.clone(),
        "Commit source file".to_owned(),
        None,
    ))
    .expect("The source file should be committed");
    let baseline_revision = committed_revision(&baseline_commit);

    let transient_directory = repository_path.join("sda");
    std::fs::create_dir_all(&transient_directory)
        .expect("The transient directory should be created");
    std::fs::copy(
        repository_path.join(source_name),
        transient_directory.join(source_name),
    )
    .expect("The transient copy should be created");
    std::fs::copy(
        repository_path.join(source_name),
        repository_path.join(target_name),
    )
    .expect("The retained copy should be created");
    let first_scan = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        true,
    ))
    .expect("The first working-tree scan should succeed");
    let reported_staged_revision = first_scan
        .events
        .iter()
        .find(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusRevision")
        })
        .and_then(|event| event.pointer("/data/revisionStaged"))
        .and_then(Value::as_str)
        .expect("Status should report the staged revision identity");
    assert!(
        is_zero_hash(reported_staged_revision),
        "The scan should start without a staged revision: {reported_staged_revision}",
    );
    let state_after_scan = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        false,
    ))
    .expect("Reading repository state after the scan should succeed");
    let persisted_staged_revision = state_after_scan
        .events
        .iter()
        .find(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusRevision")
        })
        .and_then(|event| event.pointer("/data/revisionStaged"))
        .and_then(Value::as_str)
        .expect("Status should report the persisted staged revision identity");
    assert!(
        is_zero_hash(persisted_staged_revision),
        "A read-only working-tree scan must not persist a staged revision: {persisted_staged_revision}",
    );

    std::fs::remove_dir_all(&transient_directory)
        .expect("The transient directory should be deleted");
    std::fs::remove_file(repository_path.join(source_name))
        .expect("The original source should be deleted");
    let result = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        true,
    ))
    .expect("The second working-tree scan should succeed");
    let status_files = result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/type").and_then(Value::as_str) == Some("file")
        })
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(
        status_files.len(),
        1,
        "Status must omit a transient copy that never belonged to the committed revision: {status_files:?}",
    );
    assert_eq!(status_files[0]["data"]["path"], target_name);
    assert_eq!(status_files[0]["data"]["action"], "move");
    assert_eq!(status_files[0]["data"]["fromPath"], source_name);
    tauri::async_runtime::block_on(lore_stage_move(
        repository_path_string.clone(),
        source_name.to_owned(),
        target_name.to_owned(),
    ))
    .expect("The move should be staged through the native move operation");
    let staged_result = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        true,
    ))
    .expect("Status after staging the move should succeed");
    let staged_status_files = staged_result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/type").and_then(Value::as_str) == Some("file")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        staged_status_files.len(),
        1,
        "Staging both sides must retain one atomic move: {staged_status_files:?}",
    );
    assert_eq!(staged_status_files[0]["data"]["path"], target_name);
    assert_eq!(staged_status_files[0]["data"]["action"], "move");
    assert_eq!(staged_status_files[0]["data"]["fromPath"], source_name);
    assert_eq!(staged_status_files[0]["data"]["flagStaged"], true);

    /*
     * 复现真实 UI 中“旧版本先把目标单独暂存，随后扫描两个临时副本，再删除目录并
     * 重新暂存 Move”的历史状态。固定 Lore 可能把已消失副本继续报告为 Add；最终
     * Status 必须仍只保留工作区真实存在的原子移动。
     */
    tauri::async_runtime::block_on(lore_unstage(
        repository_path_string.clone(),
        vec![source_name.to_owned(), target_name.to_owned()],
    ))
    .expect("The move should be unstaged before reproducing stale additions");
    for directory_name in ["sda", "sdd"] {
        let directory = repository_path.join(directory_name);
        std::fs::create_dir_all(&directory)
            .expect("The transient copy directory should be created");
        std::fs::copy(
            repository_path.join(target_name),
            directory.join("transient-copy.txt"),
        )
        .expect("The transient workspace copy should be created");
    }
    /*
     * 用旧客户端的写入式 Status 主动制造受污染 staged anchor，验证升级后不仅新扫描
     * 无副作用，显式 Stage/Commit 也不会把旧 dirty-only 目录带进新 Revision。
     */
    let legacy_globals = global_args(&repository_path_string)
        .expect("The legacy status simulation should build repository globals");
    let legacy_scan = run_operation(
        "repository.status.legacy-write-simulation",
        move |callback| {
            lore::runtime().block_on(lore::repository::status(
                legacy_globals,
                LoreRepositoryStatusArgs {
                    staged: 1,
                    scan: 1,
                    check_dirty: 0,
                    reset: 0,
                    sync_point: 0,
                    revision_only: 0,
                    count: 0,
                    paths: LoreArray::default(),
                },
                callback,
            ))
        },
    )
    .expect("The legacy write-style status simulation should succeed");
    assert_eq!(legacy_scan.status, 0);
    let legacy_persisted_state = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        false,
    ))
    .expect("The persisted legacy staged anchor should be readable");
    assert!(
        legacy_persisted_state
            .events
            .iter()
            .find(|event| event["tagName"] == "repositoryStatusRevision")
            .and_then(|event| event["data"]["revisionStaged"].as_str())
            .is_some_and(|revision| !is_zero_hash(revision)),
        "The regression setup must persist the legacy dirty-only staged anchor",
    );
    for directory_name in ["sda", "sdd"] {
        std::fs::remove_dir_all(repository_path.join(directory_name))
            .expect("The transient copy directory should be deleted");
    }
    tauri::async_runtime::block_on(lore_stage_move(
        repository_path_string.clone(),
        source_name.to_owned(),
        target_name.to_owned(),
    ))
    .expect("The exact move should be staged after deleting transient copies");
    let final_result = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        true,
    ))
    .expect("Final status should succeed after removing transient additions");
    let final_status_files = final_result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/type").and_then(Value::as_str) == Some("file")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        final_status_files.len(),
        1,
        "Missing transient additions must not reappear after staging the move: {final_status_files:?}",
    );
    assert_eq!(final_status_files[0]["data"]["action"], "move");
    assert_eq!(final_status_files[0]["data"]["flagStaged"], true);

    let move_commit = tauri::async_runtime::block_on(lore_commit(
        repository_path_string.clone(),
        "Commit retained move".to_owned(),
        None,
    ))
    .expect("The staged move should commit successfully");
    let move_revision = committed_revision(&move_commit);
    let revision_changes = tauri::async_runtime::block_on(lore_revision_changes(
        repository_path_string.clone(),
        Some(baseline_revision),
        move_revision,
    ))
    .expect("The immutable revision changes should be readable");
    assert_eq!(
        revision_changes.len(),
        1,
        "Only the explicitly staged move may enter revision history: {revision_changes:?}",
    );
    assert_eq!(revision_changes[0].action, "move");
    assert_eq!(
        revision_changes[0].source_path.as_deref(),
        Some(source_name)
    );
    assert_eq!(revision_changes[0].path, target_name);
    assert!(
        revision_changes
            .iter()
            .all(|change| !change.path.starts_with("sda/") && !change.path.starts_with("sdd/")),
        "Transient directories must never appear in immutable revision history: {revision_changes:?}",
    );
    release_repository_cache(&repository_path)
        .expect("The cached repository context should be released before cleanup");
}

#[test]
fn commit_includes_only_explicitly_staged_files_after_read_only_scan() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let repository_path =
        std::env::temp_dir().join(format!("lore-client-stage-isolation-{unique}"));
    let _cleanup = TemporaryRepository::new(repository_path.clone());
    std::fs::create_dir_all(&repository_path)
        .expect("The temporary test directory should be created");
    let repository_path_string = repository_path.to_string_lossy().into_owned();

    initialize_repository(
        &repository_path_string,
        "stage-isolation",
        "Explicit stage isolation regression",
        "lore-client-test",
        None,
    )
    .expect("The temporary Lore repository should be initialized");
    std::fs::write(repository_path.join("staged.txt"), "included")
        .expect("The explicitly staged file should be created");
    std::fs::write(repository_path.join("working-only.txt"), "excluded")
        .expect("The working-tree-only file should be created");

    let scan = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        true,
    ))
    .expect("The read-only working-tree scan should succeed");
    assert_eq!(
        scan.events
            .iter()
            .filter(|event| event["tagName"] == "repositoryStatusFile")
            .count(),
        2,
        "The read-only snapshot should display both working-tree files",
    );
    tauri::async_runtime::block_on(lore_stage(
        repository_path_string.clone(),
        vec!["staged.txt".to_owned()],
    ))
    .expect("The selected file should be staged");
    std::fs::write(repository_path.join("staged.txt"), "working edit")
        .expect("The staged file should be edited again in the working tree");
    let staged_status = tauri::async_runtime::block_on(lore_repository_status(
        repository_path_string.clone(),
        false,
    ))
    .expect("The read-only status after editing a staged path should succeed");
    let staged_path_events = staged_status
        .events
        .iter()
        .filter(|event| {
            event["tagName"] == "repositoryStatusFile" && event["data"]["path"] == "staged.txt"
        })
        .collect::<Vec<_>>();
    assert_eq!(
        staged_path_events.len(),
        1,
        "Lore Stage tracks path membership, so the selected path remains one staged change: {staged_path_events:?}",
    );
    assert_eq!(staged_path_events[0]["data"]["flagStaged"], true);
    let commit = tauri::async_runtime::block_on(lore_commit(
        repository_path_string.clone(),
        "Commit selected file".to_owned(),
        None,
    ))
    .expect("The explicitly staged file should commit successfully");
    let revision = committed_revision(&commit);
    let committed_paths = collect_revision_tree_files(&repository_path_string, &revision)
        .expect("The committed immutable tree should be readable")
        .into_iter()
        .map(|file| file.path)
        .collect::<Vec<_>>();
    assert_eq!(
        committed_paths,
        vec!["staged.txt"],
        "A read-only scan must not make the working-tree-only file committable",
    );
    let committed_diff = build_initial_revision_diff(
        &repository_path_string,
        &revision,
        &["staged.txt".to_owned()],
        3,
    )
    .expect("The committed file content should be readable from the immutable revision");
    let committed_patch = committed_diff
        .events
        .iter()
        .find(|event| event["tagName"] == "fileDiff" && event["data"]["path"] == "staged.txt")
        .and_then(|event| event["data"]["patch"].as_str())
        .expect("The initial revision should include a text patch");
    assert!(
        committed_patch.contains("+working edit"),
        "Lore Stage includes the path, and Commit records its latest working content: {committed_patch:?}",
    );
    assert!(
        !committed_patch.contains("working-only"),
        "An unselected working-tree path must remain outside the immutable revision: {committed_patch:?}",
    );

    release_repository_cache(&repository_path)
        .expect("The cached repository context should be released before cleanup");
}

#[test]
fn structural_status_does_not_guess_an_ambiguous_move_source() {
    let baseline_files = vec![
        RevisionTreeFile {
            path: "first.txt".to_owned(),
            size: 13,
            address: format!("{}-context", "a".repeat(64)),
            repository: "repository".to_owned(),
        },
        RevisionTreeFile {
            path: "second.txt".to_owned(),
            size: 13,
            address: format!("{}-context", "a".repeat(64)),
            repository: "repository".to_owned(),
        },
    ];
    let mut events = vec![
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": { "path": "target.txt", "type": "file", "action": "add", "size": 13 }
        }),
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": { "path": "first.txt", "type": "file", "action": "delete", "size": 0 }
        }),
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": { "path": "second.txt", "type": "file", "action": "delete", "size": 0 }
        }),
    ];
    let workspace_hashes = BTreeMap::from([("target.txt".to_owned(), "a".repeat(64))]);

    rewrite_unstaged_structural_status_events(
        &mut events,
        &baseline_files,
        &workspace_hashes,
        &BTreeSet::new(),
    );

    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["data"]["action"], "add");
    assert_eq!(events[0]["data"]["fromPath"], Value::Null);
}

#[test]
fn structural_status_preserves_real_staged_changes() {
    let staged_event = serde_json::json!({
        "tagName": "repositoryStatusFile",
        "data": {
            "path": "staged.txt",
            "type": "file",
            "action": "delete",
            "flagStaged": true,
            "flagConflict": false
        }
    });
    let result = LoreOperationResult {
        operation: "repository.status",
        status: 0,
        duration_ms: 0,
        events: vec![staged_event.clone()],
    };

    let normalized = normalize_unstaged_structural_status("missing-repository", result);

    assert_eq!(normalized.events, vec![staged_event]);
}

#[test]
fn structural_status_does_not_merge_across_stage_partitions() {
    let baseline_files = vec![RevisionTreeFile {
        path: "source.txt".to_owned(),
        size: 13,
        address: format!("{}-context", "a".repeat(64)),
        repository: "repository".to_owned(),
    }];
    let mut events = vec![
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": {
                "path": "source.txt",
                "type": "file",
                "action": "delete",
                "size": 0,
                "flagStaged": false
            }
        }),
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": {
                "path": "target.txt",
                "type": "file",
                "action": "add",
                "size": 13,
                "flagStaged": true
            }
        }),
    ];
    let workspace_hashes = BTreeMap::from([("target.txt".to_owned(), "a".repeat(64))]);

    rewrite_unstaged_structural_status_events(
        &mut events,
        &baseline_files,
        &workspace_hashes,
        &BTreeSet::new(),
    );

    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["data"]["action"], "delete");
    assert_eq!(events[1]["data"]["action"], "add");
}

#[test]
fn structural_status_removes_only_missing_unstaged_additions() {
    let mut events = vec![
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": {
                "path": "missing-unstaged.txt",
                "type": "file",
                "action": "add",
                "flagStaged": false
            }
        }),
        serde_json::json!({
            "tagName": "repositoryStatusFile",
            "data": {
                "path": "missing-staged.txt",
                "type": "file",
                "action": "add",
                "flagStaged": true
            }
        }),
    ];
    let missing = BTreeSet::from([
        "missing-unstaged.txt".to_owned(),
        "missing-staged.txt".to_owned(),
    ]);

    rewrite_unstaged_structural_status_events(&mut events, &[], &BTreeMap::new(), &missing);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["data"]["path"], "missing-staged.txt");
}

#[test]
fn storage_payload_capture_reassembles_fragments_without_json_values() {
    let mut capture = StorageGetCapture::default();
    prepare_storage_get_buffer(&mut capture, 7, 6)
        .expect("The declared storage payload should fit in memory");

    copy_storage_get_chunk(&mut capture, 7, 3, &[4, 5, 6])
        .expect("A later storage fragment should fit the declared payload");
    copy_storage_get_chunk(&mut capture, 7, 0, &[1, 2, 3])
        .expect("An earlier storage fragment should fit the declared payload");

    assert_eq!(
        capture.contents.get(&7),
        Some(&vec![1, 2, 3, 4, 5, 6]),
        "Storage fragments must be copied directly into one contiguous byte buffer",
    );
}

#[test]
fn storage_payload_capture_rejects_out_of_bounds_fragments() {
    let mut capture = StorageGetCapture::default();
    prepare_storage_get_buffer(&mut capture, 9, 3)
        .expect("The declared storage payload should fit in memory");

    let error = copy_storage_get_chunk(&mut capture, 9, 2, &[3, 4])
        .expect_err("A fragment beyond the declared payload must be rejected");

    assert!(
        error.contains("beyond its declared content size"),
        "The invalid fragment should retain a diagnostic reason",
    );
}

#[test]
fn auth_mutation_releases_every_open_repository_context() {
    let first = PathBuf::from("C:/repositories/first");
    let second = PathBuf::from("C:/repositories/second");
    let mut released = Vec::new();

    release_repository_authentication_contexts_with(
        &[first.clone(), second.clone(), first.clone()],
        |path| {
            released.push(path.to_path_buf());
            Ok(())
        },
    )
    .expect("Authentication context refresh should succeed");

    assert_eq!(
        released,
        vec![first, second],
        "Every open repository context must be released exactly once after auth changes",
    );
}

#[test]
fn auth_mutation_continues_releasing_contexts_after_one_failure() {
    let first = PathBuf::from("C:/repositories/first");
    let second = PathBuf::from("C:/repositories/second");
    let mut released = Vec::new();

    let error =
        release_repository_authentication_contexts_with(&[first.clone(), second.clone()], |path| {
            released.push(path.to_path_buf());
            if path == first {
                Err(LoreCommandError::new(
                    "repository_cache_release_failed",
                    "First repository context could not be released",
                ))
            } else {
                Ok(())
            }
        })
        .expect_err("The first release failure should still be reported");

    assert_eq!(error.code, "repository_cache_release_failed");
    assert_eq!(
        released,
        vec![first, second],
        "A failed repository must not prevent later contexts from being released",
    );
}

#[test]
fn successful_auth_mutation_invalidates_cached_transport_connections() {
    let result = LoreOperationResult {
        operation: "auth.test",
        status: 0,
        duration_ms: 0,
        events: Vec::new(),
    };
    let mut invalidation_count = 0;

    invalidate_authentication_connections_with(&result, || invalidation_count += 1);

    assert_eq!(
        invalidation_count, 1,
        "A successful auth mutation must invalidate cached transport connections",
    );
}

#[test]
fn explicit_empty_publish_account_bypasses_repository_binding() {
    assert_eq!(
        resolve_publish_auth_identity(None, Some("bound-user"), false),
        ""
    );
}

#[test]
fn selected_publish_account_overrides_repository_binding() {
    assert_eq!(
        resolve_publish_auth_identity(Some("selected-user"), Some("bound-user"), true),
        "selected-user"
    );
}

#[test]
fn legacy_publish_request_falls_back_to_repository_binding() {
    assert_eq!(
        resolve_publish_auth_identity(None, Some("bound-user"), true),
        "bound-user"
    );
}

#[test]
fn publish_preflight_finds_the_existing_remote_by_repository_id() {
    let result = LoreOperationResult {
        operation: "repository.list.publish-preflight",
        status: 0,
        duration_ms: 1,
        events: vec![serde_json::json!({
            "tagName": "repositoryListEntry",
            "data": {
                "id": "019f9ef8cecb7e43b04c954f5faa9ec8",
                "name": "test-new-repo"
            }
        })],
    };

    assert_eq!(
        find_remote_repository_name(&result, "019F9EF8CECB7E43B04C954F5FAA9EC8"),
        Some("test-new-repo")
    );
}

#[test]
fn failed_publish_preflight_does_not_claim_an_existing_remote() {
    let result = LoreOperationResult {
        operation: "repository.list.publish-preflight",
        status: -1,
        duration_ms: 1,
        events: vec![serde_json::json!({
            "tagName": "repositoryListEntry",
            "data": {
                "id": "repository-id",
                "name": "project"
            }
        })],
    };

    assert_eq!(find_remote_repository_name(&result, "repository-id"), None);
}

fn branch_list_entry(location: &str, name: &str, id: &str, latest: &str) -> Value {
    serde_json::json!({
        "tagName": "branchListEntry",
        "data": {
            "location": location,
            "name": name,
            "id": id,
            "latest": latest
        }
    })
}

#[test]
fn matching_zero_branch_tips_are_recognized_before_publish_push() {
    let result = LoreOperationResult {
        operation: "branch.list.publish-preflight",
        status: 0,
        duration_ms: 1,
        events: vec![
            branch_list_entry("local", "main", "branch-id", ZERO_HASH),
            branch_list_entry("remote", "main", "branch-id", ZERO_HASH),
        ],
    };

    assert!(published_branch_tips_are_zero(&result, "main"));
}

#[test]
fn nonzero_remote_branch_tip_requires_real_publish_push() {
    let result = LoreOperationResult {
        operation: "branch.list.publish-preflight",
        status: 0,
        duration_ms: 1,
        events: vec![
            branch_list_entry("local", "main", "branch-id", ZERO_HASH),
            branch_list_entry("remote", "main", "branch-id", "revision-id"),
        ],
    };

    assert!(!published_branch_tips_are_zero(&result, "main"));
}

#[test]
fn failed_branch_list_does_not_skip_publish_push() {
    let result = LoreOperationResult {
        operation: "branch.list.publish-preflight",
        status: -1,
        duration_ms: 1,
        events: Vec::new(),
    };

    assert!(!published_branch_tips_are_zero(&result, "main"));
}
use lore::repository::LoreRepositoryCreateArgs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn auth_user_info_request_normalizes_and_deduplicates_user_ids() {
    let (auth_url, user_ids) = validate_auth_user_info_request(
        " https://auth.example.com ".to_owned(),
        vec![
            " user-2 ".to_owned(),
            "user-1".to_owned(),
            "user-2".to_owned(),
        ],
    )
    .expect("A valid Auth endpoint and user IDs must be accepted");

    assert_eq!(auth_url, "https://auth.example.com");
    assert_eq!(user_ids, vec!["user-1".to_owned(), "user-2".to_owned()]);
}

#[test]
fn auth_user_info_request_rejects_missing_or_unsafe_identity_data() {
    let missing =
        validate_auth_user_info_request("https://auth.example.com".to_owned(), Vec::new())
            .expect_err("At least one user ID must be required");
    assert_eq!(missing.code, "auth_identity_required");

    let unsafe_identity = validate_auth_user_info_request(
        "https://auth.example.com".to_owned(),
        vec!["user\n2".to_owned()],
    )
    .expect_err("Control characters must not enter an Auth identity lookup");
    assert_eq!(unsafe_identity.code, "auth_identity_invalid");
}

#[test]
fn repository_auth_user_info_request_deduplicates_candidates_and_enforces_history_limit() {
    assert_eq!(
        normalize_auth_user_ids(vec![
            " user-2 ".to_owned(),
            "Artist Team".to_owned(),
            "user-2".to_owned(),
        ])
        .expect("Revision author candidates must be normalized"),
        vec!["Artist Team".to_owned(), "user-2".to_owned()]
    );

    let error = normalize_auth_user_ids((0..=1_000).map(|index| format!("user-{index}")).collect())
        .expect_err("A single Auth request must not exceed the history limit");
    assert_eq!(error.code, "auth_identity_limit_exceeded");
}

fn revision_history_entry(
    revision: &str,
    revision_number: u64,
    parent_self: &str,
    parent_other: &str,
) -> Value {
    serde_json::json!({
        "tagName": "revisionHistoryEntry",
        "data": {
            "revision": revision,
            "revisionNumber": revision_number,
            "parent": [parent_self, parent_other]
        }
    })
}

fn revision_history_metadata(revision: &str) -> Value {
    serde_json::json!({
        "tagName": "metadata",
        "data": {
            "key": "message",
            "value": {
                "data": format!("message-{revision}")
            }
        }
    })
}

fn revision_history_result(events: Vec<Value>) -> LoreOperationResult {
    LoreOperationResult {
        operation: "revision.history",
        status: 0,
        duration_ms: 1,
        events,
    }
}

#[test]
fn revision_history_uses_the_explicit_branch_tip_as_its_primary_anchor() {
    let zero = "0000000000000000000000000000000000000000000000000000000000000000";
    let mut queried_revisions = Vec::new();
    let merged =
        collect_revision_history_with(100, Some("main-tip".to_owned()), |revision, _length| {
            queried_revisions.push(revision.clone());
            Ok(revision_history_result(vec![
                revision_history_entry("main-tip", 2, "old-head", zero),
                revision_history_metadata("main-tip"),
                revision_history_entry("old-head", 1, zero, zero),
                revision_history_metadata("old-head"),
            ]))
        })
        .expect("An explicit Branch tip should produce readable history");

    assert_eq!(queried_revisions, vec![Some("main-tip".to_owned())]);
    assert_eq!(
        merged.events[0]["data"]["revision"].as_str(),
        Some("main-tip")
    );
}

#[test]
fn shared_store_info_maps_parallel_arrays_and_container_path() {
    let separator = std::path::MAIN_SEPARATOR;
    let path = format!("{separator}device{separator}remote{separator}shared_store");
    let info = parse_shared_store_info(&[serde_json::json!({
        "tagName": "sharedStoreInfo",
        "data": {
            "useAutomatically": 1,
            "remoteUrls": ["lore://127.0.0.1:41337"],
            "paths": [path],
            "exists": [0]
        }
    })])
    .expect("Shared Store Info event should parse");

    assert!(info.use_automatically);
    assert_eq!(info.stores.len(), 1);
    assert_eq!(info.stores[0].remote_url, "lore://127.0.0.1:41337");
    assert!(info.stores[0].container_path.ends_with("remote"));
    assert!(!info.stores[0].exists);
    assert!(!info.exact_savings_available);
}

#[test]
fn shared_store_usage_counts_files_without_following_directories_outside_root() {
    let root = std::env::temp_dir().join(format!(
        "lore-client-shared-store-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos()
    ));
    // 使用作用域清理夹具，即使后续扫描或断言发生 panic，也会尽力删除测试目录。
    let _cleanup = TemporaryRepository::new(root.clone());
    fs::create_dir_all(root.join("nested")).expect("temporary Store directory should exist");
    fs::write(root.join("first.fragment"), [1_u8, 2, 3])
        .expect("first Store file should be writable");
    fs::write(root.join("nested").join("second.fragment"), [4_u8, 5])
        .expect("second Store file should be writable");

    let (size_bytes, file_count, error) = scan_directory_usage(&root);

    assert_eq!(size_bytes, 5);
    assert_eq!(file_count, 2);
    assert!(error.is_none());
}

#[test]
fn clone_shared_store_path_is_ignored_when_the_option_is_disabled() {
    assert_eq!(
        validate_clone_shared_store_path(false, Some("missing".to_owned()))
            .expect("disabled Shared Store should not validate an unused path"),
        None
    );
}

#[test]
fn lock_query_filters_reject_control_characters_and_preserve_trimmed_values() {
    assert_eq!(
        validate_optional_lock_filter(Some("  artist@example.com  ".to_owned()), "Lock owner")
            .expect("a normal owner filter should be accepted"),
        Some("artist@example.com".to_owned())
    );
    let error =
        validate_optional_lock_filter(Some("Content/Maps/\nSecret.umap".to_owned()), "Lock path")
            .expect_err("control characters must never enter a remote lock query");
    assert_eq!(error.code, "invalid_lock_filter");
}

#[test]
fn dependency_tags_are_trimmed_deduplicated_and_bounded() {
    assert_eq!(
        validate_dependency_tags(vec![
            " runtime ".to_owned(),
            "runtime".to_owned(),
            "high-resolution".to_owned(),
        ])
        .expect("normal dependency tags should be accepted"),
        vec!["runtime".to_owned(), "high-resolution".to_owned()]
    );
    let error = validate_dependency_tags(vec!["invalid\nvalue".to_owned()])
        .expect_err("control characters must never enter dependency metadata");
    assert_eq!(error.code, "invalid_dependency_tag");
    assert!(validate_dependency_depth_limit(1_024).is_ok());
    assert_eq!(
        validate_dependency_depth_limit(1_025)
            .expect_err("unbounded input must be rejected")
            .code,
        "dependency_depth_limit_too_large"
    );
}

#[test]
fn merge_history_includes_secondary_parent_chain_in_topological_order() {
    const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    let mut requested_revisions = Vec::new();
    let merged = collect_revision_history_with(100, None, |revision, _length| {
        requested_revisions.push(revision.clone());
        match revision.as_deref() {
            None => Ok(revision_history_result(vec![
                serde_json::json!({
                    "tagName": "revisionHistory",
                    "data": {"repository": "repo", "branch": "main"}
                }),
                revision_history_entry("merge-4", 4, "main-3", "side-3"),
                revision_history_metadata("merge-4"),
                revision_history_entry("main-3", 3, "main-2", ZERO),
                revision_history_metadata("main-3"),
                revision_history_entry("main-2", 2, "root-1", ZERO),
                revision_history_metadata("main-2"),
                revision_history_entry("root-1", 1, ZERO, ZERO),
                revision_history_metadata("root-1"),
                serde_json::json!({"tagName": "complete", "data": {}}),
            ])),
            Some("side-3") => Ok(revision_history_result(vec![
                serde_json::json!({
                    "tagName": "revisionHistory",
                    "data": {"repository": "repo", "branch": "side"}
                }),
                revision_history_entry("side-3", 3, "side-2", ZERO),
                revision_history_metadata("side-3"),
                revision_history_entry("side-2", 2, "root-1", ZERO),
                revision_history_metadata("side-2"),
                revision_history_entry("root-1", 1, ZERO, ZERO),
                revision_history_metadata("root-1"),
                serde_json::json!({"tagName": "complete", "data": {}}),
            ])),
            Some(other) => panic!("Unexpected history query for {other}"),
        }
    })
    .expect("Merge history aggregation should succeed");

    let revisions = merged
        .events
        .iter()
        .filter(|event| event["tagName"] == "revisionHistoryEntry")
        .filter_map(|event| event["data"]["revision"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        revisions,
        vec!["merge-4", "main-3", "side-3", "main-2", "side-2", "root-1"]
    );
    assert_eq!(
        requested_revisions,
        vec![None, Some("side-3".to_owned())],
        "Only missing parents should trigger an additional Lore query"
    );

    /*
     * 前端解析器把 Entry 后连续的 Metadata 归属于该 Revision，因此聚合层
     * 移动节点时必须连同元数据事件组一起移动，不能只重排 Entry。
     */
    for window in merged.events.windows(2) {
        if window[0]["tagName"] == "revisionHistoryEntry" {
            let revision = window[0]["data"]["revision"]
                .as_str()
                .expect("Revision entry should contain an id");
            assert_eq!(window[1]["tagName"], "metadata");
            assert_eq!(
                window[1]["data"]["value"]["data"],
                format!("message-{revision}")
            );
        }
    }
    assert_eq!(
        merged
            .events
            .iter()
            .filter(|event| event["tagName"] == "revisionHistory")
            .count(),
        1
    );
    assert_eq!(
        merged
            .events
            .iter()
            .filter(|event| event["tagName"] == "complete")
            .count(),
        1
    );
}

#[test]
fn merge_history_expands_secondary_chain_when_primary_page_is_full() {
    const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    let mut requested_revisions = Vec::new();
    let merged = collect_revision_history_with(3, None, |revision, _length| {
        requested_revisions.push(revision.clone());
        match revision.as_deref() {
            None => Ok(revision_history_result(vec![
                revision_history_entry("merge-5", 5, "main-4", "side-4"),
                revision_history_metadata("merge-5"),
                revision_history_entry("main-4", 4, "main-3", ZERO),
                revision_history_metadata("main-4"),
                revision_history_entry("main-3", 3, "main-2", ZERO),
                revision_history_metadata("main-3"),
            ])),
            Some("side-4") => Ok(revision_history_result(vec![
                revision_history_entry("side-4", 4, "side-3", ZERO),
                revision_history_metadata("side-4"),
                revision_history_entry("side-3", 3, "root-1", ZERO),
                revision_history_metadata("side-3"),
            ])),
            Some(other) => panic!("Unexpected history query for {other}"),
        }
    })
    .expect("A full primary page should still expand visible merge parents");

    let revisions = merged
        .events
        .iter()
        .filter(|event| event["tagName"] == "revisionHistoryEntry")
        .filter_map(|event| event["data"]["revision"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(revisions, vec!["merge-5", "main-4", "side-4"]);
    assert_eq!(requested_revisions, vec![None, Some("side-4".to_owned())]);
}

#[test]
fn linear_history_does_not_expand_a_truncated_primary_parent() {
    const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    let mut requested_revisions = Vec::new();
    let merged = collect_revision_history_with(3, None, |revision, _length| {
        requested_revisions.push(revision.clone());
        match revision.as_deref() {
            None => Ok(revision_history_result(vec![
                revision_history_entry("main-5", 5, "main-4", ZERO),
                revision_history_entry("main-4", 4, "main-3", ZERO),
                revision_history_entry("main-3", 3, "main-2", ZERO),
            ])),
            Some(other) => panic!("Primary parent {other} must not trigger page expansion"),
        }
    })
    .expect("Linear history should preserve the requested page");

    assert_eq!(requested_revisions, vec![None]);
    assert_eq!(
        merged
            .events
            .iter()
            .filter(|event| event["tagName"] == "revisionHistoryEntry")
            .count(),
        3
    );
}

#[test]
fn merge_history_reports_secondary_parent_read_failures() {
    const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    let error =
        collect_revision_history_with(100, None, |revision, _length| match revision.as_deref() {
            None => Ok(revision_history_result(vec![
                revision_history_entry("merge-2", 2, "main-1", "side-1"),
                revision_history_entry("main-1", 1, ZERO, ZERO),
            ])),
            Some("side-1") => Ok(LoreOperationResult {
                operation: "revision.history",
                status: -1,
                duration_ms: 1,
                events: vec![serde_json::json!({
                    "tagName": "complete",
                    "data": {
                        "error": {
                            "message": "secondary state is unavailable"
                        }
                    }
                })],
            }),
            Some(other) => panic!("Unexpected history query for {other}"),
        })
        .expect_err("A missing secondary parent must not produce a partial successful history");

    assert_eq!(error.code, "revision_tree_read_failed");
    assert!(error.message.contains("secondary state is unavailable"));
}

#[test]
fn text_like_paths_cover_unity_godot_and_common_scripts() {
    assert!(is_text_like_revision_path("Assets/Hero.prefab"));
    assert!(is_text_like_revision_path("Assets/Hero.cs.meta"));
    assert!(is_text_like_revision_path("Scripts/Player.gd"));
    assert!(is_text_like_revision_path("Scenes/Main.tscn"));
    assert!(is_text_like_revision_path("src/main.zig"));
    assert!(is_text_like_revision_path("src/app.odin"));
    assert!(is_text_like_revision_path("tools/build.bat"));
    assert!(is_text_like_revision_path("tools/setup.bash"));
    assert!(is_text_like_revision_path(".gitignore"));
    assert!(is_text_like_revision_path("Dockerfile"));
    assert!(!is_text_like_revision_path("Content/Map.umap"));
    assert!(!is_text_like_revision_path("Content/Actor.uasset"));
}

#[test]
fn revision_content_reading_preserves_storage_item_error_code() {
    let result = LoreOperationResult {
        operation: "storage.get",
        status: -1,
        duration_ms: 1,
        events: vec![
            serde_json::json!({
                "tagName": "storageGetItemComplete",
                "data": {
                    "id": 1,
                    "errorCode": "AddressNotFound"
                }
            }),
            serde_json::json!({
                "tagName": "complete",
                "data": {
                    "error": {
                        "errorCode": -1,
                        "message": "1/1 get items failed"
                    }
                }
            }),
        ],
    };

    let error = ensure_operation_success(&result, "Read revision file content")
        .expect_err("A nonzero status must map to a structured error");
    assert_eq!(error.code, "revision_tree_read_failed");
    assert!(error.message.contains("AddressNotFound"));
}

#[test]
fn completed_operation_collects_events_while_callback_is_still_dropping() {
    let mut retained_callback: LoreEventCallback = None;
    let result = run_operation("test.callback-drop-race", |callback| {
        /*
         * 固定 Lore 的事件转发线程会先调用 End、再唤醒等待完成的调用方，
         * callback 本身要等异步任务退出时才析构。这里精确保留这个短窗口，
         * 防止适配层再次把“事件已完整送达”误判成操作失败。
         */
        if let Some(callback_ref) = callback.as_ref() {
            callback_ref(&LoreEvent::End(Default::default()));
        }
        retained_callback = callback;
        0
    })
    .expect("A completed event stream should not require the callback to be dropped first");

    assert_eq!(result.status, 0);
    assert!(result.events.iter().any(|event| event["tagName"] == "end"));
    drop(retained_callback);
}

#[test]
fn workspace_binary_preview_returns_validated_real_file_content() {
    let (repository_path, _cleanup) =
        create_configuration_test_repository("workspace-binary-preview", "");
    let image_directory = repository_path.join("Content").join("Images");
    std::fs::create_dir_all(&image_directory).expect("Temporary image directory should be created");
    // PNG 文件头足以验证真实字节读取与编码链路；预览命令不负责解码图片内容，
    // 实际格式解码仍交给受限的 WebView 图片元素。
    std::fs::write(
        image_directory.join("Preview.PNG"),
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .expect("Temporary image should be written");

    let preview = build_file_preview(
        repository_path.to_string_lossy().as_ref(),
        "Content/Images/Preview.PNG",
        None,
        false,
    )
    .expect("An allowlisted workspace image should return a preview DTO");

    assert_eq!(preview.path, "Content/Images/Preview.PNG");
    assert_eq!(preview.kind, "image");
    assert_eq!(preview.mime_type, "image/png");
    assert_eq!(preview.size, 8);
    assert_eq!(
        preview.content_state,
        LoreFilePreviewContentState::Available
    );
    assert_eq!(
        preview.data,
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
    );
}

#[test]
fn file_preview_envelope_preserves_metadata_and_payload() {
    let payload = vec![0x89, b'P', b'N', b'G'];
    let envelope = encode_file_preview_envelope(LoreFilePreview {
        path: "Content/Images/Preview.png".to_string(),
        kind: "image",
        mime_type: "image/png",
        data: payload.clone(),
        size: payload.len() as u64,
        content_state: LoreFilePreviewContentState::Available,
        structured_preview: None,
    })
    .expect("A valid preview should be encoded into an IPC envelope");

    // 流式 IPC 直接切分该信封，因此这里固定头部长度、JSON 元数据和尾部原始载荷的
    // 边界，防止后端传输方式变化时破坏前端稳定解码协议。
    let metadata_length = u32::from_le_bytes(
        envelope[..4]
            .try_into()
            .expect("The envelope should start with a four-byte metadata length"),
    ) as usize;
    let metadata_end = 4 + metadata_length;
    let metadata: serde_json::Value = serde_json::from_slice(&envelope[4..metadata_end])
        .expect("The envelope metadata should contain valid JSON");

    assert_eq!(metadata["path"], "Content/Images/Preview.png");
    assert_eq!(metadata["kind"], "image");
    assert_eq!(metadata["contentState"], "available");
    assert_eq!(&envelope[metadata_end..], payload.as_slice());
}

#[test]
fn disabled_workspace_binary_diff_returns_metadata_without_reading_content() {
    let (repository_path, _cleanup) =
        create_configuration_test_repository("workspace-disabled-binary-preview", "");
    let image_directory = repository_path.join("Content").join("Images");
    std::fs::create_dir_all(&image_directory).expect("Temporary image directory should be created");
    std::fs::write(
        image_directory.join("Preview.PNG"),
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
    )
    .expect("Temporary image should be written");

    let preview = build_file_preview(
        repository_path.to_string_lossy().as_ref(),
        "Content/Images/Preview.PNG",
        None,
        true,
    )
    .expect("A disabled binary Diff should return size-only metadata");

    assert_eq!(preview.kind, "image");
    assert_eq!(preview.size, 8);
    assert_eq!(
        preview.content_state,
        LoreFilePreviewContentState::MetadataOnly
    );
    assert!(preview.data.is_empty());
    assert!(preview.structured_preview.is_none());
}

#[test]
fn oversized_workspace_asset_returns_size_metadata_without_reading_content() {
    let (repository_path, _cleanup) =
        create_configuration_test_repository("workspace-oversized-preview", "");
    let asset_path = repository_path.join("Content").join("World.umap");
    std::fs::create_dir_all(
        asset_path
            .parent()
            .expect("Asset should have a parent directory"),
    )
    .expect("Asset directory should be created");
    let asset = std::fs::File::create(&asset_path).expect("Oversized asset should be created");
    asset
        .set_len(24 * 1024 * 1024)
        .expect("Sparse oversized asset length should be set");

    let preview = build_file_preview(
        repository_path.to_string_lossy().as_ref(),
        "Content/World.umap",
        None,
        false,
    )
    .expect("An oversized allowlisted asset should return size-only metadata");

    assert_eq!(preview.size, 24 * 1024 * 1024);
    assert_eq!(preview.content_state, LoreFilePreviewContentState::TooLarge);
    assert!(preview.data.is_empty());
    assert!(preview.structured_preview.is_none());
}

#[test]
fn unsupported_workspace_binary_returns_size_metadata_without_reading_content() {
    let (repository_path, _cleanup) =
        create_configuration_test_repository("workspace-unsupported-preview", "");
    let binary_path = repository_path
        .join("Content")
        .join("OnlineFramework.archive");
    std::fs::create_dir_all(
        binary_path
            .parent()
            .expect("Binary file should have a parent directory"),
    )
    .expect("Binary directory should be created");
    std::fs::write(&binary_path, [0_u8; 32]).expect("Unsupported binary should be written");

    let preview = build_file_preview(
        repository_path.to_string_lossy().as_ref(),
        "Content/OnlineFramework.archive",
        None,
        false,
    )
    .expect("An unsupported binary should return size-only metadata");

    assert_eq!(preview.kind, "binary");
    assert_eq!(preview.mime_type, "application/octet-stream");
    assert_eq!(preview.size, 32);
    assert_eq!(
        preview.content_state,
        LoreFilePreviewContentState::Unsupported
    );
    assert!(preview.data.is_empty());
    assert!(preview.structured_preview.is_none());
}

#[test]
fn revision_storage_prefers_bound_auth_identity_over_commit_identity() {
    let (repository_path, _cleanup) = create_configuration_test_repository(
        "revision-storage-auth-identity",
        "identity = \"commit-author\"\nremote_url = \"lore://127.0.0.1:41337\"\n",
    );
    let binding_key = repository_binding_key(&repository_path);
    auth_account_bindings()
        .lock()
        .expect("The auth binding store should be writable")
        .insert(
            binding_key.clone(),
            BoundAuthAccount {
                auth_url: "https://auth.example.com".to_owned(),
                user_id: "remote-account".to_owned(),
            },
        );

    let globals = revision_storage_globals(&repository_path)
        .expect("The revision storage globals should be constructed");

    auth_account_bindings()
        .lock()
        .expect("The auth binding store should be writable")
        .remove(&binding_key);
    assert_eq!(globals.identity.as_str(), "remote-account");
}

#[test]
fn empty_repository_path_returns_structured_error() {
    let error = validate_repository_path("  ").expect_err("An empty path must be rejected");
    assert_eq!(error.code, "empty_repository_path");
}

#[test]
fn composition_argument_builders_preserve_safe_link_and_layer_options() {
    let layer = build_layer_add_args(
        " Content/Shared ".to_owned(),
        "repository-shared".to_owned(),
        "Assets".to_owned(),
        Some(" release ".to_owned()),
    )
    .expect("A complete Layer request should be accepted");
    assert_eq!(layer.target_path.as_str(), "Content/Shared");
    assert_eq!(layer.source_repository.as_str(), "repository-shared");
    assert_eq!(layer.source_path.as_str(), "Assets");
    assert_eq!(layer.metadata.as_str(), "release");

    let link = build_link_add_args(
        "lore://127.0.0.1:41337/tools".to_owned(),
        "Tools".to_owned(),
        "/".to_owned(),
        Some(" main ".to_owned()),
        true,
    )
    .expect("A complete Link request should be accepted");
    assert_eq!(link.link.as_str(), "lore://127.0.0.1:41337/tools");
    assert_eq!(link.link_path.as_str(), "Tools");
    assert_eq!(link.source_path.as_str(), "/");
    assert_eq!(link.pin.as_str(), "main");
    assert_eq!(link.disable_branching, 1);

    let removal = build_layer_remove_args(
        "Content/Shared".to_owned(),
        "repository-shared".to_owned(),
        true,
    )
    .expect("A selected Layer can opt into an explicit purge");
    assert_eq!(removal.purge, 1);
}

#[test]
fn composition_argument_builders_reject_missing_or_control_character_fields() {
    let empty = build_link_update_args("  ".to_owned(), None)
        .expect_err("An empty Link path must be rejected before entering Lore");
    assert_eq!(empty.code, "composition_field_required");

    let invalid = build_layer_add_args(
        "Content/\nShared".to_owned(),
        "repository-shared".to_owned(),
        "Assets".to_owned(),
        None,
    )
    .expect_err("Control characters must not enter a Lore path argument");
    assert_eq!(invalid.code, "composition_field_invalid");
}

#[test]
fn conflict_session_recovers_staged_and_incoming_revisions_from_status() {
    let events = vec![serde_json::json!({
        "tagName": "repositoryStatusRevision",
        "data": {
            "revision": "11111111",
            "revisionStaged": "22222222",
            "revisionMerged": "33333333"
        }
    })];

    assert_eq!(
        conflict_revision_ids(&events),
        Some((
            "11111111".to_owned(),
            "22222222".to_owned(),
            Some("33333333".to_owned())
        ))
    );
}

#[test]
fn conflict_kind_prefers_revision_metadata_and_detects_merge_from_second_parent() {
    let cherry_pick = vec![serde_json::json!({
        "tagName": "metadata",
        "data": { "key": "cherry-picked-from" }
    })];
    let revert = vec![serde_json::json!({
        "tagName": "metadata",
        "data": { "key": "reverted-from" }
    })];
    let merge = vec![serde_json::json!({
        "tagName": "revisionInfo",
        "data": { "parent": ["11111111", "22222222"] }
    })];

    assert_eq!(
        classify_conflict_operation(&cherry_pick, Some("33333333")),
        LoreConflictOperationKind::CherryPick,
        "Cherry-pick metadata must take precedence over a generic incoming revision"
    );
    assert_eq!(
        classify_conflict_operation(&revert, None),
        LoreConflictOperationKind::Revert
    );
    assert_eq!(
        classify_conflict_operation(&merge, None),
        LoreConflictOperationKind::Merge
    );
    assert_eq!(
        classify_conflict_operation(&[], None),
        LoreConflictOperationKind::Unknown,
        "The conflict kind must not be guessed without persisted evidence"
    );
}

#[test]
fn conflict_file_action_rejects_empty_paths_and_abort_discards_stale_selection() {
    assert_eq!(
        validate_conflict_action_paths(LoreConflictAction::Resolve, Vec::new())
            .expect_err("A file-level conflict action must not interpret an empty set as all files")
            .code,
        "conflict_paths_required"
    );
    assert_eq!(
        validate_conflict_action_paths(
            LoreConflictAction::Abort,
            vec!["Content/Conflict.txt".to_owned()]
        )
        .expect("Abort should ignore stale frontend selection"),
        Vec::<String>::new()
    );
}

#[test]
fn commit_identity_prefers_repository_configuration_and_falls_back_to_client_default() {
    let (repository_path, _cleanup) = create_configuration_test_repository(
        "identity-resolution",
        "identity = \"repository@example.com\"\n",
    );

    assert_eq!(
        resolve_commit_identity(
            repository_path.to_string_lossy().as_ref(),
            Some("default@example.com"),
        )
        .unwrap(),
        "repository@example.com",
    );

    update_repository_configuration(&repository_path, "", "").unwrap();
    assert_eq!(
        resolve_commit_identity(
            repository_path.to_string_lossy().as_ref(),
            Some("default@example.com"),
        )
        .unwrap(),
        "default@example.com",
    );
    assert_eq!(
        resolve_commit_identity(repository_path.to_string_lossy().as_ref(), None)
            .expect_err("Missing repository and client identities must fail before calling Lore")
            .code,
        "commit_identity_missing",
    );
}

#[test]
fn git_style_author_and_email_pass_through_as_single_lore_identity() {
    assert_eq!(
        normalize_identity(" YourName <yourname@example.com> ")
            .unwrap()
            .as_deref(),
        Some("YourName <yourname@example.com>"),
    );
}

#[test]
fn repository_configuration_edit_preserves_unknown_tables_and_comments() {
    let (repository_path, _cleanup) = create_configuration_test_repository(
        "config-update",
        concat!(
            "# Repository comment that must be preserved\n",
            "identity = \"old@example.com\"\n",
            "remote_url = \"lore://old:41337/project\"\n\n",
            "[store]\n",
            "max_size = 2048\n",
        ),
    );

    let updated =
        update_repository_configuration(&repository_path, "new@example.com", "lore://new:41337/")
            .unwrap();
    assert_eq!(updated.identity.as_deref(), Some("new@example.com"));
    assert_eq!(updated.remote_url.as_deref(), Some("lore://new:41337"));
    let config_path = repository_path.join(".lore").join("config.toml");
    let content = std::fs::read_to_string(&config_path).unwrap();
    assert!(content.contains("# Repository comment that must be preserved"));
    assert!(content.contains("[store]"));
    assert!(content.contains("max_size = 2048"));

    let cleared = update_repository_configuration(&repository_path, "", "").unwrap();
    assert_eq!(cleared.identity, None);
    assert_eq!(cleared.remote_url, None);
    let cleared_content = std::fs::read_to_string(config_path).unwrap();
    assert!(!cleared_content.contains("identity ="));
    assert!(!cleared_content.contains("remote_url ="));
    assert!(cleared_content.contains("[store]"));
}

#[test]
fn empty_file_list_maps_to_repository_root() {
    assert_eq!(normalize_paths(Vec::new(), true), vec!["."]);
}

#[test]
fn revision_signature_rejects_whitespace() {
    assert_eq!(
        validate_revision("  ")
            .expect_err("An empty revision must be rejected")
            .code,
        "empty_revision",
    );
    assert_eq!(
        validate_revision("abc def")
            .expect_err("A revision containing whitespace must be rejected")
            .code,
        "invalid_revision",
    );
    assert_eq!(validate_revision("c7f3a81d").unwrap(), "c7f3a81d");
}

#[test]
fn file_history_clears_branch_when_revision_is_provided() {
    assert_eq!(
        validate_file_history_start(Some("main".to_owned()), Some("abcdef1234567890".to_owned()))
            .unwrap(),
        (String::new(), "abcdef1234567890".to_owned())
    );
    assert_eq!(
        validate_file_history_start(Some("main".to_owned()), None).unwrap(),
        ("main".to_owned(), String::new())
    );
    assert_eq!(
        validate_file_history_start(None, Some("bad revision".to_owned()))
            .expect_err("An invalid revision must be rejected before calling Lore")
            .code,
        "invalid_revision"
    );
}

#[test]
fn tag_name_supports_path_semantics_and_rejects_control_characters() {
    assert_eq!(
        validate_tag_name(" release/world-1.0 ").unwrap(),
        "release/world-1.0",
    );
    assert_eq!(
        validate_tag_name("  ")
            .expect_err("An empty name must be rejected")
            .code,
        "empty_tag_name",
    );
    assert_eq!(
        validate_tag_name("release\n1.0")
            .expect_err("Newline characters must be rejected")
            .code,
        "invalid_tag_name",
    );
}

#[test]
fn tag_metadata_event_parses_string_values_and_ignores_other_keys() {
    let tag = LoreTag {
        id: "tag-stable".to_owned(),
        name: "release/1.0".to_owned(),
        branch: "main".to_owned(),
        revision: "c7f3a81d".to_owned(),
        message: "First stable release".to_owned(),
        created_at: 1,
        updated_at: 2,
    };
    let event = serde_json::json!({
        "tagName": "metadata",
        "data": {
            "key": "lore-client.tag.v1/release/1.0",
            "value": {
                "tagName": "string",
                "data": serde_json::to_string(&tag).unwrap(),
            }
        }
    });
    let parsed = parse_tag_metadata_event(&event).expect("A valid tag event should be parsed");
    assert_eq!(parsed.tag, tag);
    assert_eq!(parsed.key, "lore-client.tag.v1/release/1.0");

    let unrelated = serde_json::json!({
        "tagName": "metadata",
        "data": {
            "key": "another-tool.key",
            "value": {"tagName": "string", "data": "{}"}
        }
    });
    assert!(parse_tag_metadata_event(&unrelated).is_none());
}

#[test]
fn tag_list_deduplicates_by_stable_id_and_keeps_latest_rename() {
    let old = LoreTagRecord {
        key: "lore-client.tag.v1/release/old".to_owned(),
        tag: LoreTag {
            id: "tag-stable".to_owned(),
            name: "release/old".to_owned(),
            branch: "main".to_owned(),
            revision: "c7f3a81d".to_owned(),
            message: String::new(),
            created_at: 1,
            updated_at: 2,
        },
    };
    let mut renamed = old.clone();
    renamed.key = "lore-client.tag.v1/release/new".to_owned();
    renamed.tag.name = "release/new".to_owned();
    renamed.tag.updated_at = 3;

    let result = deduplicate_tag_records(vec![old, renamed]);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].tag.name, "release/new");
}

#[test]
fn clearing_empty_tag_keys_does_not_clear_all_repository_metadata() {
    let result = clear_tag_keys(".", Vec::new());
    assert!(
        result.is_ok(),
        "An empty array must return directly from the adapter"
    );
}

#[test]
fn file_paths_are_normalized_to_forward_slashes() {
    assert_eq!(
        normalize_paths(vec!["Content\\Maps\\World.umap".to_owned()], false),
        vec!["Content/Maps/World.umap"],
    );
}

#[test]
fn file_restore_path_rejects_repository_root_escape() {
    let error = validate_repository_relative_path("../outside.txt")
        .expect_err("Parent traversal must be rejected");
    assert_eq!(error.code, "invalid_repository_relative_path");
}

#[test]
fn file_restore_path_accepts_nested_repository_relative_path() {
    let path = validate_repository_relative_path("Content/Maps/World.umap")
        .expect("A valid repository-relative path should pass validation");
    assert_eq!(path, PathBuf::from("Content/Maps/World.umap"));
}

#[test]
fn file_restore_path_accepts_and_normalizes_current_directory_prefix() {
    let path = validate_repository_relative_path("./sda.txt")
        .expect("A current-directory prefix should remain valid inside the repository");
    assert_eq!(path, PathBuf::from("sda.txt"));
}

#[test]
fn user_visible_path_removes_windows_extended_prefix() {
    assert_eq!(
        display_path_without_windows_verbatim_prefix(Path::new(r"\\?\E:\Game\Lore")),
        r"E:\Game\Lore"
    );
    assert_eq!(
        display_path_without_windows_verbatim_prefix(Path::new(r"\\?\UNC\server\share\Lore")),
        r"\\server\share\Lore"
    );
}

#[test]
fn empty_file_restore_list_returns_structured_error() {
    let error =
        validate_repository_relative_paths(Vec::new()).expect_err("An empty list must be rejected");
    assert_eq!(error.code, "empty_reset_paths");
}

#[test]
fn revision_diff_accepts_empty_path_for_complete_revision() {
    assert!(validate_optional_diff_paths(Vec::new())
        .expect("A complete revision diff should accept an empty path")
        .is_empty());
    assert_eq!(
        validate_optional_diff_paths(vec!["Content/World.ini".to_owned()]).unwrap(),
        vec!["Content/World.ini"],
    );
}

#[test]
fn targeted_revision_tree_walk_prunes_unrelated_directories_and_files() {
    let paths = BTreeSet::from(["Content/Characters/Hero.glb".to_owned()]);

    assert!(should_visit_revision_tree_node(0, "Content", Some(&paths)));
    assert!(should_visit_revision_tree_node(
        0,
        "Content/Characters",
        Some(&paths)
    ));
    assert!(!should_visit_revision_tree_node(0, "Scripts", Some(&paths)));
    assert!(should_visit_revision_tree_node(
        1,
        "Content/Characters/Hero.glb",
        Some(&paths)
    ));
    assert!(!should_visit_revision_tree_node(
        1,
        "Content/Characters/Villain.glb",
        Some(&paths)
    ));
    assert!(should_visit_revision_tree_node(0, "Scripts", None));
}

#[test]
fn operation_stream_drops_large_non_progress_payloads() {
    let event = serde_json::json!({
        "tagName": "fileDiff",
        "data": {
            "path": "Content/Hero.txt",
            "patch": "x".repeat(1024 * 1024)
        }
    });

    assert!(operation_stream_summary(&event).is_none());
}

#[test]
fn operation_stream_keeps_only_bounded_progress_metrics() {
    let event = serde_json::json!({
        "tagName": "cloneProgress",
        "data": {
            "current": 4,
            "total": 10,
            "bytes": 8192,
            "patch": "must not cross the stream boundary"
        }
    });

    assert_eq!(
        operation_stream_summary(&event),
        Some(serde_json::json!({
            "tagName": "cloneProgress",
            "data": { "current": 4, "total": 10, "bytes": 8192 }
        }))
    );
}

#[test]
fn revision_diff_adds_empty_new_files_without_text_hunks() {
    let source = vec![RevisionTreeFile {
        path: "existing.txt".to_owned(),
        size: 1,
        address: String::new(),
        repository: String::new(),
    }];
    let target = vec![
        source[0].clone(),
        RevisionTreeFile {
            path: "empty.txt".to_owned(),
            size: 0,
            address: String::new(),
            repository: String::new(),
        },
    ];
    let mut events = Vec::new();

    supplement_structural_diff_events(&mut events, &source, &target, &[]);

    assert_eq!(
        events,
        vec![serde_json::json!({
            "tagName": "fileDiff",
            "data": {
                "path": "empty.txt",
                "patch": "",
                "action": "add"
            }
        })],
    );

    /*
     * Inspector 的单文件请求同样必须补全空文件；之前按“paths 非空”跳过扫描
     * 会让这类结构变化在右侧 Diff 中完全消失。
     */
    let mut targeted_events = Vec::new();
    supplement_structural_diff_events(
        &mut targeted_events,
        &source,
        &target,
        &["empty.txt".to_owned()],
    );
    assert_eq!(targeted_events, events);
}

#[test]
fn revision_change_list_compares_only_tree_metadata_and_detects_common_actions() {
    let file = |path: &str, address: &str, size: u64| RevisionTreeFile {
        path: path.to_owned(),
        size,
        address: address.to_owned(),
        repository: "repository-id".to_owned(),
    };
    let source = vec![
        file("copy-source.txt", "copy-address", 10),
        file("deleted.txt", "deleted-address", 11),
        file("modified.txt", "old-address", 12),
        file("moved-old.txt", "moved-address", 13),
        file("unchanged.txt", "same-address", 14),
    ];
    let target = vec![
        file("added.txt", "added-address", 20),
        file("copy-new.txt", "copy-address", 10),
        file("copy-source.txt", "copy-address", 10),
        file("modified.txt", "new-address", 21),
        file("moved-new.txt", "moved-address", 13),
        file("unchanged.txt", "same-address", 14),
    ];

    assert_eq!(
        compare_revision_tree_files(&source, &target),
        vec![
            LoreRevisionChange {
                path: "added.txt".to_owned(),
                source_path: None,
                action: "add",
                size: 20,
            },
            LoreRevisionChange {
                path: "copy-new.txt".to_owned(),
                source_path: None,
                action: "copy",
                size: 10,
            },
            LoreRevisionChange {
                path: "deleted.txt".to_owned(),
                source_path: None,
                action: "delete",
                size: 11,
            },
            LoreRevisionChange {
                path: "modified.txt".to_owned(),
                source_path: None,
                action: "modify",
                size: 21,
            },
            LoreRevisionChange {
                path: "moved-new.txt".to_owned(),
                source_path: Some("moved-old.txt".to_owned()),
                action: "move",
                size: 13,
            },
        ]
    );
}

#[test]
fn root_revision_change_list_marks_the_entire_target_tree_as_added() {
    let target = vec![RevisionTreeFile {
        path: "Scenes/Main.tscn".to_owned(),
        size: 42,
        address: "content-address".to_owned(),
        repository: "repository-id".to_owned(),
    }];

    assert_eq!(
        compare_revision_tree_files(&[], &target),
        vec![LoreRevisionChange {
            path: "Scenes/Main.tscn".to_owned(),
            source_path: None,
            action: "add",
            size: 42,
        }]
    );
}

#[test]
fn initial_revision_added_text_patch_contains_complete_content() {
    let patch = build_added_file_patch("Content/World.txt", b"first\nsecond");
    assert!(patch.contains("--- /dev/null"));
    assert!(patch.contains("+++ Content/World.txt"));
    assert!(patch.contains("+first\n+second"));
    assert!(patch.contains("\\ No newline at end of file"));
}

#[test]
fn ignore_rules_are_generated_and_deduplicated_by_path_or_extension() {
    let paths = vec!["Build/Client.log".to_owned(), "Saved/Server.log".to_owned()];
    assert_eq!(
        build_ignore_rules(&paths, false).unwrap(),
        vec!["Build/Client.log", "Saved/Server.log"],
    );
    assert_eq!(build_ignore_rules(&paths, true).unwrap(), vec!["*.log"],);
}

#[test]
fn ignore_extension_rejects_files_without_extensions() {
    let error = build_ignore_rules(&["LICENSE".to_owned()], true)
        .expect_err("A file without an extension must return an explicit error");
    assert_eq!(error.code, "ignore_extension_missing");
}

#[test]
fn temporary_patch_file_name_does_not_preserve_directory_semantics() {
    assert_eq!(
        sanitize_patch_name("../Content/World Map.ini"),
        ".._Content_World_Map.ini",
    );
    assert_eq!(sanitize_patch_name("////"), "workspace-change");
}

#[test]
fn external_diff_arguments_replace_paths_without_shell_splitting() {
    let tool = ExternalDiffTool {
        id: "diff-test".to_owned(),
        name: "Custom Tool".to_owned(),
        executable: "custom-diff".to_owned(),
        arguments: vec![
            "--left".to_owned(),
            "{before}".to_owned(),
            "--right={after}".to_owned(),
            "{beforeLabel} → {afterLabel}".to_owned(),
        ],
    };
    let arguments = resolve_external_diff_arguments(
        &tool,
        Path::new(r"C:\Temp\before file.txt"),
        Path::new(r"C:\Temp\after & file.txt"),
        "Before",
        "After",
    )
    .unwrap();

    assert_eq!(
        arguments,
        vec![
            "--left",
            r"C:\Temp\before file.txt",
            r"--right=C:\Temp\after & file.txt",
            "Before → After",
        ]
    );
}

#[test]
fn external_diff_arguments_require_both_file_placeholders() {
    let tool = ExternalDiffTool {
        id: "diff-test".to_owned(),
        name: "Broken Tool".to_owned(),
        executable: "broken-diff".to_owned(),
        arguments: vec!["{before}".to_owned()],
    };

    let error = resolve_external_diff_arguments(
        &tool,
        Path::new("before.txt"),
        Path::new("after.txt"),
        "Before",
        "After",
    )
    .expect_err("Both file placeholders are required");
    assert_eq!(error.code, "external_diff_placeholders_missing");
}

#[test]
fn external_tool_command_name_resolves_from_supplied_path() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("studio-diff.testexe");
    fs::write(&executable, b"test executable marker").unwrap();
    let path_value = std::env::join_paths([directory.path()]).unwrap();

    let resolved = resolve_external_executable_with(
        "studio-diff",
        Some(path_value.as_os_str()),
        &[String::new(), ".testexe".to_owned()],
    );

    assert_eq!(resolved.as_deref(), Some(executable.as_path()));
}

#[cfg(windows)]
#[test]
fn external_tool_resolution_prefers_windows_launcher_over_extensionless_shell_script() {
    let directory = tempfile::tempdir().unwrap();
    let shell_script = directory.path().join("code");
    let windows_launcher = directory.path().join("code.cmd");
    fs::write(&shell_script, b"#!/usr/bin/env sh\n").unwrap();
    fs::write(&windows_launcher, b"@echo off\r\n").unwrap();
    let path_value = std::env::join_paths([directory.path()]).unwrap();

    let resolved = resolve_external_executable_with(
        "code",
        Some(path_value.as_os_str()),
        &[".CMD".to_owned(), String::new()],
    );

    assert_eq!(
        resolved.and_then(|path| fs::canonicalize(path).ok()),
        fs::canonicalize(windows_launcher).ok(),
    );
}

#[cfg(windows)]
#[test]
fn absolute_extensionless_external_tool_path_prefers_windows_launcher() {
    let directory = tempfile::tempdir().unwrap();
    let shell_script = directory.path().join("cursor");
    let windows_launcher = directory.path().join("cursor.cmd");
    fs::write(&shell_script, b"#!/usr/bin/env sh\n").unwrap();
    fs::write(&windows_launcher, b"@echo off\r\n").unwrap();

    let resolved = resolve_external_executable_with(
        shell_script.to_string_lossy().as_ref(),
        None,
        &[".CMD".to_owned(), String::new()],
    );

    assert_eq!(
        resolved.and_then(|path| fs::canonicalize(path).ok()),
        fs::canonicalize(windows_launcher).ok(),
    );
}

#[test]
fn external_merge_arguments_require_and_replace_all_four_paths() {
    let tool = ExternalDiffTool {
        id: "merge-test".to_owned(),
        name: "Studio Merge".to_owned(),
        executable: "studio-merge".to_owned(),
        arguments: vec![
            "{remote}".to_owned(),
            "{local}".to_owned(),
            "{base}".to_owned(),
            "{merged}".to_owned(),
            "{localLabel} → {remoteLabel}".to_owned(),
        ],
    };
    let labels = ExternalMergeLabels {
        base: "Base".to_owned(),
        local: "Local".to_owned(),
        remote: "Remote".to_owned(),
        merged: "Merged".to_owned(),
    };

    let arguments = resolve_external_merge_arguments(
        &tool,
        [
            Path::new("base file.txt"),
            Path::new("local file.txt"),
            Path::new("remote file.txt"),
            Path::new("merged file.txt"),
        ],
        &labels,
    )
    .unwrap();

    assert_eq!(
        arguments,
        vec![
            "remote file.txt",
            "local file.txt",
            "base file.txt",
            "merged file.txt",
            "Local → Remote",
        ]
    );
}

#[test]
fn empty_patch_is_rejected() {
    assert_eq!(
        validate_patch_content("  ")
            .expect_err("An empty patch must be rejected")
            .code,
        "empty_patch",
    );
}

#[test]
fn patch_write_command_preserves_real_unified_diff_content() {
    let directory = tempfile::tempdir().expect("A temporary patch directory should be created");
    let destination = directory.path().join("workspace.patch");
    let patch = "--- a/Content/World.txt\n+++ b/Content/World.txt\n@@ -1 +1 @@\n-old\n+new\n";

    lore_write_patch_file(destination.to_string_lossy().into_owned(), patch.to_owned())
        .expect("A patch with a valid parent directory should be written");

    assert_eq!(
        std::fs::read_to_string(destination).expect("The saved patch should be readable"),
        patch,
    );
}

#[test]
fn server_url_validates_scheme_and_removes_trailing_slash() {
    assert_eq!(
        validate_server_url(" lore://127.0.0.1:41337/ ").unwrap(),
        "lore://127.0.0.1:41337",
    );
    assert!(validate_server_url("https://example.com").is_err());
    assert!(
        validate_server_url("lore://127.0.0.1:41337/world").is_err(),
        "Repository configuration must store only the server root URL",
    );
}

#[test]
fn revision_history_args_preserve_branch_date_and_only_branch_filter() {
    let args = build_revision_history_args(
        Some("revision-123".to_owned()),
        Some("main".to_owned()),
        1_743_724_799,
        250,
        true,
    );

    assert_eq!(args.revision.as_str(), "revision-123");
    assert_eq!(args.branch.as_str(), "main");
    assert_eq!(args.date, 1_743_724_799);
    assert_eq!(args.length, 250);
    assert_eq!(args.only_branch, 1);
}

#[test]
fn diagnostic_paths_reject_absolute_and_parent_traversal_inputs() {
    assert!(validate_repository_relative_path("../outside").is_err());
    assert!(validate_repository_relative_path("C:\\outside").is_err());
    assert_eq!(
        validate_repository_relative_path("Content/Maps/World.umap")
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/"),
        "Content/Maps/World.umap"
    );
}

#[test]
fn remote_repository_url_rejects_path_injection() {
    assert_eq!(
        build_repository_url("lore://127.0.0.1:41337/", "world").unwrap(),
        "lore://127.0.0.1:41337/world",
    );
    assert!(build_repository_url("lore://127.0.0.1:41337", "../world").is_err());
}

#[test]
fn directory_probe_finds_repository_root_and_preserves_damaged_metadata() {
    let (repository_path, _cleanup) = create_configuration_test_repository("directory-probe", "");
    let nested_path = repository_path.join("Content").join("Maps");
    std::fs::create_dir_all(&nested_path)
        .expect("The repository test subdirectory should be created");

    let probe = probe_repository_directory(&nested_path);
    assert!(matches!(probe.kind, RepositoryDirectoryKind::Repository));
    assert_eq!(
        probe.repository_path.as_deref(),
        Some(display_path_without_windows_verbatim_prefix(
            &repository_path,
        ))
        .as_deref(),
    );

    /*
     * 仅存在 `.lore` 目录就必须判定为受管理目录。后续真实打开会报告配置损坏，
     * 但绝不能展示初始化入口覆盖用户的修复现场。
     */
    std::fs::remove_file(repository_path.join(".lore").join("config.toml"))
        .expect("The test configuration should be removable");
    let damaged_probe = probe_repository_directory(&nested_path);
    assert!(matches!(
        damaged_probe.kind,
        RepositoryDirectoryKind::Repository
    ));
}

#[test]
fn ordinary_nonempty_directory_can_be_initialized_without_persisting_client_identity() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let repository_path =
        std::env::temp_dir().join(format!("lore-client-initialize-ordinary-{unique}"));
    let _cleanup = TemporaryRepository::new(repository_path.clone());
    std::fs::create_dir_all(&repository_path)
        .expect("The ordinary test directory should be created");
    std::fs::write(repository_path.join("existing.txt"), "must be preserved")
        .expect("An existing file should be created in the directory");

    let initialized = initialize_repository(
        repository_path.to_string_lossy().as_ref(),
        "ordinary-project",
        "Ordinary directory initialization test",
        "",
        Some("client-default@example.com"),
    )
    .expect("An ordinary nonempty directory should initialize in place");

    assert_eq!(initialized.result.status, 0);
    assert!(repository_path.join(".lore").is_dir());
    assert_eq!(
        std::fs::read_to_string(repository_path.join("existing.txt")).unwrap(),
        "must be preserved",
    );
    assert_eq!(
        read_repository_configuration(&repository_path)
            .unwrap()
            .identity,
        None,
        "The client default identity must not be persisted into repository configuration",
    );
    /*
     * 初始化完成并不代表仓库已经可供客户端使用。这里继续经过“打开仓库”必经的
     * Status 边界，防止空仓库把全零 Revision 当成真实对象并在首次打开时失败。
     */
    let status = tauri::async_runtime::block_on(lore_repository_status(
        repository_path.to_string_lossy().into_owned(),
        true,
    ))
    .expect("A newly initialized repository should be readable immediately");
    assert_eq!(status.status, 0);
    let history = tauri::async_runtime::block_on(lore_revision_history(
        repository_path.to_string_lossy().into_owned(),
        Some(100),
        None,
        None,
        None,
        None,
    ))
    .expect(
        "An empty repository should expose an empty history without resolving the zero Revision",
    );
    assert_eq!(history.status, 0);
    assert!(
        history.events.iter().all(|event| {
            event.get("tagName").and_then(Value::as_str) != Some("revisionHistoryEntry")
        }),
        "A newly initialized repository must not invent a Revision entry",
    );
    release_repository_cache(&repository_path)
        .expect("Lore path cache should be released before test cleanup");
}

#[test]
fn native_repository_id_is_converted_to_fixed_length_hex() {
    let (repository_path, _cleanup) = create_configuration_test_repository("repository-id", "");
    let expected = (0_u8..16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    std::fs::write(
        repository_path.join(".lore").join("id"),
        (0_u8..16).collect::<Vec<_>>(),
    )
    .expect("The test repository ID should be written");

    assert_eq!(read_repository_id(&repository_path).unwrap(), expected);
}

#[test]
fn clone_target_and_layer_options_enforce_stable_boundaries() {
    assert_eq!(
        validate_optional_clone_target(Some(" release/1.0 ".to_owned())).unwrap(),
        "release/1.0"
    );
    assert_eq!(
        validate_optional_clone_target(Some("bad\nbranch".to_owned()))
            .expect_err("Control characters must be rejected before calling Lore")
            .code,
        "invalid_clone_target"
    );
    assert_eq!(
        validate_clone_layer(
            Some("world-lighting".to_owned()),
            Some("build-id".to_owned())
        )
        .unwrap(),
        ("world-lighting".to_owned(), "build-id".to_owned())
    );
    assert_eq!(
        validate_clone_layer(None, Some("build-id".to_owned()))
            .expect_err("A metadata key without a Layer repository must be rejected")
            .code,
        "clone_layer_repository_required"
    );
    assert_eq!(
        validate_clone_layer(Some("../world".to_owned()), None)
            .expect_err("A Layer repository must remain one safe remote name")
            .code,
        "invalid_clone_layer_repository"
    );
}

#[test]
fn bare_clone_rejects_options_that_lore_would_ignore() {
    validate_bare_clone_options(true, None, false, "", &[], &[], false, 0)
        .expect("A plain Bare Clone should remain valid");

    let error = validate_bare_clone_options(
        true,
        Some("C:\\views\\world.view"),
        false,
        "",
        &[],
        &[],
        false,
        0,
    )
    .expect_err("A Bare Clone must reject materialization-only options");
    assert_eq!(error.code, "clone_bare_materialization_options");

    let dependency_error = validate_bare_clone_options(
        true,
        None,
        false,
        "",
        &["Content/World.umap".to_owned()],
        &[],
        true,
        4,
    )
    .expect_err("A Bare Clone must reject dependency materialization");
    assert_eq!(dependency_error.code, "clone_bare_materialization_options");
}

#[test]
fn repository_list_authentication_error_maps_to_stable_state() {
    let result = LoreOperationResult {
        operation: "repository.list",
        status: -1,
        duration_ms: 1,
        events: vec![serde_json::json!({
            "tagName": "complete",
            "data": {
                "status": -1,
                "error": {
                    "errorCode": -1,
                    "message": "Failed to list repositories: code: 'The request does not have valid authentication credentials'"
                }
            }
        })],
    };

    assert!(operation_requires_authentication(&result));
}

#[test]
fn clone_target_rejects_nonempty_directory() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!("lore-client-clone-target-{unique}"));
    let _cleanup = TemporaryRepository::new(parent.clone());
    let destination = parent.join("world");
    std::fs::create_dir_all(&destination).expect("The test directory should be created");
    std::fs::write(destination.join("existing.txt"), "preserve")
        .expect("The test file should be written");

    let result = validate_clone_destination(parent.to_string_lossy().as_ref(), "world");
    assert!(
        result.is_err(),
        "A nonempty directory must be rejected to avoid overwriting user files"
    );
}

#[test]
fn clone_target_rejects_both_platform_path_separators() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!("lore-client-clone-separators-{unique}"));
    let _cleanup = TemporaryRepository::new(parent.clone());
    std::fs::create_dir_all(&parent).expect("The test parent directory should be created");
    let parent = parent.to_string_lossy();

    for directory_name in ["nested/directory", r"nested\directory"] {
        let error = validate_clone_destination(parent.as_ref(), directory_name)
            .expect_err("Both Windows and Unix path separators must be rejected");
        assert_eq!(error.code, "invalid_clone_directory");
    }
}

#[test]
fn clone_target_rejects_windows_reserved_names_on_every_platform() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!("lore-client-clone-reserved-{unique}"));
    let _cleanup = TemporaryRepository::new(parent.clone());
    std::fs::create_dir_all(&parent).expect("The test parent directory should be created");
    let parent = parent.to_string_lossy();

    for directory_name in ["CON", "nul.txt", "COM1", "LPT9.logs", "trailing."] {
        let error = validate_clone_destination(parent.as_ref(), directory_name)
            .expect_err("Windows reserved names must be rejected on every platform");
        assert_eq!(error.code, "invalid_clone_directory");
    }
}

#[test]
fn clone_target_accepts_a_portable_unicode_directory_name() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!("lore-client-clone-portable-{unique}"));
    let _cleanup = TemporaryRepository::new(parent.clone());
    std::fs::create_dir_all(&parent).expect("The test parent directory should be created");

    let destination = validate_clone_destination(parent.to_string_lossy().as_ref(), "世界-project")
        .expect("A portable Unicode directory name should be accepted");
    assert_eq!(
        destination,
        std::fs::canonicalize(&parent)
            .expect("The test parent directory should be canonicalizable")
            .join("世界-project")
    );
}

#[test]
fn real_lore_repository_can_be_created_and_events_read() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let repository_path = std::env::temp_dir().join(format!("lore-client-smoke-{unique}"));
    let _cleanup = TemporaryRepository::new(repository_path.clone());
    std::fs::create_dir_all(&repository_path)
        .expect("The temporary test directory should be created");

    let globals = LoreGlobalArgs {
        repository_path: repository_path.as_path().into(),
        working_directory: repository_path.as_path().into(),
        identity: "lore-client-test".into(),
        offline: 1,
        ..Default::default()
    };
    let create_result = run_operation("repository.create", {
        let globals = globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::repository::create(
                globals,
                LoreRepositoryCreateArgs {
                    repository_url: format!("lore://localhost/{unique}").into(),
                    description: "Lore Client smoke test".into(),
                    id: LoreString::default(),
                    use_shared_store: 0,
                    shared_store_path: LoreString::default(),
                },
                callback,
            ))
        }
    })
    .expect("The create operation should return a structured result");
    assert_eq!(
        create_result.status, 0,
        "An offline Lore repository should be created"
    );
    assert!(
        create_result
            .events
            .iter()
            .any(|event| event["tagName"] == "repositoryCreate"),
        "The create operation should produce a repositoryCreate event",
    );

    /*
     * 创建命令会把显式 identity 保存到仓库配置。后续操作刻意不再向
     * LoreGlobalArgs 传 identity，用来验证生产客户端的 global_args 路径：
     * Lore 必须从仓库配置恢复执行身份，而不是要求每条命令重复携带作者。
     */
    let globals = LoreGlobalArgs {
        repository_path: repository_path.as_path().into(),
        working_directory: repository_path.as_path().into(),
        offline: 1,
        ..Default::default()
    };

    std::fs::write(repository_path.join("hello.txt"), "hello lore")
        .expect("The test file should be written");
    // 真实 PNG 通常会超过 Lore 的小内容内联范围，因此夹具保留 PNG 文件头并
    // 扩展到 1 MB，用来覆盖分块 Store 读取而不依赖图片解码器。
    let mut root_png_bytes = vec![0u8; 1024 * 1024];
    root_png_bytes[..8].copy_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    std::fs::write(repository_path.join("root-preview.png"), &root_png_bytes)
        .expect("The root revision test image should be written");
    let stage_result = run_operation("file.stage", {
        let globals = globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::file::stage(
                globals,
                LoreFileStageArgs {
                    paths: LoreArray::from_vec(vec![
                        LoreString::from("hello.txt"),
                        LoreString::from("root-preview.png"),
                    ]),
                    case_change: 0,
                    scan: 1,
                },
                callback,
            ))
        }
    })
    .expect("The stage operation should return a structured result");
    assert_eq!(stage_result.status, 0, "A real file should be staged");

    let status_result = run_operation("repository.status", {
        let globals = globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::repository::status(
                globals,
                LoreRepositoryStatusArgs {
                    staged: 1,
                    scan: 0,
                    check_dirty: 0,
                    reset: 0,
                    sync_point: 0,
                    revision_only: 0,
                    count: 1,
                    paths: LoreArray::default(),
                },
                callback,
            ))
        }
    })
    .expect("The status operation should return a structured result");
    assert_eq!(
        status_result.status, 0,
        "The real repository status should be readable"
    );
    assert!(
        status_result.events.iter().any(|event| {
            event["tagName"] == "repositoryStatusFile" && event["data"]["path"] == "hello.txt"
        }),
        "The status event should contain the real staged file",
    );

    let commit_result = run_operation("revision.commit", {
        let globals = globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::revision::commit(
                globals,
                LoreRevisionCommitArgs {
                    message: "Create the branch test starting point".into(),
                    ..Default::default()
                },
                callback,
            ))
        }
    })
    .expect("The commit operation should return a structured result");
    assert_eq!(
        commit_result.status, 0,
        "A real revision should be committed"
    );
    let source_revision = commit_result
        .events
        .iter()
        .find(|event| event["tagName"] == "revisionCommitRevision")
        .and_then(|event| event["data"]["revision"].as_str())
        .expect("The commit event should provide the source revision")
        .to_owned();

    /*
     * 初始 Revision 没有父节点，生产适配层必须从不可变树读取内容并显式与
     * 空树比较，不能回退到当前工作区或返回空 Diff。
     */
    let initial_diff = build_initial_revision_diff(
        repository_path.to_string_lossy().as_ref(),
        &source_revision,
        &[],
        3,
    )
    .expect("The initial revision diff should be generated from the immutable tree");
    assert!(
        initial_diff.events.iter().any(|event| {
            event["tagName"] == "fileDiff"
                && event["data"]["path"] == "hello.txt"
                && event["data"]["patch"]
                    .as_str()
                    .is_some_and(|patch| patch.contains("+hello lore"))
        }),
        "Added text from the initial revision must appear in fileDiff",
    );

    let root_png_preview = build_file_preview(
        repository_path.to_string_lossy().as_ref(),
        "root-preview.png",
        Some(&source_revision),
        false,
    )
    .expect("The root revision PNG should return real preview content from the immutable store");
    assert_eq!(root_png_preview.kind, "image");
    assert_eq!(root_png_preview.mime_type, "image/png");
    assert_eq!(root_png_preview.size, root_png_bytes.len() as u64);

    /*
     * 直接覆盖生产 View 应用组合：先只保留 hello.txt，确认二进制文件从
     * 工作区撤除；再清空规则，确认 Lore 能从不可变 Store 重新物化它。
     * 这同时防止 keep-alive 让 Sync 继续使用替换前 Filter 的回归。
     */
    let selective_view_result = apply_repository_view(
        repository_path.to_string_lossy().into_owned(),
        source_revision.clone(),
        "**\n!hello.txt\n".to_owned(),
    )
    .expect("Applying a selective View should synchronize the real repository");
    assert_eq!(
        selective_view_result.result.status, 0,
        "Selective View synchronization should succeed"
    );
    assert_eq!(selective_view_result.preview.dematerialize_files, 1);
    assert!(
        repository_path.join("hello.txt").is_file(),
        "The included file should remain materialized"
    );
    assert!(
        !repository_path.join("root-preview.png").exists(),
        "The excluded file should be removed from the workspace"
    );

    let full_view_result = apply_repository_view(
        repository_path.to_string_lossy().into_owned(),
        source_revision.clone(),
        String::new(),
    )
    .expect("Clearing the View should restore full materialization");
    assert_eq!(
        full_view_result.result.status, 0,
        "Full materialization synchronization should succeed"
    );
    assert_eq!(full_view_result.preview.materialize_files, 1);
    assert!(
        repository_path.join("root-preview.png").is_file(),
        "Clearing the View should rematerialize the excluded file"
    );

    let history_result = run_operation("revision.history", {
        let globals = globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::revision::history(
                globals,
                LoreRevisionHistoryArgs {
                    revision: LoreString::default(),
                    branch: LoreString::default(),
                    date: 0,
                    length: 10,
                    only_branch: 0,
                },
                callback,
            ))
        }
    })
    .expect("The history operation should return a structured result");
    assert_eq!(
        history_result.status, 0,
        "Real revision history should be readable"
    );
    assert!(
        history_result.events.iter().any(|event| {
            event["tagName"] == "metadata"
                && matches!(
                    event["data"]["key"].as_str(),
                    Some("created-by" | "committed-by")
                )
                && event["data"]["value"]["data"] == "lore-client-test"
        }),
        "A later commit without an explicit identity should use repository configuration metadata",
    );

    /*
     * 直接调用生产组合函数，覆盖“精确切换来源 → 创建分支”的真实 Lore 路径。
     * 来源与恢复锚点相同，可以同时验证当前工作区入口不会依赖前端伪造状态。
     */
    let branch_result = run_branch_create_from(
        repository_path.to_string_lossy().into_owned(),
        "feature/from-revision".to_owned(),
        "main".to_owned(),
        source_revision.clone(),
        "main".to_owned(),
        source_revision.clone(),
    )
    .expect("Creating a branch from a revision should return a structured result");
    assert_eq!(
        branch_result.status, 0,
        "A branch should be created from a real revision"
    );
    assert!(
        ["sourceCheckout", "create"].iter().all(|phase| {
            branch_result.events.iter().any(|event| {
                event["tagName"] == "adapterOperationPhase" && event["data"]["phase"] == *phase
            })
        }),
        "The combined operation should preserve source checkout and creation stage events",
    );

    /*
     * 再用已存在名称触发创建失败，验证组合命令确实执行恢复阶段，
     * 而不是把工作区留在刚刚切换过去的来源 Branch。
     */
    let duplicate_result = run_branch_create_from(
        repository_path.to_string_lossy().into_owned(),
        "feature/from-revision".to_owned(),
        "main".to_owned(),
        source_revision.clone(),
        "feature/from-revision".to_owned(),
        source_revision.clone(),
    )
    .expect("Duplicate branch creation should also return a structured result");
    assert_ne!(
        duplicate_result.status, 0,
        "Lore must reject a duplicate branch name"
    );
    assert!(
        duplicate_result.events.iter().any(|event| {
            event["tagName"] == "adapterOperationPhase" && event["data"]["phase"] == "restore"
        }),
        "A creation failure after source checkout must run the recovery stage",
    );

    /*
     * 零字节文件没有内容哈希可用于“内容发生变化”的快捷判断，但它仍然是
     * 一个明确的新增路径。这里直接覆盖生产状态扫描，避免前端为了补空文件
     * 而自行遍历工作区并与 Lore 的选择性同步规则产生分歧。
     */
    std::fs::File::create(repository_path.join("empty.txt"))
        .expect("A new empty file should be created");
    let empty_file_status = run_operation("repository.status", {
        let globals = globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::repository::status(
                globals,
                LoreRepositoryStatusArgs {
                    staged: 1,
                    scan: 1,
                    check_dirty: 1,
                    reset: 0,
                    sync_point: 0,
                    revision_only: 0,
                    count: 1,
                    paths: LoreArray::default(),
                },
                callback,
            ))
        }
    })
    .expect("Empty-file status scanning should return a structured result");
    assert_eq!(
        empty_file_status.status, 0,
        "Empty-file status scanning should succeed"
    );
    assert!(
        empty_file_status.events.iter().any(|event| {
            event["tagName"] == "repositoryStatusFile"
                && event["data"]["path"] == "empty.txt"
                && event["data"]["action"] == "add"
        }),
        "The status event must preserve the newly added zero-byte file",
    );
    let committed_files =
        collect_revision_tree_files(repository_path.to_string_lossy().as_ref(), &source_revision)
            .expect("The committed file tree should be readable");
    assert!(
        committed_files.iter().any(|file| file.path == "hello.txt"),
        "The committed file must appear in the revision tree",
    );
    assert!(
        committed_files.iter().all(|file| file.path != "empty.txt"),
        "The uncommitted empty file must not appear in the revision tree",
    );

    let branch_list = run_operation("branch.list", move |callback| {
        lore::runtime().block_on(lore::branch::list(
            globals,
            LoreBranchListArgs { archived: 0 },
            callback,
        ))
    })
    .expect("Branch List should return a structured result");
    assert_eq!(
        branch_list.status, 0,
        "The created branch should be readable"
    );
    assert!(
            branch_list.events.iter().any(|event| {
                event["tagName"] == "branchListEntry"
                    && event["data"]["name"] == "feature/from-revision"
                    && event["data"]["isCurrent"] == true
            }),
            "Branch List should contain the new branch and remain attached after failed creation recovery",
        );
}

/// 测试结束时只删除本测试创建的唯一临时目录，避免污染用户工作区。
struct TemporaryRepository {
    path: PathBuf,
}

impl TemporaryRepository {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TemporaryRepository {
    fn drop(&mut self) {
        /*
         * Lore 会缓存已打开仓库的上下文；Windows 上直接删除仍被上下文持有的数据库
         * 文件会失败。测试夹具必须先释放上下文，再容忍句柄关闭存在极短延迟。
         * 非 Lore 临时目录或尚未完成初始化的目录无需释放，直接进入删除流程即可。
         */
        if self.path.join(".lore").exists() || self.path.join(".urc").exists() {
            let _ = release_repository_cache(&self.path);
        }

        for attempt in 0..3 {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) if attempt < 2 => std::thread::sleep(std::time::Duration::from_millis(25)),
                Err(_) => break,
            }
        }

        /*
         * 固定 Lore 版本在 Windows 测试进程退出前仍可能保留 Store 文件句柄。
         * 此时启动同一测试二进制中的最小清理工作进程；它不继承标准流，也不会阻塞
         * Cargo，在父测试进程释放最终句柄后只删除本夹具生成的精确路径。
         */
        #[cfg(windows)]
        if let Ok(current_executable) = std::env::current_exe() {
            let _ = std::process::Command::new(current_executable)
                .args([
                    "--exact",
                    "lore_adapter::tests::deferred_temporary_repository_cleanup_worker",
                    "--nocapture",
                ])
                .env("LORE_CLIENT_TEST_CLEANUP_PATH", &self.path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        }
    }
}

#[test]
fn deferred_temporary_repository_cleanup_worker() {
    let Some(path) = std::env::var_os("LORE_CLIENT_TEST_CLEANUP_PATH").map(PathBuf::from) else {
        return;
    };

    // 最长等待两分钟，覆盖完整 Rust 测试进程退出并释放 Lore 全局运行时的时间。
    for _ in 0..2_400 {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// 创建只包含 Lore 元数据目录的最小仓库，用于隔离配置读写单元测试。
fn create_configuration_test_repository(
    label: &str,
    configuration: &str,
) -> (PathBuf, TemporaryRepository) {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time should be later than the Unix epoch")
        .as_nanos();
    let repository_path = std::env::temp_dir().join(format!(
        "lore-client-{label}-{}-{unique}",
        std::process::id()
    ));
    let cleanup = TemporaryRepository::new(repository_path.clone());
    let metadata_path = repository_path.join(".lore");
    std::fs::create_dir_all(&metadata_path)
        .expect("The temporary Lore metadata directory should be created");
    std::fs::write(metadata_path.join("config.toml"), configuration)
        .expect("The temporary repository configuration should be written");
    (repository_path, cleanup)
}

#[test]
fn repository_view_rules_follow_lore_ordered_exclusion_and_reinclusion_semantics() {
    let parsed = parse_repository_view(
        "# Exclude everything, then materialize one asset subtree.\n**\n!Content/Textures/\n",
    );

    assert!(repository_view_is_valid(&parsed));
    assert_eq!(parsed.rule_count, 2);
    assert_eq!(parsed.exclusion_count, 1);
    assert_eq!(parsed.inclusion_count, 1);
    assert!(repository_view_excludes(&parsed, "Docs/Guide.md"));
    assert!(!repository_view_excludes(
        &parsed,
        "Content/Textures/Sky.tga"
    ));
}

#[test]
fn repository_view_rejects_expensive_double_star_inclusion() {
    let parsed = parse_repository_view("**\n!**/Textures/**\n");

    assert!(!repository_view_is_valid(&parsed));
    assert_eq!(
        parsed.diagnostics,
        vec![LoreViewDiagnostic {
            line: 2,
            severity: "error",
            code: "view_inclusion_starts_with_double_star",
        }]
    );
}

#[test]
fn repository_view_warns_when_inclusions_have_no_exclusion_to_override() {
    let parsed = parse_repository_view("!Content/Maps/\n");

    assert!(repository_view_is_valid(&parsed));
    assert_eq!(
        parsed.diagnostics,
        vec![LoreViewDiagnostic {
            line: 0,
            severity: "warning",
            code: "view_inclusion_without_exclusion",
        }]
    );
}

#[test]
fn repository_view_uses_the_metadata_directory_matching_the_repository_format() {
    let repository = tempfile::tempdir().expect("temporary repository should be created");
    fs::create_dir(repository.path().join(".lore"))
        .expect("current metadata directory should be created");
    fs::create_dir(repository.path().join(".urc"))
        .expect("legacy metadata directory should be created");
    fs::write(repository.path().join(".lore").join("view"), "Current/**\n")
        .expect("current view should be written");
    fs::write(repository.path().join(".urc").join("view"), "Legacy/**\n")
        .expect("legacy view should be written");

    let view = read_repository_view(repository.path()).expect("view should be read");

    assert_eq!(view.path, ".urc/view");
    assert_eq!(view.content, "Legacy/**\n");
}
