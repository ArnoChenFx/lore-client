//! Lore 事件捕获、流式摘要、冲突识别与操作结果封装。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 运行操作并捕获完整 LoreEvent 序列。
pub(super) fn run_operation(
    operation: &'static str,
    call: impl FnOnce(LoreEventCallback) -> i32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let operation_id = format!(
        "lore-operation-{}",
        OPERATION_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation,
        phase: "queued",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });
    let started_at = Instant::now();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation,
        phase: "running",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_target = Arc::clone(&events);
    let callback_operation_id = operation_id.clone();
    let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
        let serialized = serialize_lore_event(event);
        if let Some(summary) = operation_stream_summary(&serialized) {
            emit_operation_stream(LoreOperationStreamEvent {
                operation_id: callback_operation_id.clone(),
                operation,
                phase: "streaming",
                event: Some(summary),
                status: None,
                duration_ms: None,
                cancellable: false,
            });
        }
        if let Ok(mut target) = event_target.lock() {
            target.push(serialized);
        }
    }));

    let status = call(callback);
    /*
     * Lore 的 EventDispatcher 会先调用 End callback，再通知 `complete()` 的等待者，
     * 最后才随转发任务退出而析构 callback。因此同步 Lore 调用返回时，事件流已经
     * 完整结束，但 callback 捕获的 Arc 仍可能短暂存活。这里在 Mutex 下原子取走
     * 已完成事件，避免用 `Arc::try_unwrap` 把正常的异步析构窗口误判成 Diff 失败。
     */
    let events = {
        let mut target = events.lock().map_err(|_| {
            LoreCommandError::new(
                "event_collector_poisoned",
                "The Lore event collector state is poisoned",
            )
        })?;
        std::mem::take(&mut *target)
    };

    let duration_ms = started_at.elapsed().as_millis();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id,
        operation,
        phase: if status == 0 { "succeeded" } else { "failed" },
        event: None,
        status: Some(status),
        duration_ms: Some(duration_ms),
        cancellable: false,
    });

    Ok(LoreOperationResult {
        operation,
        status,
        duration_ms,
        events,
    })
}

pub(super) fn serialize_lore_event(event: &LoreEvent) -> Value {
    serde_json::to_value(event).unwrap_or_else(|error| {
        serde_json::json!({
            "tagName": "adapterSerializationError",
            "data": {
                "message": error.to_string()
            }
        })
    })
}

///
/// 操作中心只消费进度数字；完整 Diff、Tree Child 和内容地址已经包含在最终 IPC 结果
/// 中，不能再原样克隆并通过 Tauri Event 传输一次。这里只允许有限数字键，既保留
/// Clone/Push 等长操作的实时进度，也让单个流事件拥有稳定且很小的内存上限。
pub(super) fn operation_stream_summary(event: &Value) -> Option<Value> {
    const PROGRESS_KEYS: [&str; 6] = ["current", "processed", "total", "count", "bytes", "size"];
    const PROGRESS_SIGNALS: [&str; 5] = ["current", "processed", "total", "count", "bytes"];

    let tag_name = event["tagName"].as_str()?;
    let data = event["data"].as_object()?;
    if !PROGRESS_SIGNALS
        .iter()
        .any(|key| data.get(*key).is_some_and(Value::is_number))
    {
        return None;
    }

    let mut summary = serde_json::Map::new();
    for key in PROGRESS_KEYS {
        if let Some(value) = data.get(key).filter(|value| value.is_number()) {
            summary.insert(key.to_owned(), value.clone());
        }
    }
    Some(serde_json::json!({
        "tagName": tag_name,
        "data": summary
    }))
}

/// 从 Status 事件提取当前、staged 与 incoming Revision。
///
/// 返回 `None` 表示 Lore 没有发出 Revision 状态；调用者据此视为没有可恢复会话，
/// 而不是从文件事件或错误字符串猜测。
pub(super) fn conflict_revision_ids(events: &[Value]) -> Option<(String, String, Option<String>)> {
    let data = events
        .iter()
        .find(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusRevision")
        })?
        .get("data")?;
    let current = data.get("revision")?.as_str()?.to_owned();
    let staged = data.get("revisionStaged")?.as_str()?.to_owned();
    let incoming = data
        .get("revisionMerged")
        .and_then(Value::as_str)
        .filter(|value| !is_zero_hash(value))
        .map(str::to_owned);
    Some((current, staged, incoming))
}

/// 使用公开 Revision Info 事件判定 staged State 的冲突类型。
pub(super) fn classify_conflict_operation(
    events: &[Value],
    incoming_revision: Option<&str>,
) -> LoreConflictOperationKind {
    let metadata_keys = events
        .iter()
        .filter(|event| event.get("tagName").and_then(Value::as_str) == Some("metadata"))
        .filter_map(|event| event.pointer("/data/key").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    if metadata_keys.contains("cherry-picked-from") {
        return LoreConflictOperationKind::CherryPick;
    }
    if metadata_keys.contains("reverted-from") {
        return LoreConflictOperationKind::Revert;
    }

    let has_second_parent = events
        .iter()
        .find(|event| event.get("tagName").and_then(Value::as_str) == Some("revisionInfo"))
        .and_then(|event| event.pointer("/data/parent/1"))
        .and_then(Value::as_str)
        .is_some_and(|value| !is_zero_hash(value));
    if incoming_revision.is_some() || has_second_parent {
        LoreConflictOperationKind::Merge
    } else {
        LoreConflictOperationKind::Unknown
    }
}

pub(super) fn is_zero_hash(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte == b'0')
}
