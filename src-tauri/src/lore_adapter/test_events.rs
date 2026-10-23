//! Lore 事件测试夹具。
//!
//! Lore 0.11 起，事件与参数类型改用 bitcode 编解码，不再实现 serde
//! `Deserialize`，因此无法再把录制的 JSON 文本反序列化成 `LoreEvent`。
//! 这里改为直接构造类型化事件；字段值逐项抄自此前在真实本地仓库录制的
//! 事件（暂存 4003 个文件、推送两轮、克隆 2752 个文件等），保证聚合与
//! 流式逻辑面对的仍是与实测一致的形状和数值。

use lore_revision::branch::push::{
    LoreBranchPushEventData, LoreBranchPushFragmentBeginEventData,
    LoreBranchPushFragmentEndEventData, LoreBranchPushFragmentProgressEventData,
    LoreBranchPushRevisionPushBeginEventData, LoreBranchPushRevisionPushEndEventData,
};
use lore_revision::commit::{
    LoreRevisionCommitCountData, LoreRevisionCommitEndEventData,
    LoreRevisionCommitProgressEventData,
};
use lore_revision::event::{LoreEvent, LoreMetadataEventData};
use lore_revision::interface::{LoreFileAction, LoreMetadata};
use lore_revision::repository::clone::{
    LoreRepositoryCloneBeginEventData, LoreRepositoryCloneCountData,
    LoreRepositoryCloneEndEventData, LoreRepositoryCloneProgressEventData,
};
use lore_revision::revision::sync::LoreRevisionSyncProgressEventData;
use lore_revision::stage::{
    LoreFileStageBeginEventData, LoreFileStageCountData, LoreFileStageEndEventData,
    LoreFileStageFileEventData, LoreFileStageProgressEventData,
};

/// 录制事件里反复出现的分支 Context（32 位十六进制）。
const BRANCH_ID: &str = "e726318bbc3fd75ac8733a7e030cc35b";
/// 录制事件里反复出现的零哈希。
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn stage_count(directory_add: u64, file_add: u64, total: u64) -> LoreFileStageCountData {
    LoreFileStageCountData {
        directory_modify_count: 0,
        directory_add_count: directory_add,
        directory_delete_count: 0,
        directory_move_count: 0,
        file_modify_count: 0,
        file_add_count: file_add,
        file_delete_count: 0,
        file_move_count: 0,
        total_count: total,
    }
}

/// 暂存开始：请求 1 条路径。
pub fn stage_begin() -> LoreEvent {
    LoreEvent::FileStageBegin(LoreFileStageBeginEventData { path_count: 1 })
}

/// 暂存进度（实测）：目录新增 1、文件新增 3、合计 4。
pub fn stage_tick() -> LoreEvent {
    LoreEvent::FileStageProgress(LoreFileStageProgressEventData {
        count: stage_count(1, 3, 4),
    })
}

/// 暂存结束（实测）：目录新增 41、文件新增 4003、合计 4044。
pub fn stage_end() -> LoreEvent {
    LoreEvent::FileStageEnd(LoreFileStageEndEventData {
        count: stage_count(41, 4003, 4044),
    })
}

/// 单个暂存文件（动作恒为新增，源路径为空）。
pub fn stage_file(path: &str) -> LoreEvent {
    LoreEvent::FileStageFile(LoreFileStageFileEventData {
        from_path: "".into(),
        path: path.into(),
        action: LoreFileAction::Add,
    })
}

/// 只带文件新增数的暂存计数事件：`end` 为真时是结束事件，否则是进度事件。
pub fn stage_count_event(end: bool, added: u64) -> LoreEvent {
    let count = stage_count(0, added, added);
    if end {
        LoreEvent::FileStageEnd(LoreFileStageEndEventData { count })
    } else {
        LoreEvent::FileStageProgress(LoreFileStageProgressEventData { count })
    }
}

fn commit_count(
    bytes_total: u64,
    bytes_transferred: u64,
    directory_count: u64,
    directory_total: u64,
    file_count: u64,
    file_total: u64,
    file_modify_count: u64,
    discovery_complete: bool,
) -> LoreRevisionCommitCountData {
    LoreRevisionCommitCountData {
        directory_count,
        directory_total,
        file_count,
        file_total,
        directory_delete_count: 0,
        file_modify_count,
        file_delete_count: 0,
        bytes_transferred,
        bytes_total,
        discovery_complete: u8::from(discovery_complete),
    }
}

/// 提交发现阶段（实测）：总量未定稿，尚未传输。
pub fn commit_discovering() -> LoreEvent {
    LoreEvent::RevisionCommitProgress(LoreRevisionCommitProgressEventData {
        count: commit_count(168_701_592, 0, 38, 38, 0, 3906, 0, false),
    })
}

/// 提交进行中（实测）：发现完成，已传 46681 字节、11 个文件。
pub fn commit_running() -> LoreEvent {
    LoreEvent::RevisionCommitProgress(LoreRevisionCommitProgressEventData {
        count: commit_count(169_144_370, 46_681, 41, 41, 11, 4003, 11, true),
    })
}

/// 提交结束（实测）：字节与文件全部完成。
pub fn commit_end() -> LoreEvent {
    LoreEvent::RevisionCommitEnd(LoreRevisionCommitEndEventData {
        count: commit_count(169_144_370, 169_144_370, 41, 41, 4003, 4003, 4003, true),
    })
}

#[allow(clippy::too_many_arguments)]
fn sync_progress(
    file_update: usize,
    file_update_total: usize,
    file_delete: usize,
    file_delete_total: usize,
    bytes_update: u64,
    bytes_update_total: u64,
    discovery_complete: bool,
) -> LoreEvent {
    LoreEvent::RevisionSyncProgress(LoreRevisionSyncProgressEventData {
        file_update,
        file_update_total,
        file_delete,
        file_delete_total,
        file_automerge: 0,
        file_conflict: 0,
        bytes_update,
        bytes_update_total,
        discovery_complete: u8::from(discovery_complete),
    })
}

/// 同步发现阶段（实测）：待删 12 / 500，更新总量未定。
pub fn sync_discovering() -> LoreEvent {
    sync_progress(0, 0, 12, 500, 0, 0, false)
}

/// 同步进行中（实测）：删除完成，更新 499 / 501。
pub fn sync_running() -> LoreEvent {
    sync_progress(499, 501, 500, 500, 2_246_789, 52_580_830, true)
}

/// 推送开始（合成）：字段形状取自上游 branch/push.rs，哈希使用零值。
pub fn push_start(local_history: u64, already: bool) -> LoreEvent {
    LoreEvent::BranchPush(LoreBranchPushEventData {
        remote: "quic://example".into(),
        repository: "01a133b39ff976f2a32b7cb4d54202f8".parse().unwrap(),
        branch: BRANCH_ID.parse().unwrap(),
        branch_name: "main".into(),
        remote_revision: ZERO_HASH.parse().unwrap(),
        local_revision: ZERO_HASH.parse().unwrap(),
        remote_history: 0,
        local_history,
        flag_already_pushed: u8::from(already),
        flag_default: 1,
        flag_link: 0,
        flag_layer: 0,
    })
}

/// 片段传输开始。
pub fn push_begin(fragments: u64) -> LoreEvent {
    LoreEvent::BranchPushFragmentBegin(LoreBranchPushFragmentBeginEventData {
        fragments,
        bytes_total: 0,
    })
}

/// 片段传输进度；`bytes_total` 是当前已知的待传总量（会随发现增长）。
pub fn push_tick(complete: u64, count: u64, transferred: u64, bytes_total: u64) -> LoreEvent {
    LoreEvent::BranchPushFragmentProgress(LoreBranchPushFragmentProgressEventData {
        complete,
        count,
        bytes_transferred: transferred,
        bytes_total,
    })
}

/// 片段传输结束。
pub fn push_end(fragments: u64, transferred: u64) -> LoreEvent {
    LoreEvent::BranchPushFragmentEnd(LoreBranchPushFragmentEndEventData {
        fragments,
        bytes_transferred: transferred,
    })
}

/// 单个版本推送完成（合成零值版本）。
pub fn revision_done() -> LoreEvent {
    LoreEvent::BranchPushRevisionPushEnd(LoreBranchPushRevisionPushEndEventData {
        repository: "00000000000000000000000000000000".parse().unwrap(),
        branch: "00000000000000000000000000000000".parse().unwrap(),
        old_remote_revision: ZERO_HASH.parse().unwrap(),
        new_remote_revision: ZERO_HASH.parse().unwrap(),
        new_remote_revision_number: 2,
        message: "".into(),
        fast_forward_merged: 0,
    })
}

fn clone_count(
    file_complete: u64,
    file_count: u64,
    file_inflight: u64,
    fragment_inflight: u64,
    bytes_transferred: u64,
    bytes_total: u64,
    discovery_complete: bool,
) -> LoreRepositoryCloneCountData {
    LoreRepositoryCloneCountData {
        file_complete,
        file_retain: 0,
        file_replace: 0,
        file_count,
        file_inflight,
        fragment_inflight,
        bytes_transferred,
        bytes_total,
        discovery_complete: u8::from(discovery_complete),
    }
}

/// 克隆计数事件：`end` 为真时是结束事件（带分支与零哈希版本），否则是进度事件。
pub fn clone_event(
    end: bool,
    complete: u64,
    count: u64,
    transferred: u64,
    total: u64,
    done: bool,
) -> LoreEvent {
    let count = clone_count(complete, count, 0, 0, transferred, total, done);
    if end {
        LoreEvent::RepositoryCloneEnd(LoreRepositoryCloneEndEventData {
            branch: "main".into(),
            revision: ZERO_HASH.parse().unwrap(),
            count,
        })
    } else {
        LoreEvent::RepositoryCloneProgress(LoreRepositoryCloneProgressEventData { count })
    }
}

/// 与进度聚合无关的元数据事件：键 `branch`、值为录制的分支 Context。
pub fn metadata_context_event() -> LoreEvent {
    LoreEvent::Metadata(LoreMetadataEventData {
        key: "branch".into(),
        value: LoreMetadata::Context(BRANCH_ID.parse().unwrap()),
    })
}

/// 实测两轮推送序列（毫秒偏移, 事件）：第一轮 3595 个片段，第二轮 269 个。
pub fn real_two_round_push() -> Vec<(u64, LoreEvent)> {
    let repository = "01a1344baf3377dc9bedfb65bd0911a4";
    let remote_revision = "eb08a7a5754e62db5eacca07ad2a546f75fdac4c11d0873752f061115da79e48";
    let local_revision = "54a5a01ca1fcf7a96c0f74e284160c9834b809e67a805b03389ed5150eeddcba";
    let pushed_revision = "08de68f62342f4b4f009c3737ff203dc6a8ba729fded42440562533b2b05ab80";
    vec![
        (
            23,
            LoreEvent::BranchPush(LoreBranchPushEventData {
                remote: "lore://127.0.0.1:41337".into(),
                repository: repository.parse().unwrap(),
                branch: BRANCH_ID.parse().unwrap(),
                branch_name: "main".into(),
                remote_revision: remote_revision.parse().unwrap(),
                local_revision: local_revision.parse().unwrap(),
                remote_history: 0,
                local_history: 2,
                flag_already_pushed: 0,
                flag_default: 1,
                flag_link: 0,
                flag_layer: 0,
            }),
        ),
        (33, push_begin(3595)),
        (34, push_tick(0, 3595, 0, 412_645)),
        (133, push_tick(32, 3595, 2_124_645, 168_279_676)),
        (346, push_tick(944, 3595, 69_080_678, 270_978_532)),
        (933, push_tick(3142, 3595, 235_066_392, 270_978_532)),
        (1032, push_tick(3595, 3595, 270_978_532, 270_978_532)),
        (1032, push_end(3595, 270_978_532)),
        (
            1032,
            LoreEvent::BranchPushRevisionPushBegin(LoreBranchPushRevisionPushBeginEventData {
                repository: repository.parse().unwrap(),
                branch: BRANCH_ID.parse().unwrap(),
                remote_revision: remote_revision.parse().unwrap(),
                local_revision: pushed_revision.parse().unwrap(),
            }),
        ),
        (
            1046,
            LoreEvent::BranchPushRevisionPushEnd(LoreBranchPushRevisionPushEndEventData {
                repository: repository.parse().unwrap(),
                branch: BRANCH_ID.parse().unwrap(),
                old_remote_revision: remote_revision.parse().unwrap(),
                new_remote_revision: pushed_revision.parse().unwrap(),
                new_remote_revision_number: 2,
                message: "".into(),
                fast_forward_merged: 0,
            }),
        ),
        (1050, push_begin(269)),
        (1050, push_tick(0, 269, 0, 196_040)),
        (1063, push_tick(269, 269, 1_333_221, 1_333_221)),
        (1063, push_end(269, 1_333_221)),
    ]
}

/// 实测克隆序列（节选）：2752 个文件 / 524 MiB，两个 256 MiB 大文件先到。
pub fn real_clone() -> Vec<(u64, LoreEvent)> {
    let revision = "54a5a01ca1fcf7a96c0f74e284160c9834b809e67a805b03389ed5150eeddcba";
    let progress = |count: LoreRepositoryCloneCountData| {
        LoreEvent::RepositoryCloneProgress(LoreRepositoryCloneProgressEventData { count })
    };
    vec![
        (
            419,
            LoreEvent::RepositoryCloneBegin(LoreRepositoryCloneBeginEventData {
                repository: "01a1344baf3377dc9bedfb65bd0911a4".parse().unwrap(),
                branch: "main".into(),
                revision: revision.parse().unwrap(),
                path: "/work/clone".into(),
            }),
        ),
        (420, progress(clone_count(0, 0, 0, 1, 0, 0, false))),
        (
            521,
            progress(clone_count(0, 2, 2, 6163, 0, 536_870_912, false)),
        ),
        (
            720,
            progress(clone_count(0, 702, 476, 6472, 0, 540_143_769, false)),
        ),
        (
            869,
            progress(clone_count(0, 2752, 476, 6164, 0, 549_396_907, true)),
        ),
        (
            2820,
            progress(clone_count(
                1,
                2752,
                2153,
                654,
                268_435_456,
                549_396_907,
                true,
            )),
        ),
        (
            2920,
            progress(clone_count(
                1,
                2752,
                2751,
                163,
                268_435_456,
                549_396_907,
                true,
            )),
        ),
        (
            3124,
            progress(clone_count(
                87,
                2752,
                2665,
                173,
                268_812_508,
                549_396_907,
                true,
            )),
        ),
        (
            3417,
            progress(clone_count(
                2752,
                2752,
                0,
                0,
                549_396_907,
                549_396_907,
                true,
            )),
        ),
        (
            3449,
            LoreEvent::RepositoryCloneEnd(LoreRepositoryCloneEndEventData {
                branch: "main".into(),
                revision: revision.parse().unwrap(),
                count: clone_count(2752, 2752, 0, 0, 549_396_907, 549_396_907, true),
            }),
        ),
    ]
}

/// 实测远端同步序列（节选）：两个版本、361 个文件 / 130 MB；最后一个大文件
/// 落盘前，上游重复发送了同一个进度 tick（326 ms 与 141 ms 相同）。
pub fn real_sync_from_remote() -> Vec<(u64, LoreEvent)> {
    vec![
        (28, sync_progress(0, 257, 0, 0, 0, 1_192_804, false)),
        (33, sync_progress(2, 361, 0, 0, 12_075, 135_893_640, true)),
        (
            141,
            sync_progress(360, 361, 0, 0, 1_675_912, 135_893_640, true),
        ),
        (
            326,
            sync_progress(360, 361, 0, 0, 1_675_912, 135_893_640, true),
        ),
        (
            768,
            sync_progress(361, 361, 0, 0, 135_893_640, 135_893_640, true),
        ),
    ]
}

/// 完成事件，`message` 是错误详情里的消息文本（可为大载荷）。
pub fn complete_event_with_message(message: String) -> LoreEvent {
    LoreEvent::Complete(lore_revision::event::LoreCompleteEventData {
        status: 0,
        error: lore_revision::event::LoreErrorDetail {
            error_code: 0,
            message: message.into(),
            trace_locations: lore_revision::interface::LoreArray::default(),
        },
    })
}
