use std::cmp::Reverse;
use std::collections::HashMap;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use glob_match::glob_match;
use lore::auth::{
    LoreAuthClearArgs, LoreAuthListArgs, LoreAuthLocalUserInfoArgs, LoreAuthLoginInteractiveArgs,
    LoreAuthLoginWithTokenArgs, LoreAuthLogoutArgs, LoreAuthUserInfoArgs,
};
use lore::branch::{
    LoreBranchArchiveArgs, LoreBranchCreateArgs, LoreBranchDiffArgs, LoreBranchInfoArgs,
    LoreBranchLatestListArgs, LoreBranchListArgs, LoreBranchMergeAbortArgs,
    LoreBranchMergeResolveArgs, LoreBranchMergeResolveMineArgs, LoreBranchMergeResolveTheirsArgs,
    LoreBranchMergeRestartArgs, LoreBranchMergeStartArgs, LoreBranchMergeUnresolveArgs,
    LoreBranchMetadataGetArgs, LoreBranchProtectArgs, LoreBranchPushArgs, LoreBranchResetArgs,
    LoreBranchSwitchArgs, LoreBranchUnprotectArgs,
};
use lore::dependency::{
    LoreFileDependencyAddArgs, LoreFileDependencyListArgs, LoreFileDependencyRemoveArgs,
};
use lore::file::{
    LoreFileDiffArgs, LoreFileHashArgs, LoreFileHistoryArgs, LoreFileMetadataListArgs,
    LoreFileResetArgs, LoreFileStageArgs, LoreFileStageMoveArgs, LoreFileUnstageArgs,
};
use lore::interface::{
    LoreArray, LoreEvent, LoreEventCallback, LoreGlobalArgs, LoreMetadataType, LoreString,
};
use lore::layer::{
    LoreLayerAddArgs, LoreLayerListArgs, LoreLayerListStagedArgs, LoreLayerRemoveArgs,
};
use lore::link::{LoreLinkAddArgs, LoreLinkListArgs, LoreLinkRemoveArgs, LoreLinkUpdateArgs};
use lore::lock::{
    LoreLockFileAcquireArgs, LoreLockFileQueryArgs, LoreLockFileReleaseArgs, LoreLockFileStatusArgs,
};
use lore::notification::{LoreNotificationSubscribeArgs, LoreNotificationUnsubscribeArgs};
use lore::repository::{
    LoreRepositoryCloneArgs, LoreRepositoryConfigGetArgs, LoreRepositoryCreateArgs,
    LoreRepositoryCreateMetadata, LoreRepositoryDumpArgs, LoreRepositoryGcArgs,
    LoreRepositoryInfoArgs, LoreRepositoryInstanceListArgs, LoreRepositoryInstancePruneArgs,
    LoreRepositoryListArgs, LoreRepositoryMetadataClearArgs, LoreRepositoryMetadataGetArgs,
    LoreRepositoryMetadataSetArgs, LoreRepositoryReleaseArgs, LoreRepositoryStatusArgs,
    LoreRepositoryUpdatePathArgs, LoreRepositoryVerifyFragmentArgs, LoreRepositoryVerifyStateArgs,
};
use lore::revision::{
    LoreRevisionAmendArgs, LoreRevisionBisectArgs, LoreRevisionCherryPickAbortArgs,
    LoreRevisionCherryPickArgs, LoreRevisionCherryPickResolveArgs,
    LoreRevisionCherryPickResolveMineArgs, LoreRevisionCherryPickResolveTheirsArgs,
    LoreRevisionCherryPickRestartArgs, LoreRevisionCherryPickUnresolveArgs, LoreRevisionCommitArgs,
    LoreRevisionFindArgs, LoreRevisionHistoryArgs, LoreRevisionInfoArgs,
    LoreRevisionMetadataListArgs, LoreRevisionRestoreArgs, LoreRevisionRevertAbortArgs,
    LoreRevisionRevertArgs, LoreRevisionRevertResolveArgs, LoreRevisionRevertResolveMineArgs,
    LoreRevisionRevertResolveTheirsArgs, LoreRevisionRevertRestartArgs,
    LoreRevisionRevertUnresolveArgs, LoreRevisionSyncArgs,
};
use lore::revision_tree::close::LoreRevisionTreeCloseArgs;
use lore::revision_tree::handle::LoreRevisionTree;
use lore::revision_tree::list_children::LoreRevisionTreeListChildrenArgs;
use lore::revision_tree::load::LoreRevisionTreeLoadArgs;
use lore::shared_store::{
    LoreSharedStoreCreateArgs, LoreSharedStoreInfoArgs, LoreSharedStoreSetUseAutomaticallyArgs,
};
use lore::storage::close::LoreStorageCloseArgs;
use lore::storage::get::{LoreStorageGetArgs, LoreStorageGetItem};
use lore::storage::handle::LoreStore;
use lore::storage::open::{LoreStorageOpenArgs, LoreStorageRemoteConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;

use crate::asset_preview::{
    binary_preview_format, binary_preview_limit_bytes, binary_preview_size_exceeded,
    ensure_binary_preview_size, prepare_file_preview_payload, prepare_large_asset_preview_payload,
    supports_large_embedded_thumbnail, StructuredAssetPreview, DEFAULT_BINARY_PREVIEW_LIMIT_MIB,
};
use crate::client_preferences::RepositoryAuthAccountBinding;

// Lore 适配层按领域拆分；根模块继续作为 `lib.rs` 和客户端偏好的稳定兼容门面。
pub(crate) mod auth;
pub(crate) mod branch;
pub(crate) mod composition;
mod configuration;
mod external_tools;
mod file_content;
pub(crate) mod history;
pub(crate) mod maintenance;
mod operation_support;
pub(crate) mod operations;
pub(crate) mod repository;
mod repository_lifecycle;
mod revision_storage;
mod runtime;
mod tags;
#[cfg(test)]
mod tests;
mod view;
pub(crate) mod workspace;

use file_content::{
    classify_file_content, FileContentClassification, FileContentClassificationSource,
    FileContentKind,
};

// 私有导入让兄弟模块可以通过父模块复用 `pub(super)` 支撑项，同时不扩大 crate API。
use branch::*;
use configuration::*;
use external_tools::*;
use history::*;
use operation_support::*;
use repository::*;
use repository_lifecycle::*;
use revision_storage::*;
use runtime::*;
use tags::*;
use view::*;

/// Tauri 启动后安装的应用句柄，只用于把 Lore 回调实时转发给 WebView。
static EVENT_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static OPERATION_STREAM_COUNTER: AtomicU64 = AtomicU64::new(1);
/// 完整树、Diff 与预览共享一个进程级异步读取门；等待许可时不得占用 blocking 线程。
static HEAVY_READ_LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
static WORKSPACE_DIFF_READ_LANE: HeavyReadLane = HeavyReadLane::new();
static REVISION_FILES_READ_LANE: HeavyReadLane = HeavyReadLane::new();
static FILE_PREVIEW_READ_LANE: HeavyReadLane = HeavyReadLane::new();
static WORKSPACE_TEXT_READ_LANE: HeavyReadLane = HeavyReadLane::new();
static REVISION_DIFF_READ_LANE: HeavyReadLane = HeavyReadLane::new();
static REVISION_CHANGES_READ_LANE: HeavyReadLane = HeavyReadLane::new();
/// 通知 Subscribe/Unsubscribe 共享异步门，避免标签切换把 blocking pool 填满。
static NOTIFICATION_LIFECYCLE_LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
/// 运行期只保留 Lore Token Store 的脱敏索引；真实 Token 从不进入客户端偏好或 IPC。
static AUTH_ACCOUNT_BINDINGS: OnceLock<Mutex<HashMap<String, BoundAuthAccount>>> = OnceLock::new();

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct BoundAuthAccount {
    auth_url: String,
    user_id: String,
}

/// 在 Tauri `setup` 阶段安装唯一事件出口。
pub fn install_event_emitter(app_handle: tauri::AppHandle) {
    let _ = EVENT_APP_HANDLE.set(app_handle);
}

fn auth_account_bindings() -> &'static Mutex<HashMap<String, BoundAuthAccount>> {
    AUTH_ACCOUNT_BINDINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/** 偏好加载或保存后同步完整绑定快照，避免 Rust 与 React 各自维护长期分叉状态。 */
pub(crate) fn sync_auth_account_bindings(
    bindings: &[RepositoryAuthAccountBinding],
) -> Result<(), LoreCommandError> {
    let mut next = HashMap::new();
    for binding in bindings {
        let repository_path = Path::new(binding.repository_path.trim());
        let canonical = std::fs::canonicalize(repository_path)
            .unwrap_or_else(|_| repository_path.to_path_buf());
        next.insert(
            repository_binding_key(&canonical),
            BoundAuthAccount {
                auth_url: binding.auth_url.trim().to_owned(),
                user_id: binding.user_id.trim().to_owned(),
            },
        );
    }
    *auth_account_bindings().lock().map_err(|_| {
        LoreCommandError::new(
            "auth_binding_lock_poisoned",
            "The authentication account binding store is unavailable",
        )
    })? = next;
    Ok(())
}

fn repository_binding_key(path: &Path) -> String {
    let value = display_path_without_windows_verbatim_prefix(path);
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn bound_auth_account(
    repository_path: &Path,
) -> Result<Option<BoundAuthAccount>, LoreCommandError> {
    Ok(auth_account_bindings()
        .lock()
        .map_err(|_| {
            LoreCommandError::new(
                "auth_binding_lock_poisoned",
                "The authentication account binding store is unavailable",
            )
        })?
        .get(&repository_binding_key(repository_path))
        .cloned())
}

fn bound_auth_identity(repository_path: &Path) -> Result<Option<String>, LoreCommandError> {
    Ok(bound_auth_account(repository_path)?.map(|binding| binding.user_id))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoreOperationStreamEvent {
    operation_id: String,
    operation: &'static str,
    phase: &'static str,
    event: Option<Value>,
    status: Option<i32>,
    duration_ms: Option<u128>,
    cancellable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoreRepositoryNotificationEvent {
    repository_path: String,
    event: Value,
}

fn emit_operation_stream(event: LoreOperationStreamEvent) {
    if let Some(app_handle) = EVENT_APP_HANDLE.get() {
        let _ = app_handle.emit("lore://operation-stream", event);
    }
}

fn emit_repository_notification(repository_path: &str, event: Value) {
    if let Some(app_handle) = EVENT_APP_HANDLE.get() {
        let _ = app_handle.emit(
            "lore://repository-notification",
            LoreRepositoryNotificationEvent {
                repository_path: repository_path.to_owned(),
                event,
            },
        );
    }
}

/// Lore Client 自定义标签在仓库共享元数据中的键前缀。
///
/// 每个标签使用独立键，修改某个标签时不会覆盖其他标签；版本号允许未来迁移格式，
/// 又不会误读同一仓库中其他工具写入的用户元数据。
const TAG_METADATA_PREFIX: &str = "lore-client.tag.v1/";

/// 构建脚本从 Cargo 锁文件中读取的 Lore 上游提交。
///
/// 这个值同时返回给前端和诊断页面，使错误报告能够准确对应上游源码，
/// 避免只记录一个仍可能变化的 nightly 版本字符串。锁文件缺少有效的 Lore
/// Git 提交时构建会提前失败，因此这里不会静默回退为未知值。
pub const LORE_SOURCE_REVISION: &str = env!("LORE_SOURCE_REVISION");

/// 前端启动时读取的原生运行时信息。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRuntimeInfo {
    pub application: &'static str,
    pub available: bool,
    pub integration_mode: &'static str,
    pub lore_core_status: &'static str,
    pub library_version: String,
    pub source_revision: &'static str,
}

/// 单次 Lore 操作的稳定返回结构。
///
/// `events` 完整保留上游事件流，React 数据层只依赖本结构和自己定义的 DTO。
/// 后续 Lore 升级即使调整了 Rust 类型，也只需要在这一适配文件内处理。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreOperationResult {
    pub operation: &'static str,
    pub status: i32,
    pub duration_ms: u128,
    pub events: Vec<Value>,
}

/// 冲突操作的稳定分类。
///
/// `Unknown` 只用于 Lore 报告冲突文件、但固定版本的 staged Revision 又没有可识别
/// 操作标记的损坏或未来格式场景。前端必须禁用写操作并提示刷新/诊断，不能猜测类型。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoreConflictOperationKind {
    Merge,
    CherryPick,
    Revert,
    Unknown,
}

/// 应用重启后可由真实 staged Revision 恢复的冲突会话。
///
/// `staged_revision` 是 Lore 当前冲突状态的不可变签名；Merge 还会尽量附带
/// `incoming_revision`。React 不接触 State flags 或元数据二进制格式。
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreConflictSession {
    pub kind: LoreConflictOperationKind,
    pub current_revision: String,
    pub staged_revision: String,
    pub incoming_revision: Option<String>,
}

/// Lore Client 对外提供的冲突动作集合。
///
/// 文件级动作统一要求非空仓库相对路径；只有 Abort 是仓库级动作并忽略 paths。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LoreConflictAction {
    Resolve,
    Mine,
    Theirs,
    Unresolve,
    Restart,
    Abort,
}

/// 可序列化的命令错误，确保前端能够按错误代码提供明确提示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreCommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<crate::asset_preview::AssetPreviewError> for LoreCommandError {
    fn from(error: crate::asset_preview::AssetPreviewError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

/// Clone 需要同时返回 Lore 原始事件与最终目标目录，避免前端自行拼接
/// Windows、macOS 和 Linux 上不同的路径分隔符。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreCloneResult {
    pub destination_path: String,
    pub result: LoreOperationResult,
}

/// 设备级 Shared Store 的稳定投影。
///
/// Lore `Info` 返回实际 Store 目录；Clone 的显式参数却要求其容器目录，因此两者
/// 同时返回，避免 React 猜测固定版本的磁盘布局。容量扫描跳过符号链接，既防止
/// 越界统计，也避免目录环。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreSharedStoreEntry {
    pub remote_url: String,
    pub path: String,
    pub container_path: String,
    pub exists: bool,
    pub size_bytes: u64,
    pub file_count: u64,
    pub scan_error: Option<String>,
}

/// Shared Store 管理页消费的设备级汇总。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreSharedStoreInfo {
    pub use_automatically: bool,
    pub stores: Vec<LoreSharedStoreEntry>,
    pub total_size_bytes: u64,
    /// 固定 Lore 版本没有可用于重建“未去重基线”的统计接口，必须明确为 false。
    pub exact_savings_available: bool,
}

/// 用户所选目录与实际 Lore 仓库根目录之间的稳定探测结果。
///
/// 选择仓库内的子目录时，`repository_path` 会返回祖先中的真实仓库根；只有整条
/// 祖先链都没有 `.lore` / `.urc` 时才标记为 `unmanaged`，避免在仓库内部误建
/// 嵌套仓库。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDirectoryProbe {
    pub kind: RepositoryDirectoryKind,
    pub selected_path: String,
    pub repository_path: Option<String>,
}

/// 目录探测只暴露前端需要的两个稳定状态。
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryDirectoryKind {
    Repository,
    Unmanaged,
}

/// 原地初始化返回规范化目录和完整 Lore 事件，前端无需重新拼接平台路径。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRepositoryInitializeResult {
    pub repository_path: String,
    pub result: LoreOperationResult,
}

/// 发布已有本地仓库时可能失败的明确阶段。
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoreRepositoryPublishFailureStage {
    RemoteCreate,
    Configuration,
    Push,
}

/// 把“远端创建 → 本地配置 → 当前分支 Push”拆成可审计的稳定结果。
///
/// 远端创建没有安全的隐式回滚语义，因此后续阶段失败时仍返回已经完成的状态；
/// 前端据此告诉用户下一步应重试保存配置还是重试 Push，不能伪装成全量失败。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRepositoryPublishResult {
    pub repository_url: String,
    pub remote_created: bool,
    pub remote_preexisting: bool,
    pub existing_remote_name: Option<String>,
    pub requested_remote_name: String,
    pub configuration_updated: bool,
    pub pushed: bool,
    pub create_result: LoreOperationResult,
    pub push_result: Option<LoreOperationResult>,
    pub failure_stage: Option<LoreRepositoryPublishFailureStage>,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
}

/// 指定 Revision 中单个已提交文件的稳定 DTO。
///
/// 只暴露界面构建目录树需要的仓库相对路径、字节大小和内容分类；内容地址、Node ID
/// 和 Store handle 都属于固定 Lore 版本的内部细节，不能跨越 IPC 边界。Revision 列表
/// 不批量物化正文，因此分类在真实 Diff 加载前明确保持 `unknown/deferred`。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRevisionFile {
    pub path: String,
    pub size: u64,
    pub content_classification: FileContentClassification,
}

/// 前端可直接渲染的受控二进制文件内容。
///
/// `kind` 与 `mime_type` 都由扩展名白名单产生，调用方不能通过 IPC 注入任意 MIME；
/// `data` 只在 Rust 内存中短暂存在，命令通过 Tauri Raw IPC 传输，禁止再次编码 Base64。
#[derive(Clone, Debug)]
pub struct LoreFilePreview {
    pub path: String,
    pub kind: &'static str,
    pub mime_type: &'static str,
    pub data: Vec<u8>,
    pub size: u64,
    /// 超限、不支持或调用方仅请求元数据时只返回大小；`data` 保持为空且不读取正文。
    pub content_state: LoreFilePreviewContentState,
    /// 归档目录与引擎资产元数据由 Rust 解析，React 不接触不可信二进制结构。
    pub structured_preview: Option<StructuredAssetPreview>,
}

/// Raw IPC 预览正文的可用状态；前端据此区分真实空文件与不同原因的安全省略内容。
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoreFilePreviewContentState {
    Available,
    TooLarge,
    Unsupported,
    MetadataOnly,
}

/** Raw IPC 二进制信封前部的轻量 JSON 元数据。 */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoreFilePreviewMetadata {
    path: String,
    kind: &'static str,
    mime_type: &'static str,
    size: u64,
    content_state: LoreFilePreviewContentState,
    structured_preview: Option<StructuredAssetPreview>,
}

/// Revision 相对第一父 Revision 的轻量文件变化。
///
/// 清单只携带 Revision Tree 中已经存在的元数据，不读取文件内容或生成 unified
/// patch。前端可先显示数百个文件，再为主要选择单独请求真实 Diff。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRevisionChange {
    pub path: String,
    /// Move 的精确来源路径；其他动作不返回猜测值。
    pub source_path: Option<String>,
    pub action: &'static str,
    pub size: u64,
    pub content_classification: FileContentClassification,
}

/// 外部 Diff 工具配置；参数按数组接收并直接交给 `Command::args`。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffTool {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub executable: String,
    pub arguments: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalToolAvailability {
    pub tool_id: String,
    pub resolved_executable: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMergeLabels {
    pub base: String,
    pub local: String,
    pub remote: String,
    pub merged: String,
}

/// 外部 Diff 单侧内容来源。
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalDiffSideKind {
    Empty,
    Workspace,
    Revision,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffSide {
    pub kind: ExternalDiffSideKind,
    pub path: String,
    pub revision: Option<String>,
    pub label: String,
}

/// 外部 Diff 进程成功创建后的稳定反馈。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffLaunchResult {
    pub tool_name: String,
    pub process_id: u32,
    pub temporary_file_count: u8,
}

/// Revision Tree 遍历期间保留的内部文件记录。
///
/// `address` 只用于 Rust 边界内比较不可变内容和读取历史内容；普通文件树与变更
/// 清单响应都会立即丢弃它，前端永远不会持有可跨仓库复用的内容地址。
#[derive(Clone, Debug)]
struct RevisionTreeFile {
    path: String,
    size: u64,
    address: String,
    repository: String,
}

/// 仓库配置中允许客户端读写的稳定字段。
///
/// 不把 Lore 的完整 RepositoryConfig 暴露给 IPC，避免客户端保存两个表单字段时
/// 意外覆盖固定版本之外新增的 Store、File 或共享缓存配置。
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryConfiguration {
    pub identity: Option<String>,
    pub remote_url: Option<String>,
}

/// 当前 Lore Instance 的本地选择性同步 View。
///
/// `path` 只暴露元数据目录内的相对展示路径，不把平台绝对路径或 Lore 内部
/// Filter 类型交给 React。诊断使用稳定代码，由前端按当前语言渲染。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRepositoryView {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub valid: bool,
    pub rule_count: usize,
    pub exclusion_count: usize,
    pub inclusion_count: usize,
    pub diagnostics: Vec<LoreViewDiagnostic>,
}

/// View 规则的稳定诊断信息。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreViewDiagnostic {
    pub line: usize,
    pub severity: &'static str,
    pub code: &'static str,
}

/// View 应用预览中的单个物化变化。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreViewImpactFile {
    pub path: String,
    pub size: u64,
    pub action: &'static str,
}

/// 基于不可变 Revision Tree 和当前磁盘物化状态计算的 View 影响。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRepositoryViewPreview {
    pub revision: String,
    pub valid: bool,
    pub rule_count: usize,
    pub exclusion_count: usize,
    pub inclusion_count: usize,
    pub diagnostics: Vec<LoreViewDiagnostic>,
    pub total_files: usize,
    pub included_files: usize,
    pub excluded_files: usize,
    pub materialize_files: usize,
    pub dematerialize_files: usize,
    pub unchanged_files: usize,
    pub included_bytes: u64,
    pub materialize_bytes: u64,
    pub dematerialize_bytes: u64,
    pub impact_files: Vec<LoreViewImpactFile>,
}

/// View 写入和 Lore Sync 的组合结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRepositoryViewApplyResult {
    pub preview: LoreRepositoryViewPreview,
    pub result: LoreOperationResult,
}

/// Rust 边界内部复现固定 Lore 版本的单条 Filter 规则。
#[derive(Clone, Debug, PartialEq)]
struct RepositoryViewRule {
    glob: String,
    negated: bool,
    directory: bool,
    generated: bool,
    filename: bool,
}

/// 解析后的 View 只在 Rust 内使用，避免绑定 Lore 内部 Filter ABI。
#[derive(Clone, Debug, Default, PartialEq)]
struct ParsedRepositoryView {
    rules: Vec<RepositoryViewRule>,
    rule_count: usize,
    exclusion_count: usize,
    inclusion_count: usize,
    diagnostics: Vec<LoreViewDiagnostic>,
}

/// Lore Client 对外暴露的稳定标签数据结构。
///
/// Lore 当前没有原生 Git 式标签 API，因此客户端把标签作为仓库共享元数据保存。
/// `id` 在改名时保持不变，用来识别“新键已写入、旧键尚未清理”的部分成功状态。
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreTag {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub revision: String,
    pub message: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 内部保留元数据键，供改名和删除时清理同一标签的遗留记录。
#[derive(Clone, Debug)]
struct LoreTagRecord {
    key: String,
    tag: LoreTag,
}

impl LoreCommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
