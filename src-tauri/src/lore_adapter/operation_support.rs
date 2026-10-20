//! Lore 事件捕获、流式摘要、冲突识别与操作结果封装。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::progress::{retain_in_result, ProgressAggregator};
use super::*;

/**
 * 延迟开启的全局操作流生命周期。
 *
 * 普通短读的完整结果已经由 IPC 返回，若仍为每次调用广播 queued/running/terminal，
 * 启动恢复会把大量无进度事件投递给页面 listener，并在 reload 后放大陈旧 callback。
 * 只有进度聚合器给出可显示的快照时才开启全局流；首次快照按顺序补齐 queued 与
 * running，后续保留 streaming，最终只为已开启的流发送 terminal。
 */
struct OperationStreamLifecycle {
    context: OperationContext,
    operation_id: String,
    operation: &'static str,
    opened: bool,
    completed: bool,
}

impl OperationStreamLifecycle {
    fn new(context: OperationContext, operation_id: String, operation: &'static str) -> Self {
        Self {
            context,
            operation_id,
            operation,
            opened: false,
            completed: false,
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
            request_id: self.context.request_id.clone(),
            workspace_key: self.context.workspace_key.clone(),
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
        if self.completed {
            return Vec::new();
        }
        let mut events = Vec::with_capacity(if self.opened { 1 } else { 3 });
        if !self.opened {
            self.opened = true;
            events.push(self.event("queued", None, None, None));
            events.push(self.event("running", None, None, None));
        }
        events.push(self.event("streaming", Some(summary), None, None));
        events
    }

    fn completion_event(
        &mut self,
        status: i32,
        duration_ms: u128,
    ) -> Option<LoreOperationStreamEvent> {
        if self.completed {
            return None;
        }
        self.completed = true;
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

/**
 * 把进度聚合器与全局流生命周期接在一起。
 *
 * 聚合器决定发什么、何时发，生命周期决定何时开流、何时收尾。事件回调只需要调用
 * `observe` 并转发返回的事件，因此这条链路可以脱离 Tauri 做单元测试。
 */
struct OperationProgressStream {
    aggregator: ProgressAggregator,
    lifecycle: OperationStreamLifecycle,
}

impl OperationProgressStream {
    fn new(
        context: OperationContext,
        operation_id: String,
        operation: &'static str,
        started_at: Instant,
    ) -> Self {
        Self {
            aggregator: ProgressAggregator::new(started_at),
            lifecycle: OperationStreamLifecycle::new(context, operation_id, operation),
        }
    }

    fn observe(&mut self, event: &LoreEvent, now: Instant) -> Vec<LoreOperationStreamEvent> {
        if self.lifecycle.completed {
            return Vec::new();
        }
        match self.aggregator.observe(event, now) {
            Some(snapshot) => self.lifecycle.progress_events(snapshot),
            None => Vec::new(),
        }
    }

    fn completion_event(
        &mut self,
        status: i32,
        duration_ms: u128,
    ) -> Option<LoreOperationStreamEvent> {
        self.lifecycle.completion_event(status, duration_ms)
    }
}

/// Also stop retained callbacks when the synchronous Lore call unwinds.
struct OperationStreamScope(Arc<Mutex<OperationProgressStream>>);

impl Drop for OperationStreamScope {
    fn drop(&mut self) {
        if let Ok(mut stream) = self.0.lock() {
            stream.lifecycle.completed = true;
        }
    }
}

/// 运行操作并捕获 LoreEvent 序列。
///
/// 暂存和同步的逐文件事件以及各类进度 tick 只服务于实时显示，由进度聚合器消化后不再
/// 进入返回结果：一万个文件就是约 1 MB 的 JSON，先驻留内存再经 IPC 复制一遍，前端
/// 没有任何地方消费它们。
pub(super) fn run_operation(
    operation: &'static str,
    call: impl FnOnce(LoreEventCallback) -> i32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let context = current_operation_context()?;
    let operation_id = format!(
        "lore-operation-{}",
        OPERATION_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let started_at = Instant::now();
    log::debug!(
        "Lore operation started requestId={:?} workspaceKey={:?} operationId={:?} operation={operation:?}",
        context.request_id,
        context.workspace_key,
        operation_id
    );
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let event_target = Arc::clone(&events);
    let progress_stream = Arc::new(Mutex::new(OperationProgressStream::new(
        context.clone(),
        operation_id.clone(),
        operation,
        started_at,
    )));
    let callback_progress_stream = Arc::clone(&progress_stream);
    let _stream_scope = OperationStreamScope(Arc::clone(&progress_stream));
    let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
        if let Ok(mut stream) = callback_progress_stream.lock() {
            if stream.lifecycle.completed {
                return;
            }
            for stream_event in stream.observe(event, Instant::now()) {
                emit_operation_stream(stream_event);
            }
        }
        if retain_in_result(event) {
            let serialized = serialize_lore_event(event);
            if let Ok(mut target) = event_target.lock() {
                target.push(serialized);
            }
        }
    }));

    let status = call(callback);
    let duration_ms = started_at.elapsed().as_millis();
    let terminal_event = progress_stream
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
    log::debug!(
        "Lore operation completed requestId={:?} workspaceKey={:?} operationId={:?} operation={operation:?} status={status} durationMs={duration_ms}",
        context.request_id,
        context.workspace_key,
        operation_id
    );
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

    /*
     * 凭据缺失/失效的失败会让无关命令（tag list、Revision Diff、分类采样…）
     * 各自报错而用户看不到任何恢复入口。这里在所有 Lore 命令的汇聚点统一检测
     * 认证失效证据并广播全局信号；前端据此探测服务器并打开重新认证弹窗。
     * 检测与错误转换解耦，emit 自带节流，不会放大重试风暴。
     */
    if status != 0 && operation_failure_indicates_unauthenticated(status, &events) {
        emit_remote_authentication_required(operation);
    }
    Ok(LoreOperationResult {
        request_id: context.request_id,
        workspace_key: context.workspace_key,
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
    fn terminal_stream_rejects_late_progress_and_duplicate_completion() {
        let context = test_operation_context();
        let mut lifecycle = OperationStreamLifecycle::new(
            context.clone(),
            "operation-terminal".into(),
            "file.stage",
        );
        let opened = lifecycle.progress_events(serde_json::json!({}));
        assert_eq!(opened.len(), 3);
        assert!(opened
            .iter()
            .all(|event| event.request_id == context.request_id
                && event.workspace_key == context.workspace_key));
        assert!(lifecycle.completion_event(0, 500).is_some());
        assert!(
            lifecycle.progress_events(serde_json::json!({})).is_empty(),
            "a terminal stream accepted late progress"
        );
        assert!(
            lifecycle.completion_event(0, 600).is_none(),
            "terminal was emitted twice"
        );
    }

    #[test]
    fn silent_completed_operation_cannot_open_a_late_stream() {
        let base = Instant::now();
        let mut stream = OperationProgressStream::new(
            test_operation_context(),
            "operation-completed".into(),
            "file.stage",
            base,
        );
        assert!(stream.completion_event(0, 10).is_none());
        assert!(stream
            .observe(&event(STAGE_END), base + Duration::from_secs(1))
            .is_empty());
    }

    #[test]
    fn operation_stream_stays_silent_without_progress() {
        let mut lifecycle = OperationStreamLifecycle::new(
            test_operation_context(),
            "operation-1".to_owned(),
            "repository.status",
        );

        assert!(lifecycle.completion_event(0, 8).is_none());
    }

    #[test]
    fn operation_stream_opens_in_order_on_the_first_progress_event() {
        let mut lifecycle = OperationStreamLifecycle::new(
            test_operation_context(),
            "operation-2".to_owned(),
            "repository.clone",
        );
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

    fn event(json: &str) -> LoreEvent {
        serde_json::from_str(json).unwrap_or_else(|error| panic!("bad fixture {json}: {error}"))
    }

    fn phases(events: &[LoreOperationStreamEvent]) -> Vec<&'static str> {
        events.iter().map(|event| event.phase).collect()
    }

    // 来自真实本地仓库暂存 4003 个文件时的事件。
    const STAGE_BEGIN: &str = r#"{"data":{"pathCount":1},"tagName":"fileStageBegin"}"#;
    const STAGE_TICK: &str = r#"{"data":{"count":{"directoryAddCount":1,"directoryDeleteCount":0,"directoryModifyCount":0,"directoryMoveCount":0,"fileAddCount":3,"fileDeleteCount":0,"fileModifyCount":0,"fileMoveCount":0,"totalCount":4}},"tagName":"fileStageProgress"}"#;
    const STAGE_END: &str = r#"{"data":{"count":{"directoryAddCount":41,"directoryDeleteCount":0,"directoryModifyCount":0,"directoryMoveCount":0,"fileAddCount":4003,"fileDeleteCount":0,"fileModifyCount":0,"fileMoveCount":0,"totalCount":4044}},"tagName":"fileStageEnd"}"#;

    #[test]
    fn short_operations_never_open_the_global_stream() {
        let base = Instant::now();
        let mut stream = OperationProgressStream::new(
            test_operation_context(),
            "operation-3".to_owned(),
            "file.stage",
            base,
        );

        for json in [STAGE_BEGIN, STAGE_TICK, STAGE_END] {
            assert!(stream
                .observe(&event(json), base + Duration::from_millis(40))
                .is_empty());
        }
        assert!(stream.completion_event(0, 40).is_none());
    }

    #[test]
    fn slow_operations_stream_normalized_snapshots_and_close_with_a_terminal_event() {
        let base = Instant::now();
        let mut stream = OperationProgressStream::new(
            test_operation_context(),
            "operation-4".to_owned(),
            "file.stage",
            base,
        );

        assert!(stream
            .observe(&event(STAGE_BEGIN), base + Duration::from_millis(1))
            .is_empty());
        let opened = stream.observe(&event(STAGE_TICK), base + Duration::from_millis(320));
        assert_eq!(phases(&opened), ["queued", "running", "streaming"]);
        assert_eq!(
            opened[2].event,
            Some(serde_json::json!({
                "tagName": "fileStageProgress",
                "data": { "unit": "files", "current": 3, "totalFinal": false, "elapsedMs": 320 }
            }))
        );

        // 结束事件是离散变化，不受 250 ms 节流限制；此时流已打开，只补一条 streaming。
        let finished = stream.observe(&event(STAGE_END), base + Duration::from_millis(330));
        assert_eq!(phases(&finished), ["streaming"]);
        let data = &finished[0].event.as_ref().expect("snapshot")["data"];
        assert_eq!(data["current"], 4003);
        assert_eq!(data["total"], 4003);
        assert_eq!(data["totalFinal"], true);

        let terminal = stream
            .completion_event(0, 340)
            .expect("An opened stream should emit its terminal phase");
        assert_eq!(terminal.phase, "succeeded");
        assert_eq!(terminal.operation_id, "operation-4");
    }

    #[test]
    fn payload_events_never_reach_the_stream() {
        // 流上只有聚合器构造的小快照；大载荷事件既不开流，也不会被复制进去。
        let base = Instant::now();
        let mut stream = OperationProgressStream::new(
            test_operation_context(),
            "operation-5".to_owned(),
            "file.diff",
            base,
        );
        let payload = "x".repeat(1024 * 1024);
        let large = event(&format!(
            r#"{{"tagName":"complete","data":{{"error":{{"errorCode":0,"message":"{payload}","traceLocations":[]}},"status":0}}}}"#
        ));

        assert!(stream
            .observe(&large, base + Duration::from_secs(5))
            .is_empty());
        assert!(stream.completion_event(0, 5_000).is_none());
    }
}
