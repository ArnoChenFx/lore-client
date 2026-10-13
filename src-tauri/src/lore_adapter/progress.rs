//! Lore 进度事件归一化。
//!
//! 上游为不同操作发出形状各异的进度事件：暂存只有嵌套的变更计数，提交 / 克隆带字节与文件
//! 两套计数，同步的字段叫 `fileUpdate`，推送则分轮上传片段。这里把它们折算成一种小而稳定的
//! 快照（见 `Snapshot::to_value`），前端只认这一种形状。
//!
//! 设计要点：
//! - 按 `LoreEvent` 变体做类型匹配，不再用“字段名白名单”猜测；上游改名时编译即失败。
//! - 每个操作一个聚合器，累积状态（推送要跨多轮上传记账，暂存要自己数文件）。
//! - 同一操作 250 ms 内最多一条快照；状态突变（总量定稿、进入下一轮上传、结束）立即发出；
//!   不到 300 ms 就结束的操作不开启全局流。
//! - 只依赖 std、serde_json 与 `LoreEvent`，可以脱离 Tauri 单测。

use std::time::{Duration, Instant};

use lore::interface::LoreEvent;
use serde_json::{json, Map, Value};

/// 同一操作两条流式快照之间的最小间隔。
const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(250);
/// 低于该时长就结束的操作不会开启全局流，避免每次点击“暂存”都闪一下进度。
const OPEN_DELAY: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    Stage,
    Commit,
    Sync,
    Push,
    Clone,
}

impl Family {
    /// 流上使用的 tagName：沿用上游同族进度事件的名字，OperationCenter 的标签映射保持稳定。
    fn tag(self) -> &'static str {
        match self {
            Family::Stage => "fileStageProgress",
            Family::Commit => "revisionCommitProgress",
            Family::Sync => "revisionSyncProgress",
            Family::Push => "branchPushFragmentProgress",
            Family::Clone => "repositoryCloneProgress",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unit {
    Files,
    Bytes,
    Fragments,
}

impl Unit {
    fn as_str(self) -> &'static str {
        match self {
            Unit::Files => "files",
            Unit::Bytes => "bytes",
            Unit::Fragments => "fragments",
        }
    }
}

/// 与具体操作无关的进度快照。比较两个快照时不含 `elapsedMs`。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    family: Family,
    unit: Unit,
    current: u64,
    /// `None` 表示总量未知（暂存、推送准备阶段）。
    total: Option<u64>,
    /// 总量不会再增长；`false` 时即便有 total 也只能当作“至少”。
    total_final: bool,
    files: Option<u64>,
    files_total: Option<u64>,
    bytes: Option<u64>,
    bytes_total: Option<u64>,
    step_index: Option<u64>,
    step_count: Option<u64>,
}

impl Snapshot {
    fn to_value(&self, elapsed: Duration) -> Value {
        let mut data = Map::new();
        data.insert("unit".into(), json!(self.unit.as_str()));
        data.insert("current".into(), json!(self.current));
        if let Some(total) = self.total {
            data.insert("total".into(), json!(total));
        }
        data.insert("totalFinal".into(), json!(self.total_final));
        for (key, value) in [
            ("files", self.files),
            ("filesTotal", self.files_total),
            ("bytes", self.bytes),
            ("bytesTotal", self.bytes_total),
            ("stepIndex", self.step_index),
            ("stepCount", self.step_count),
        ] {
            if let Some(value) = value {
                data.insert(key.into(), json!(value));
            }
        }
        data.insert("elapsedMs".into(), json!(elapsed.as_millis() as u64));
        json!({ "tagName": self.family.tag(), "data": data })
    }
}

/// 一次 `run_operation` 调用对应一个聚合器。
pub(super) struct ProgressAggregator {
    started: Instant,
    min_interval: Duration,
    open_delay: Duration,
    /// 推送在“比对服务器已有数据”阶段完全无事件，必须在 `BranchPush` 时立即开流。
    force_open: bool,
    snapshot: Option<Snapshot>,
    last_sent: Option<(Instant, Snapshot)>,
    stage_files: u64,
    push: PushState,
}

/// 推送按“上传轮”记账：每个版本的片段上传是一轮 `FragmentBegin → Progress* → FragmentEnd`。
///
/// 轮数不能从别处推出来（依据固定版本上游的 `lore-revision/src/branch/push.rs`）：
/// `BranchPush.localHistory` 只数 `full_local_history`，主循环之前远端分歧的版本还会各多传一轮；
/// `BranchPushRevisionPushEnd` 只为属于当前分支的版本发送，来自其他分支的版本在它之前就
/// `continue` 了。所以以 `FragmentEnd` 的次数为准，`localHistory` 之和只作“已宣布的轮数”，
/// 实际轮数超过它时 `step_count` 随之上调。升级上游版本时需要重新核对这一点。
#[derive(Default)]
struct PushState {
    /// 各个 `BranchPush`（主分支、layer、link）宣布的版本数之和。
    rounds_total: u64,
    /// 已经结束的上传轮数。
    rounds_done: u64,
    /// 当前这一轮是否已经开始上传（Begin 之后、End 之前）。
    cycle_open: bool,
    /// 当前轮：(已登记, 需传输)。`None` 表示还在准备（收集片段、向远端询问缺哪些）。
    fragments: Option<(u64, u64)>,
    bytes_prior: u64,
    bytes_current: u64,
}

impl ProgressAggregator {
    pub(super) fn new(started: Instant) -> Self {
        Self {
            started,
            min_interval: MIN_EMIT_INTERVAL,
            open_delay: OPEN_DELAY,
            force_open: false,
            snapshot: None,
            last_sent: None,
            stage_files: 0,
            push: PushState::default(),
        }
    }

    /// 喂入一个上游事件，返回需要推送到全局流的 `{tagName, data}`（无需推送则为 `None`）。
    pub(super) fn observe(&mut self, event: &LoreEvent, now: Instant) -> Option<Value> {
        let force = self.apply(event)?;
        let snapshot = self.snapshot.clone()?;
        let elapsed = now.saturating_duration_since(self.started);
        if !self.force_open && elapsed < self.open_delay {
            return None;
        }
        if let Some((sent_at, last)) = &self.last_sent {
            if *last == snapshot {
                return None;
            }
            if !force && now.saturating_duration_since(*sent_at) < self.min_interval {
                return None;
            }
        }
        let value = snapshot.to_value(elapsed);
        self.last_sent = Some((now, snapshot));
        Some(value)
    }

    /// 更新内部状态；返回 `Some(force)` 表示事件与进度有关，`force` 表示必须绕过节流。
    fn apply(&mut self, event: &LoreEvent) -> Option<bool> {
        match event {
            // ---- 暂存：只有“已暂存的变更数”，没有总量 ----
            LoreEvent::FileStageBegin(_) => {
                self.stage_files = 0;
                self.set_stage(false);
                Some(false)
            }
            LoreEvent::FileStageFile(_) => {
                // 每个变更文件一条事件，自己数比等 500 ms 的 ticker 更及时。
                self.stage_files += 1;
                self.set_stage(false);
                Some(false)
            }
            LoreEvent::FileStageProgress(data) => {
                let count = &data.count;
                let files = count.file_add_count
                    + count.file_modify_count
                    + count.file_delete_count
                    + count.file_move_count;
                self.stage_files = self.stage_files.max(files);
                self.set_stage(false);
                Some(false)
            }
            LoreEvent::FileStageEnd(data) => {
                let count = &data.count;
                let files = count.file_add_count
                    + count.file_modify_count
                    + count.file_delete_count
                    + count.file_move_count;
                self.stage_files = self.stage_files.max(files);
                self.set_stage(true);
                Some(true)
            }

            // ---- 提交 / 克隆 / 同步：总量随发现过程增长，discoveryComplete 后定稿 ----
            LoreEvent::RevisionCommitProgress(data) => {
                let c = &data.count;
                Some(self.set_counted(
                    Family::Commit,
                    Counted {
                        files: c.file_count,
                        files_total: c.file_total,
                        bytes: c.bytes_transferred,
                        bytes_total: c.bytes_total,
                        discovery_complete: c.discovery_complete != 0,
                    },
                    false,
                ))
            }
            LoreEvent::RevisionCommitEnd(data) => {
                let c = &data.count;
                Some(self.set_counted(
                    Family::Commit,
                    Counted {
                        files: c.file_count,
                        files_total: c.file_total,
                        bytes: c.bytes_transferred,
                        bytes_total: c.bytes_total,
                        discovery_complete: true,
                    },
                    true,
                ))
            }
            LoreEvent::RepositoryCloneProgress(data) => {
                let c = &data.count;
                Some(self.set_counted(
                    Family::Clone,
                    Counted {
                        files: c.file_complete,
                        files_total: c.file_count,
                        bytes: c.bytes_transferred,
                        bytes_total: c.bytes_total,
                        discovery_complete: c.discovery_complete != 0,
                    },
                    false,
                ))
            }
            LoreEvent::RepositoryCloneEnd(data) => {
                let c = &data.count;
                Some(self.set_counted(
                    Family::Clone,
                    Counted {
                        files: c.file_complete,
                        files_total: c.file_count,
                        bytes: c.bytes_transferred,
                        bytes_total: c.bytes_total,
                        discovery_complete: true,
                    },
                    true,
                ))
            }
            LoreEvent::RevisionSyncProgress(data) => Some(self.set_counted(
                Family::Sync,
                Counted {
                    files: (data.file_update + data.file_delete) as u64,
                    files_total: (data.file_update_total + data.file_delete_total) as u64,
                    bytes: data.bytes_update,
                    bytes_total: data.bytes_update_total,
                    discovery_complete: data.discovery_complete != 0,
                },
                false,
            )),

            // ---- 推送：按上传轮记账；每轮 Begin → Progress* → End ----
            LoreEvent::BranchPush(data) => {
                if data.flag_already_pushed != 0 {
                    return None;
                }
                // 同一次操作里主分支、layer 与 link 会各发一次 BranchPush，总量逐次累加。
                self.push.rounds_total += data.local_history.max(1);
                self.force_open = true;
                self.set_push();
                Some(true)
            }
            LoreEvent::BranchPushFragmentBegin(data) => {
                self.push.cycle_open = true;
                self.push.fragments = Some((0, data.fragments));
                self.push.bytes_current = 0;
                self.set_push();
                Some(true)
            }
            LoreEvent::BranchPushFragmentProgress(data) => {
                // 注意：bytes_total 只是“目前已装载待传的字节数”，会随装载增长，不能当分母。
                self.push.cycle_open = true;
                self.push.fragments = Some((data.complete, data.count));
                self.push.bytes_current = data.bytes_transferred;
                self.set_push();
                Some(false)
            }
            LoreEvent::BranchPushFragmentEnd(data) => {
                let count = self
                    .push
                    .fragments
                    .map_or(data.fragments, |(_, count)| count);
                self.push.bytes_prior += data.bytes_transferred;
                self.push.bytes_current = 0;
                self.push.cycle_open = false;
                self.push.rounds_done += 1;
                // 还有下一轮要准备就回到“准备中”；已宣布的轮数都传完了就停在 100%，
                // 直到操作结束，或者又冒出一轮（总数随之上调）。
                self.push.fragments = (self.push.rounds_done >= self.push.rounds_total)
                    .then_some((data.fragments, count));
                self.set_push();
                Some(true)
            }
            // 只为属于当前分支的版本发送，不能用来数轮（见 `PushState`）。
            _ => None,
        }
    }

    fn set_stage(&mut self, done: bool) {
        self.snapshot = Some(Snapshot {
            family: Family::Stage,
            unit: Unit::Files,
            current: self.stage_files,
            total: done.then_some(self.stage_files),
            total_final: done,
            files: None,
            files_total: None,
            bytes: None,
            bytes_total: None,
            step_index: None,
            step_count: None,
        });
    }

    fn set_counted(&mut self, family: Family, mut counted: Counted, ended: bool) -> bool {
        if ended {
            // 结束事件意味着工作已经完成。上游的“已传输”可能因为本地已有数据而小于总量，
            // 不能让一个成功的操作在记录里停在 63%。
            counted.files = counted.files.max(counted.files_total);
            counted.bytes = counted.bytes.max(counted.bytes_total);
        }
        let was_final = self
            .snapshot
            .as_ref()
            .is_some_and(|s| s.family == family && s.total_final);
        let snapshot = if counted.discovery_complete && counted.bytes_total > 0 {
            // 字节比文件数更接近真实耗时：总量定稿后以字节为主指标，文件数作为补充。
            Snapshot {
                family,
                unit: Unit::Bytes,
                current: counted.bytes.min(counted.bytes_total),
                total: Some(counted.bytes_total),
                total_final: true,
                files: Some(counted.files),
                files_total: Some(counted.files_total),
                bytes: None,
                bytes_total: None,
                step_index: None,
                step_count: None,
            }
        } else {
            Snapshot {
                family,
                unit: Unit::Files,
                current: counted.files,
                total: (counted.files_total > 0).then_some(counted.files_total),
                total_final: counted.discovery_complete,
                files: None,
                files_total: None,
                bytes: (counted.bytes > 0).then_some(counted.bytes),
                bytes_total: None,
                step_index: None,
                step_count: None,
            }
        };
        let flipped = snapshot.total_final && !was_final;
        self.snapshot = Some(snapshot);
        ended || flipped
    }

    fn set_push(&mut self) {
        // 这一轮没有片段要传（对端已经都有）时按“准备中”显示，不出现 “0 / 0 个片段”。
        let (current, total) = match self.push.fragments {
            Some((complete, count)) if count > 0 => (complete, Some(count)),
            _ => (0, None),
        };
        let announced = self.push.rounds_total.max(1);
        let step_index = if self.push.cycle_open {
            self.push.rounds_done + 1
        } else {
            (self.push.rounds_done + 1).min(announced)
        };
        let bytes = self.push.bytes_prior + self.push.bytes_current;
        self.snapshot = Some(Snapshot {
            family: Family::Push,
            unit: Unit::Fragments,
            current,
            total,
            total_final: total.is_some(),
            files: None,
            files_total: None,
            bytes: (bytes > 0).then_some(bytes),
            bytes_total: None,
            step_index: Some(step_index),
            step_count: Some(announced.max(step_index)),
        });
    }
}

struct Counted {
    files: u64,
    files_total: u64,
    bytes: u64,
    bytes_total: u64,
    discovery_complete: bool,
}

/// 返回结果里是否值得保留该事件。
///
/// 逐文件事件（暂存、同步各一个文件一条）与进度 tick 只服务于实时显示，前端没有任何
/// 消费者；一万个文件就是 ~1 MB 的 JSON 先驻留内存、再经 IPC 复制一遍。
pub(super) fn retain_in_result(event: &LoreEvent) -> bool {
    !matches!(
        event,
        LoreEvent::FileStageFile(_)
            | LoreEvent::FileStageProgress(_)
            | LoreEvent::RevisionSyncFile(_)
            | LoreEvent::RevisionSyncProgress(_)
            | LoreEvent::RevisionCommitProgress(_)
            | LoreEvent::BranchPushFragmentProgress(_)
            | LoreEvent::RepositoryCloneProgress(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: &str) -> LoreEvent {
        serde_json::from_str(json).unwrap_or_else(|error| panic!("bad fixture {json}: {error}"))
    }

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    fn stage_file(path: &str) -> LoreEvent {
        event(&format!(
            r#"{{"tagName":"fileStageFile","data":{{"action":"add","fromPath":"","path":"{path}"}}}}"#
        ))
    }

    // 以下 JSON 均来自真实本地仓库的实测事件。
    const STAGE_BEGIN: &str = r#"{"data":{"pathCount":1},"tagName":"fileStageBegin"}"#;
    const STAGE_TICK: &str = r#"{"data":{"count":{"directoryAddCount":1,"directoryDeleteCount":0,"directoryModifyCount":0,"directoryMoveCount":0,"fileAddCount":3,"fileDeleteCount":0,"fileModifyCount":0,"fileMoveCount":0,"totalCount":4}},"tagName":"fileStageProgress"}"#;
    const STAGE_END: &str = r#"{"data":{"count":{"directoryAddCount":41,"directoryDeleteCount":0,"directoryModifyCount":0,"directoryMoveCount":0,"fileAddCount":4003,"fileDeleteCount":0,"fileModifyCount":0,"fileMoveCount":0,"totalCount":4044}},"tagName":"fileStageEnd"}"#;
    const COMMIT_DISCOVERING: &str = r#"{"data":{"count":{"bytesTotal":168701592,"bytesTransferred":0,"directoryCount":38,"directoryDeleteCount":0,"directoryTotal":38,"discoveryComplete":false,"fileCount":0,"fileDeleteCount":0,"fileModifyCount":0,"fileTotal":3906}},"tagName":"revisionCommitProgress"}"#;
    const COMMIT_RUNNING: &str = r#"{"data":{"count":{"bytesTotal":169144370,"bytesTransferred":46681,"directoryCount":41,"directoryDeleteCount":0,"directoryTotal":41,"discoveryComplete":true,"fileCount":11,"fileDeleteCount":0,"fileModifyCount":11,"fileTotal":4003}},"tagName":"revisionCommitProgress"}"#;
    const COMMIT_END: &str = r#"{"data":{"count":{"bytesTotal":169144370,"bytesTransferred":169144370,"directoryCount":41,"directoryDeleteCount":0,"directoryTotal":41,"discoveryComplete":true,"fileCount":4003,"fileDeleteCount":0,"fileModifyCount":4003,"fileTotal":4003}},"tagName":"revisionCommitEnd"}"#;
    const SYNC_DISCOVERING: &str = r#"{"data":{"bytesUpdate":0,"bytesUpdateTotal":0,"discoveryComplete":false,"fileAutomerge":0,"fileConflict":0,"fileDelete":12,"fileDeleteTotal":500,"fileUpdate":0,"fileUpdateTotal":0},"tagName":"revisionSyncProgress"}"#;
    const SYNC_RUNNING: &str = r#"{"data":{"bytesUpdate":2246789,"bytesUpdateTotal":52580830,"discoveryComplete":true,"fileAutomerge":0,"fileConflict":0,"fileDelete":500,"fileDeleteTotal":500,"fileUpdate":499,"fileUpdateTotal":501},"tagName":"revisionSyncProgress"}"#;

    // 合成推送序列用的构造函数，字段名取自上游 branch/push.rs；真实录制的推送与克隆事件见 REAL_*。
    fn push_start(local_history: u64, already: bool) -> LoreEvent {
        event(&format!(
            r#"{{"tagName":"branchPush","data":{{"remote":"quic://example","repository":"01a133b39ff976f2a32b7cb4d54202f8","branch":"e726318bbc3fd75ac8733a7e030cc35b","branchName":"main","remoteRevision":"{z}","localRevision":"{z}","remoteHistory":0,"localHistory":{local_history},"flagAlreadyPushed":{already},"flagDefault":true,"flagLink":false,"flagLayer":false}}}}"#,
            z = "0".repeat(64),
            already = if already { "true" } else { "false" }
        ))
    }
    fn push_begin(fragments: u64) -> LoreEvent {
        event(&format!(
            r#"{{"tagName":"branchPushFragmentBegin","data":{{"fragments":{fragments},"bytesTotal":0}}}}"#
        ))
    }
    fn push_tick(complete: u64, count: u64, transferred: u64, queued: u64) -> LoreEvent {
        event(&format!(
            r#"{{"tagName":"branchPushFragmentProgress","data":{{"complete":{complete},"count":{count},"bytesTransferred":{transferred},"bytesTotal":{queued}}}}}"#
        ))
    }
    fn push_end(fragments: u64, transferred: u64) -> LoreEvent {
        event(&format!(
            r#"{{"tagName":"branchPushFragmentEnd","data":{{"fragments":{fragments},"bytesTransferred":{transferred}}}}}"#
        ))
    }
    fn revision_done() -> LoreEvent {
        event(&format!(
            r#"{{"tagName":"branchPushRevisionPushEnd","data":{{"repository":"{id}","branch":"{id}","oldRemoteRevision":"{hash}","newRemoteRevision":"{hash}","newRemoteRevisionNumber":2,"message":"","fastForwardMerged":false}}}}"#,
            id = "0".repeat(32),
            hash = "0".repeat(64)
        ))
    }

    fn data(value: &Value) -> &Value {
        &value["data"]
    }

    #[test]
    fn real_fixtures_deserialize_as_typed_events() {
        for json in [
            STAGE_BEGIN,
            STAGE_TICK,
            STAGE_END,
            COMMIT_DISCOVERING,
            COMMIT_RUNNING,
            COMMIT_END,
            SYNC_DISCOVERING,
            SYNC_RUNNING,
        ] {
            event(json);
        }
    }

    #[test]
    fn stage_is_indeterminate_until_end_and_counts_files_itself() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        assert!(aggregator
            .observe(&event(STAGE_BEGIN), at(base, 1))
            .is_none());
        // 300 ms 之前只累积状态，不开流。
        for index in 0..200 {
            assert!(aggregator
                .observe(
                    &stage_file(&format!("a/{index}")),
                    at(base, 2 + index / 100)
                )
                .is_none());
        }
        let first = aggregator
            .observe(&stage_file("a/200"), at(base, 320))
            .expect("opens after the delay");
        assert_eq!(first["tagName"], "fileStageProgress");
        assert_eq!(data(&first)["unit"], "files");
        assert_eq!(data(&first)["current"], 201);
        assert!(data(&first).get("total").is_none(), "stage has no total");
        assert_eq!(data(&first)["totalFinal"], false);
        // 节流：250 ms 内的后续文件不再发出。
        assert!(aggregator
            .observe(&stage_file("a/201"), at(base, 400))
            .is_none());
        let later = aggregator
            .observe(&stage_file("a/202"), at(base, 600))
            .expect("after the interval");
        assert_eq!(data(&later)["current"], 203);
        // 结束事件立即定稿，且以上游 End 的总数为准。
        let end = aggregator
            .observe(&event(STAGE_END), at(base, 610))
            .expect("end bypasses throttle");
        assert_eq!(data(&end)["current"], 4003);
        assert_eq!(data(&end)["total"], 4003);
        assert_eq!(data(&end)["totalFinal"], true);
    }

    #[test]
    fn fast_operations_never_open_a_stream() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        for json in [STAGE_BEGIN, STAGE_TICK, STAGE_END] {
            assert!(aggregator.observe(&event(json), at(base, 40)).is_none());
        }
    }

    #[test]
    fn commit_switches_to_bytes_once_discovery_finishes() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let discovering = aggregator
            .observe(&event(COMMIT_DISCOVERING), at(base, 320))
            .unwrap();
        assert_eq!(data(&discovering)["unit"], "files");
        assert_eq!(data(&discovering)["total"], 3906);
        assert_eq!(
            data(&discovering)["totalFinal"],
            false,
            "totals still grow while discovering"
        );
        // 总量定稿是离散变化：即使距上次不足 250 ms 也立即发出。
        let running = aggregator
            .observe(&event(COMMIT_RUNNING), at(base, 330))
            .unwrap();
        assert_eq!(data(&running)["unit"], "bytes");
        assert_eq!(data(&running)["current"], 46681);
        assert_eq!(data(&running)["total"], 169144370);
        assert_eq!(data(&running)["totalFinal"], true);
        assert_eq!(data(&running)["files"], 11);
        assert_eq!(data(&running)["filesTotal"], 4003);
        let end = aggregator
            .observe(&event(COMMIT_END), at(base, 340))
            .unwrap();
        assert_eq!(data(&end)["current"], 169144370);
    }

    #[test]
    fn sync_sums_updates_and_deletes() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let discovering = aggregator
            .observe(&event(SYNC_DISCOVERING), at(base, 400))
            .unwrap();
        assert_eq!(data(&discovering)["current"], 12);
        assert_eq!(data(&discovering)["total"], 500);
        assert_eq!(data(&discovering)["totalFinal"], false);
        let running = aggregator
            .observe(&event(SYNC_RUNNING), at(base, 410))
            .unwrap();
        assert_eq!(data(&running)["unit"], "bytes");
        assert_eq!(data(&running)["total"], 52580830);
        assert_eq!(data(&running)["filesTotal"], 1001);
        assert_eq!(data(&running)["files"], 999);
    }

    #[test]
    fn push_is_indeterminate_while_preparing_then_counts_fragments_per_round() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        // 准备阶段没有任何事件：BranchPush 必须立刻开流（不等 300 ms）。
        let preparing = aggregator
            .observe(&push_start(2, false), at(base, 5))
            .expect("opens immediately");
        assert_eq!(preparing["tagName"], "branchPushFragmentProgress");
        assert_eq!(data(&preparing)["unit"], "fragments");
        assert!(data(&preparing).get("total").is_none());
        assert_eq!(data(&preparing)["stepIndex"], 1);
        assert_eq!(data(&preparing)["stepCount"], 2);

        let begun = aggregator
            .observe(&push_begin(1000), at(base, 3000))
            .unwrap();
        assert_eq!(data(&begun)["total"], 1000);
        assert_eq!(data(&begun)["totalFinal"], true);

        // bytesTotal（已装载字节）远大于已上传字节；快照不得把它当分母。
        let tick = aggregator
            .observe(
                &push_tick(250, 1000, 10_000_000, 900_000_000),
                at(base, 3300),
            )
            .unwrap();
        assert_eq!(data(&tick)["current"], 250);
        assert_eq!(data(&tick)["bytes"], 10_000_000);
        assert!(data(&tick).get("bytesTotal").is_none());

        // 第一轮传完：回到“准备中”，步骤前进到 2/2，字节累计不归零。
        let next = aggregator
            .observe(&push_end(1000, 40_000_000), at(base, 3400))
            .unwrap();
        assert_eq!(data(&next)["stepIndex"], 2);
        assert_eq!(data(&next)["stepCount"], 2);
        assert!(data(&next).get("total").is_none());
        assert_eq!(data(&next)["bytes"], 40_000_000);

        let second = aggregator.observe(&push_begin(10), at(base, 3500)).unwrap();
        assert_eq!(data(&second)["total"], 10);
        assert_eq!(data(&second)["stepIndex"], 2);
        let tick = aggregator
            .observe(&push_tick(4, 10, 1_000_000, 5_000_000), at(base, 3800))
            .unwrap();
        assert_eq!(data(&tick)["current"], 4);
        assert_eq!(data(&tick)["bytes"], 41_000_000);

        // 宣布的两轮都传完了：停在 100%，不再冒出第三轮。
        let done = aggregator
            .observe(&push_end(10, 1_500_000), at(base, 4100))
            .unwrap();
        assert_eq!(data(&done)["current"], 10);
        assert_eq!(data(&done)["total"], 10);
        assert_eq!(data(&done)["stepIndex"], 2);
        assert_eq!(data(&done)["stepCount"], 2);
    }

    #[test]
    fn push_counts_upload_rounds_not_branch_revision_events() {
        // 上游推送在主循环前会为远端分歧的版本多传几轮，来自其他分支的版本也各传一轮，
        // 而 BranchPushRevisionPushEnd 只为当前分支的版本发送。轮数必须数 FragmentEnd。
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        aggregator
            .observe(&push_start(1, false), at(base, 5))
            .expect("opens immediately");

        // 宣布 1 轮，实际传了 3 轮：步数总数随实际轮数上调，不会出现 “3/1”。
        for round in 1..=3u64 {
            let begun = aggregator
                .observe(&push_begin(100), at(base, 1000 * round))
                .unwrap();
            assert_eq!(data(&begun)["stepIndex"], round);
            assert_eq!(data(&begun)["stepCount"], round.max(1));
            aggregator.observe(&push_end(100, 1_000), at(base, 1000 * round + 500));
        }

        // RevisionPushEnd 不改变任何数字：它既不推进步骤，也不触发新快照。
        assert!(aggregator
            .observe(&revision_done(), at(base, 5000))
            .is_none());
    }

    #[test]
    fn push_round_with_nothing_to_upload_is_not_shown_as_zero_of_zero() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let preparing = aggregator
            .observe(&push_start(2, false), at(base, 5))
            .unwrap();
        assert!(data(&preparing).get("total").is_none());
        // 对端已经有这一轮的全部片段：界面仍是“准备中”，快照没有变化，所以不重发。
        assert!(aggregator.observe(&push_begin(0), at(base, 2000)).is_none());
        assert!(aggregator
            .observe(&push_tick(0, 0, 0, 0), at(base, 2300))
            .is_none());
        // 这一轮结束后进入下一轮的准备：只有步骤前进会发出新快照。
        let next = aggregator.observe(&push_end(0, 0), at(base, 2400)).unwrap();
        assert_eq!(data(&next)["stepIndex"], 2);
        assert!(data(&next).get("total").is_none());
    }

    #[test]
    fn already_pushed_branch_stays_silent() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        assert!(aggregator
            .observe(&push_start(0, true), at(base, 5))
            .is_none());
    }

    #[test]
    fn unrelated_events_are_ignored() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let metadata = event(
            r#"{"tagName":"metadata","data":{"key":"branch","value":{"data":"e726318bbc3fd75ac8733a7e030cc35b","tagName":"context"}}}"#,
        );
        assert!(aggregator.observe(&metadata, at(base, 1000)).is_none());
    }

    #[test]
    fn identical_snapshots_are_not_resent() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        assert!(aggregator
            .observe(&event(COMMIT_RUNNING), at(base, 400))
            .is_some());
        assert!(
            aggregator
                .observe(&event(COMMIT_RUNNING), at(base, 900))
                .is_none(),
            "a stalled operation sends nothing"
        );
    }

    #[test]
    fn bulk_events_are_not_kept_in_the_result() {
        assert!(!retain_in_result(&stage_file("a")));
        assert!(!retain_in_result(&event(STAGE_TICK)));
        assert!(retain_in_result(&event(STAGE_END)));
        assert!(retain_in_result(&event(COMMIT_END)));
        assert!(retain_in_result(&push_end(1, 1)));
    }

    fn clone_event(
        tag: &str,
        complete: u64,
        count: u64,
        transferred: u64,
        total: u64,
        done: bool,
    ) -> LoreEvent {
        let counts = format!(
            r#"{{"fileComplete":{complete},"fileRetain":0,"fileReplace":0,"fileCount":{count},"fileInflight":0,"fragmentInflight":0,"bytesTransferred":{transferred},"bytesTotal":{total},"discoveryComplete":{done}}}"#
        );
        if tag == "repositoryCloneEnd" {
            event(&format!(
                r#"{{"tagName":"{tag}","data":{{"branch":"main","revision":"{z}","count":{counts}}}}}"#,
                z = "0".repeat(64)
            ))
        } else {
            event(&format!(
                r#"{{"tagName":"{tag}","data":{{"count":{counts}}}}}"#
            ))
        }
    }

    #[test]
    fn clone_counts_files_while_discovering_then_bytes() {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let discovering = aggregator
            .observe(
                &clone_event("repositoryCloneProgress", 3, 40, 1_000, 9_000, false),
                at(base, 400),
            )
            .unwrap();
        assert_eq!(discovering["tagName"], "repositoryCloneProgress");
        assert_eq!(data(&discovering)["unit"], "files");
        assert_eq!(data(&discovering)["current"], 3);
        assert_eq!(data(&discovering)["total"], 40);
        assert_eq!(data(&discovering)["totalFinal"], false);
        assert_eq!(data(&discovering)["bytes"], 1_000);

        let running = aggregator
            .observe(
                &clone_event("repositoryCloneProgress", 10, 40, 4_500, 9_000, true),
                at(base, 410),
            )
            .unwrap();
        assert_eq!(data(&running)["unit"], "bytes");
        assert_eq!(data(&running)["current"], 4_500);
        assert_eq!(data(&running)["total"], 9_000);
        assert_eq!(data(&running)["files"], 10);
        assert_eq!(data(&running)["filesTotal"], 40);
    }

    #[test]
    fn ended_operations_report_completion_even_when_counters_lag() {
        // 克隆时本地已有的数据不会计入“已传输”，结束时字节数可以小于总量。
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let end = aggregator
            .observe(
                &clone_event("repositoryCloneEnd", 40, 40, 5_700, 9_000, true),
                at(base, 900),
            )
            .unwrap();
        assert_eq!(data(&end)["current"], 9_000);
        assert_eq!(data(&end)["total"], 9_000);
        assert_eq!(data(&end)["files"], 40);
        assert_eq!(data(&end)["totalFinal"], true);
    }

    #[test]
    fn a_busy_stage_emits_a_bounded_number_of_monotonic_snapshots() {
        // 十万个文件在 6 秒内到达：流上最多每 250 ms 一条，数字只增不减，结束时定稿。
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let file = stage_file("Content/Hero.png");
        aggregator.observe(&event(STAGE_BEGIN), at(base, 0));
        let mut emitted = Vec::new();
        for index in 0..100_000u64 {
            assert!(!retain_in_result(&file));
            if let Some(value) = aggregator.observe(&file, at(base, index * 6_000 / 100_000)) {
                emitted.push(value);
            }
        }
        let end = aggregator
            .observe(&event(STAGE_END), at(base, 6_000))
            .expect("end bypasses the throttle");

        assert!(
            (20..=26).contains(&emitted.len()),
            "{} snapshots",
            emitted.len()
        );
        let currents = emitted
            .iter()
            .map(|value| data(value)["current"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert!(currents.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(data(&end)["current"], 100_000);
        assert_eq!(data(&end)["total"], 100_000);
        assert_eq!(data(&end)["totalFinal"], true);
    }

    // 以下三段事件录自上游自带的 `loreserver`（本机回环、未开认证）：真实的推送、克隆与同步事件，
    // 字段、顺序和节奏都是实测的。每条前面的数字是相对操作开始的毫秒。
    // 推送两个版本：第一轮 3595 个片段，第二轮 269 个（节选，中间的 tick 已略去）。
    const REAL_TWO_ROUND_PUSH: &[(u64, &str)] = &[
        (
            23,
            r#"{"data":{"branch":"e726318bbc3fd75ac8733a7e030cc35b","branchName":"main","flagAlreadyPushed":false,"flagDefault":true,"flagLayer":false,"flagLink":false,"localHistory":2,"localRevision":"54a5a01ca1fcf7a96c0f74e284160c9834b809e67a805b03389ed5150eeddcba","remote":"lore://127.0.0.1:41337","remoteHistory":0,"remoteRevision":"eb08a7a5754e62db5eacca07ad2a546f75fdac4c11d0873752f061115da79e48","repository":"01a1344baf3377dc9bedfb65bd0911a4"},"tagName":"branchPush"}"#,
        ),
        (
            33,
            r#"{"data":{"bytesTotal":0,"fragments":3595},"tagName":"branchPushFragmentBegin"}"#,
        ),
        (
            34,
            r#"{"data":{"bytesTotal":412645,"bytesTransferred":0,"complete":0,"count":3595},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            133,
            r#"{"data":{"bytesTotal":168279676,"bytesTransferred":2124645,"complete":32,"count":3595},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            346,
            r#"{"data":{"bytesTotal":270978532,"bytesTransferred":69080678,"complete":944,"count":3595},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            933,
            r#"{"data":{"bytesTotal":270978532,"bytesTransferred":235066392,"complete":3142,"count":3595},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            1032,
            r#"{"data":{"bytesTotal":270978532,"bytesTransferred":270978532,"complete":3595,"count":3595},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            1032,
            r#"{"data":{"bytesTransferred":270978532,"fragments":3595},"tagName":"branchPushFragmentEnd"}"#,
        ),
        (
            1032,
            r#"{"data":{"branch":"e726318bbc3fd75ac8733a7e030cc35b","localRevision":"08de68f62342f4b4f009c3737ff203dc6a8ba729fded42440562533b2b05ab80","remoteRevision":"eb08a7a5754e62db5eacca07ad2a546f75fdac4c11d0873752f061115da79e48","repository":"01a1344baf3377dc9bedfb65bd0911a4"},"tagName":"branchPushRevisionPushBegin"}"#,
        ),
        (
            1046,
            r#"{"data":{"branch":"e726318bbc3fd75ac8733a7e030cc35b","fastForwardMerged":false,"message":"","newRemoteRevision":"08de68f62342f4b4f009c3737ff203dc6a8ba729fded42440562533b2b05ab80","newRemoteRevisionNumber":2,"oldRemoteRevision":"eb08a7a5754e62db5eacca07ad2a546f75fdac4c11d0873752f061115da79e48","repository":"01a1344baf3377dc9bedfb65bd0911a4"},"tagName":"branchPushRevisionPushEnd"}"#,
        ),
        (
            1050,
            r#"{"data":{"bytesTotal":0,"fragments":269},"tagName":"branchPushFragmentBegin"}"#,
        ),
        (
            1050,
            r#"{"data":{"bytesTotal":196040,"bytesTransferred":0,"complete":0,"count":269},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            1063,
            r#"{"data":{"bytesTotal":1333221,"bytesTransferred":1333221,"complete":269,"count":269},"tagName":"branchPushFragmentProgress"}"#,
        ),
        (
            1063,
            r#"{"data":{"bytesTransferred":1333221,"fragments":269},"tagName":"branchPushFragmentEnd"}"#,
        ),
    ];

    // 克隆 2752 个文件 / 524 MiB：两个 256 MiB 的大文件先到，其余的随后一起到（节选）。
    const REAL_CLONE: &[(u64, &str)] = &[
        (
            419,
            r#"{"data":{"branch":"main","path":"/work/clone","repository":"01a1344baf3377dc9bedfb65bd0911a4","revision":"54a5a01ca1fcf7a96c0f74e284160c9834b809e67a805b03389ed5150eeddcba"},"tagName":"repositoryCloneBegin"}"#,
        ),
        (
            420,
            r#"{"data":{"count":{"bytesTotal":0,"bytesTransferred":0,"discoveryComplete":false,"fileComplete":0,"fileCount":0,"fileInflight":0,"fileReplace":0,"fileRetain":0,"fragmentInflight":1}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            521,
            r#"{"data":{"count":{"bytesTotal":536870912,"bytesTransferred":0,"discoveryComplete":false,"fileComplete":0,"fileCount":2,"fileInflight":2,"fileReplace":0,"fileRetain":0,"fragmentInflight":6163}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            720,
            r#"{"data":{"count":{"bytesTotal":540143769,"bytesTransferred":0,"discoveryComplete":false,"fileComplete":0,"fileCount":702,"fileInflight":476,"fileReplace":0,"fileRetain":0,"fragmentInflight":6472}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            869,
            r#"{"data":{"count":{"bytesTotal":549396907,"bytesTransferred":0,"discoveryComplete":true,"fileComplete":0,"fileCount":2752,"fileInflight":476,"fileReplace":0,"fileRetain":0,"fragmentInflight":6164}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            2820,
            r#"{"data":{"count":{"bytesTotal":549396907,"bytesTransferred":268435456,"discoveryComplete":true,"fileComplete":1,"fileCount":2752,"fileInflight":2153,"fileReplace":0,"fileRetain":0,"fragmentInflight":654}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            2920,
            r#"{"data":{"count":{"bytesTotal":549396907,"bytesTransferred":268435456,"discoveryComplete":true,"fileComplete":1,"fileCount":2752,"fileInflight":2751,"fileReplace":0,"fileRetain":0,"fragmentInflight":163}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            3124,
            r#"{"data":{"count":{"bytesTotal":549396907,"bytesTransferred":268812508,"discoveryComplete":true,"fileComplete":87,"fileCount":2752,"fileInflight":2665,"fileReplace":0,"fileRetain":0,"fragmentInflight":173}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            3417,
            r#"{"data":{"count":{"bytesTotal":549396907,"bytesTransferred":549396907,"discoveryComplete":true,"fileComplete":2752,"fileCount":2752,"fileInflight":0,"fileReplace":0,"fileRetain":0,"fragmentInflight":0}},"tagName":"repositoryCloneProgress"}"#,
        ),
        (
            3449,
            r#"{"data":{"branch":"main","count":{"bytesTotal":549396907,"bytesTransferred":549396907,"discoveryComplete":true,"fileComplete":2752,"fileCount":2752,"fileInflight":0,"fileReplace":0,"fileRetain":0,"fragmentInflight":0},"revision":"54a5a01ca1fcf7a96c0f74e284160c9834b809e67a805b03389ed5150eeddcba"},"tagName":"repositoryCloneEnd"}"#,
        ),
    ];

    // 拉取两个版本（361 个文件 / 130 MB）：最后一个 128 MB 的大文件落盘前，上游重复同一个 tick（节选）。
    const REAL_SYNC_FROM_REMOTE: &[(u64, &str)] = &[
        (
            28,
            r#"{"data":{"bytesUpdate":0,"bytesUpdateTotal":1192804,"discoveryComplete":false,"fileAutomerge":0,"fileConflict":0,"fileDelete":0,"fileDeleteTotal":0,"fileUpdate":0,"fileUpdateTotal":257},"tagName":"revisionSyncProgress"}"#,
        ),
        (
            33,
            r#"{"data":{"bytesUpdate":12075,"bytesUpdateTotal":135893640,"discoveryComplete":true,"fileAutomerge":0,"fileConflict":0,"fileDelete":0,"fileDeleteTotal":0,"fileUpdate":2,"fileUpdateTotal":361},"tagName":"revisionSyncProgress"}"#,
        ),
        (
            141,
            r#"{"data":{"bytesUpdate":1675912,"bytesUpdateTotal":135893640,"discoveryComplete":true,"fileAutomerge":0,"fileConflict":0,"fileDelete":0,"fileDeleteTotal":0,"fileUpdate":360,"fileUpdateTotal":361},"tagName":"revisionSyncProgress"}"#,
        ),
        (
            326,
            r#"{"data":{"bytesUpdate":1675912,"bytesUpdateTotal":135893640,"discoveryComplete":true,"fileAutomerge":0,"fileConflict":0,"fileDelete":0,"fileDeleteTotal":0,"fileUpdate":360,"fileUpdateTotal":361},"tagName":"revisionSyncProgress"}"#,
        ),
        (
            768,
            r#"{"data":{"bytesUpdate":135893640,"bytesUpdateTotal":135893640,"discoveryComplete":true,"fileAutomerge":0,"fileConflict":0,"fileDelete":0,"fileDeleteTotal":0,"fileUpdate":361,"fileUpdateTotal":361},"tagName":"revisionSyncProgress"}"#,
        ),
    ];

    fn replay(events: &[(u64, &str)]) -> Vec<Value> {
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        events
            .iter()
            .filter_map(|(ms, json)| aggregator.observe(&event(json), at(base, *ms)))
            .collect()
    }

    #[test]
    fn real_two_round_push_reports_each_round_and_cumulative_bytes() {
        let snapshots = replay(REAL_TWO_ROUND_PUSH);
        let summary = snapshots
            .iter()
            .map(|snapshot| {
                let d = data(snapshot);
                (
                    d["current"].as_u64().unwrap(),
                    d["total"].as_u64(),
                    d["stepIndex"].as_u64().unwrap(),
                    d["bytes"].as_u64(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                // BranchPush：还在准备，没有总量。
                (0, None, 1, None),
                // 第一轮的片段总量定稿。
                (0, Some(3595), 1, None),
                // 之后每 250 ms 至多一条。
                (944, Some(3595), 1, Some(69_080_678)),
                (3142, Some(3595), 1, Some(235_066_392)),
                // 第一轮结束：字节累计，回到第二轮的准备。
                (0, None, 2, Some(270_978_532)),
                (0, Some(269), 2, Some(270_978_532)),
                // 宣布的两轮都传完：停在 100%。
                (269, Some(269), 2, Some(272_311_753)),
            ]
        );
        for snapshot in &snapshots {
            assert_wire_shape(snapshot);
            assert_eq!(data(snapshot)["stepCount"], 2);
        }
    }

    #[test]
    fn real_clone_switches_from_files_to_bytes_and_ends_on_the_last_tick() {
        let snapshots = replay(REAL_CLONE);
        let summary = snapshots
            .iter()
            .map(|snapshot| {
                let d = data(snapshot);
                (
                    d["unit"].as_str().unwrap(),
                    d["current"].as_u64().unwrap(),
                    d["total"].as_u64(),
                    d["totalFinal"].as_bool().unwrap(),
                    d["files"].as_u64(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                // 发现阶段：只有已完成的文件数，总量还在涨。
                ("files", 0, None, false, None),
                ("files", 0, Some(702), false, None),
                // 发现完成：总量定稿，改以字节为主指标。
                ("bytes", 0, Some(549_396_907), true, Some(0)),
                // 第一个 256 MiB 的大文件落盘前没有任何进度，之后才有。
                ("bytes", 268_435_456, Some(549_396_907), true, Some(1)),
                ("bytes", 268_812_508, Some(549_396_907), true, Some(87)),
                // 克隆结束事件与最后一个 tick 相同，不再重发。
                ("bytes", 549_396_907, Some(549_396_907), true, Some(2752)),
            ]
        );
        for snapshot in &snapshots {
            assert_wire_shape(snapshot);
        }
    }

    #[test]
    fn real_sync_from_a_remote_opens_late_and_ends_at_the_full_size() {
        // 前几个 tick 都在 300 ms 之前到达：只累积状态，不开流；开流之后每个快照都带着定稿的总量。
        let snapshots = replay(REAL_SYNC_FROM_REMOTE);
        let summary = snapshots
            .iter()
            .map(|snapshot| {
                let d = data(snapshot);
                (
                    d["current"].as_u64().unwrap(),
                    d["total"].as_u64(),
                    d["files"].as_u64(),
                    d["filesTotal"].as_u64(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                (1_675_912, Some(135_893_640), Some(360), Some(361)),
                (135_893_640, Some(135_893_640), Some(361), Some(361)),
            ]
        );
        for snapshot in &snapshots {
            assert_wire_shape(snapshot);
            assert_eq!(snapshot["tagName"], "revisionSyncProgress");
            assert_eq!(data(snapshot)["totalFinal"], true);
        }
    }

    #[test]
    fn a_commit_stuck_on_a_huge_file_stays_quiet_until_it_ends() {
        // 实测：提交两个 256 MiB 的文件时，上游约每 100 ms 重复同一个 tick 近一秒，随后一次跳到
        // 100%。重复的 tick 不能变成重复的快照，前端靠“长时间没有快照”判断卡住。
        let base = Instant::now();
        let mut aggregator = ProgressAggregator::new(base);
        let mut emitted = Vec::new();
        for index in 0..10u64 {
            emitted.extend(aggregator.observe(&event(COMMIT_RUNNING), at(base, 400 + 100 * index)));
        }
        let end = aggregator
            .observe(&event(COMMIT_END), at(base, 1_400))
            .expect("the end is a new snapshot");
        assert_eq!(emitted.len(), 1);
        assert_eq!(data(&end)["current"], data(&end)["total"]);
    }

    /// 前端 `OperationProgress`（src/types.ts）能解析的全部键。
    const WIRE_KEYS: [&str; 11] = [
        "unit",
        "current",
        "total",
        "totalFinal",
        "files",
        "filesTotal",
        "bytes",
        "bytesTotal",
        "stepIndex",
        "stepCount",
        "elapsedMs",
    ];

    fn assert_wire_shape(value: &Value) {
        assert!(
            matches!(
                value["tagName"].as_str(),
                Some(
                    "fileStageProgress"
                        | "revisionCommitProgress"
                        | "revisionSyncProgress"
                        | "branchPushFragmentProgress"
                        | "repositoryCloneProgress"
                )
            ),
            "unexpected tag in {value}"
        );
        let data = value["data"].as_object().expect("data object");
        for key in data.keys() {
            assert!(WIRE_KEYS.contains(&key.as_str()), "unexpected key {key}");
        }
        for key in ["unit", "current", "totalFinal", "elapsedMs"] {
            assert!(data.contains_key(key), "missing {key} in {value}");
        }
        assert!(matches!(
            data["unit"].as_str(),
            Some("files" | "bytes" | "fragments")
        ));
        for (key, number) in data {
            if key != "unit" && key != "totalFinal" {
                assert!(number.is_u64(), "{key} must be a non-negative integer");
            }
        }
    }

    #[test]
    fn every_snapshot_matches_the_shape_the_frontend_parses() {
        let base = Instant::now();
        let sequences: [Vec<LoreEvent>; 5] = [
            vec![event(STAGE_BEGIN), event(STAGE_TICK), event(STAGE_END)],
            vec![
                event(COMMIT_DISCOVERING),
                event(COMMIT_RUNNING),
                event(COMMIT_END),
            ],
            vec![event(SYNC_DISCOVERING), event(SYNC_RUNNING)],
            vec![
                push_start(2, false),
                push_begin(10),
                push_tick(4, 10, 1_000, 5_000),
                push_end(10, 2_000),
            ],
            vec![
                clone_event("repositoryCloneProgress", 3, 40, 1_000, 9_000, false),
                clone_event("repositoryCloneProgress", 10, 40, 4_500, 9_000, true),
                clone_event("repositoryCloneEnd", 40, 40, 9_000, 9_000, true),
            ],
        ];
        let mut checked = 0;
        for events in sequences {
            let mut aggregator = ProgressAggregator::new(base);
            for (index, event) in events.iter().enumerate() {
                let now = at(base, 400 + 300 * index as u64);
                if let Some(value) = aggregator.observe(event, now) {
                    assert_wire_shape(&value);
                    checked += 1;
                }
            }
        }
        assert!(checked >= 10, "only {checked} snapshots were produced");
    }
}
