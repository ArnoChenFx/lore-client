//! Lore 事件捕获、流式摘要、冲突识别与操作结果封装。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;

/**
 * 延迟开启的全局操作流生命周期。
 *
 * 普通短读的完整结果已经由 IPC 返回，若仍为每次调用广播 queued/running/terminal，
 * 启动恢复会把大量无进度事件投递给页面 listener，并在 reload 后放大陈旧 callback。
 * 只有 Lore 实际给出受限数值进度时才开启全局流；首次进度按顺序补齐 queued 与
 * running，后续保留 streaming，最终只为已开启的流发送 terminal。
 */
struct OperationStreamLifecycle {
    operation_id: String,
    operation: &'static str,
    opened: bool,
}

impl OperationStreamLifecycle {
    fn new(operation_id: String, operation: &'static str) -> Self {
        Self {
            operation_id,
            operation,
            opened: false,
        }
    }

    fn event(
        &self,
        phase: &'static str,
        event: Option<Value>,
        status: Option<i32>,
        duration_ms: Option<u128>,
    ) -> LoreOperationStreamEvent {
        LoreOperationStreamEvent {
            operation_id: self.operation_id.clone(),
            operation: self.operation,
            phase,
            event,
            status,
            duration_ms,
            cancellable: false,
        }
    }

    fn progress_events(&mut self, summary: Value) -> Vec<LoreOperationStreamEvent> {
        let mut events = Vec::with_capacity(if self.opened { 1 } else { 3 });
        if !self.opened {
            self.opened = true;
            events.push(self.event("queued", None, None, None));
            events.push(self.event("running", None, None, None));
        }
        events.push(self.event("streaming", Some(summary), None, None));
        events
    }

    fn completion_event(&self, status: i32, duration_ms: u128) -> Option<LoreOperationStreamEvent> {
        self.opened.then(|| {
            self.event(
                if status == 0 { "succeeded" } else { "failed" },
                None,
                Some(status),
                Some(duration_ms),
            )
        })
    }
}

/// 运行操作并捕获完整 LoreEvent 序列。
pub(super) fn run_operation(
    operation: &'static str,
    call: impl FnOnce(LoreEventCallback) -> i32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let operation_id = format!(
        "lore-operation-{}",
        OPERATION_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let started_at = Instant::now();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_target = Arc::clone(&events);
    let stream_lifecycle = Arc::new(Mutex::new(OperationStreamLifecycle::new(
        operation_id,
        operation,
    )));
    let callback_stream_lifecycle = Arc::clone(&stream_lifecycle);
    let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
        let serialized = serialize_lore_event(event);
        if let Some(summary) = operation_stream_summary(&serialized) {
            if let Ok(mut lifecycle) = callback_stream_lifecycle.lock() {
                for stream_event in lifecycle.progress_events(summary) {
                    emit_operation_stream(stream_event);
                }
            }
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
    /*
     * 凭据缺失/失效的失败会让无关命令（tag list、Revision Diff、分类采样…）
     * 各自报错而用户看不到任何恢复入口。这里在所有 Lore 命令的汇聚点统一检测
     * 认证失效证据并广播全局信号；前端据此探测服务器并打开重新认证弹窗。
     * 检测与错误转换解耦，emit 自带节流，不会放大重试风暴。
     */
    if status != 0 && operation_failure_indicates_unauthenticated(status, &events) {
        emit_remote_authentication_required(operation);
    }
    let terminal_event = stream_lifecycle
        .lock()
        .map_err(|_| {
            LoreCommandError::new(
                "operation_stream_state_poisoned",
                "The Lore operation stream state is poisoned",
            )
        })?
        .completion_event(status, duration_ms);
    if let Some(terminal_event) = terminal_event {
        emit_operation_stream(terminal_event);
    }

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
    /*
     * Lore 的进度变体稳定序列化为 `progress` 或 `*Progress`。Branch/List/Status 等业务
     * 结束事件也可能带 count、size，不能仅凭字段名把它们误判为实时进度，否则启动
     * 短读仍会重新开启全局流并向 reload 前的陈旧 callback 广播。
     */
    if tag_name != "progress" && !tag_name.ends_with("Progress") {
        return None;
    }
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

#[cfg(test)]
mod operation_stream_lifecycle_tests {
    use super::*;

    #[test]
    fn operation_stream_stays_silent_without_progress() {
        let lifecycle =
            OperationStreamLifecycle::new("operation-1".to_owned(), "repository.status");

        assert!(lifecycle.completion_event(0, 8).is_none());
    }

    #[test]
    fn operation_stream_opens_in_order_on_the_first_progress_event() {
        let mut lifecycle =
            OperationStreamLifecycle::new("operation-2".to_owned(), "repository.clone");
        let first = lifecycle.progress_events(serde_json::json!({
            "tagName": "progress",
            "data": { "current": 1, "total": 3 }
        }));
        let second = lifecycle.progress_events(serde_json::json!({
            "tagName": "progress",
            "data": { "current": 2, "total": 3 }
        }));
        let completed = lifecycle
            .completion_event(0, 42)
            .expect("An opened stream should emit its terminal phase");

        assert_eq!(
            first.iter().map(|event| event.phase).collect::<Vec<_>>(),
            ["queued", "running", "streaming"]
        );
        assert_eq!(
            second.iter().map(|event| event.phase).collect::<Vec<_>>(),
            ["streaming"]
        );
        assert_eq!(completed.phase, "succeeded");
        assert_eq!(completed.status, Some(0));
        assert_eq!(completed.duration_ms, Some(42));
    }
}
