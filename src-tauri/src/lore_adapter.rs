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

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
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
    LoreFileDiffArgs, LoreFileHistoryArgs, LoreFileMetadataListArgs, LoreFileResetArgs,
    LoreFileStageArgs, LoreFileUnstageArgs,
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
    binary_preview_format, build_structured_preview, ensure_binary_preview_size,
    prepare_preview_payload, StructuredAssetPreview,
};
use crate::client_preferences::RepositoryAuthAccountBinding;

/// Tauri 启动后安装的应用句柄，只用于把 Lore 回调实时转发给 WebView。
static EVENT_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static OPERATION_STREAM_COUNTER: AtomicU64 = AtomicU64::new(1);
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
#[derive(Clone, Debug, PartialEq, Serialize)]
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
/// 只暴露界面构建目录树需要的仓库相对路径与字节大小；内容地址、Node ID 和
/// Store handle 都属于固定 Lore 版本的内部细节，不能跨越 IPC 边界。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreRevisionFile {
    pub path: String,
    pub size: u64,
}

/// 前端可直接渲染的受控二进制文件内容。
///
/// `kind` 与 `mime_type` 都由扩展名白名单产生，调用方不能通过 IPC 注入任意 MIME；
/// `data_base64` 在 20 MB 原始字节上限内生成，避免一次预览挤占桌面进程大量内存。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreFilePreview {
    pub path: String,
    pub kind: &'static str,
    pub mime_type: &'static str,
    pub data_base64: String,
    pub size: u64,
    /// 归档目录与引擎资产元数据由 Rust 解析，React 不接触不可信二进制结构。
    pub structured_preview: Option<StructuredAssetPreview>,
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

/// 返回已嵌入应用的 Lore Core 信息，不需要探测外部 CLI 或动态库。
#[tauri::command]
pub fn lore_runtime_info() -> LoreRuntimeInfo {
    LoreRuntimeInfo {
        application: "Lore Client",
        available: true,
        integration_mode: "embedded-rust",
        lore_core_status: "ready",
        library_version: lore::LORE_LIBRARY_VERSION.to_string(),
        source_revision: LORE_SOURCE_REVISION,
    }
}

/// 列出脱敏后的本机账户缓存；固定关闭 `with_token`，原始 Token 永不跨 IPC 返回。
#[tauri::command]
pub async fn lore_auth_list() -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        run_operation("auth.list", move |callback| {
            lore::runtime().block_on(lore::auth::list(
                LoreGlobalArgs::default(),
                LoreAuthListArgs { with_token: 0 },
                callback,
            ))
        })
    })
    .await
}

/**
 * 从 Auth 服务签发并保存在 Lore Token Store 中的 JWT 解析账户显示名。
 *
 * 该命令固定关闭 `with_token`：Lore 只跨 IPC 返回 `AuthUserInfo` 中的用户 ID 与
 * 显示名，JWT 原文、首选用户名等完整 Token 信息始终留在 Rust/Lore 边界内。
 */
#[tauri::command]
pub async fn lore_auth_local_user_info(
    auth_url: String,
    user_ids: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let (auth_url, user_ids) = validate_auth_user_info_request(auth_url, user_ids)?;
    run_lore_task(move || {
        run_operation("auth.local-user-info", move |callback| {
            lore::runtime().block_on(lore::auth::local_user_info(
                LoreGlobalArgs::default(),
                LoreAuthLocalUserInfoArgs {
                    auth_endpoint: auth_url.into(),
                    user_ids: to_lore_array(user_ids),
                    // 账户页只需要显示名，任何 Token 内容都不得进入事件流或 IPC。
                    with_token: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/**
 * 使用仓库的远程上下文把历史 userId 批量解析为 Auth 用户名。
 *
 * 与 `lore_auth_local_user_info` 不同，该命令会使用仓库绑定账户执行
 * repository-scoped Token 交换，因此可查询其他提交者。上游只为真实
 * userId 返回 `AuthUserInfo`；自由文本 identity 和未解析 ID 会由前端保留
 * 原文，不在 Rust 边界猜测身份格式。
 */
#[tauri::command]
pub async fn lore_auth_user_info(
    repository_path: String,
    user_ids: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let user_ids = normalize_auth_user_ids(user_ids)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("auth.user-info", move |callback| {
            lore::runtime().block_on(lore::auth::resolve_user_info(
                globals,
                LoreAuthUserInfoArgs {
                    user_ids: to_lore_array(user_ids),
                },
                callback,
            ))
        })
    })
    .await
}

/**
 * 远端作者查询失败时，仅从当前仓库绑定账户的本地脱敏资料恢复显示名。
 *
 * 候选集合由前端历史批量传入，但 Rust 边界只允许查询绑定的 userId；这条命令
 * 固定关闭 Token 返回，既不能读取其他历史作者，也不会把 JWT 暴露给 WebView。
 */
#[tauri::command]
pub async fn lore_auth_repository_local_user_info(
    repository_path: String,
    user_ids: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let user_ids = normalize_auth_user_ids(user_ids)?;
    run_lore_task(move || {
        let repository_path = validate_repository_path(&repository_path)?;
        let binding = bound_auth_account(&repository_path)?.ok_or_else(|| {
            LoreCommandError::new(
                "auth_binding_missing",
                "The repository does not have a bound authentication account",
            )
        })?;
        if !user_ids
            .iter()
            .any(|candidate| candidate == &binding.user_id)
        {
            return Err(LoreCommandError::new(
                "auth_binding_identity_not_requested",
                "The bound authentication identity is not present in the revision history",
            ));
        }
        let (auth_url, bound_user_ids) =
            validate_auth_user_info_request(binding.auth_url, vec![binding.user_id])?;
        run_operation("auth.repository-local-user-info", move |callback| {
            lore::runtime().block_on(lore::auth::local_user_info(
                LoreGlobalArgs::default(),
                LoreAuthLocalUserInfoArgs {
                    auth_endpoint: auth_url.into(),
                    user_ids: to_lore_array(bound_user_ids),
                    // 本地缓存降级只需要显示名，Token 内容永远不能进入事件流。
                    with_token: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 启动 Lore 原生交互认证；浏览器打开与回调均由 Rust 上游持有。
#[tauri::command]
pub async fn lore_auth_login_interactive(
    remote_url: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let remote_url = validate_server_url(&remote_url)?;
    run_lore_task(move || {
        run_operation("auth.login-interactive", move |callback| {
            lore::runtime().block_on(lore::auth::login_interactive(
                LoreGlobalArgs::default(),
                LoreAuthLoginInteractiveArgs {
                    remote_url: remote_url.into(),
                    no_browser: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 使用一次性 Token 登录；Token 只在本命令栈与 Lore 凭据存储之间流转。
#[tauri::command]
pub async fn lore_auth_login_with_token(
    remote_url: String,
    token: String,
    token_type: String,
    auth_url: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let remote_url = validate_server_url(&remote_url)?;
    let token = token.trim().to_owned();
    if token.is_empty() || token.len() > 64 * 1024 || token.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "auth_token_invalid",
            "The authentication token is empty, oversized, or contains control characters",
        ));
    }
    let token_type = token_type.trim().to_owned();
    if token_type.is_empty() || token_type.len() > 64 || token_type.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "auth_token_type_invalid",
            "The authentication token type is invalid",
        ));
    }
    let auth_url = auth_url.unwrap_or_default().trim().to_owned();
    if auth_url.len() > 2_048 || auth_url.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "auth_url_invalid",
            "The authentication service URL is invalid",
        ));
    }
    run_lore_task(move || {
        run_operation("auth.login-with-token", move |callback| {
            lore::runtime().block_on(lore::auth::login_with_token(
                LoreGlobalArgs::default(),
                LoreAuthLoginWithTokenArgs {
                    remote_url: remote_url.into(),
                    token: token.into(),
                    token_type: token_type.into(),
                    auth_url: auth_url.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 删除一个用户在指定认证端点下的全部认证与授权 Token。
#[tauri::command]
pub async fn lore_auth_logout(
    auth_url: String,
    user_id: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let auth_url = auth_url.trim().to_owned();
    let user_id = user_id.trim().to_owned();
    if auth_url.is_empty()
        || user_id.is_empty()
        || auth_url.chars().any(char::is_control)
        || user_id.chars().any(char::is_control)
    {
        return Err(LoreCommandError::new(
            "auth_identity_invalid",
            "The authentication endpoint and user identity are required",
        ));
    }
    run_lore_task(move || {
        run_operation("auth.logout", move |callback| {
            lore::runtime().block_on(lore::auth::logout(
                LoreGlobalArgs::default(),
                LoreAuthLogoutArgs {
                    auth_url: auth_url.into(),
                    // 空 Resource 会删除该用户在端点下的认证与全部资源授权。
                    resource: LoreString::default(),
                    user_id: user_id.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 清空 Lore 凭据存储中的全部身份；只在全局危险确认后调用。
#[tauri::command]
pub async fn lore_auth_clear() -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        run_operation("auth.clear", move |callback| {
            lore::runtime().block_on(lore::auth::clear(
                LoreGlobalArgs::default(),
                LoreAuthClearArgs::default(),
                callback,
            ))
        })
    })
    .await
}

/// 立即切换单个本地仓库的认证账户；`None` 恢复 Lore 自动选择。
#[tauri::command]
pub async fn lore_auth_repository_binding_set(
    repository_path: String,
    user_id: Option<String>,
    auth_url: Option<String>,
) -> Result<(), LoreCommandError> {
    run_lore_task(move || {
        let repository_path = validate_repository_path(&repository_path)?;
        let user_id = user_id.map(|value| value.trim().to_owned());
        let auth_url = auth_url.map(|value| value.trim().to_owned());
        if user_id.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
        }) {
            return Err(LoreCommandError::new(
                "auth_identity_invalid",
                "The authentication user identity is invalid",
            ));
        }
        if auth_url.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 2_048 || value.chars().any(char::is_control)
        }) {
            return Err(LoreCommandError::new(
                "auth_url_invalid",
                "The authentication service URL is invalid",
            ));
        }
        let previous = {
            let mut bindings = auth_account_bindings().lock().map_err(|_| {
                LoreCommandError::new(
                    "auth_binding_lock_poisoned",
                    "The authentication account binding store is unavailable",
                )
            })?;
            let key = repository_binding_key(&repository_path);
            if let Some(user_id) = user_id {
                let mut next = bindings.get(&key).cloned().unwrap_or_default();
                next.user_id = user_id;
                if let Some(auth_url) = auth_url {
                    next.auth_url = auth_url;
                }
                bindings.insert(key, next)
            } else {
                bindings.remove(&key)
            }
        };
        /*
         * Repository Context 会短期保留解析后的远端身份。切换绑定后必须先释放，
         * 下一次读写才能用新身份重新建立连接。
         */
        if let Err(error) = release_repository_cache(&repository_path) {
            let mut bindings = auth_account_bindings().lock().map_err(|_| {
                LoreCommandError::new(
                    "auth_binding_lock_poisoned",
                    "The authentication account binding store is unavailable",
                )
            })?;
            let key = repository_binding_key(&repository_path);
            if let Some(previous) = previous {
                bindings.insert(key, previous);
            } else {
                bindings.remove(&key);
            }
            return Err(error);
        }
        Ok(())
    })
    .await
}

/// 探测普通目录、仓库根目录或仓库子目录，不打开 Lore Store。
#[tauri::command]
pub async fn lore_repository_probe(
    directory_path: String,
) -> Result<RepositoryDirectoryProbe, LoreCommandError> {
    run_lore_task(move || {
        let selected_path = validate_existing_directory(&directory_path, "Selected directory")?;
        Ok(probe_repository_directory(&selected_path))
    })
    .await
}

/// 在用户明确选择的普通目录中创建离线 Lore 仓库。
///
/// 目录允许包含普通文件，Lore 会在随后扫描时把它们显示为本地更改；任何祖先已经
/// 存在 Lore 元数据时都会拒绝初始化，防止误建嵌套仓库。客户端默认身份只用于
/// 仓库创建者元数据，不会自动写回新仓库的 `identity`。
#[tauri::command]
pub async fn lore_repository_initialize(
    directory_path: String,
    repository_name: String,
    description: String,
    repository_identity: String,
    default_identity: Option<String>,
) -> Result<LoreRepositoryInitializeResult, LoreCommandError> {
    run_lore_task(move || {
        initialize_repository(
            &directory_path,
            &repository_name,
            &description,
            &repository_identity,
            default_identity.as_deref(),
        )
    })
    .await
}

/// 在远端创建与本地仓库同 ID 的项目，保存服务器根地址并 Push 当前分支。
///
/// 固定 Lore 版本的在线 Create 总会同时创建一个本地仓库，因此适配层把这一本地
/// 副本放在受控临时目录；原仓库只接收白名单配置更新，绝不会被 Create 覆盖。
#[tauri::command]
pub async fn lore_repository_publish(
    repository_path: String,
    repository_name: String,
    description: String,
    identity: String,
    default_identity: Option<String>,
    server_url: String,
    branch: String,
    user_id: Option<String>,
    use_auth_account: Option<bool>,
) -> Result<LoreRepositoryPublishResult, LoreCommandError> {
    let user_id = validate_optional_auth_identity(user_id)?;
    run_lore_task(move || {
        publish_repository(
            &repository_path,
            &repository_name,
            &description,
            &identity,
            default_identity.as_deref(),
            &server_url,
            &branch,
            user_id.as_deref(),
            use_auth_account.unwrap_or(true),
        )
    })
    .await
}

/// 读取 Lore 服务器公开的仓库目录。
///
/// 列表操作不依赖本地工作区，也不会对服务器执行写入；前端可以用它先确认
/// 服务器可达，再决定打开哪个已经克隆到本地的仓库。
#[tauri::command]
pub async fn lore_repository_list(
    server_url: String,
    user_id: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let server_url = validate_server_url(&server_url)?;
    let user_id = user_id.map(|value| value.trim().to_owned());
    if user_id.as_ref().is_some_and(|value| {
        value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
    }) {
        return Err(LoreCommandError::new(
            "auth_identity_invalid",
            "The authentication user identity is invalid",
        ));
    }
    run_lore_task(move || {
        let globals = LoreGlobalArgs {
            identity: user_id.unwrap_or_default().into(),
            ..Default::default()
        };
        let result = run_operation("repository.list", move |callback| {
            lore::runtime().block_on(lore::repository::list(
                globals,
                LoreRepositoryListArgs {
                    url: server_url.into(),
                },
                callback,
            ))
        })?;
        if operation_requires_authentication(&result) {
            return Err(LoreCommandError::new(
                "auth_required",
                "The Lore server requires authentication",
            ));
        }
        Ok(result)
    })
    .await
}

/**
 * 固定 Lore 版本没有把 MissingToken 保留成结构化客户端错误，只在 Complete 事件中
 * 返回协议标准描述。服务器目录与远端 Create 共用这个边界，把它收敛为稳定
 * `auth_required`；Lore 升级暴露错误枚举后应删除这个兼容分支。
 */
fn operation_requires_authentication(result: &LoreOperationResult) -> bool {
    result.status != 0
        && result.events.iter().any(|event| {
            event
                .pointer("/data/error/message")
                .and_then(Value::as_str)
                .is_some_and(|message| {
                    message.contains("The request does not have valid authentication credentials")
                })
        })
}

/// 读取设备全局配置中的 Shared Store，并补充只读磁盘占用统计。
///
/// 该命令不依赖仓库，也不会打开 Store；容量扫描在 Tauri 阻塞任务中完成，避免
/// 阻塞主线程。固定版本未返回精确去重收益，因此只报告可验证的当前占用。
#[tauri::command]
pub async fn lore_shared_store_info() -> Result<LoreSharedStoreInfo, LoreCommandError> {
    run_lore_task(move || {
        let result = run_operation("shared_store.info", move |callback| {
            lore::runtime().block_on(lore::shared_store::info(
                LoreGlobalArgs::default(),
                LoreSharedStoreInfoArgs {},
                callback,
            ))
        })?;
        ensure_command_success(
            &result,
            "shared_store_info_failed",
            "Read Shared Store configuration",
        )?;
        parse_shared_store_info(&result.events)
    })
    .await
}

/// 创建并登记远端对应的设备级 Shared Store。
///
/// `parent_path` 是用户选择的既有父目录；Lore 会在其下创建按远端隔离的目录，
/// 本适配层从不传递 `force`，因此不会覆盖已有 Store。
#[tauri::command]
pub async fn lore_shared_store_create(
    remote_url: String,
    parent_path: Option<String>,
    make_default: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let remote_url = validate_server_url(&remote_url)?;
    let parent_path = match parent_path.filter(|path| !path.trim().is_empty()) {
        Some(path) => Some(display_path_without_windows_verbatim_prefix(
            &validate_existing_directory(&path, "Shared Store parent directory")?,
        )),
        None => None,
    };
    run_lore_task(move || {
        run_operation("shared_store.create", move |callback| {
            lore::runtime().block_on(lore::shared_store::create(
                LoreGlobalArgs::default(),
                LoreSharedStoreCreateArgs {
                    remote_url: remote_url.into(),
                    path: parent_path.unwrap_or_default().into(),
                    make_default: u8::from(make_default),
                },
                callback,
            ))
        })
    })
    .await
}

/// 切换新建仓库是否自动使用已登记的 Shared Store。
#[tauri::command]
pub async fn lore_shared_store_set_use_automatically(
    enabled: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        run_operation("shared_store.set_use_automatically", move |callback| {
            lore::runtime().block_on(lore::shared_store::set_use_automatically(
                LoreGlobalArgs::default(),
                LoreSharedStoreSetUseAutomaticallyArgs {
                    enabled: u8::from(enabled),
                },
                callback,
            ))
        })
    })
    .await
}

/// 查询指定 Branch 的协作锁，可按 Owner ID 或仓库相对路径筛选。
#[tauri::command]
pub async fn lore_lock_file_query(
    repository_path: String,
    branch: String,
    owner: Option<String>,
    path: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let owner = validate_optional_lock_filter(owner, "Lock owner")?;
    let path = match validate_optional_lock_filter(path, "Lock path")? {
        Some(path) => validate_repository_relative_path(&path)?
            .to_string_lossy()
            .replace('\\', "/"),
        None => String::new(),
    };
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("lock.file-query", move |callback| {
            lore::runtime().block_on(lore::lock::file_query(
                globals,
                LoreLockFileQueryArgs {
                    branch: branch.into(),
                    owner: owner.unwrap_or_default().into(),
                    path: path.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 只查询明确路径集合的协作锁状态，供本地更改行和右侧 Diff 按需刷新。
#[tauri::command]
pub async fn lore_lock_file_status(
    repository_path: String,
    branch: String,
    paths: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let paths = validate_repository_relative_paths(paths)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("lock.file-status", move |callback| {
            lore::runtime().block_on(lore::lock::file_status(
                globals,
                LoreLockFileStatusArgs {
                    paths: to_lore_array(paths),
                    branch: branch.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 为明确文件集合获取协作提示锁。
///
/// 固定 Lore 的锁不会阻止编辑或提交；命令名称和 DTO 保持中性，不向前端承诺
/// 强制独占。路径仍在 Rust 边界执行仓库相对校验。
#[tauri::command]
pub async fn lore_lock_file_acquire(
    repository_path: String,
    branch: String,
    paths: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let paths = validate_repository_relative_paths(paths)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("lock.file-acquire", move |callback| {
            lore::runtime().block_on(lore::lock::file_acquire(
                globals,
                LoreLockFileAcquireArgs {
                    paths: to_lore_array(paths),
                    branch: branch.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 释放当前凭据在指定 Branch 和路径上的协作锁。
///
/// Owner 留空让 Lore 使用当前已认证身份；客户端不会让 React 构造或持有 Owner ID。
#[tauri::command]
pub async fn lore_lock_file_release(
    repository_path: String,
    branch: String,
    paths: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let paths = validate_repository_relative_paths(paths)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("lock.file-release", move |callback| {
            lore::runtime().block_on(lore::lock::file_release(
                globals,
                LoreLockFileReleaseArgs {
                    paths: to_lore_array(paths),
                    branch: branch.into(),
                    owner: LoreString::default(),
                    owner_id: LoreString::default(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 为单个来源文件增加一条带标签的依赖边。
///
/// UI 每次提交一条边，Rust 再展开为固定 Lore 使用的并行数组。默认保留循环检测；
/// `force` 只在用户明确确认后传入，不能作为隐藏默认值。
#[tauri::command]
pub async fn lore_file_dependency_add(
    repository_path: String,
    source_path: String,
    dependency_path: String,
    tags: Vec<String>,
    force: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let source_path = validate_repository_relative_paths(vec![source_path])?;
    let dependency_path = validate_repository_relative_paths(vec![dependency_path])?;
    let tags = validate_dependency_tags(tags)?;
    let tag_count = u32::try_from(tags.len()).map_err(|_| {
        LoreCommandError::new(
            "too_many_dependency_tags",
            "The dependency contains too many tags",
        )
    })?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("file.dependency-add", move |callback| {
            lore::runtime().block_on(lore::dependency::dependency_add(
                globals,
                LoreFileDependencyAddArgs {
                    paths: to_lore_array(source_path),
                    dependencies: to_lore_array(dependency_path),
                    tags: to_lore_array(tags),
                    dep_counts: LoreArray::from_vec(vec![1]),
                    tag_counts: LoreArray::from_vec(vec![tag_count]),
                    force: u8::from(force),
                },
                callback,
            ))
        })
    })
    .await
}

/// 从来源文件移除一条依赖边；标签为空表示移除该目标的全部标签关系。
#[tauri::command]
pub async fn lore_file_dependency_remove(
    repository_path: String,
    source_path: String,
    dependency_path: String,
    tags: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let source_path = validate_repository_relative_paths(vec![source_path])?;
    let dependency_path = validate_repository_relative_paths(vec![dependency_path])?;
    let tags = validate_dependency_tags(tags)?;
    let tag_count = u32::try_from(tags.len()).map_err(|_| {
        LoreCommandError::new(
            "too_many_dependency_tags",
            "The dependency contains too many tags",
        )
    })?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("file.dependency-remove", move |callback| {
            lore::runtime().block_on(lore::dependency::dependency_remove(
                globals,
                LoreFileDependencyRemoveArgs {
                    paths: to_lore_array(source_path),
                    dependencies: to_lore_array(dependency_path),
                    tags: to_lore_array(tags),
                    dep_counts: LoreArray::from_vec(vec![1]),
                    tag_counts: LoreArray::from_vec(vec![tag_count]),
                },
                callback,
            ))
        })
    })
    .await
}

/// 在精确 Revision（空值表示当前 Revision）查询依赖或反向依赖。
#[tauri::command]
pub async fn lore_file_dependency_list(
    repository_path: String,
    paths: Vec<String>,
    revision: Option<String>,
    recursive: bool,
    reverse: bool,
    tags: Vec<String>,
    depth_limit: u32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let paths = validate_repository_relative_paths(paths)?;
    let revision = revision
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_revision(&value))
        .transpose()?;
    let tags = validate_dependency_tags(tags)?;
    if depth_limit > 1_024 {
        return Err(LoreCommandError::new(
            "dependency_depth_limit_too_large",
            "Dependency depth limit must not exceed 1024",
        ));
    }
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("file.dependency-list", move |callback| {
            lore::runtime().block_on(lore::dependency::dependency_list(
                globals,
                LoreFileDependencyListArgs {
                    paths: to_lore_array(paths),
                    revision: revision.unwrap_or_default().into(),
                    recursive: u8::from(recursive),
                    reverse: u8::from(reverse),
                    tags: to_lore_array(tags),
                    depth_limit,
                },
                callback,
            ))
        })
    })
    .await
}

/// 订阅远端 Branch、Revision 与文件锁通知。
///
/// 固定 Lore 会在 Subscribe 返回后继续持有回调，因此该命令不能复用会等待回调
/// 释放的 `run_operation` 收集器。回调只向 WebView 发送序列化事件，不持有仓库
/// 内容、凭据或 React 状态。
#[tauri::command]
pub async fn lore_notification_subscribe(repository_path: String) -> Result<i32, LoreCommandError> {
    let normalized_path =
        display_path_without_windows_verbatim_prefix(&validate_repository_path(&repository_path)?);
    run_lore_task(move || {
        let globals = global_args(&normalized_path)?;
        let callback_path = normalized_path.clone();
        let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
            emit_repository_notification(&callback_path, serialize_lore_event(event));
        }));
        Ok(lore::runtime().block_on(lore::notification::subscribe(
            globals,
            LoreNotificationSubscribeArgs {},
            callback,
        )))
    })
    .await
}

/// 真实取消当前仓库的通知订阅；固定 Lore 没有通用长操作取消 API。
#[tauri::command]
pub async fn lore_notification_unsubscribe(
    repository_path: String,
) -> Result<i32, LoreCommandError> {
    let repository_path =
        display_path_without_windows_verbatim_prefix(&validate_repository_path(&repository_path)?);
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let callback: LoreEventCallback = Some(Box::new(|_event: &LoreEvent| {}));
        Ok(lore::runtime().block_on(lore::notification::unsubscribe(
            globals,
            LoreNotificationUnsubscribeArgs {},
            callback,
        )))
    })
    .await
}

/// 将服务器目录中的仓库克隆到用户明确选择的父目录。
///
/// 目标目录必须不存在或为空；适配层绝不会覆盖已有文件。Clone 失败时保留
/// Lore 已经写入的诊断现场，由用户决定检查或删除，不做隐式递归清理。
#[tauri::command]
pub async fn lore_repository_clone(
    server_url: String,
    repository_name: String,
    destination_parent: String,
    directory_name: String,
    view_path: Option<String>,
    target_revision: Option<String>,
    bare: bool,
    direct_file_io: bool,
    layer_repository: Option<String>,
    layer_metadata_key: Option<String>,
    use_shared_store: bool,
    shared_store_path: Option<String>,
    dependency_root_files: Vec<String>,
    dependency_tags: Vec<String>,
    dependency_recursive: bool,
    dependency_depth_limit: u32,
    user_id: Option<String>,
) -> Result<LoreCloneResult, LoreCommandError> {
    let repository_url = build_repository_url(&server_url, &repository_name)?;
    let destination = validate_clone_destination(&destination_parent, &directory_name)?;
    let view_path = validate_optional_file(view_path, "Selective sync rules file")?;
    let target_revision = validate_optional_clone_target(target_revision)?;
    let (layer_repository, layer_metadata_key) =
        validate_clone_layer(layer_repository, layer_metadata_key)?;
    let shared_store_path = validate_clone_shared_store_path(use_shared_store, shared_store_path)?;
    let dependency_root_files = validate_optional_dependency_paths(dependency_root_files)?;
    let dependency_tags = validate_dependency_tags(dependency_tags)?;
    validate_dependency_depth_limit(dependency_depth_limit)?;
    let user_id = validate_optional_auth_identity(user_id)?;
    validate_bare_clone_options(
        bare,
        view_path.as_deref(),
        direct_file_io,
        &layer_repository,
        &dependency_root_files,
        &dependency_tags,
        dependency_recursive,
        dependency_depth_limit,
    )?;

    run_lore_task(move || {
        let destination = display_path_without_windows_verbatim_prefix(&destination);
        let result_destination = destination.clone();
        let globals = LoreGlobalArgs {
            repository_path: destination.clone().into(),
            working_directory: destination.into(),
            store_keep_alive: 1,
            store_keep_alive_seconds: 30,
            identity: user_id.unwrap_or_default().into(),
            ..Default::default()
        };

        let result = run_operation("repository.clone", move |callback| {
            lore::runtime().block_on(lore::repository::clone(
                globals,
                LoreRepositoryCloneArgs {
                    repository_url: repository_url.into(),
                    revision: target_revision.into(),
                    view: view_path.unwrap_or_default().into(),
                    bare: u8::from(bare),
                    direct_file_io: u8::from(direct_file_io),
                    layer: layer_repository.into(),
                    layer_metadata: layer_metadata_key.into(),
                    use_shared_store: u8::from(use_shared_store),
                    shared_store_path: shared_store_path.unwrap_or_default().into(),
                    root_files: to_lore_array(dependency_root_files),
                    dependency_tags: to_lore_array(dependency_tags),
                    dependency_recursive: u8::from(dependency_recursive),
                    dependency_depth_limit,
                    ..Default::default()
                },
                callback,
            ))
        })?;
        Ok(LoreCloneResult {
            destination_path: result_destination,
            result,
        })
    })
    .await
}

/// 读取仓库自身配置中的连接地址或作者身份。
///
/// 键白名单在适配层校验，前端不能借此读取任意配置字段；返回值继续使用
/// Lore 事件流，避免暴露上游内部配置结构。
#[tauri::command]
pub async fn lore_repository_config_get(
    repository_path: String,
    key: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let key = key.trim().to_owned();
    if key != "remote_url" && key != "identity" {
        return Err(LoreCommandError::new(
            "invalid_repository_config_key",
            format!("Reading repository configuration key {key} is not supported"),
        ));
    }

    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.config-get", move |callback| {
            lore::runtime().block_on(lore::repository::config_get(
                globals,
                LoreRepositoryConfigGetArgs { key: key.into() },
                callback,
            ))
        })
    })
    .await
}

/// 设置或清除仓库自己的提交身份与远端地址。
///
/// Lore 固定版本只提供 `config_get`，没有程序化写接口，因此这里使用
/// `toml_edit` 仅修改两个顶层白名单键。空字符串表示删除对应键，其他未知字段、
/// 表和注释都会保留。
#[tauri::command]
pub async fn lore_repository_config_update(
    repository_path: String,
    identity: String,
    remote_url: String,
) -> Result<RepositoryConfiguration, LoreCommandError> {
    run_lore_task(move || {
        let repository_path = validate_repository_path(&repository_path)?;
        // 先释放可能仍由 30 秒 keep-alive 保留的 RepositoryContext；否则紧随其后的
        // Status/Push 可能继续沿用修改前的 remote_url 或 identity。
        release_repository_cache(&repository_path)?;
        update_repository_configuration(&repository_path, &identity, &remote_url)
    })
    .await
}

/// 读取当前 Instance 的选择性同步 View 和结构化诊断。
#[tauri::command]
pub async fn lore_repository_view_get(
    repository_path: String,
) -> Result<LoreRepositoryView, LoreCommandError> {
    run_lore_task(move || read_repository_view(Path::new(&repository_path))).await
}

/// 在不改写 View 或工作区的前提下预览规则对当前 Revision 的影响。
#[tauri::command]
pub async fn lore_repository_view_preview(
    repository_path: String,
    revision: String,
    content: String,
) -> Result<LoreRepositoryViewPreview, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    validate_view_content_size(&content)?;
    run_lore_task(move || build_repository_view_preview(&repository_path, &revision, &content))
        .await
}

/// 原子替换当前 Instance View，并通过 Lore Sync 重新协调物化文件。
///
/// 写入前会再次读取真实 Status，拒绝本地更改、Stage 和冲突状态；前端按钮门禁
/// 只负责解释原因，不能替代这个 Rust 安全边界。
#[tauri::command]
pub async fn lore_repository_view_apply(
    repository_path: String,
    revision: String,
    content: String,
) -> Result<LoreRepositoryViewApplyResult, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    validate_view_content_size(&content)?;
    run_lore_task(move || apply_repository_view(repository_path, revision, content)).await
}

/// 读取仓库状态，并可选择执行一次完整文件系统扫描。
#[tauri::command]
pub async fn lore_repository_status(
    repository_path: String,
    scan: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.status", move |callback| {
            lore::runtime().block_on(lore::repository::status(
                globals,
                LoreRepositoryStatusArgs {
                    staged: 1,
                    scan: u8::from(scan),
                    check_dirty: u8::from(!scan),
                    reset: 0,
                    sync_point: 1,
                    revision_only: 0,
                    count: 1,
                    paths: LoreArray::default(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 一个 Revision Entry 及其隐式关联的全部 Metadata 事件。
#[derive(Debug)]
struct RevisionHistoryEventGroup {
    revision: String,
    revision_number: u64,
    parent_ids: Vec<String>,
    events: Vec<Value>,
    discovery_order: usize,
}

/// 把 Lore 的线性事件流拆成不可分割的 Revision 事件组。
///
/// Metadata 在协议中没有重复携带 Revision ID，而是隐式归属于它前面的 Entry；
/// 因此聚合和排序必须移动完整事件组，不能分别处理 Entry 与 Metadata。
fn parse_revision_history_event_groups(
    events: &[Value],
    next_discovery_order: &mut usize,
) -> Result<Vec<RevisionHistoryEventGroup>, LoreCommandError> {
    let mut groups = Vec::new();
    let mut current: Option<RevisionHistoryEventGroup> = None;

    for event in events {
        match event.get("tagName").and_then(Value::as_str) {
            Some("revisionHistoryEntry") => {
                if let Some(group) = current.take() {
                    groups.push(group);
                }
                let revision = event
                    .pointer("/data/revision")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        LoreCommandError::new(
                            "invalid_revision_history_entry",
                            "Lore history entry is missing a valid revision ID",
                        )
                    })?
                    .to_owned();
                let revision_number = event
                    .pointer("/data/revisionNumber")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        LoreCommandError::new(
                            "invalid_revision_history_entry",
                            format!("Revision {revision} is missing a valid sequence number"),
                        )
                    })?;
                let parent_ids = event
                    .pointer("/data/parent")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|parent| {
                        !parent.is_empty() && !is_zero_hash(parent) && *parent != revision
                    })
                    .map(str::to_owned)
                    .collect();
                current = Some(RevisionHistoryEventGroup {
                    revision,
                    revision_number,
                    parent_ids,
                    events: vec![event.clone()],
                    discovery_order: *next_discovery_order,
                });
                *next_discovery_order += 1;
            }
            Some("metadata") => {
                if let Some(group) = current.as_mut() {
                    group.events.push(event.clone());
                }
            }
            _ => {}
        }
    }

    if let Some(group) = current {
        groups.push(group);
    }
    Ok(groups)
}

/// 收录新的 Revision 事件组，并把尚未加载的第二及后续父节点加入补查队列。
///
/// 第一父链已经由单次 Lore History 查询线性返回；不继续追逐被分页截断的第一父节点，
/// 可以避免无 Merge 的长历史为了得到同一页结果额外读取数倍数据。
fn insert_revision_history_groups(
    groups: &mut HashMap<String, RevisionHistoryEventGroup>,
    pending_secondary_parents: &mut VecDeque<String>,
    candidates: Vec<RevisionHistoryEventGroup>,
    candidate_limit: usize,
) {
    for group in candidates {
        if groups.len() >= candidate_limit || groups.contains_key(&group.revision) {
            continue;
        }
        for parent in group.parent_ids.iter().skip(1) {
            if !groups.contains_key(parent) {
                pending_secondary_parents.push_back(parent.clone());
            }
        }
        groups.insert(group.revision.clone(), group);
    }
}

/// 按显式父边生成“子 Revision 先于父 Revision”的稳定顺序。
///
/// 同时可用的节点优先选择较大的 Revision Number；序号相同则保持首次发现顺序，
/// 使 main 与来源 Branch 在同一代际交错显示，而不是先走完整条 main 再回到来源分支。
fn topologically_order_revision_history(
    mut groups: HashMap<String, RevisionHistoryEventGroup>,
) -> Result<Vec<RevisionHistoryEventGroup>, LoreCommandError> {
    let mut visible_child_counts = groups
        .keys()
        .map(|revision| (revision.clone(), 0_usize))
        .collect::<HashMap<_, _>>();
    for group in groups.values() {
        for parent in &group.parent_ids {
            if let Some(child_count) = visible_child_counts.get_mut(parent) {
                *child_count += 1;
            }
        }
    }

    let mut ready = BinaryHeap::new();
    for (revision, child_count) in &visible_child_counts {
        if *child_count == 0 {
            let group = &groups[revision];
            ready.push((
                group.revision_number,
                Reverse(group.discovery_order),
                revision.clone(),
            ));
        }
    }

    let expected_count = groups.len();
    let mut ordered = Vec::with_capacity(expected_count);
    while let Some((_revision_number, _discovery_order, revision)) = ready.pop() {
        let group = groups.remove(&revision).ok_or_else(|| {
            LoreCommandError::new(
                "revision_history_topology_invalid",
                format!("Revision history topology processed node {revision} more than once"),
            )
        })?;
        for parent in &group.parent_ids {
            let Some(child_count) = visible_child_counts.get_mut(parent) else {
                continue;
            };
            *child_count = child_count.saturating_sub(1);
            if *child_count == 0 {
                if let Some(parent_group) = groups.get(parent) {
                    ready.push((
                        parent_group.revision_number,
                        Reverse(parent_group.discovery_order),
                        parent.clone(),
                    ));
                }
            }
        }
        ordered.push(group);
    }

    if ordered.len() != expected_count {
        return Err(LoreCommandError::new(
            "revision_history_cycle",
            "Revision history contains a cyclic parent relationship and cannot produce a reliable graph",
        ));
    }
    Ok(ordered)
}

/// 通过可替换的 Lore History 查询器收集 Revision 历史。
///
/// 查询器参数依次是可选起点 Revision 与本次最大返回数。生产路径调用固定 Lore
/// API，测试路径注入确定性的事件流，使多父遍历、去重和数量边界可以脱离真实仓库验证。
fn collect_revision_history_with(
    limit: u32,
    primary_revision: Option<String>,
    mut fetch: impl FnMut(Option<String>, u32) -> Result<LoreOperationResult, LoreCommandError>,
) -> Result<LoreOperationResult, LoreCommandError> {
    const HISTORY_EXPANSION_FACTOR: usize = 4;

    /*
     * 显式主起点用于“工作区停在旧 Revision、Branch latest 仍在更新 Revision”的场景。
     * 后续第二父链查询继续复用同一个 fetch，不把工作区锚点误当成 Branch 历史边界。
     */
    let primary = fetch(primary_revision, limit)?;
    /*
     * 主查询失败时保留既有命令契约：把完整状态与事件交给前端统一映射。只有主查询
     * 成功后才开始组合额外查询，避免把原始错误改写成另一个聚合错误。
     */
    if primary.status != 0 {
        return Ok(primary);
    }

    let output_limit = limit as usize;
    let candidate_limit = output_limit.saturating_mul(HISTORY_EXPANSION_FACTOR);
    let header = primary
        .events
        .iter()
        .find(|event| event.get("tagName").and_then(Value::as_str) == Some("revisionHistory"))
        .cloned();
    let completion = primary
        .events
        .iter()
        .rev()
        .find(|event| event.get("tagName").and_then(Value::as_str) == Some("complete"))
        .cloned();
    let passthrough_events = primary
        .events
        .iter()
        .filter(|event| {
            !matches!(
                event.get("tagName").and_then(Value::as_str),
                Some("revisionHistory" | "revisionHistoryEntry" | "metadata" | "complete")
            )
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut next_discovery_order = 0;
    let primary_groups =
        parse_revision_history_event_groups(&primary.events, &mut next_discovery_order)?;
    let mut groups = HashMap::new();
    let mut pending_secondary_parents = VecDeque::new();
    insert_revision_history_groups(
        &mut groups,
        &mut pending_secondary_parents,
        primary_groups,
        candidate_limit,
    );

    let mut queried_secondary_parents = BTreeSet::new();
    let mut duration_ms = primary.duration_ms;
    while groups.len() < candidate_limit {
        let Some(parent) = pending_secondary_parents.pop_front() else {
            break;
        };
        if groups.contains_key(&parent) || !queried_secondary_parents.insert(parent.clone()) {
            continue;
        }
        let remaining_capacity = candidate_limit - groups.len();
        let supplemental = fetch(Some(parent.clone()), remaining_capacity as u32)?;
        let parent_hint = parent.chars().take(8).collect::<String>();
        ensure_operation_success(
            &supplemental,
            &format!("Read merge parent revision {parent_hint}"),
        )?;
        duration_ms = duration_ms.saturating_add(supplemental.duration_ms);
        let supplemental_groups =
            parse_revision_history_event_groups(&supplemental.events, &mut next_discovery_order)?;
        insert_revision_history_groups(
            &mut groups,
            &mut pending_secondary_parents,
            supplemental_groups,
            candidate_limit,
        );
    }

    let ordered = topologically_order_revision_history(groups)?;
    let mut events = Vec::new();
    if let Some(header) = header {
        events.push(header);
    }
    events.extend(passthrough_events);
    for group in ordered.into_iter().take(output_limit) {
        events.extend(group.events);
    }
    if let Some(completion) = completion {
        events.push(completion);
    }

    Ok(LoreOperationResult {
        operation: primary.operation,
        status: primary.status,
        duration_ms,
        events,
    })
}

/// 读取当前 Branch 的 Revision 历史，并补齐 Merge Revision 的其他父链。
fn build_revision_history_args(
    revision: Option<String>,
    branch: Option<String>,
    date: u64,
    length: u32,
    only_branch: bool,
) -> LoreRevisionHistoryArgs {
    LoreRevisionHistoryArgs {
        revision: revision.unwrap_or_default().into(),
        branch: branch.unwrap_or_default().into(),
        date,
        length,
        only_branch: u8::from(only_branch),
    }
}

/// 读取当前 Branch 的 Revision 历史，并补齐 Merge Revision 的其他父链。
#[tauri::command]
pub async fn lore_revision_history(
    repository_path: String,
    limit: Option<u32>,
    revision: Option<String>,
    branch: Option<String>,
    date: Option<u64>,
    only_branch: Option<bool>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = revision
        .filter(|revision| !revision.trim().is_empty())
        .map(|revision| validate_revision(&revision))
        .transpose()?;
    let branch = branch
        .filter(|branch| !branch.trim().is_empty())
        .map(|branch| validate_branch_name(&branch))
        .transpose()?;
    let date = date.unwrap_or_default();
    let only_branch = only_branch.unwrap_or(false);
    run_lore_task(move || {
        let limit = limit.unwrap_or(100).clamp(1, 1_000);
        collect_revision_history_with(limit, revision, move |revision, length| {
            let globals = global_args(&repository_path)?;
            let branch = branch.clone();
            run_operation("revision.history", move |callback| {
                lore::runtime().block_on(lore::revision::history(
                    globals,
                    build_revision_history_args(revision, branch, date, length, only_branch),
                    callback,
                ))
            })
        })
    })
    .await
}

/// 读取 Repository、Branch、Revision 或文件的原始 Lore 元数据事件。
///
/// 该入口刻意只读，不把 Metadata Set/Clear 暴露给前端。固定版本允许空 key 列出
/// Repository 与 Branch 元数据，而 Revision 与文件使用各自的 List API；组件只会
/// 消费 `services/lore.ts` 归一化后的稳定 DTO。
#[tauri::command]
pub async fn lore_metadata_list(
    repository_path: String,
    scope: String,
    target: Option<String>,
    revision: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let scope = scope.trim().to_owned();
    let target = target.unwrap_or_default();
    let revision = revision
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_revision(&value))
        .transpose()?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        match scope.as_str() {
            "repository" => run_operation("repository.metadata-get", move |callback| {
                lore::runtime().block_on(lore::repository::metadata_get(
                    globals,
                    LoreRepositoryMetadataGetArgs {
                        key: LoreString::default(),
                    },
                    callback,
                ))
            }),
            "branch" => {
                let branch = validate_branch_name(&target)?;
                run_operation("branch.metadata-get", move |callback| {
                    lore::runtime().block_on(lore::branch::metadata_get(
                        globals,
                        LoreBranchMetadataGetArgs {
                            branch: branch.into(),
                            key: LoreString::default(),
                        },
                        callback,
                    ))
                })
            }
            "revision" => {
                let revision = revision
                    .or_else(|| (!target.trim().is_empty()).then(|| target.clone()))
                    .ok_or_else(|| {
                        LoreCommandError::new(
                            "metadata_revision_required",
                            "Revision metadata requires an explicit revision",
                        )
                    })
                    .and_then(|value| validate_revision(&value))?;
                run_operation("revision.metadata-list", move |callback| {
                    lore::runtime().block_on(lore::revision::metadata_list(
                        globals,
                        LoreRevisionMetadataListArgs {
                            revision: revision.into(),
                        },
                        callback,
                    ))
                })
            }
            "file" => {
                let path = validate_repository_relative_path(&target)?;
                let path = path.to_string_lossy().replace('\\', "/");
                run_operation("file.metadata-list", move |callback| {
                    lore::runtime().block_on(lore::file::metadata_list(
                        globals,
                        LoreFileMetadataListArgs {
                            path: path.into(),
                            revision: revision.unwrap_or_default().into(),
                        },
                        callback,
                    ))
                })
            }
            _ => Err(LoreCommandError::new(
                "metadata_scope_invalid",
                "Metadata scope must be repository, branch, revision, or file",
            )),
        }
    })
    .await
}

/// 读取精确 Revision 的基础信息、父节点、文件 Delta 与元数据。
#[tauri::command]
pub async fn lore_revision_info(
    repository_path: String,
    revision: String,
    include_delta: bool,
    include_metadata: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.info", move |callback| {
            lore::runtime().block_on(lore::revision::info(
                globals,
                LoreRevisionInfoArgs {
                    revision: revision.into(),
                    delta: u8::from(include_delta),
                    metadata: u8::from(include_metadata),
                },
                callback,
            ))
        })
    })
    .await
}

/// 按当前 Branch 的 Revision 编号或元数据查找一个精确 Revision。
#[tauri::command]
pub async fn lore_revision_find(
    repository_path: String,
    metadata_key: Option<String>,
    metadata_value: Option<String>,
    revision_number: Option<u64>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let key = metadata_key.unwrap_or_default().trim().to_owned();
    let value = metadata_value.unwrap_or_default().trim().to_owned();
    let number = revision_number.unwrap_or_default();
    if key.is_empty() == (number == 0) {
        return Err(LoreCommandError::new(
            "revision_find_mode_invalid",
            "Specify exactly one revision search mode: metadata key or positive revision number",
        ));
    }
    if key.chars().any(char::is_control) || value.contains('\0') {
        return Err(LoreCommandError::new(
            "revision_find_metadata_invalid",
            "Revision metadata search values must not contain control characters",
        ));
    }
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.find", move |callback| {
            lore::runtime().block_on(lore::revision::find(
                globals,
                LoreRevisionFindArgs {
                    key: key.into(),
                    value: value.into(),
                    number,
                },
                callback,
            ))
        })
    })
    .await
}

/// 修改当前 Latest Revision 的消息，并在写入前重验工作区与分支指针。
#[tauri::command]
pub async fn lore_revision_amend(
    repository_path: String,
    message: String,
    branch: String,
    expected_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let message = validate_revision_message(&message)?;
    let branch = validate_branch_name(&branch)?;
    let expected_revision = validate_revision(&expected_revision)?;
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_revision)?;
        let latest = read_branch_latest(&repository_path, &branch)?;
        if latest != expected_revision {
            return Err(LoreCommandError::new(
                "revision_amend_not_latest",
                "Only the current branch LATEST revision can be amended safely",
            ));
        }
        let globals = global_args(&repository_path)?;
        run_operation("revision.amend", move |callback| {
            lore::runtime().block_on(lore::revision::amend(
                globals,
                LoreRevisionAmendArgs {
                    message: message.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 执行一步真实 Bisect，并把干净工作区同步到区间中点。
#[tauri::command]
pub async fn lore_revision_bisect(
    repository_path: String,
    start: String,
    end: String,
    expected_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let start = validate_revision(&start)?;
    let end = validate_revision(&end)?;
    let expected_revision = validate_revision(&expected_revision)?;
    if start == end {
        return Err(LoreCommandError::new(
            "revision_bisect_range_empty",
            "The known-good and known-bad revisions must be different",
        ));
    }
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_revision)?;
        let globals = global_args(&repository_path)?;
        run_operation("revision.bisect", move |callback| {
            lore::runtime().block_on(lore::revision::bisect(
                globals,
                LoreRevisionBisectArgs {
                    start: start.into(),
                    end: end.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 把当前已检出的历史内容重放到远端最新头并自动创建新 Revision。
#[tauri::command]
pub async fn lore_revision_restore(
    repository_path: String,
    message: String,
    expected_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let message = validate_revision_message(&message)?;
    let expected_revision = validate_revision(&expected_revision)?;
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_revision)?;
        let globals = global_args(&repository_path)?;
        run_operation("revision.restore", move |callback| {
            lore::runtime().block_on(lore::revision::restore(
                globals,
                LoreRevisionRestoreArgs {
                    message: message.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 读取本地与远端 Branch 列表。
#[tauri::command]
pub async fn lore_branch_list(
    repository_path: String,
    include_archived: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.list", move |callback| {
            lore::runtime().block_on(lore::branch::list(
                globals,
                LoreBranchListArgs {
                    archived: u8::from(include_archived),
                },
                callback,
            ))
        })
    })
    .await
}

/// 读取单个 Branch 的上游信息。
#[tauri::command]
pub async fn lore_branch_info(
    repository_path: String,
    branch: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.info", move |callback| {
            lore::runtime().block_on(lore::branch::info(
                globals,
                LoreBranchInfoArgs {
                    branch: branch.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 读取 Branch 的保护元数据。
///
/// 固定 Lore 版本的 `BranchInfo` 文档提到保护状态，但实际事件尚未携带该字段，
/// 因此这里显式读取 `protect` 元数据，前端不需要猜测事件或错误文本。
#[tauri::command]
pub async fn lore_branch_protection_info(
    repository_path: String,
    branch: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.protection-info", move |callback| {
            lore::runtime().block_on(lore::branch::metadata_get(
                globals,
                LoreBranchMetadataGetArgs {
                    branch: branch.into(),
                    key: "protect".into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 比较两个 Branch，可选按仓库相对路径缩小范围。
#[tauri::command]
pub async fn lore_branch_diff(
    repository_path: String,
    source: String,
    target: String,
    path: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let source = validate_branch_name(&source)?;
    let target = validate_branch_name(&target)?;
    let path = path
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            validate_repository_relative_path(&value).map(|validated| {
                validated
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/")
            })
        })
        .transpose()?
        .unwrap_or_default();
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.diff", move |callback| {
            lore::runtime().block_on(lore::branch::diff(
                globals,
                LoreBranchDiffArgs {
                    source: source.into(),
                    target: target.into(),
                    path: path.into(),
                    /*
                     * 审计界面只做只读比较，不应在预览阶段尝试自动合并冲突。
                     * 真正 Merge 仍走已有的确认与冲突会话流程。
                     */
                    auto_resolve: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 读取 Branch 的本地 Latest 指针历史。
#[tauri::command]
pub async fn lore_branch_latest_list(
    repository_path: String,
    branch: String,
    limit: Option<u32>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let limit = limit.unwrap_or(30).clamp(1, 200);
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.latest-list", move |callback| {
            lore::runtime().block_on(lore::branch::latest_list(
                globals,
                LoreBranchLatestListArgs {
                    branch: branch.into(),
                    limit,
                },
                callback,
            ))
        })
    })
    .await
}

/// 设置或移除 Branch 写保护。
#[tauri::command]
pub async fn lore_branch_set_protected(
    repository_path: String,
    branch: String,
    protected: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        if protected {
            run_operation("branch.protect", move |callback| {
                lore::runtime().block_on(lore::branch::protect(
                    globals,
                    LoreBranchProtectArgs {
                        branch: branch.into(),
                    },
                    callback,
                ))
            })
        } else {
            run_operation("branch.unprotect", move |callback| {
                lore::runtime().block_on(lore::branch::unprotect(
                    globals,
                    LoreBranchUnprotectArgs {
                        branch: branch.into(),
                    },
                    callback,
                ))
            })
        }
    })
    .await
}

/// 安全地把当前 Branch 的本地 Latest 指针回退到历史 Revision。
///
/// Reset 会改写指针并重新同步当前工作区，因此必须在真正写入前重新读取 Status、
/// 保护元数据、BranchInfo 和 Latest 历史。调用方传入的预览签名只用于防止
/// “确认弹窗打开后仓库已变化”的竞态，不会被当成事实来源。
#[tauri::command]
pub async fn lore_branch_reset(
    repository_path: String,
    branch: String,
    revision: String,
    expected_workspace_revision: String,
    expected_latest: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let revision = validate_revision(&revision)?;
    let expected_workspace_revision = validate_revision(&expected_workspace_revision)?;
    let expected_latest = validate_revision(&expected_latest)?;
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_workspace_revision)?;

        let protection = read_branch_protection(&repository_path, &branch)?;
        if protection {
            return Err(LoreCommandError::new(
                "branch_reset_protected",
                "The branch is protected; remove protection before resetting it",
            ));
        }

        let actual_latest = read_branch_latest(&repository_path, &branch)?;
        if actual_latest != expected_latest {
            return Err(LoreCommandError::new(
                "branch_reset_latest_changed",
                "The branch LATEST pointer changed; reload the branch history before resetting",
            ));
        }

        let latest_history = read_branch_latest_history(&repository_path, &branch, 200)?;
        if !latest_history.iter().any(|item| item == &revision) {
            return Err(LoreCommandError::new(
                "branch_reset_revision_not_in_latest_history",
                "The selected revision is not present in the current branch LATEST history",
            ));
        }

        let globals = global_args(&repository_path)?;
        run_operation("branch.reset", move |callback| {
            lore::runtime().block_on(lore::branch::reset(
                globals,
                LoreBranchResetArgs {
                    revision: revision.into(),
                    branch: branch.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 从真实 Branch 元数据读取保护状态；缺少 `protect` 键表示未保护。
fn read_branch_protection(repository_path: &str, branch: &str) -> Result<bool, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let branch = branch.to_owned();
    let result = run_operation("branch.protection-info.reset-check", move |callback| {
        lore::runtime().block_on(lore::branch::metadata_get(
            globals,
            LoreBranchMetadataGetArgs {
                branch: branch.into(),
                key: "protect".into(),
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Read branch protection metadata")?;
    Ok(result
        .events
        .iter()
        .find(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("metadata")
                && event.pointer("/data/key").and_then(Value::as_str) == Some("protect")
        })
        .and_then(|event| event.pointer("/data/value/data"))
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

/// 读取 BranchInfo 中当前真实的本地 Latest 指针。
fn read_branch_latest(repository_path: &str, branch: &str) -> Result<String, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let branch = branch.to_owned();
    let result = run_operation("branch.info.reset-check", move |callback| {
        lore::runtime().block_on(lore::branch::info(
            globals,
            LoreBranchInfoArgs {
                branch: branch.into(),
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Read branch information")?;
    result
        .events
        .iter()
        .find(|event| event.get("tagName").and_then(Value::as_str) == Some("branchInfo"))
        .and_then(|event| event.pointer("/data/latest").and_then(Value::as_str))
        .map(str::to_owned)
        .ok_or_else(|| {
            LoreCommandError::new(
                "branch_info_latest_unavailable",
                "Lore branch information did not contain a local LATEST revision",
            )
        })
}

/// 读取 Reset 允许选择的真实 Latest 历史，避免调用方提交任意 Revision。
fn read_branch_latest_history(
    repository_path: &str,
    branch: &str,
    limit: u32,
) -> Result<Vec<String>, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let branch = branch.to_owned();
    let result = run_operation("branch.latest-list.reset-check", move |callback| {
        lore::runtime().block_on(lore::branch::latest_list(
            globals,
            LoreBranchLatestListArgs {
                branch: branch.into(),
                limit,
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Read branch LATEST history")?;
    Ok(result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("branchLatestListEntry")
        })
        .filter_map(|event| {
            event
                .pointer("/data/revision")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect())
}

/// 从明确的来源 Branch/Revision 创建并附着新 Branch。
///
/// 当前 Lore 公共 `branch::create` API 没有来源参数，只会读取实例当前锚点。
/// 因此组合命令先安全切换到来源，再创建新 Branch；创建失败时尽力恢复调用前
/// 的 Branch/Revision。所有切换都关闭 `reset`，不会静默丢弃 Stage 内容。
#[tauri::command]
pub async fn lore_branch_create_from(
    repository_path: String,
    branch: String,
    source_branch: String,
    source_revision: String,
    previous_branch: String,
    previous_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let source_branch = validate_branch_name(&source_branch)?;
    let source_revision = validate_revision(&source_revision)?;
    let previous_branch = validate_branch_name(&previous_branch)?;
    let previous_revision = validate_revision(&previous_revision)?;

    run_lore_task(move || {
        run_branch_create_from(
            repository_path,
            branch,
            source_branch,
            source_revision,
            previous_branch,
            previous_revision,
        )
    })
    .await
}

/// 执行可由 Tauri IPC 与真实 Lore 集成测试共同复用的同步组合操作。
fn run_branch_create_from(
    repository_path: String,
    branch: String,
    source_branch: String,
    source_revision: String,
    previous_branch: String,
    previous_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let started_at = Instant::now();
    let mut events = Vec::new();

    events.push(serde_json::json!({
        "tagName": "adapterOperationPhase",
        "data": {
            "phase": "sourceCheckout",
            "branch": source_branch,
            "revision": source_revision,
        }
    }));
    let source_checkout = {
        let globals = global_args(&repository_path)?;
        let source_branch = source_branch.clone();
        let source_revision = source_revision.clone();
        run_operation("branch.create-from.checkout", move |callback| {
            lore::runtime().block_on(lore::branch::switch(
                globals,
                LoreBranchSwitchArgs {
                    branch: source_branch.into(),
                    revision: source_revision.into(),
                    reset: 0,
                    bare: 0,
                },
                callback,
            ))
        })?
    };
    let source_status = source_checkout.status;
    events.extend(source_checkout.events);
    if source_status != 0 {
        return Ok(LoreOperationResult {
            operation: "branch.create-from",
            status: source_status,
            duration_ms: started_at.elapsed().as_millis(),
            events,
        });
    }

    events.push(serde_json::json!({
        "tagName": "adapterOperationPhase",
        "data": {
            "phase": "create",
            "branch": branch,
        }
    }));
    let create_result = {
        let globals = global_args(&repository_path)?;
        let branch = branch.clone();
        run_operation("branch.create-from.create", move |callback| {
            lore::runtime().block_on(lore::branch::create(
                globals,
                LoreBranchCreateArgs {
                    branch: branch.into(),
                    category: LoreString::default(),
                    id: LoreString::default(),
                },
                callback,
            ))
        })?
    };
    let create_status = create_result.status;
    events.extend(create_result.events);

    if create_status != 0 {
        // 创建失败时恢复调用前锚点；恢复结果只追加诊断，不覆盖原始创建错误。
        events.push(serde_json::json!({
            "tagName": "adapterOperationPhase",
            "data": {
                "phase": "restore",
                "branch": previous_branch,
                "revision": previous_revision,
            }
        }));
        let restore_result = {
            let globals = global_args(&repository_path)?;
            run_operation("branch.create-from.restore", move |callback| {
                lore::runtime().block_on(lore::branch::switch(
                    globals,
                    LoreBranchSwitchArgs {
                        branch: previous_branch.into(),
                        revision: previous_revision.into(),
                        reset: 0,
                        bare: 0,
                    },
                    callback,
                ))
            })?
        };
        events.extend(restore_result.events);
    }

    Ok(LoreOperationResult {
        operation: "branch.create-from",
        status: create_status,
        duration_ms: started_at.elapsed().as_millis(),
        events,
    })
}

/// 列出当前仓库中由 Lore Client 管理的全部标签。
///
/// 读取会沿用 Lore Core 的远端优先、本地缓存回退策略。解析时按稳定 ID 去重，
/// 因而一次改名若只完成了“写入新键”，列表也只会展示更新时间较新的新名称。
#[tauri::command]
pub async fn lore_tag_list(repository_path: String) -> Result<Vec<LoreTag>, LoreCommandError> {
    run_lore_task(move || {
        let records = read_tag_records(&repository_path)?;
        Ok(deduplicate_tag_records(records)
            .into_iter()
            .map(|record| record.tag)
            .collect())
    })
    .await
}

/// 从明确的 Branch/Revision 创建仓库共享标签。
///
/// Lore 没有隐式“当前提交”标签语义，调用方必须传入精确 Revision，避免用户从历史
/// 列表创建标签时意外指向工作区当前 Revision。
#[tauri::command]
pub async fn lore_tag_create(
    repository_path: String,
    name: String,
    branch: String,
    revision: String,
    message: String,
) -> Result<LoreTag, LoreCommandError> {
    let name = validate_tag_name(&name)?;
    let branch = validate_branch_name(&branch)?;
    let revision = validate_revision(&revision)?;
    let message = validate_tag_message(&message)?;

    run_lore_task(move || {
        let existing = read_tag_records(&repository_path)?;
        ensure_tag_name_available(&existing, &name, None)?;

        let now_millis = unix_time_millis()?;
        let unique_nanos = unix_time_nanos()?;
        let revision_hint = revision.chars().take(8).collect::<String>();
        let tag = LoreTag {
            id: format!("tag-{unique_nanos:x}-{revision_hint}"),
            name,
            branch,
            revision,
            message,
            created_at: now_millis,
            updated_at: now_millis,
        };
        write_tag(&repository_path, &tag)?;
        Ok(tag)
    })
    .await
}

/// 修改标签名称或说明，但保持来源 Branch、Revision 与稳定 ID 不变。
///
/// 改名采用“先写新键、后清旧键”。即使网络在两步之间中断，新的有效标签仍然
/// 存在；下一次列表会按稳定 ID 去重，后续编辑或删除会继续清理遗留键。
#[tauri::command]
pub async fn lore_tag_update(
    repository_path: String,
    tag_id: String,
    name: String,
    message: String,
) -> Result<LoreTag, LoreCommandError> {
    let tag_id = validate_tag_id(&tag_id)?;
    let name = validate_tag_name(&name)?;
    let message = validate_tag_message(&message)?;

    run_lore_task(move || {
        let records = read_tag_records(&repository_path)?;
        ensure_tag_name_available(&records, &name, Some(&tag_id))?;
        let current = newest_tag_record(&records, &tag_id)?.tag;
        let mut updated = current;
        updated.name = name;
        updated.message = message;
        updated.updated_at = unix_time_millis()?;

        write_tag(&repository_path, &updated)?;
        let new_key = tag_metadata_key(&updated.name);
        let stale_keys = records
            .iter()
            .filter(|record| record.tag.id == tag_id && record.key != new_key)
            .map(|record| record.key.clone())
            .collect::<Vec<_>>();
        clear_tag_keys(&repository_path, stale_keys)?;
        Ok(updated)
    })
    .await
}

/// 删除稳定 ID 对应的全部标签元数据键。
///
/// 这里不会只删除当前显示名称对应的键；这样可以同时回收早先改名部分失败留下的
/// 旧键，保证一次成功删除后仓库中不再出现该标签。
#[tauri::command]
pub async fn lore_tag_delete(
    repository_path: String,
    tag_id: String,
) -> Result<(), LoreCommandError> {
    let tag_id = validate_tag_id(&tag_id)?;
    run_lore_task(move || {
        let records = read_tag_records(&repository_path)?;
        let keys = records
            .iter()
            .filter(|record| record.tag.id == tag_id)
            .map(|record| record.key.clone())
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Err(LoreCommandError::new(
                "tag_not_found",
                "The tag to delete no longer exists; refresh the repository state",
            ));
        }
        clear_tag_keys(&repository_path, keys)
    })
    .await
}

/// 清理组合仓库表单中的外围空白，并在进入 Lore 写队列前拒绝空值和控制字符。
///
/// 路径是否越界仍由固定 Lore 版本的 `RelativePath` 在 Repository 边界校验；
/// 这里负责提供稳定、可本地化的客户端错误类型，避免空表单只得到内部错误码。
fn required_composition_value(
    value: String,
    field_name: &'static str,
) -> Result<String, LoreCommandError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(LoreCommandError::new(
            "composition_field_required",
            format!("{field_name} must not be empty"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "composition_field_invalid",
            format!("{field_name} must not contain control characters"),
        ));
    }
    Ok(value.to_owned())
}

/// 可选的 Pin/Metadata 空字符串统一映射为 Lore 的默认空值。
fn optional_composition_value(value: Option<String>) -> LoreString {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(LoreString::from)
        .unwrap_or_default()
}

fn build_layer_add_args(
    target_path: String,
    source_repository: String,
    source_path: String,
    metadata: Option<String>,
) -> Result<LoreLayerAddArgs, LoreCommandError> {
    Ok(LoreLayerAddArgs {
        target_path: required_composition_value(target_path, "Layer mount path")?.into(),
        source_repository: required_composition_value(
            source_repository,
            "Layer source repository",
        )?
        .into(),
        source_path: required_composition_value(source_path, "Layer source path")?.into(),
        metadata: optional_composition_value(metadata),
    })
}

fn build_layer_remove_args(
    target_path: String,
    source_repository: String,
    purge: bool,
) -> Result<LoreLayerRemoveArgs, LoreCommandError> {
    Ok(LoreLayerRemoveArgs {
        target_path: required_composition_value(target_path, "Layer mount path")?.into(),
        source_repository: required_composition_value(
            source_repository,
            "Layer source repository",
        )?
        .into(),
        purge: u8::from(purge),
    })
}

fn build_link_add_args(
    link: String,
    link_path: String,
    source_path: String,
    pin: Option<String>,
    disable_branching: bool,
) -> Result<LoreLinkAddArgs, LoreCommandError> {
    Ok(LoreLinkAddArgs {
        link: required_composition_value(link, "Link repository address")?.into(),
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
        source_path: required_composition_value(source_path, "Link source path")?.into(),
        pin: optional_composition_value(pin),
        disable_branching: u8::from(disable_branching),
    })
}

fn build_link_update_args(
    link_path: String,
    pin: Option<String>,
) -> Result<LoreLinkUpdateArgs, LoreCommandError> {
    Ok(LoreLinkUpdateArgs {
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
        pin: optional_composition_value(pin),
    })
}

/// 列出当前 Repository 已配置的 Layer。
#[tauri::command]
pub async fn lore_layer_list(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.list", move |callback| {
            lore::runtime().block_on(lore::layer::layer_list(
                globals,
                LoreLayerListArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 列出当前 Repository 中具有已暂存文件的 Layer。
///
/// 普通 Layer 列表只描述挂载关系；已暂存文件数必须消费 Lore 的专用事件，
/// 不能根据父仓库 Status 或 Revision 差异猜测。
#[tauri::command]
pub async fn lore_layer_list_staged(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.list-staged", move |callback| {
            lore::runtime().block_on(lore::layer::layer_list_staged(
                globals,
                LoreLayerListStagedArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 把来源 Repository 的一个子树挂载为当前实例的本地 Layer。
#[tauri::command]
pub async fn lore_layer_add(
    repository_path: String,
    target_path: String,
    source_repository: String,
    source_path: String,
    metadata: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_layer_add_args(target_path, source_repository, source_path, metadata)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.add", move |callback| {
            lore::runtime().block_on(lore::layer::layer_add(globals, args, callback))
        })
    })
    .await
}

/// 从当前实例移除一个 Layer。
///
/// `purge` 会删除挂载目录中的未跟踪文件，因此只能由已经展示影响并取得确认的
/// 前端入口传入；适配层不会自动启用 Lore 的全局 Force。
#[tauri::command]
pub async fn lore_layer_remove(
    repository_path: String,
    target_path: String,
    source_repository: String,
    purge: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_layer_remove_args(target_path, source_repository, purge)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.remove", move |callback| {
            lore::runtime().block_on(lore::layer::layer_remove(globals, args, callback))
        })
    })
    .await
}

/// 列出当前 Repository 已配置的 Link。
#[tauri::command]
pub async fn lore_link_list(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.list", move |callback| {
            lore::runtime().block_on(lore::link::list(globals, LoreLinkListArgs {}, callback))
        })
    })
    .await
}

/// 列出当前 Repository 中具有已暂存文件的 Link。
#[tauri::command]
pub async fn lore_link_list_staged(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.list-staged", move |callback| {
            lore::runtime().block_on(lore::link::list_staged(globals, callback))
        })
    })
    .await
}

/// 添加随父 Revision 版本化的 Link，并把 Link 变更暂存到下一次 Revision。
#[tauri::command]
pub async fn lore_link_add(
    repository_path: String,
    link: String,
    link_path: String,
    source_path: String,
    pin: Option<String>,
    disable_branching: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_link_add_args(link, link_path, source_path, pin, disable_branching)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.add", move |callback| {
            lore::runtime().block_on(lore::link::add(globals, args, callback))
        })
    })
    .await
}

/// 移除 Link，并把删除记录暂存到父 Repository 的下一次 Revision。
#[tauri::command]
pub async fn lore_link_remove(
    repository_path: String,
    link_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = LoreLinkRemoveArgs {
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
    };
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.remove", move |callback| {
            lore::runtime().block_on(lore::link::remove(globals, args, callback))
        })
    })
    .await
}

/// 更新 Link 的 Branch/Revision Pin，并把结果暂存到父 Repository。
///
/// 固定 Lore 版本的 Update 只接受 Pin；`disable_branching` 只能在 Add 时设置，
/// 因此这里不提供一个无法兑现的 flags 编辑参数。
#[tauri::command]
pub async fn lore_link_update(
    repository_path: String,
    link_path: String,
    pin: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_link_update_args(link_path, pin)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.update", move |callback| {
            lore::runtime().block_on(lore::link::update(globals, args, callback))
        })
    })
    .await
}

/// 验证本地 Repository 状态；可限定仓库相对路径，并由明确参数启用修复。
///
/// `heal` 为 true 时 Lore 会进入写队列。前端必须先执行同一路径的只读验证并展示
/// 结果，再通过危险确认调用本入口，Rust 边界仍会重新校验路径。
#[tauri::command]
pub async fn lore_repository_verify(
    repository_path: String,
    path: Option<String>,
    heal: Option<bool>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let path = path.unwrap_or_default();
    let path = if path.trim().is_empty() {
        String::new()
    } else {
        validate_repository_relative_path(&path)?
            .to_string_lossy()
            .replace('\\', "/")
    };
    let heal = heal.unwrap_or(false);
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation(
            if heal {
                "repository.verify-heal"
            } else {
                "repository.verify"
            },
            move |callback| {
                lore::runtime().block_on(lore::repository::verify_state(
                    globals,
                    LoreRepositoryVerifyStateArgs {
                        path: path.into(),
                        heal: u8::from(heal),
                    },
                    callback,
                ))
            },
        )
    })
    .await
}

/// 验证一个明确 Fragment；hash/context 仍由 Lore 解析，长度和控制字符先在 IPC 边界拒绝。
#[tauri::command]
pub async fn lore_repository_verify_fragment(
    repository_path: String,
    hash: String,
    context: Option<String>,
    heal: Option<bool>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let hash = hash.trim().to_owned();
    let context = context.unwrap_or_default().trim().to_owned();
    if hash.is_empty()
        || hash.len() > 256
        || context.len() > 256
        || hash.chars().any(char::is_control)
        || context.chars().any(char::is_control)
    {
        return Err(LoreCommandError::new(
            "fragment_identifier_invalid",
            "Fragment hash or context is empty, too long, or contains control characters",
        ));
    }
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.verify-fragment", move |callback| {
            lore::runtime().block_on(lore::repository::verify_fragment(
                globals,
                LoreRepositoryVerifyFragmentArgs {
                    hash: hash.into(),
                    context: context.into(),
                    heal: u8::from(heal.unwrap_or(false)),
                },
                callback,
            ))
        })
    })
    .await
}

/// 输出受深度限制的 Repository State 诊断事件，不读取或返回文件内容。
#[tauri::command]
pub async fn lore_repository_dump(
    repository_path: String,
    revision: Option<String>,
    path: Option<String>,
    max_depth: Option<usize>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = revision
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_revision(&value))
        .transpose()?;
    let path = path.unwrap_or_default();
    let path = if path.trim().is_empty() {
        String::new()
    } else {
        validate_repository_relative_path(&path)?
            .to_string_lossy()
            .replace('\\', "/")
    };
    let max_depth = max_depth.unwrap_or(4).clamp(1, 32);
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.dump", move |callback| {
            lore::runtime().block_on(lore::repository::dump(
                globals,
                LoreRepositoryDumpArgs {
                    revision: revision.unwrap_or_default().into(),
                    path: path.into(),
                    max_depth,
                },
                callback,
            ))
        })
    })
    .await
}

/// 列出 Lore 记录的全部本地 Instance；路径是否陈旧由 Core 自己判定。
#[tauri::command]
pub async fn lore_repository_instance_list(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.instance-list", move |callback| {
            lore::runtime().block_on(lore::repository::instance_list(
                globals,
                LoreRepositoryInstanceListArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 清理已不存在路径对应的 Instance；前端必须先 List 并对精确陈旧集合进行确认。
#[tauri::command]
pub async fn lore_repository_instance_prune(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.instance-prune", move |callback| {
            lore::runtime().block_on(lore::repository::instance_prune(
                globals,
                LoreRepositoryInstancePruneArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 把当前 Instance 的记录路径更新为当前工作目录，不允许前端指定任意替代路径。
#[tauri::command]
pub async fn lore_repository_instance_update_path(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.instance-update-path", move |callback| {
            lore::runtime().block_on(lore::repository::repository_update_path(
                globals,
                LoreRepositoryUpdatePathArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 读取 Clone 前的远端 Repository 说明、默认 Branch、创建者与创建时间。
#[tauri::command]
pub async fn lore_repository_info_remote(
    server_url: String,
    repository_name: String,
    user_id: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let repository_url = build_repository_url(&server_url, &repository_name)?;
    let user_id = validate_optional_auth_identity(user_id)?;
    run_lore_task(move || {
        let globals = LoreGlobalArgs {
            identity: user_id.unwrap_or_default().into(),
            ..Default::default()
        };
        run_operation("repository.info", move |callback| {
            lore::runtime().block_on(lore::repository::info(
                globals,
                LoreRepositoryInfoArgs {
                    repository_url: repository_url.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 回收本地 Store 中未被引用的数据。
#[tauri::command]
pub async fn lore_repository_gc(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("repository.gc", move |callback| {
            lore::runtime().block_on(lore::repository::gc(
                globals,
                LoreRepositoryGcArgs {},
                callback,
            ))
        })
    })
    .await
}

/// Stage 指定路径；空路径数组表示递归扫描并暂存整个仓库。
#[tauri::command]
pub async fn lore_stage(
    repository_path: String,
    paths: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let paths = normalize_paths(paths, true);
        run_operation("file.stage", move |callback| {
            lore::runtime().block_on(lore::file::stage(
                globals,
                LoreFileStageArgs {
                    paths: to_lore_array(paths),
                    case_change: 0,
                    // UI 发起的 Stage 必须感知外部编辑器直接写入的文件，因此目录操作执行扫描。
                    scan: 1,
                },
                callback,
            ))
        })
    })
    .await
}

/// 从待提交集合中移除指定路径；空路径数组表示全部路径。
#[tauri::command]
pub async fn lore_unstage(
    repository_path: String,
    paths: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let paths = normalize_paths(paths, true);
        run_operation("file.unstage", move |callback| {
            lore::runtime().block_on(lore::file::unstage(
                globals,
                LoreFileUnstageArgs {
                    paths: to_lore_array(paths),
                },
                callback,
            ))
        })
    })
    .await
}

/// 将指定文件恢复到目标 Revision。
///
/// 该操作会覆盖工作区中的对应文件，因此只接受已经过严格校验的仓库相对路径；
/// `purge` 固定关闭，避免一次文件级操作顺带删除未跟踪内容。
#[tauri::command]
pub async fn lore_file_reset(
    repository_path: String,
    paths: Vec<String>,
    revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = revision.trim().to_owned();
    if revision.is_empty() {
        return Err(LoreCommandError::new(
            "empty_reset_revision",
            "File restoration requires a target revision",
        ));
    }

    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let paths = validate_repository_relative_paths(paths)?;
        run_operation("file.reset", move |callback| {
            lore::runtime().block_on(lore::file::reset(
                globals,
                LoreFileResetArgs {
                    paths: to_lore_array(paths),
                    revision: revision.into(),
                    purge: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 读取当前锚点 Revision 与工作区文件系统之间的 unified diff。
///
/// 来源和目标 Revision 都留空是 Lore `file::diff` 的明确语义：来源使用当前实例
/// 锚点，目标使用文件系统。这样可以直接展示真实工作区内容，而不需要客户端自行
/// 读取 Store 或猜测当前 Branch latest。
#[tauri::command]
pub async fn lore_workspace_diff(
    repository_path: String,
    paths: Vec<String>,
    context_lines: Option<u32>,
    ignore_whitespace_eol: Option<bool>,
    ignore_whitespace_inline: Option<bool>,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let paths = validate_repository_relative_paths(paths)?;
        run_operation("file.diff", move |callback| {
            lore::runtime().block_on(lore::file::diff(
                globals,
                LoreFileDiffArgs {
                    paths: to_lore_array(paths),
                    source_revision: LoreString::default(),
                    target_revision: LoreString::default(),
                    diff3: 0,
                    context_lines: context_lines.unwrap_or(3).min(100),
                    ignore_whitespace_eol: ignore_whitespace_eol.unwrap_or(false).into(),
                    ignore_whitespace_inline: ignore_whitespace_inline.unwrap_or(false).into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 读取指定 Revision 的完整已提交文件集合。
///
/// 数据只来自不可变 Revision Tree，不扫描工作区，因此新增但未提交的文件不会
/// 混入 Inspector 文件树。目录由前端根据仓库相对路径投影，Rust 端只返回文件。
#[tauri::command]
pub async fn lore_revision_files(
    repository_path: String,
    revision: String,
) -> Result<Vec<LoreRevisionFile>, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        collect_revision_tree_files(&repository_path, &revision).map(|files| {
            files
                .into_iter()
                .map(|file| LoreRevisionFile {
                    path: file.path,
                    size: file.size,
                })
                .collect()
        })
    })
    .await
}

/// 按需读取一个工作区文件或指定 Revision 中的图片/PDF 预览。
///
/// `revision` 为空时读取工作区真实文件；非空时只读取该不可变 Revision Tree 中
/// 精确匹配的内容。两条路径都执行仓库相对路径、格式白名单和 20 MB 大小限制。
#[tauri::command]
pub async fn lore_file_preview(
    repository_path: String,
    path: String,
    revision: Option<String>,
) -> Result<LoreFilePreview, LoreCommandError> {
    let revision = revision
        .map(|value| validate_revision(&value))
        .transpose()?;
    run_lore_task(move || build_file_preview(&repository_path, &path, revision.as_deref())).await
}

/// 读取目标 Revision 相对来源 Revision 的完整 unified diff。
///
/// 普通 Revision 继续使用 Lore 原生 `file::diff`，再用两棵不可变 Revision Tree
/// 补上空文件新增/删除这种没有文本 hunk 的结构变化。根 Revision 没有父节点，
/// 此时来源为 `None`，适配层把目标树与空树比较并从 Store 读取每个文本文件内容。
#[tauri::command]
pub async fn lore_revision_diff(
    repository_path: String,
    source_revision: Option<String>,
    target_revision: String,
    paths: Vec<String>,
    context_lines: Option<u32>,
    ignore_whitespace_eol: Option<bool>,
    ignore_whitespace_inline: Option<bool>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let source_revision = source_revision
        .map(|revision| validate_revision(&revision))
        .transpose()?;
    let target_revision = validate_revision(&target_revision)?;
    run_lore_task(move || {
        let paths = validate_optional_diff_paths(paths)?;
        let context_lines = context_lines.unwrap_or(3).min(100);

        match source_revision {
            Some(source_revision) => {
                let globals = global_args(&repository_path)?;
                let diff_paths = paths.clone();
                let diff_source_revision = source_revision.clone();
                let diff_target_revision = target_revision.clone();
                let mut result = run_operation("file.diff.revision", move |callback| {
                    lore::runtime().block_on(lore::file::diff(
                        globals,
                        LoreFileDiffArgs {
                            paths: to_lore_array(diff_paths),
                            source_revision: diff_source_revision.into(),
                            target_revision: diff_target_revision.into(),
                            diff3: 0,
                            context_lines,
                            ignore_whitespace_eol: ignore_whitespace_eol.unwrap_or(false).into(),
                            ignore_whitespace_inline: ignore_whitespace_inline
                                .unwrap_or(false)
                                .into(),
                        },
                        callback,
                    ))
                })?;
                ensure_operation_success(&result, "Read revision diff")?;

                /*
                 * Lore 文本 Diff 对“空串 → 空串”没有 hunk，因此新增或删除的零字节
                 * 文件不会产生 fileDiff。不可变树集合差可以补全这些结构变化，
                 * 又不会把当前工作区的未跟踪文件带入历史视图。
                 */
                let source_files = collect_revision_tree_files(&repository_path, &source_revision)?;
                let target_files = collect_revision_tree_files(&repository_path, &target_revision)?;
                supplement_structural_diff_events(
                    &mut result.events,
                    &source_files,
                    &target_files,
                    &paths,
                );
                Ok(result)
            }
            None => build_initial_revision_diff(
                &repository_path,
                &target_revision,
                &paths,
                context_lines,
            ),
        }
    })
    .await
}

/// 读取目标 Revision 相对第一父 Revision（或空树）的轻量文件变化清单。
///
/// 与 `lore_revision_diff` 不同，该命令不读取文件内容。根 Revision 的目标树文件
/// 全部标记为新增；普通 Revision 通过路径与内容地址比较新增、删除、修改和移动。
#[tauri::command]
pub async fn lore_revision_changes(
    repository_path: String,
    source_revision: Option<String>,
    target_revision: String,
) -> Result<Vec<LoreRevisionChange>, LoreCommandError> {
    let source_revision = source_revision
        .map(|revision| validate_revision(&revision))
        .transpose()?;
    let target_revision = validate_revision(&target_revision)?;
    run_lore_task(move || {
        let target_files = collect_revision_tree_files(&repository_path, &target_revision)?;
        let source_files = source_revision
            .as_deref()
            .map(|revision| collect_revision_tree_files(&repository_path, revision))
            .transpose()?
            .unwrap_or_default();
        Ok(compare_revision_tree_files(&source_files, &target_files))
    })
    .await
}

/// 读取单个文件的真实 Lore 历史事件。
#[tauri::command]
pub async fn lore_file_history(
    repository_path: String,
    path: String,
    branch: Option<String>,
    revision: Option<String>,
    length: Option<u32>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let path = validate_repository_relative_path(&path)?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let (branch, revision) = validate_file_history_start(branch, revision)?;

    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("file.history", move |callback| {
            lore::runtime().block_on(lore::file::history(
                globals,
                LoreFileHistoryArgs {
                    path: path.into(),
                    revision: revision.into(),
                    branch: branch.into(),
                    length: length.unwrap_or(100).clamp(1, 500),
                    depth: 1_000,
                },
                callback,
            ))
        })
    })
    .await
}

/// 丢弃明确选择的工作区文件变化。
///
/// 与历史文件还原使用的保守命令不同，这里打开 `purge`，使所选新增文件也能被
/// 删除。路径数组禁止为空且经过仓库相对路径校验，因此不会把未选中的未跟踪内容
/// 一并清理。
#[tauri::command]
pub async fn lore_discard_workspace_files(
    repository_path: String,
    paths: Vec<String>,
    revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let paths = validate_repository_relative_paths(paths)?;
        run_operation("file.discard-workspace", move |callback| {
            lore::runtime().block_on(lore::file::reset(
                globals,
                LoreFileResetArgs {
                    paths: to_lore_array(paths),
                    revision: revision.into(),
                    purge: 1,
                },
                callback,
            ))
        })
    })
    .await
}

/// 使用系统关联应用打开仓库内的文件。
#[tauri::command]
pub fn lore_open_workspace_file(
    repository_path: String,
    relative_path: String,
) -> Result<(), LoreCommandError> {
    let target_path = validate_existing_workspace_file(&repository_path, &relative_path)?;
    open::that(&target_path).map_err(|error| {
        LoreCommandError::new(
            "workspace_file_open_failed",
            format!(
                "Failed to open {} with the associated system application: {error}",
                target_path.display()
            ),
        )
    })
}

/// 使用用户配置的本地工具比较两个真实文件版本。
///
/// 工作区存在的文件直接传递真实绝对路径；空树和不可变 Revision 内容只在 Rust
/// 边界写入临时目录。进程参数不经过 Shell，临时目录会保持到工具退出后一段宽限期，
/// 兼容先启动窗口再由子进程延迟读取文件的桌面工具。
#[tauri::command]
pub async fn lore_open_external_diff(
    repository_path: String,
    tool: ExternalDiffTool,
    before: ExternalDiffSide,
    after: ExternalDiffSide,
) -> Result<ExternalDiffLaunchResult, LoreCommandError> {
    run_lore_task(move || launch_external_diff(&repository_path, tool, before, after)).await
}

/// 探测已配置工具的显式路径或系统 PATH；失效工具不返回，前端据此隐藏菜单入口。
#[tauri::command]
pub fn lore_detect_external_tools(
    tools: Vec<ExternalDiffTool>,
) -> Result<Vec<ExternalToolAvailability>, LoreCommandError> {
    if tools.len() > 64 {
        return Err(LoreCommandError::new(
            "external_tool_count_invalid",
            "No more than 64 external tools can be detected at once",
        ));
    }
    Ok(tools
        .into_iter()
        .filter_map(|tool| {
            resolve_external_executable(&tool.executable).map(|resolved| ExternalToolAvailability {
                tool_id: tool.id,
                resolved_executable: display_path_without_windows_verbatim_prefix(&resolved),
            })
        })
        .collect())
}

/// 为真实冲突文件启动四路外部 Merge。
#[tauri::command]
pub async fn lore_open_external_merge(
    repository_path: String,
    tool: ExternalDiffTool,
    path: String,
    current_revision: String,
    incoming_revision: String,
    labels: ExternalMergeLabels,
) -> Result<ExternalDiffLaunchResult, LoreCommandError> {
    run_lore_task(move || {
        launch_external_merge(
            &repository_path,
            tool,
            &path,
            &current_revision,
            &incoming_revision,
            labels,
        )
    })
    .await
}

/// 把真实 unified patch 写入临时目录并交给系统关联应用。
#[tauri::command]
pub fn lore_open_patch(file_name: String, patch: String) -> Result<String, LoreCommandError> {
    validate_patch_content(&patch)?;
    let safe_name = sanitize_patch_name(&file_name);
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            LoreCommandError::new(
                "system_time_invalid",
                format!("Failed to create a temporary patch because the system clock is invalid: {error}"),
            )
        })?
        .as_nanos();
    let destination = std::env::temp_dir().join(format!("lore-client-{unique}-{safe_name}.patch"));
    std::fs::write(&destination, patch).map_err(|error| {
        LoreCommandError::new(
            "patch_write_failed",
            format!(
                "Failed to write temporary patch {}: {error}",
                destination.display()
            ),
        )
    })?;
    open::that(&destination).map_err(|error| {
        LoreCommandError::new(
            "patch_open_failed",
            format!("Failed to open the patch with the associated system application: {error}"),
        )
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

/// 把 unified patch 保存到用户通过原生对话框明确选择的位置。
#[tauri::command]
pub fn lore_write_patch_file(
    destination_path: String,
    patch: String,
) -> Result<(), LoreCommandError> {
    validate_patch_content(&patch)?;
    let destination = PathBuf::from(destination_path.trim());
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(LoreCommandError::new(
            "invalid_patch_destination",
            "The patch destination must be an absolute path that includes a file name",
        ));
    }
    let parent = destination.parent().ok_or_else(|| {
        LoreCommandError::new(
            "invalid_patch_destination",
            "The patch destination has no parent directory",
        )
    })?;
    if !parent.is_dir() {
        return Err(LoreCommandError::new(
            "patch_parent_missing",
            format!(
                "The patch destination directory does not exist: {}",
                parent.display()
            ),
        ));
    }
    std::fs::write(&destination, patch).map_err(|error| {
        LoreCommandError::new(
            "patch_write_failed",
            format!("Failed to save patch {}: {error}", destination.display()),
        )
    })
}

/// 把所选路径或扩展名规则追加到 Lore 官方 `.loreignore` 文件。
///
/// 前端只选择“按路径”或“按扩展名”，规则文本始终由 Rust 从已校验路径生成，
/// 避免换行注入或意外写入任意过滤表达式。
#[tauri::command]
pub fn lore_ignore_paths(
    repository_path: String,
    paths: Vec<String>,
    by_extension: bool,
) -> Result<Vec<String>, LoreCommandError> {
    let repository_path = validate_repository_path(&repository_path)?;
    let paths = validate_repository_relative_paths(paths)?;
    let rules = build_ignore_rules(&paths, by_extension)?;
    let ignore_path = repository_path.join(".loreignore");
    // 已存在的忽略文件可能包含用户手写规则，读取失败时必须停止，不能把异常误判为空文件后覆盖。
    let existing = match std::fs::read_to_string(&ignore_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(LoreCommandError::new(
                "ignore_read_failed",
                format!("Failed to read {}: {error}", ignore_path.display()),
            ))
        }
    };
    let mut existing_rules = existing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut appended = Vec::new();
    for rule in rules {
        if !existing_rules.iter().any(|current| current == &rule) {
            existing_rules.push(rule.clone());
            appended.push(rule);
        }
    }
    if appended.is_empty() {
        return Ok(appended);
    }

    let mut content = existing_rules.join("\n");
    content.push('\n');
    std::fs::write(&ignore_path, content).map_err(|error| {
        LoreCommandError::new(
            "ignore_write_failed",
            format!("Failed to update {}: {error}", ignore_path.display()),
        )
    })?;
    Ok(appended)
}

/// 提交当前已经 Stage 的文件。
#[tauri::command]
pub async fn lore_commit(
    repository_path: String,
    message: String,
    default_identity: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let message = message.trim().to_owned();
    if message.is_empty() {
        return Err(LoreCommandError::new(
            "empty_commit_message",
            "The revision message must not be empty",
        ));
    }

    run_lore_task(move || {
        /*
         * Lore 自身的显式 global identity 优先于仓库配置，因此不能直接把客户端
         * 默认值塞进去。这里先从磁盘解析仓库配置，只有仓库值不存在时才采用默认值，
         * 再把最终值显式传给本次调用，确保身份优先级不会受在线认证缓存影响。
         */
        let mut globals = global_args(&repository_path)?;
        /*
         * 受保护远端的显式绑定必须保留：固定 Lore 版本用同一个 identity 选择 JWT
         * 并写入 Revision 创建者。未绑定仓库继续沿用“仓库 identity > 客户端默认”
         * 的离线提交规则。
         */
        if globals.identity.is_empty() {
            let commit_identity =
                resolve_commit_identity(&repository_path, default_identity.as_deref())?;
            globals.identity = commit_identity.into();
        }
        run_operation("revision.commit", move |callback| {
            lore::runtime().block_on(lore::revision::commit(
                globals,
                LoreRevisionCommitArgs {
                    message: message.into(),
                    ..Default::default()
                },
                callback,
            ))
        })
    })
    .await
}

/// 同步工作目录到当前 Branch 的目标 Revision。
#[tauri::command]
pub async fn lore_sync(
    repository_path: String,
    dependency_root_files: Vec<String>,
    dependency_tags: Vec<String>,
    dependency_recursive: bool,
    dependency_depth_limit: u32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let dependency_root_files = validate_optional_dependency_paths(dependency_root_files)?;
    let dependency_tags = validate_dependency_tags(dependency_tags)?;
    validate_dependency_depth_limit(dependency_depth_limit)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.sync", move |callback| {
            lore::runtime().block_on(lore::revision::sync(
                globals,
                LoreRevisionSyncArgs {
                    root_files: to_lore_array(dependency_root_files),
                    dependency_tags: to_lore_array(dependency_tags),
                    dependency_recursive: u8::from(dependency_recursive),
                    dependency_depth_limit,
                    ..Default::default()
                },
                callback,
            ))
        })
    })
    .await
}

/// 将当前或指定 Branch 推送到远端。
#[tauri::command]
pub async fn lore_push(
    repository_path: String,
    branch: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.push", move |callback| {
            lore::runtime().block_on(lore::branch::push(
                globals,
                LoreBranchPushArgs {
                    branch: branch.unwrap_or_default().into(),
                    fast_forward_merge: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 切换工作目录到指定 Branch，并可显式附着到该 Branch 的精确 latest Revision。
///
/// 当前实例可能已经属于目标 Branch、但停在更早的 Revision。此时空 Revision 的
/// Lore Switch 会视为无需切换，因此 Branch 检出入口必须传入列表快照中的 latest。
#[tauri::command]
pub async fn lore_branch_switch(
    repository_path: String,
    branch: String,
    revision: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let revision = revision
        .filter(|revision| !revision.trim().is_empty())
        .map(|revision| validate_revision(&revision))
        .transpose()?;

    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.switch", move |callback| {
            lore::runtime().block_on(lore::branch::switch(
                globals,
                LoreBranchSwitchArgs {
                    branch: branch.into(),
                    revision: revision.unwrap_or_default().into(),
                    reset: 0,
                    bare: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 把当前实例附着在指定 Branch 的目标 Revision 上。
///
/// Lore 没有 Git detached HEAD；Branch 的 latest 指针保持不变，只有当前实例锚点和
/// 工作区被同步到目标 Revision。`reset` 与 `force` 均未启用，因此 Stage 内容仍受
/// Lore Core 的丢失保护。
#[tauri::command]
pub async fn lore_revision_checkout(
    repository_path: String,
    branch: String,
    revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.checkout", move |callback| {
            lore::runtime().block_on(lore::branch::switch(
                globals,
                LoreBranchSwitchArgs {
                    branch: branch.into(),
                    revision: revision.into(),
                    reset: 0,
                    bare: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 把指定 Revision 的变更应用到当前 Branch；无冲突时沿用源 Revision 说明自动提交。
#[tauri::command]
pub async fn lore_revision_cherry_pick(
    repository_path: String,
    revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.cherry-pick", move |callback| {
            lore::runtime().block_on(lore::revision::cherry_pick(
                globals,
                LoreRevisionCherryPickArgs {
                    revision: revision.into(),
                    // 空说明会由 Lore Core 复用源 Revision 的提交说明。
                    message: LoreString::default(),
                    no_commit: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 在当前 Branch 创建一个撤销目标 Revision 的新 Revision。
#[tauri::command]
pub async fn lore_revision_revert(
    repository_path: String,
    revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.revert", move |callback| {
            lore::runtime().block_on(lore::revision::revert(
                globals,
                LoreRevisionRevertArgs {
                    revision: revision.into(),
                    // 由 Lore Core 生成默认 Revert 说明，避免客户端复制上游格式规则。
                    message: LoreString::default(),
                    no_commit: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 把指定源 Branch 合并到当前 Branch；无冲突时自动创建合并 Revision。
#[tauri::command]
pub async fn lore_branch_merge(
    repository_path: String,
    branch: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    let message = format!("Merge branch {branch}");
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.merge-start", move |callback| {
            lore::runtime().block_on(lore::branch::merge_start(
                globals,
                LoreBranchMergeStartArgs {
                    branch: branch.into(),
                    message: message.into(),
                    no_commit: 0,
                    link: LoreString::default(),
                    ignore_links: 0,
                },
                callback,
            ))
        })
    })
    .await
}

/// 从 Lore 持久化的 staged Revision 恢复当前冲突操作类型。
///
/// Status 提供 staged / incoming Revision；Revision Info 的顶层元数据进一步区分
/// Cherry-pick 与 Revert，第二父 Revision则识别普通 Merge。整个过程只调用
/// 固定版本的程序化接口，不解析 CLI 文本，也不读取 `.lore` 内部二进制格式。
#[tauri::command]
pub async fn lore_conflict_session(
    repository_path: String,
) -> Result<Option<LoreConflictSession>, LoreCommandError> {
    run_lore_task(move || {
        let status_globals = global_args(&repository_path)?;
        let status = run_operation("conflict.session.status", move |callback| {
            lore::runtime().block_on(lore::repository::status(
                status_globals,
                LoreRepositoryStatusArgs {
                    staged: 1,
                    scan: 0,
                    check_dirty: 0,
                    reset: 0,
                    sync_point: 0,
                    // 需要文件事件确认 staged State 真的包含冲突；普通 Stage 同样会
                    // 产生不同于当前锚点的 staged Revision，不能据此误判为冲突会话。
                    revision_only: 0,
                    count: 0,
                    paths: LoreArray::default(),
                },
                callback,
            ))
        })?;
        ensure_conflict_read_succeeded(&status, "Read conflict status")?;
        if !status.events.iter().any(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/flagConflict").is_some_and(|value| {
                    value.as_bool().unwrap_or(false) || value.as_u64().is_some_and(|flag| flag != 0)
                })
        }) {
            return Ok(None);
        }

        let Some((current_revision, staged_revision, incoming_revision)) =
            conflict_revision_ids(&status.events)
        else {
            return Ok(None);
        };
        if is_zero_hash(&staged_revision) || staged_revision == current_revision {
            return Ok(None);
        }

        let info_globals = global_args(&repository_path)?;
        let staged_for_info = staged_revision.clone();
        let info = run_operation("conflict.session.revision-info", move |callback| {
            lore::runtime().block_on(lore::revision::info(
                info_globals,
                LoreRevisionInfoArgs {
                    revision: staged_for_info.into(),
                    // 顶层 Revision 元数据无论此开关都会发出；关闭它可避免遍历每个文件的元数据。
                    delta: 0,
                    metadata: 0,
                },
                callback,
            ))
        })?;
        ensure_conflict_read_succeeded(&info, "Read conflict revision information")?;

        Ok(Some(LoreConflictSession {
            kind: classify_conflict_operation(&info.events, incoming_revision.as_deref()),
            current_revision,
            staged_revision,
            incoming_revision,
        }))
    })
    .await
}

/// 对当前冲突会话执行一个经过类型和路径验证的真实 Lore 动作。
///
/// 操作类型来自上面的持久状态查询，并且 Lore Core 会在每个具体入口再次验证
/// staged State 的真实类型；即使前端持有旧快照，也不会把 Merge 命令误用于 Revert。
#[tauri::command]
pub async fn lore_conflict_action(
    repository_path: String,
    operation: LoreConflictOperationKind,
    action: LoreConflictAction,
    paths: Vec<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    if operation == LoreConflictOperationKind::Unknown {
        return Err(LoreCommandError::new(
            "unknown_conflict_operation",
            "The current Lore conflict operation type is unknown; refresh the repository state or verify the repository",
        ));
    }
    let paths = validate_conflict_action_paths(action, paths)?;

    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        let lore_paths = || to_lore_array(paths.clone());
        match (operation, action) {
            (LoreConflictOperationKind::Merge, LoreConflictAction::Resolve) => {
                run_operation("branch.merge-resolve", move |callback| {
                    lore::runtime().block_on(lore::branch::merge_resolve(
                        globals,
                        LoreBranchMergeResolveArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Merge, LoreConflictAction::Mine) => {
                run_operation("branch.merge-resolve-mine", move |callback| {
                    lore::runtime().block_on(lore::branch::merge_resolve_mine(
                        globals,
                        LoreBranchMergeResolveMineArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Merge, LoreConflictAction::Theirs) => {
                run_operation("branch.merge-resolve-theirs", move |callback| {
                    lore::runtime().block_on(lore::branch::merge_resolve_theirs(
                        globals,
                        LoreBranchMergeResolveTheirsArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Merge, LoreConflictAction::Unresolve) => {
                run_operation("branch.merge-unresolve", move |callback| {
                    lore::runtime().block_on(lore::branch::merge_unresolve(
                        globals,
                        LoreBranchMergeUnresolveArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Merge, LoreConflictAction::Restart) => {
                run_operation("branch.merge-restart", move |callback| {
                    lore::runtime().block_on(lore::branch::merge_restart(
                        globals,
                        LoreBranchMergeRestartArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Merge, LoreConflictAction::Abort) => {
                run_operation("branch.merge-abort", move |callback| {
                    lore::runtime().block_on(lore::branch::merge_abort(
                        globals,
                        LoreBranchMergeAbortArgs {
                            link: LoreString::default(),
                            ignore_links: 0,
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::CherryPick, LoreConflictAction::Resolve) => {
                run_operation("revision.cherry-pick-resolve", move |callback| {
                    lore::runtime().block_on(lore::revision::cherry_pick_resolve(
                        globals,
                        LoreRevisionCherryPickResolveArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::CherryPick, LoreConflictAction::Mine) => {
                run_operation("revision.cherry-pick-resolve-mine", move |callback| {
                    lore::runtime().block_on(lore::revision::cherry_pick_resolve_mine(
                        globals,
                        LoreRevisionCherryPickResolveMineArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::CherryPick, LoreConflictAction::Theirs) => {
                run_operation("revision.cherry-pick-resolve-theirs", move |callback| {
                    lore::runtime().block_on(lore::revision::cherry_pick_resolve_theirs(
                        globals,
                        LoreRevisionCherryPickResolveTheirsArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::CherryPick, LoreConflictAction::Unresolve) => {
                run_operation("revision.cherry-pick-unresolve", move |callback| {
                    lore::runtime().block_on(lore::revision::cherry_pick_unresolve(
                        globals,
                        LoreRevisionCherryPickUnresolveArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::CherryPick, LoreConflictAction::Restart) => {
                run_operation("revision.cherry-pick-restart", move |callback| {
                    lore::runtime().block_on(lore::revision::cherry_pick_restart(
                        globals,
                        LoreRevisionCherryPickRestartArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::CherryPick, LoreConflictAction::Abort) => {
                run_operation("revision.cherry-pick-abort", move |callback| {
                    lore::runtime().block_on(lore::revision::cherry_pick_abort(
                        globals,
                        LoreRevisionCherryPickAbortArgs {},
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Revert, LoreConflictAction::Resolve) => {
                run_operation("revision.revert-resolve", move |callback| {
                    lore::runtime().block_on(lore::revision::revert_resolve(
                        globals,
                        LoreRevisionRevertResolveArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Revert, LoreConflictAction::Mine) => {
                run_operation("revision.revert-resolve-mine", move |callback| {
                    lore::runtime().block_on(lore::revision::revert_resolve_mine(
                        globals,
                        LoreRevisionRevertResolveMineArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Revert, LoreConflictAction::Theirs) => {
                run_operation("revision.revert-resolve-theirs", move |callback| {
                    lore::runtime().block_on(lore::revision::revert_resolve_theirs(
                        globals,
                        LoreRevisionRevertResolveTheirsArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Revert, LoreConflictAction::Unresolve) => {
                run_operation("revision.revert-unresolve", move |callback| {
                    lore::runtime().block_on(lore::revision::revert_unresolve(
                        globals,
                        LoreRevisionRevertUnresolveArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Revert, LoreConflictAction::Restart) => {
                run_operation("revision.revert-restart", move |callback| {
                    lore::runtime().block_on(lore::revision::revert_restart(
                        globals,
                        LoreRevisionRevertRestartArgs {
                            paths: lore_paths(),
                        },
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Revert, LoreConflictAction::Abort) => {
                run_operation("revision.revert-abort", move |callback| {
                    lore::runtime().block_on(lore::revision::revert_abort(
                        globals,
                        LoreRevisionRevertAbortArgs {},
                        callback,
                    ))
                })
            }
            (LoreConflictOperationKind::Unknown, _) => {
                unreachable!("Unknown operation types are rejected before the task starts")
            }
        }
    })
    .await
}

/// 归档指定本地 Branch；联网模式下 Lore Core 同步归档其远端指针。
#[tauri::command]
pub async fn lore_branch_archive(
    repository_path: String,
    branch: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.archive", move |callback| {
            lore::runtime().block_on(lore::branch::archive(
                globals,
                LoreBranchArchiveArgs {
                    branch: branch.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 使用系统文件管理器打开当前工作区。
#[tauri::command]
pub fn lore_open_workspace(repository_path: String) -> Result<(), LoreCommandError> {
    let repository_path = validate_repository_path(&repository_path)?;

    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command.arg(&repository_path).spawn().map_err(|error| {
        LoreCommandError::new(
            "workspace_open_failed",
            format!(
                "Failed to open {} in the system file manager: {error}",
                repository_path.display()
            ),
        )
    })?;
    Ok(())
}

/// 在系统文件管理器中定位仓库内的单个文件。
///
/// 文件可能已经被 Revision 删除，此时无法选中具体文件，命令会退回到最近仍存在的
/// 父目录。路径解析后还会检查真实路径仍位于仓库内，防止符号链接越界。
#[tauri::command]
pub fn lore_reveal_workspace_file(
    repository_path: String,
    relative_path: String,
) -> Result<(), LoreCommandError> {
    let repository_path = validate_repository_path(&repository_path)?;
    let relative_path = validate_repository_relative_path(&relative_path)?;
    let target_path = repository_path.join(relative_path);
    let target_exists = target_path.exists();

    let mut existing_path = if target_exists {
        target_path.clone()
    } else {
        target_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| repository_path.clone())
    };
    while !existing_path.exists() && existing_path.pop() {}

    let existing_path = std::fs::canonicalize(&existing_path).map_err(|error| {
        LoreCommandError::new(
            "workspace_file_parent_unavailable",
            format!(
                "Failed to resolve the containing directory {}: {error}",
                existing_path.display()
            ),
        )
    })?;
    if !existing_path.starts_with(&repository_path) {
        return Err(LoreCommandError::new(
            "workspace_file_outside_repository",
            "The target file resolves outside the Lore repository",
        ));
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        if target_exists {
            command.arg("/select,").arg(&target_path);
        } else {
            command.arg(&existing_path);
        }
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if target_exists {
            command.arg("-R").arg(&target_path);
        } else {
            command.arg(&existing_path);
        }
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        // 大多数 Linux 文件管理器没有统一的“选中文件”参数，因此打开所在目录。
        let mut command = Command::new("xdg-open");
        let directory = if target_exists {
            target_path
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| repository_path.clone())
        } else {
            existing_path.clone()
        };
        command.arg(directory);
        command
    };

    command.spawn().map_err(|error| {
        LoreCommandError::new(
            "workspace_file_reveal_failed",
            format!(
                "Failed to reveal {} in the system file manager: {error}",
                target_path.display()
            ),
        )
    })?;
    Ok(())
}

/// 读取并解析全部标签元数据记录；无关仓库元数据和损坏记录不会进入 UI。
///
/// 损坏的单条标签不应阻断整个仓库打开。它仍保留在仓库元数据中，方便后续版本
/// 提供诊断或迁移工具；这里仅过滤无法安全解释的数据。
fn read_tag_records(repository_path: &str) -> Result<Vec<LoreTagRecord>, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let result = run_operation("tag.list", move |callback| {
        lore::runtime().block_on(lore::repository::metadata_get(
            globals,
            LoreRepositoryMetadataGetArgs {
                key: LoreString::default(),
            },
            callback,
        ))
    })?;
    ensure_tag_operation_succeeded(&result, "tag_metadata_read_failed", "Read tag")?;

    Ok(result
        .events
        .iter()
        .filter_map(parse_tag_metadata_event)
        .collect())
}

/// 从 Lore 的带标签枚举事件中提取字符串元数据并反序列化客户端标签。
fn parse_tag_metadata_event(event: &Value) -> Option<LoreTagRecord> {
    if event.get("tagName")?.as_str()? != "metadata" {
        return None;
    }
    let data = event.get("data")?;
    let key = data.get("key")?.as_str()?.to_owned();
    if !key.starts_with(TAG_METADATA_PREFIX) {
        return None;
    }

    let value = data.get("value")?;
    let serialized = if value.get("tagName")?.as_str()? == "string" {
        value.get("data")?.as_str()?
    } else {
        return None;
    };
    let tag = serde_json::from_str::<LoreTag>(serialized).ok()?;
    if tag.id.trim().is_empty()
        || validate_tag_name(&tag.name).is_err()
        || validate_branch_name(&tag.branch).is_err()
        || validate_revision(&tag.revision).is_err()
    {
        return None;
    }
    Some(LoreTagRecord { key, tag })
}

/// 按稳定 ID 合并改名部分成功留下的重复记录，并提供可预测的更新时间排序。
fn deduplicate_tag_records(records: Vec<LoreTagRecord>) -> Vec<LoreTagRecord> {
    let mut newest_by_id = HashMap::<String, LoreTagRecord>::new();
    for record in records {
        let should_replace = newest_by_id
            .get(&record.tag.id)
            .map(|current| {
                record.tag.updated_at > current.tag.updated_at
                    || (record.tag.updated_at == current.tag.updated_at && record.key > current.key)
            })
            .unwrap_or(true);
        if should_replace {
            newest_by_id.insert(record.tag.id.clone(), record);
        }
    }

    let mut deduplicated = newest_by_id.into_values().collect::<Vec<_>>();
    deduplicated.sort_by(|left, right| {
        right
            .tag
            .updated_at
            .cmp(&left.tag.updated_at)
            .then_with(|| left.tag.name.cmp(&right.tag.name))
    });
    deduplicated
}

fn newest_tag_record(
    records: &[LoreTagRecord],
    tag_id: &str,
) -> Result<LoreTagRecord, LoreCommandError> {
    records
        .iter()
        .filter(|record| record.tag.id == tag_id)
        .max_by(|left, right| {
            left.tag
                .updated_at
                .cmp(&right.tag.updated_at)
                .then_with(|| left.key.cmp(&right.key))
        })
        .cloned()
        .ok_or_else(|| {
            LoreCommandError::new(
                "tag_not_found",
                "The tag to update no longer exists; refresh the repository state",
            )
        })
}

/// 在去重前检查名称占用，防止旧键或部分成功记录被无意覆盖。
fn ensure_tag_name_available(
    records: &[LoreTagRecord],
    name: &str,
    current_tag_id: Option<&str>,
) -> Result<(), LoreCommandError> {
    if records
        .iter()
        .any(|record| record.tag.name == name && Some(record.tag.id.as_str()) != current_tag_id)
    {
        return Err(LoreCommandError::new(
            "tag_name_exists",
            format!("Tag \"{name}\" already exists; choose another name"),
        ));
    }
    Ok(())
}

/// 写入单个标签的 JSON 字符串；Lore Core 会负责远端比较交换与本地缓存更新。
fn write_tag(repository_path: &str, tag: &LoreTag) -> Result<(), LoreCommandError> {
    let key = tag_metadata_key(&tag.name);
    let value = serde_json::to_string(tag).map_err(|error| {
        LoreCommandError::new(
            "tag_serialization_failed",
            format!("Failed to serialize tag data: {error}"),
        )
    })?;
    let globals = global_args(repository_path)?;
    let result = run_operation("tag.write", move |callback| {
        lore::runtime().block_on(lore::repository::metadata_set(
            globals,
            LoreRepositoryMetadataSetArgs {
                keys: LoreArray::from_vec(vec![key.into()]),
                values: LoreArray::from_vec(vec![value.into()]),
                formats: LoreArray::from_vec(vec![LoreMetadataType::String]),
            },
            callback,
        ))
    })?;
    ensure_tag_operation_succeeded(&result, "tag_metadata_write_failed", "Save tag")
}

/// 批量清理标签键；空数组是本适配层的“无需操作”，绝不能传给 Lore，
/// 因为 Lore 的空 keys 语义是清除仓库全部用户元数据。
fn clear_tag_keys(repository_path: &str, keys: Vec<String>) -> Result<(), LoreCommandError> {
    if keys.is_empty() {
        return Ok(());
    }
    let globals = global_args(repository_path)?;
    let result = run_operation("tag.clear", move |callback| {
        lore::runtime().block_on(lore::repository::metadata_clear(
            globals,
            LoreRepositoryMetadataClearArgs {
                keys: LoreArray::from_vec(keys.into_iter().map(LoreString::from).collect()),
            },
            callback,
        ))
    })?;
    ensure_tag_operation_succeeded(&result, "tag_metadata_clear_failed", "Delete tag")
}

/// 把 Lore 的终止错误转换为 Tauri 可序列化错误，同时尽量保留 Core 原始信息。
fn ensure_tag_operation_succeeded(
    result: &LoreOperationResult,
    code: &'static str,
    action: &str,
) -> Result<(), LoreCommandError> {
    if result.status == 0 {
        return Ok(());
    }
    let detail = result
        .events
        .iter()
        .rev()
        .find_map(|event| {
            if event.get("tagName")?.as_str()? == "complete" {
                event
                    .pointer("/data/error/message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
            } else if event.get("tagName")?.as_str()? == "error" {
                event
                    .pointer("/data/errorInner")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
            } else {
                None
            }
        })
        .unwrap_or("Lore Core did not return error details");
    Err(LoreCommandError::new(
        code,
        format!("{action} failed (status {}): {detail}", result.status),
    ))
}

fn tag_metadata_key(name: &str) -> String {
    format!("{TAG_METADATA_PREFIX}{name}")
}

fn validate_tag_name(name: &str) -> Result<String, LoreCommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(LoreCommandError::new(
            "empty_tag_name",
            "The tag name must not be empty",
        ));
    }
    if name.chars().count() > 128 {
        return Err(LoreCommandError::new(
            "tag_name_too_long",
            "The tag name must not exceed 128 characters",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "invalid_tag_name",
            "The tag name must not contain control characters or line breaks",
        ));
    }
    Ok(name.to_owned())
}

fn validate_tag_id(tag_id: &str) -> Result<String, LoreCommandError> {
    let tag_id = tag_id.trim();
    if tag_id.is_empty() || tag_id.chars().any(char::is_whitespace) {
        return Err(LoreCommandError::new(
            "invalid_tag_id",
            "The tag ID is invalid",
        ));
    }
    Ok(tag_id.to_owned())
}

fn validate_tag_message(message: &str) -> Result<String, LoreCommandError> {
    let message = message.trim();
    if message.chars().count() > 4_096 {
        return Err(LoreCommandError::new(
            "tag_message_too_long",
            "The tag description must not exceed 4096 characters",
        ));
    }
    if message.contains('\0') {
        return Err(LoreCommandError::new(
            "invalid_tag_message",
            "The tag description must not contain null characters",
        ));
    }
    Ok(message.to_owned())
}

/// Amend 与 Restore 都会写入 Revision 元数据，沿用提交消息的非空语义并限制体积。
fn validate_revision_message(message: &str) -> Result<String, LoreCommandError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(LoreCommandError::new(
            "empty_revision_message",
            "The revision message must not be empty",
        ));
    }
    if message.chars().count() > 16_384 || message.contains('\0') {
        return Err(LoreCommandError::new(
            "invalid_revision_message",
            "The revision message is invalid or exceeds 16384 characters",
        ));
    }
    Ok(message.to_owned())
}

fn unix_time_millis() -> Result<u64, LoreCommandError> {
    unix_time_duration().map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn unix_time_nanos() -> Result<u128, LoreCommandError> {
    unix_time_duration().map(|duration| duration.as_nanos())
}

fn unix_time_duration() -> Result<std::time::Duration, LoreCommandError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            LoreCommandError::new(
                "system_time_invalid",
                format!("Failed to create the tag because the system time is before the Unix epoch: {error}"),
            )
        })
}

/// 从所选目录向上寻找 Lore 元数据；损坏的元数据文件也视为“受 Lore 管理”，
/// 这样打开失败时会暴露损坏错误，而不是提供可能覆盖现场的初始化入口。
fn probe_repository_directory(selected_path: &Path) -> RepositoryDirectoryProbe {
    let repository_path = selected_path
        .ancestors()
        .find(|candidate| candidate.join(".urc").exists() || candidate.join(".lore").exists())
        .map(display_path_without_windows_verbatim_prefix);
    RepositoryDirectoryProbe {
        kind: if repository_path.is_some() {
            RepositoryDirectoryKind::Repository
        } else {
            RepositoryDirectoryKind::Unmanaged
        },
        selected_path: display_path_without_windows_verbatim_prefix(selected_path),
        repository_path,
    }
}

/// 在普通目录中创建离线 Lore 仓库，并保留客户端默认身份的“仅兜底”语义。
fn initialize_repository(
    directory_path: &str,
    repository_name: &str,
    description: &str,
    repository_identity: &str,
    default_identity: Option<&str>,
) -> Result<LoreRepositoryInitializeResult, LoreCommandError> {
    let repository_path = validate_existing_directory(directory_path, "Initialization directory")?;
    let probe = probe_repository_directory(&repository_path);
    if let Some(existing_root) = probe.repository_path {
        /*
         * Windows 的 canonicalize 可能返回带 `\\?\` 前缀的路径，而 IPC DTO 会
         * 主动移除该前缀。这里比较同一展示格式，避免把仓库根目录误报成子目录。
         */
        let selected_path = display_path_without_windows_verbatim_prefix(&repository_path);
        let code = if existing_root.eq_ignore_ascii_case(&selected_path) {
            "repository_already_initialized"
        } else {
            "directory_inside_repository"
        };
        return Err(LoreCommandError::new(
            code,
            format!("The directory is already inside a Lore repository: {existing_root}"),
        ));
    }

    let repository_name = validate_repository_name(repository_name)?;
    let description = validate_repository_description(description)?;
    let repository_identity = normalize_identity(repository_identity)?;
    let default_identity = normalize_identity(default_identity.unwrap_or_default())?;
    let repository_path_string = display_path_without_windows_verbatim_prefix(&repository_path);
    let mut globals = LoreGlobalArgs {
        repository_path: repository_path_string.clone().into(),
        working_directory: repository_path_string.clone().into(),
        // 单一仓库名只有在 offline/local 模式下才是 Lore 的合法 Create 输入。
        offline: 1,
        store_keep_alive: 1,
        store_keep_alive_seconds: 30,
        ..Default::default()
    };
    globals.identity = repository_identity.clone().unwrap_or_default().into();

    let args = LoreRepositoryCreateArgs {
        repository_url: repository_name.into(),
        id: LoreString::default(),
        description: description.into(),
        use_shared_store: 0,
        shared_store_path: LoreString::default(),
    };
    let result = if repository_identity.is_none() {
        if let Some(default_identity) = default_identity {
            /*
             * create_with_metadata 允许把客户端默认身份记作仓库创建者，同时 globals
             * 保持无 identity，因此新仓库配置仍然留空并继续依赖客户端默认兜底。
             */
            let metadata = LoreRepositoryCreateMetadata {
                creator: default_identity.into(),
                created: unix_time_millis()?,
            };
            run_operation("repository.create.local", move |callback| {
                lore::runtime().block_on(lore::repository::create_with_metadata(
                    globals, args, metadata, callback,
                ))
            })?
        } else {
            run_operation("repository.create.local", move |callback| {
                lore::runtime().block_on(lore::repository::create(globals, args, callback))
            })?
        }
    } else {
        run_operation("repository.create.local", move |callback| {
            lore::runtime().block_on(lore::repository::create(globals, args, callback))
        })?
    };

    Ok(LoreRepositoryInitializeResult {
        repository_path: repository_path_string,
        result,
    })
}

/// 使用固定 Lore 版本的在线 Create 在临时目录建立同 ID 远端，然后发布原仓库。
fn publish_repository(
    repository_path: &str,
    repository_name: &str,
    description: &str,
    identity: &str,
    default_identity: Option<&str>,
    server_url: &str,
    branch: &str,
    user_id: Option<&str>,
    use_auth_account: bool,
) -> Result<LoreRepositoryPublishResult, LoreCommandError> {
    let repository_path = validate_repository_path(repository_path)?;
    let repository_name = validate_repository_name(repository_name)?;
    let description = validate_repository_description(description)?;
    let server_url = validate_server_url(server_url)?;
    let repository_url = build_repository_url(&server_url, &repository_name)?;
    let branch = validate_branch_name(branch)?;
    let repository_id = read_repository_id(&repository_path)?;
    let repository_identity = normalize_identity(identity)?;
    let effective_identity = repository_identity
        .clone()
        .or(normalize_identity(default_identity.unwrap_or_default())?);
    /*
     * Lore 0.x 的 GlobalArgs.identity 在联网操作中是 Token Store 的 userId，
     * 不能复用仓库提交身份。显式参数用于首次发布；Rust 内存绑定作为旧调用方兼容回退。
     */
    let auth_identity = resolve_publish_auth_identity(
        user_id,
        bound_auth_identity(&repository_path)?.as_deref(),
        use_auth_account,
    );

    /*
     * Create 之前先按稳定 Repository ID 查询服务器。发布的前置阶段可能已在上次尝试
     * 成功，重复 Create 会被 Lore 拒绝；同 ID 同名时应恢复并继续配置与 Push，同 ID
     * 异名时必须阻止覆盖并把服务器权威名称返回给前端。
     */
    let preflight_globals = LoreGlobalArgs {
        identity: auth_identity.clone().into(),
        ..Default::default()
    };
    let preflight_server_url = server_url.clone();
    let preflight_result = run_operation("repository.list.publish-preflight", move |callback| {
        lore::runtime().block_on(lore::repository::list(
            preflight_globals,
            LoreRepositoryListArgs {
                url: preflight_server_url.into(),
            },
            callback,
        ))
    })?;
    let existing_remote_name =
        find_remote_repository_name(&preflight_result, &repository_id).map(str::to_owned);
    if let Some(existing_name) = existing_remote_name.as_deref() {
        if existing_name != repository_name {
            return Ok(LoreRepositoryPublishResult {
                repository_url: build_repository_url(&server_url, existing_name)?,
                remote_created: false,
                remote_preexisting: true,
                existing_remote_name,
                requested_remote_name: repository_name.clone(),
                configuration_updated: false,
                pushed: false,
                create_result: preflight_result,
                push_result: None,
                failure_stage: Some(LoreRepositoryPublishFailureStage::RemoteCreate),
                failure_code: Some("remote_repository_name_mismatch".to_owned()),
                failure_message: None,
            });
        }
    }
    let remote_preexisting = existing_remote_name.is_some();

    let create_result = if remote_preexisting {
        preflight_result
    } else {
        let temporary_directory = tempfile::Builder::new()
            .prefix("lore-client-publish-")
            .tempdir()
            .map_err(|error| {
                LoreCommandError::new(
                    "publish_temporary_directory_failed",
                    format!(
                        "Failed to create a temporary directory for remote publication: {error}"
                    ),
                )
            })?;
        let temporary_path =
            display_path_without_windows_verbatim_prefix(temporary_directory.path());
        let mut create_globals = LoreGlobalArgs {
            repository_path: temporary_path.clone().into(),
            working_directory: temporary_path.into(),
            ..Default::default()
        };
        create_globals.identity = auth_identity.clone().into();
        let create_repository_url = repository_url.clone();
        let create_args = LoreRepositoryCreateArgs {
            repository_url: create_repository_url.into(),
            id: repository_id.clone().into(),
            description: description.into(),
            use_shared_store: 0,
            shared_store_path: LoreString::default(),
        };
        if let Some(creator) = effective_identity {
            let metadata = LoreRepositoryCreateMetadata {
                creator: creator.into(),
                created: unix_time_millis()?,
            };
            run_operation("repository.create.remote", move |callback| {
                lore::runtime().block_on(lore::repository::create_with_metadata(
                    create_globals,
                    create_args,
                    metadata,
                    callback,
                ))
            })?
        } else {
            run_operation("repository.create.remote", move |callback| {
                lore::runtime().block_on(lore::repository::create(
                    create_globals,
                    create_args,
                    callback,
                ))
            })?
        }
    };

    if create_result.status != 0 {
        let failure_message = operation_failure_message(
            &create_result,
            "Lore failed to create the remote repository",
        );
        /*
         * 只有服务端明确返回标准认证无效错误时才允许前端启动交互登录并安全重试；
         * Create 尚未成功，因此该重试不会重复创建已经存在的远端仓库。
         */
        let failure_code = if operation_requires_authentication(&create_result) {
            "auth_required"
        } else {
            "remote_repository_create_failed"
        };
        return Ok(LoreRepositoryPublishResult {
            repository_url,
            remote_created: false,
            remote_preexisting: false,
            existing_remote_name: None,
            requested_remote_name: repository_name.clone(),
            configuration_updated: false,
            pushed: false,
            create_result,
            push_result: None,
            failure_stage: Some(LoreRepositoryPublishFailureStage::RemoteCreate),
            failure_code: Some(failure_code.to_owned()),
            failure_message: Some(failure_message),
        });
    }

    if let Err(error) = release_repository_cache(&repository_path).and_then(|_| {
        update_repository_configuration(
            &repository_path,
            repository_identity.as_deref().unwrap_or_default(),
            &server_url,
        )
        .map(|_| ())
    }) {
        return Ok(LoreRepositoryPublishResult {
            repository_url,
            remote_created: !remote_preexisting,
            remote_preexisting,
            existing_remote_name: existing_remote_name.clone(),
            requested_remote_name: repository_name.clone(),
            configuration_updated: false,
            pushed: false,
            create_result,
            push_result: None,
            failure_stage: Some(LoreRepositoryPublishFailureStage::Configuration),
            failure_code: Some(error.code.to_owned()),
            failure_message: Some(error.message),
        });
    }

    let repository_path_string = display_path_without_windows_verbatim_prefix(&repository_path);
    let push_result =
        push_newly_created_repository_branch(&repository_path_string, branch, auth_identity)?;
    if push_result.status != 0 {
        let failure_message = operation_failure_message(
            &push_result,
            "The remote repository was created, but pushing the current branch failed",
        );
        return Ok(LoreRepositoryPublishResult {
            repository_url,
            remote_created: !remote_preexisting,
            remote_preexisting,
            existing_remote_name: existing_remote_name.clone(),
            requested_remote_name: repository_name.clone(),
            configuration_updated: true,
            pushed: false,
            create_result,
            push_result: Some(push_result),
            failure_stage: Some(LoreRepositoryPublishFailureStage::Push),
            failure_code: Some("repository_push_failed".to_owned()),
            failure_message: Some(failure_message),
        });
    }

    Ok(LoreRepositoryPublishResult {
        repository_url,
        remote_created: !remote_preexisting,
        remote_preexisting,
        existing_remote_name,
        requested_remote_name: repository_name,
        configuration_updated: true,
        pushed: true,
        create_result,
        push_result: Some(push_result),
        failure_stage: None,
        failure_code: None,
        failure_message: None,
    })
}

/// 解析一次发布实际使用的 Token Store 身份。
///
/// 新前端会显式传入 `use_auth_account = false` 表示用户选择“不使用账户”，此时即使
/// 仓库已有持久绑定也必须返回空身份。未升级的调用方缺少该字段时由命令边界传入
/// `true`，继续兼容原有“显式 userId > 仓库绑定 > 匿名”的解析顺序。
fn resolve_publish_auth_identity(
    user_id: Option<&str>,
    bound_user_id: Option<&str>,
    use_auth_account: bool,
) -> String {
    if !use_auth_account {
        return String::new();
    }
    user_id
        .or(bound_user_id)
        .map(str::to_owned)
        .unwrap_or_default()
}

/// 从只读服务器目录中查找与本地稳定 ID 相同的远端仓库名称。
fn find_remote_repository_name<'a>(
    result: &'a LoreOperationResult,
    repository_id: &str,
) -> Option<&'a str> {
    if result.status != 0 {
        return None;
    }
    result.events.iter().find_map(|event| {
        let data = (event.get("tagName").and_then(Value::as_str) == Some("repositoryListEntry"))
            .then(|| event.get("data"))??;
        data.get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.eq_ignore_ascii_case(repository_id))
            .then(|| data.get("name").and_then(Value::as_str))
            .flatten()
            .filter(|name| !name.trim().is_empty())
    })
}

/// 推送刚刚完成远端 Create 的 Branch，并兼容 Lore 0.x 的双零历史缺陷。
fn push_newly_created_repository_branch(
    repository_path: &str,
    branch: String,
    auth_identity: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let mut push_globals = global_args(repository_path)?;
    // 发布是一个原子用户流程；即使偏好落盘稍有延迟，Push 也必须沿用本次明确账户。
    push_globals.identity = auth_identity.into();
    let branch_list_result = run_operation("branch.list.publish-preflight", {
        let list_globals = push_globals.clone();
        move |callback| {
            lore::runtime().block_on(lore::branch::list(
                list_globals,
                LoreBranchListArgs { archived: 0 },
                callback,
            ))
        }
    })?;
    if published_branch_tips_are_zero(&branch_list_result, &branch) {
        /*
         * 在线 Create 已保证新远端的同名默认 Branch 也是空历史。此时没有任何
         * Revision 或文件内容可传输，直接返回成功空操作，规避固定 Lore 版本在
         * `(zero, zero)` 上错误进入历史交汇算法的上游缺陷。
         */
        return run_operation("branch.push.publish", |_callback| 0);
    }

    run_operation("branch.push.publish", move |callback| {
        lore::runtime().block_on(lore::branch::push(
            push_globals,
            LoreBranchPushArgs {
                branch: branch.into(),
                fast_forward_merge: 0,
            },
            callback,
        ))
    })
}

/// 判断指定 Branch 的本地与远端 Latest 是否都为零。
///
/// 固定 Lore 版本的 `branch::push` 在本地与远端 Latest 都为零时，会在判断
/// `already_pushed` 之前错误进入历史交汇算法，并返回“failed to find a branch
/// point”。必须同时匹配同一 Branch 的本地与远端条目，不能只凭本地空历史吞掉
/// 远端已有提交或目录读取失败；双方均为空时才说明远端已经处于目标状态。
fn published_branch_tips_are_zero(result: &LoreOperationResult, branch: &str) -> bool {
    if result.status != 0 {
        return false;
    }

    let mut local_is_zero = false;
    let mut remote_is_zero = false;
    for event in &result.events {
        if event.get("tagName").and_then(Value::as_str) != Some("branchListEntry") {
            continue;
        }
        let Some(data) = event.get("data") else {
            continue;
        };
        let matches_branch = data.get("name").and_then(Value::as_str) == Some(branch)
            || data.get("id").and_then(Value::as_str) == Some(branch);
        if !matches_branch
            || !data
                .get("latest")
                .and_then(Value::as_str)
                .is_some_and(is_zero_hash)
        {
            continue;
        }
        match data.get("location").and_then(Value::as_str) {
            Some("local") => local_is_zero = true,
            Some("remote") => remote_is_zero = true,
            _ => {}
        }
    }
    local_is_zero && remote_is_zero
}

/// 读取 Lore 原生 16 字节 Repository ID，并转换为 Create 接口使用的十六进制。
fn read_repository_id(repository_path: &Path) -> Result<String, LoreCommandError> {
    let id_path = repository_metadata_directory(repository_path)?.join("id");
    let bytes = std::fs::read(&id_path).map_err(|error| {
        LoreCommandError::new(
            "repository_id_read_failed",
            format!(
                "Failed to read repository ID from {}: {error}",
                id_path.display()
            ),
        )
    })?;
    if bytes.len() != 16 || bytes.iter().all(|byte| *byte == 0) {
        return Err(LoreCommandError::new(
            "repository_id_invalid",
            format!("The repository ID file is invalid: {}", id_path.display()),
        ));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 在配置落盘前释放 Lore 的路径缓存，确保下一次打开会读取新的远端地址。
fn release_repository_cache(repository_path: &Path) -> Result<(), LoreCommandError> {
    let path = display_path_without_windows_verbatim_prefix(repository_path);
    let globals = global_args(&path)?;
    let result = run_operation("repository.release.config", move |callback| {
        lore::runtime().block_on(lore::repository::release(
            globals,
            LoreRepositoryReleaseArgs {},
            callback,
        ))
    })?;
    if result.status == 0 {
        Ok(())
    } else {
        Err(LoreCommandError::new(
            "repository_cache_release_failed",
            operation_failure_message(
                &result,
                "Failed to release the repository configuration cache",
            ),
        ))
    }
}

/// 从 Lore 终止事件中提取最具体的错误文本。
fn operation_failure_message(result: &LoreOperationResult, fallback: &str) -> String {
    result
        .events
        .iter()
        .rev()
        .find_map(|event| {
            event
                .pointer("/data/errorInner")
                .and_then(Value::as_str)
                .or_else(|| event.pointer("/data/error/message").and_then(Value::as_str))
                .filter(|message| !message.trim().is_empty())
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{fallback} (status code {})", result.status))
}

/// 返回仓库当前格式对应的元数据目录；旧 `.urc` 优先级与 Lore 自身保持一致。
fn repository_metadata_directory(repository_path: &Path) -> Result<PathBuf, LoreCommandError> {
    let legacy_directory = repository_path.join(".urc");
    let current_directory = repository_path.join(".lore");
    if legacy_directory.is_dir() {
        Ok(legacy_directory)
    } else if current_directory.is_dir() {
        Ok(current_directory)
    } else {
        Err(LoreCommandError::new(
            "repository_metadata_missing",
            format!(
                "The directory is not a recognized Lore repository: {}",
                repository_path.display()
            ),
        ))
    }
}

const MAX_REPOSITORY_VIEW_BYTES: usize = 256 * 1024;
const MAX_REPOSITORY_VIEW_IMPACT_FILES: usize = 200;

fn validate_view_content_size(content: &str) -> Result<(), LoreCommandError> {
    if content.len() > MAX_REPOSITORY_VIEW_BYTES {
        return Err(LoreCommandError::new(
            "repository_view_too_large",
            format!(
                "The selective sync view must not exceed {} KiB",
                MAX_REPOSITORY_VIEW_BYTES / 1024
            ),
        ));
    }
    Ok(())
}

/// 返回当前仓库格式对应的 View 文件；不会在旧 `.urc` 仓库旁创建 `.lore`。
fn repository_view_path(repository_path: &Path) -> Result<PathBuf, LoreCommandError> {
    Ok(repository_metadata_directory(repository_path)?.join("view"))
}

fn repository_view_display_path(view_path: &Path) -> String {
    view_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .map(|directory| format!("{directory}/view"))
        .unwrap_or_else(|| "view".to_owned())
}

/// 按固定 Lore 版本 `filter.rs` 的顺序覆盖语义添加一条规则。
fn push_repository_view_rule(parsed: &mut ParsedRepositoryView, glob: &str, negated: bool) {
    let leading_separator = glob.starts_with('/');
    let ending_separator = glob.ends_with('/');
    let normalized = glob.trim_matches('/').to_lowercase();
    let filename = if negated {
        !leading_separator && !normalized.contains('/')
    } else {
        !leading_separator && !normalized.contains('/') && normalized != "**"
    };

    if negated && !filename {
        let mut parts = normalized.split('/').collect::<Vec<_>>();
        parts.pop();
        let mut parent = String::new();
        for part in parts {
            if !parent.is_empty() {
                parent.push('/');
            }
            parent.push_str(part);
            parsed.rules.push(RepositoryViewRule {
                glob: parent.clone(),
                negated: true,
                directory: true,
                generated: true,
                filename: false,
            });
        }
    }

    parsed.rules.push(RepositoryViewRule {
        glob: normalized.clone(),
        negated,
        directory: ending_separator,
        generated: false,
        filename,
    });

    if !filename && !normalized.ends_with('*') && !normalized.ends_with("*/") {
        let mut subtree = normalized;
        if !subtree.ends_with('/') {
            subtree.push('/');
        }
        subtree.push_str("**");
        parsed.rules.push(RepositoryViewRule {
            glob: subtree,
            negated,
            directory: false,
            generated: true,
            filename: false,
        });
    }
}

/// 解析 Lore View 文本，不读取工作区也不产生写操作。
fn parse_repository_view(content: &str) -> ParsedRepositoryView {
    let mut parsed = ParsedRepositoryView::default();
    let mut has_include = false;
    let mut has_exclude = false;

    for (index, source_line) in content.lines().enumerate() {
        let mut glob = source_line.trim();
        if glob.is_empty() || glob.starts_with('#') {
            continue;
        }

        parsed.rule_count += 1;
        let mut negated = false;
        while glob.starts_with('!') {
            negated = !negated;
            glob = &glob[1..];
        }
        if glob.starts_with("\\!") {
            glob = &glob[1..];
        }

        if negated && glob.starts_with("**") {
            parsed.diagnostics.push(LoreViewDiagnostic {
                line: index + 1,
                severity: "error",
                code: "view_inclusion_starts_with_double_star",
            });
            continue;
        }

        if negated {
            parsed.inclusion_count += 1;
            has_include = true;
        } else {
            parsed.exclusion_count += 1;
            has_exclude = true;
        }
        push_repository_view_rule(&mut parsed, glob, negated);
    }

    if has_include && !has_exclude {
        parsed.diagnostics.push(LoreViewDiagnostic {
            line: 0,
            severity: "warning",
            code: "view_inclusion_without_exclusion",
        });
    }
    parsed
}

fn repository_view_is_valid(parsed: &ParsedRepositoryView) -> bool {
    !parsed
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == "error")
}

/// 判断文件是否被 View 排除；后出现且命中的规则覆盖此前状态。
fn repository_view_excludes(parsed: &ParsedRepositoryView, path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    let filename = normalized.rsplit('/').next().unwrap_or(&normalized);
    let mut excluded = false;
    for rule in &parsed.rules {
        if rule.negated != excluded || rule.directory {
            continue;
        }
        let target = if rule.filename {
            filename
        } else {
            normalized.as_str()
        };
        if glob_match(rule.glob.as_str(), target) {
            excluded = !rule.negated;
        }
    }
    excluded
}

fn read_repository_view(repository_path: &Path) -> Result<LoreRepositoryView, LoreCommandError> {
    let view_path = repository_view_path(repository_path)?;
    let exists = view_path.is_file();
    let content = if exists {
        let metadata = fs::metadata(&view_path).map_err(|error| {
            LoreCommandError::new(
                "repository_view_read_failed",
                format!(
                    "Failed to read view metadata from {}: {error}",
                    view_path.display()
                ),
            )
        })?;
        if metadata.len() > MAX_REPOSITORY_VIEW_BYTES as u64 {
            return Err(LoreCommandError::new(
                "repository_view_too_large",
                format!("The view file is too large: {}", view_path.display()),
            ));
        }
        fs::read_to_string(&view_path).map_err(|error| {
            LoreCommandError::new(
                "repository_view_invalid_utf8",
                format!(
                    "The view must be UTF-8 text at {}: {error}",
                    view_path.display()
                ),
            )
        })?
    } else {
        String::new()
    };
    let parsed = parse_repository_view(&content);
    Ok(LoreRepositoryView {
        path: repository_view_display_path(&view_path),
        exists,
        content,
        valid: repository_view_is_valid(&parsed),
        rule_count: parsed.rule_count,
        exclusion_count: parsed.exclusion_count,
        inclusion_count: parsed.inclusion_count,
        diagnostics: parsed.diagnostics.clone(),
    })
}

fn repository_file_is_materialized(repository_path: &Path, path: &str) -> bool {
    fs::symlink_metadata(repository_path.join(path))
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn build_repository_view_preview(
    repository_path: &str,
    revision: &str,
    content: &str,
) -> Result<LoreRepositoryViewPreview, LoreCommandError> {
    build_repository_view_preview_with_dematerialize_paths(repository_path, revision, content)
        .map(|(preview, _)| preview)
}

/// 构造公开预览，并为应用阶段保留不截断的完整撤除路径集合。
///
/// 公开 DTO 只返回前 200 个影响文件以控制 IPC 体积；真正写操作不能复用这个
/// 截断列表，否则大型仓库只会应用部分 View。
fn build_repository_view_preview_with_dematerialize_paths(
    repository_path: &str,
    revision: &str,
    content: &str,
) -> Result<(LoreRepositoryViewPreview, Vec<String>), LoreCommandError> {
    let repository_root = validate_repository_path(repository_path)?;
    repository_metadata_directory(&repository_root)?;
    let parsed = parse_repository_view(content);
    let valid = repository_view_is_valid(&parsed);
    if !valid {
        return Ok((
            LoreRepositoryViewPreview {
                revision: revision.to_owned(),
                valid,
                rule_count: parsed.rule_count,
                exclusion_count: parsed.exclusion_count,
                inclusion_count: parsed.inclusion_count,
                diagnostics: parsed.diagnostics,
                total_files: 0,
                included_files: 0,
                excluded_files: 0,
                materialize_files: 0,
                dematerialize_files: 0,
                unchanged_files: 0,
                included_bytes: 0,
                materialize_bytes: 0,
                dematerialize_bytes: 0,
                impact_files: Vec::new(),
            },
            Vec::new(),
        ));
    }

    let files = collect_revision_tree_files(repository_path, revision)?;
    let mut dematerialize_paths = Vec::new();
    let mut preview = LoreRepositoryViewPreview {
        revision: revision.to_owned(),
        valid,
        rule_count: parsed.rule_count,
        exclusion_count: parsed.exclusion_count,
        inclusion_count: parsed.inclusion_count,
        diagnostics: parsed.diagnostics.clone(),
        total_files: files.len(),
        included_files: 0,
        excluded_files: 0,
        materialize_files: 0,
        dematerialize_files: 0,
        unchanged_files: 0,
        included_bytes: 0,
        materialize_bytes: 0,
        dematerialize_bytes: 0,
        impact_files: Vec::new(),
    };

    for file in files {
        let included = !repository_view_excludes(&parsed, &file.path);
        let materialized = repository_file_is_materialized(&repository_root, &file.path);
        if included {
            preview.included_files += 1;
            preview.included_bytes = preview.included_bytes.saturating_add(file.size);
        } else {
            preview.excluded_files += 1;
        }

        let action = match (included, materialized) {
            (true, false) => {
                preview.materialize_files += 1;
                preview.materialize_bytes = preview.materialize_bytes.saturating_add(file.size);
                Some("materialize")
            }
            (false, true) => {
                preview.dematerialize_files += 1;
                preview.dematerialize_bytes = preview.dematerialize_bytes.saturating_add(file.size);
                dematerialize_paths.push(file.path.clone());
                Some("dematerialize")
            }
            _ => {
                preview.unchanged_files += 1;
                None
            }
        };
        if let Some(action) = action {
            if preview.impact_files.len() < MAX_REPOSITORY_VIEW_IMPACT_FILES {
                preview.impact_files.push(LoreViewImpactFile {
                    path: file.path,
                    size: file.size,
                    action,
                });
            }
        }
    }
    Ok((preview, dematerialize_paths))
}

/// 扫描真实 Status，并同时确认用户预览的 Revision 仍是当前锚点。
fn ensure_repository_view_can_apply(
    repository_path: &str,
    expected_revision: &str,
) -> Result<(), LoreCommandError> {
    let globals = global_args(repository_path)?;
    let result = run_operation("repository.view-status", move |callback| {
        lore::runtime().block_on(lore::repository::status(
            globals,
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
    })?;
    ensure_operation_success(&result, "Check repository status before applying the view")?;
    let (current, staged, incoming) = conflict_revision_ids(&result.events).ok_or_else(|| {
        LoreCommandError::new(
            "repository_view_status_unavailable",
            "Lore status did not return the current revision, so the view cannot be applied safely",
        )
    })?;
    if current != expected_revision {
        return Err(LoreCommandError::new(
            "repository_view_revision_changed",
            "The current revision has changed; preview the view impact again",
        ));
    }
    let has_changed_files = result
        .events
        .iter()
        .any(|event| event["tagName"] == "repositoryStatusFile");
    /*
     * Lore 用全零哈希表达“没有 staged Revision”，不能把它与 current 不同
     * 直接解释为待提交状态；冲突读取路径也遵循同一约定。
     */
    let has_pending_staged_revision = !is_zero_hash(&staged) && staged != current;
    if has_changed_files || has_pending_staged_revision || incoming.is_some() {
        return Err(LoreCommandError::new(
            "repository_view_workspace_dirty",
            "The workspace contains local changes, staged changes, or conflicts; resolve them before applying the view",
        ));
    }
    Ok(())
}

fn write_repository_view_temporary(
    view_path: &Path,
    content: &str,
) -> Result<(PathBuf, PathBuf, bool), LoreCommandError> {
    let parent = view_path.parent().ok_or_else(|| {
        LoreCommandError::new(
            "repository_view_parent_missing",
            "The view path has no parent directory",
        )
    })?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary_path = parent.join(format!(
        ".view.lore-client-{}-{unique}.tmp",
        std::process::id()
    ));
    let backup_path = parent.join(format!(
        ".view.lore-client-{}-{unique}.backup",
        std::process::id()
    ));
    let mut temporary = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| {
            LoreCommandError::new(
                "repository_view_temporary_create_failed",
                format!(
                    "Failed to create temporary view file {}: {error}",
                    temporary_path.display()
                ),
            )
        })?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|_| temporary.sync_all())
        .map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            LoreCommandError::new(
                "repository_view_temporary_write_failed",
                format!(
                    "Failed to write temporary view file {}: {error}",
                    temporary_path.display()
                ),
            )
        })?;
    drop(temporary);

    let had_original = view_path.is_file();
    if had_original {
        fs::rename(view_path, &backup_path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            LoreCommandError::new(
                "repository_view_backup_failed",
                format!(
                    "Failed to back up the current view {}: {error}",
                    view_path.display()
                ),
            )
        })?;
    }
    if let Err(error) = fs::rename(&temporary_path, view_path) {
        if had_original {
            let _ = fs::rename(&backup_path, view_path);
        }
        let _ = fs::remove_file(&temporary_path);
        return Err(LoreCommandError::new(
            "repository_view_replace_failed",
            format!(
                "Failed to replace the current view {}: {error}",
                view_path.display()
            ),
        ));
    }
    Ok((temporary_path, backup_path, had_original))
}

fn run_repository_view_sync(
    repository_path: &str,
    revision: &str,
    operation: &'static str,
) -> Result<LoreOperationResult, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let revision = revision.to_owned();
    run_operation(operation, move |callback| {
        lore::runtime().block_on(lore::revision::sync(
            globals,
            /*
             * 目标 Revision 没有变化时普通 Sync 会提前成功返回。这里在工作区
             * 已经通过完整 Status 确认为干净的前提下使用 reset，迫使 Lore
             * 按新 View 比较文件系统与同一不可变 Revision；该参数不暴露给前端。
             */
            LoreRevisionSyncArgs {
                revision: revision.into(),
                reset: 1,
                ..Default::default()
            },
            callback,
        ))
    })
}

fn restore_repository_view(view_path: &Path, backup_path: &Path, had_original: bool) {
    let _ = fs::remove_file(view_path);
    if had_original {
        let _ = fs::rename(backup_path, view_path);
    }
}

/// 删除新 View 明确排除、且属于当前不可变 Revision 的已物化普通文件。
///
/// Lore Reset Sync 会跳过排除路径，因此缩小 View 时必须在适配层撤除这些文件。
/// 每个路径都再次执行仓库相对路径、普通文件与符号链接越界校验；调用前的完整
/// Status 已证明没有本地修改，失败时上层会恢复旧 View 并让 Lore 重新物化。
fn dematerialize_repository_view_files(
    repository_path: &str,
    paths: &[String],
) -> Result<(), LoreCommandError> {
    for path in paths {
        let file_path =
            validate_existing_workspace_file(repository_path, path).map_err(|error| {
                LoreCommandError::new(
                    "repository_view_dematerialize_failed",
                    format!(
                        "Failed to safely remove view-excluded file {path}: {}",
                        error.message
                    ),
                )
            })?;
        fs::remove_file(&file_path).map_err(|error| {
            LoreCommandError::new(
                "repository_view_dematerialize_failed",
                format!(
                    "Failed to remove view-excluded file {}: {error}",
                    file_path.display()
                ),
            )
        })?;
    }
    Ok(())
}

fn apply_repository_view(
    repository_path: String,
    revision: String,
    content: String,
) -> Result<LoreRepositoryViewApplyResult, LoreCommandError> {
    ensure_repository_view_can_apply(&repository_path, &revision)?;
    let (preview, dematerialize_paths) = build_repository_view_preview_with_dematerialize_paths(
        &repository_path,
        &revision,
        &content,
    )?;
    if !preview.valid {
        return Err(LoreCommandError::new(
            "repository_view_invalid",
            "The selective sync view contains errors; fix them and preview again",
        ));
    }

    let repository_root = validate_repository_path(&repository_path)?;
    let view_path = repository_view_path(&repository_root)?;
    let (_, backup_path, had_original) = write_repository_view_temporary(&view_path, &content)?;

    /*
     * `global_args` 为连续命令启用了 30 秒 Store keep-alive。Status 与 Tree 预览
     * 因而可能仍持有替换前加载的 Filter；若直接 Sync，Lore 会成功执行但继续
     * 使用旧 View。替换后必须显式释放仓库缓存，让 Sync 从新文件重建上下文。
     */
    if let Err(error) = release_repository_cache(&repository_root) {
        restore_repository_view(&view_path, &backup_path, had_original);
        let _ = release_repository_cache(&repository_root);
        return Err(LoreCommandError::new(
            "repository_view_cache_release_failed",
            format!(
                "Failed to release the Lore repository cache for the previous view; the original rules were restored: {}",
                error.message
            ),
        ));
    }

    if let Err(error) = dematerialize_repository_view_files(&repository_path, &dematerialize_paths)
    {
        restore_repository_view(&view_path, &backup_path, had_original);
        let _ = release_repository_cache(&repository_root);
        let _ = run_repository_view_sync(&repository_path, &revision, "repository.view-rollback");
        return Err(error);
    }

    let sync_result =
        run_repository_view_sync(&repository_path, &revision, "repository.view-apply");
    match sync_result {
        Ok(result) if result.status == 0 => {
            if had_original {
                let _ = fs::remove_file(backup_path);
            }
            Ok(LoreRepositoryViewApplyResult { preview, result })
        }
        Ok(result) => {
            restore_repository_view(&view_path, &backup_path, had_original);
            // 失败的 Sync 已加载新 Filter；回滚同步前同样需要强制重读旧 View。
            let _ = release_repository_cache(&repository_root);
            let _ =
                run_repository_view_sync(&repository_path, &revision, "repository.view-rollback");
            Err(LoreCommandError::new(
                "repository_view_sync_failed",
                operation_failure_message(
                    &result,
                    "Lore sync failed after applying the view; the original rules were restored",
                ),
            ))
        }
        Err(error) => {
            restore_repository_view(&view_path, &backup_path, had_original);
            let _ = release_repository_cache(&repository_root);
            let _ =
                run_repository_view_sync(&repository_path, &revision, "repository.view-rollback");
            Err(error)
        }
    }
}

/// 返回仓库当前格式对应的配置路径；旧 `.urc` 仓库继续使用自己的目录，
/// 不能在旁边新建 `.lore` 后造成双配置来源。
fn repository_configuration_path(repository_path: &Path) -> Result<PathBuf, LoreCommandError> {
    Ok(repository_metadata_directory(repository_path)?.join("config.toml"))
}

/// 读取配置文档。真实仓库即使缺少 config.toml，Lore 也按默认配置打开，因此这里
/// 返回空文档并允许用户补充 identity 或 remote_url。
fn read_repository_configuration_document(
    repository_path: &Path,
) -> Result<(PathBuf, toml_edit::DocumentMut), LoreCommandError> {
    let path = repository_configuration_path(repository_path)?;
    if !path.exists() {
        return Ok((path, toml_edit::DocumentMut::new()));
    }
    let content = std::fs::read_to_string(&path).map_err(|error| {
        LoreCommandError::new(
            "repository_config_read_failed",
            format!(
                "Failed to read repository configuration {}: {error}",
                path.display()
            ),
        )
    })?;
    let document = content.parse::<toml_edit::DocumentMut>().map_err(|error| {
        LoreCommandError::new(
            "repository_config_invalid",
            format!(
                "Repository configuration at {} is invalid: {error}",
                path.display()
            ),
        )
    })?;
    Ok((path, document))
}

/// 只接受顶层字符串字段；类型错误必须显式暴露，不能把损坏配置伪装成“未配置”。
fn repository_configuration_string(
    document: &toml_edit::DocumentMut,
    key: &str,
) -> Result<Option<String>, LoreCommandError> {
    let Some(item) = document.get(key) else {
        return Ok(None);
    };
    let Some(value) = item.as_str() else {
        return Err(LoreCommandError::new(
            "repository_config_value_invalid",
            format!("Repository configuration key {key} must be a string"),
        ));
    };
    let value = value.trim();
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn read_repository_configuration(
    repository_path: &Path,
) -> Result<RepositoryConfiguration, LoreCommandError> {
    let (_, document) = read_repository_configuration_document(repository_path)?;
    Ok(RepositoryConfiguration {
        identity: repository_configuration_string(&document, "identity")?,
        remote_url: repository_configuration_string(&document, "remote_url")?,
    })
}

/// 身份是 Lore 的不透明字符串，但需要限制换行和异常尺寸，避免把配置文件变成
/// 难以审阅的多行值。字符串内部的普通空格会保留。
fn normalize_identity(identity: &str) -> Result<Option<String>, LoreCommandError> {
    let identity = identity.trim();
    if identity.is_empty() {
        return Ok(None);
    }
    if identity.contains(['\r', '\n']) || identity.chars().count() > 512 {
        return Err(LoreCommandError::new(
            "invalid_commit_identity",
            "The commit identity must not contain line breaks or exceed 512 characters",
        ));
    }
    Ok(Some(identity.to_owned()))
}

/// 仓库远端地址允许被清除；非空值遵循当前 Lore 客户端使用的 lore:// 协议。
fn normalize_repository_remote_url(remote_url: &str) -> Result<Option<String>, LoreCommandError> {
    let remote_url = remote_url.trim().trim_end_matches('/');
    if remote_url.is_empty() {
        return Ok(None);
    }
    validate_server_url(remote_url)
        .map(Some)
        .map_err(|error| LoreCommandError::new("invalid_repository_remote_url", error.message))
}

/// 先把完整新内容写入同目录临时文件，再替换配置。Windows 不支持直接覆盖式
/// rename，因此先把旧文件移到唯一备份，替换失败时立即回滚。
fn write_repository_configuration_document(
    path: &Path,
    document: &toml_edit::DocumentMut,
) -> Result<(), LoreCommandError> {
    let parent = path.parent().ok_or_else(|| {
        LoreCommandError::new(
            "repository_config_path_invalid",
            "The repository configuration path is invalid",
        )
    })?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary_path = parent.join(format!(
        ".config.toml.lore-client-{}-{unique}.tmp",
        std::process::id()
    ));
    let mut temporary = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| {
            LoreCommandError::new(
                "repository_config_temporary_create_failed",
                format!(
                    "Failed to create temporary repository configuration file {}: {error}",
                    temporary_path.display()
                ),
            )
        })?;
    temporary
        .write_all(document.to_string().as_bytes())
        .and_then(|_| temporary.sync_all())
        .map_err(|error| {
            let _ = std::fs::remove_file(&temporary_path);
            LoreCommandError::new(
                "repository_config_temporary_write_failed",
                format!(
                    "Failed to write temporary repository configuration file {}: {error}",
                    temporary_path.display()
                ),
            )
        })?;
    drop(temporary);

    #[cfg(not(windows))]
    {
        std::fs::rename(&temporary_path, path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary_path);
            LoreCommandError::new(
                "repository_config_replace_failed",
                format!(
                    "Failed to replace repository configuration {}: {error}",
                    path.display()
                ),
            )
        })?;
    }

    #[cfg(windows)]
    {
        let backup_path = parent.join(format!(
            ".config.toml.lore-client-{}-{unique}.backup",
            std::process::id()
        ));
        let had_original = path.exists();
        if had_original {
            std::fs::rename(path, &backup_path).map_err(|error| {
                let _ = std::fs::remove_file(&temporary_path);
                LoreCommandError::new(
                    "repository_config_backup_failed",
                    format!(
                        "Failed to back up repository configuration {}: {error}",
                        path.display()
                    ),
                )
            })?;
        }
        if let Err(error) = std::fs::rename(&temporary_path, path) {
            if had_original {
                let _ = std::fs::rename(&backup_path, path);
            }
            let _ = std::fs::remove_file(&temporary_path);
            return Err(LoreCommandError::new(
                "repository_config_replace_failed",
                format!(
                    "Failed to replace repository configuration {}: {error}",
                    path.display()
                ),
            ));
        }
        if had_original {
            let _ = std::fs::remove_file(backup_path);
        }
    }
    Ok(())
}

fn update_repository_configuration(
    repository_path: &Path,
    identity: &str,
    remote_url: &str,
) -> Result<RepositoryConfiguration, LoreCommandError> {
    let identity = normalize_identity(identity)?;
    let remote_url = normalize_repository_remote_url(remote_url)?;
    let (path, mut document) = read_repository_configuration_document(repository_path)?;

    if let Some(identity) = identity.as_deref() {
        document["identity"] = toml_edit::value(identity);
    } else {
        document.remove("identity");
    }
    if let Some(remote_url) = remote_url.as_deref() {
        document["remote_url"] = toml_edit::value(remote_url);
    } else {
        document.remove("remote_url");
    }

    write_repository_configuration_document(&path, &document)?;
    read_repository_configuration(repository_path)
}

/// 解析单次提交的最终身份。仓库配置始终优先，默认身份只作为缺失时的兜底；
/// 两者都为空时在调用 Lore 前失败，避免再出现没有作者或依赖认证缓存的修订。
fn resolve_commit_identity(
    repository_path: &str,
    default_identity: Option<&str>,
) -> Result<String, LoreCommandError> {
    let repository_path = validate_repository_path(repository_path)?;
    let configuration = read_repository_configuration(&repository_path)?;
    if let Some(identity) = configuration.identity {
        return normalize_identity(&identity)?.ok_or_else(|| {
            LoreCommandError::new(
                "commit_identity_missing",
                "The current commit does not have an available identity",
            )
        });
    }
    if let Some(identity) = normalize_identity(default_identity.unwrap_or_default())? {
        return Ok(identity);
    }
    Err(LoreCommandError::new(
        "commit_identity_missing",
        "No commit identity is configured; set the repository identity or the client default identity",
    ))
}

/// 将可能较重的 Lore 调用移出 Tauri IPC 执行线程。
async fn run_lore_task<T>(
    task: impl FnOnce() -> Result<T, LoreCommandError> + Send + 'static,
) -> Result<T, LoreCommandError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| {
            LoreCommandError::new(
                "lore_task_join_failed",
                format!("The Lore background task did not complete: {error}"),
            )
        })?
}

/// 验证并规范化仓库路径，同时配置适合桌面客户端的短期 Store 复用。
fn global_args(repository_path: &str) -> Result<LoreGlobalArgs, LoreCommandError> {
    let repository_path = validate_repository_path(repository_path)?;
    let identity = bound_auth_identity(&repository_path)?.unwrap_or_default();
    let repository_path = repository_path.to_string_lossy().into_owned();

    Ok(LoreGlobalArgs {
        repository_path: repository_path.clone().into(),
        working_directory: repository_path.into(),
        identity: identity.into(),
        store_keep_alive: 1,
        store_keep_alive_seconds: 30,
        ..Default::default()
    })
}

fn validate_optional_auth_identity(
    user_id: Option<String>,
) -> Result<Option<String>, LoreCommandError> {
    let user_id = user_id.map(|value| value.trim().to_owned());
    if user_id.as_ref().is_some_and(|value| {
        value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
    }) {
        return Err(LoreCommandError::new(
            "auth_identity_invalid",
            "The authentication user identity is invalid",
        ));
    }
    Ok(user_id)
}

/**
 * 校验本地账户显示名解析请求。
 *
 * Auth URL 是 Token Store 的查找键，不能擅自改写协议或路径；用户 ID 去除空白并去重，
 * 避免同一账户的身份根条目与资源授权条目触发重复 JWT 解码。
 */
fn validate_auth_user_info_request(
    auth_url: String,
    user_ids: Vec<String>,
) -> Result<(String, Vec<String>), LoreCommandError> {
    let auth_url = auth_url.trim().to_owned();
    if auth_url.is_empty() || auth_url.len() > 2048 || auth_url.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "auth_endpoint_invalid",
            "The authentication endpoint is invalid",
        ));
    }

    Ok((auth_url, normalize_auth_user_ids(user_ids)?))
}

/**
 * 统一收紧本地 JWT 解析与远程 Auth 查询的用户 ID 集合。
 *
 * Revision identity 是历史中的自由文本，因此不能用窄正则先行判定
 * userId；这里只阻断控制字符和过大输入，最终是否可解析由 Auth 服务
 * 回答。上限与 Revision History 的 1,000 条上限对齐，避免 IPC 被滥用
 * 为无界批量请求。
 */
fn normalize_auth_user_ids(user_ids: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
    let mut normalized_user_ids = BTreeSet::new();
    for user_id in user_ids {
        let user_id = user_id.trim();
        if user_id.is_empty() || user_id.len() > 512 || user_id.chars().any(char::is_control) {
            return Err(LoreCommandError::new(
                "auth_identity_invalid",
                "The authentication user identity is invalid",
            ));
        }
        normalized_user_ids.insert(user_id.to_owned());
    }
    if normalized_user_ids.is_empty() {
        return Err(LoreCommandError::new(
            "auth_identity_required",
            "At least one authentication user identity is required",
        ));
    }
    if normalized_user_ids.len() > 1_000 {
        return Err(LoreCommandError::new(
            "auth_identity_limit_exceeded",
            "At most 1000 authentication user identities can be resolved at once",
        ));
    }

    Ok(normalized_user_ids.into_iter().collect())
}

fn validate_repository_path(repository_path: &str) -> Result<PathBuf, LoreCommandError> {
    let path = repository_path.trim();
    if path.is_empty() {
        return Err(LoreCommandError::new(
            "empty_repository_path",
            "Select a Lore repository directory",
        ));
    }

    let path = Path::new(path);
    if !path.is_dir() {
        return Err(LoreCommandError::new(
            "repository_directory_missing",
            format!(
                "The repository directory does not exist or is not accessible: {}",
                path.display()
            ),
        ));
    }

    std::fs::canonicalize(path).map_err(|error| {
        LoreCommandError::new(
            "repository_path_unavailable",
            format!(
                "Failed to resolve repository directory {}: {error}",
                path.display()
            ),
        )
    })
}

fn validate_branch_name(branch: &str) -> Result<String, LoreCommandError> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(LoreCommandError::new(
            "empty_branch_name",
            "The branch name must not be empty",
        ));
    }
    if branch.contains(['\r', '\n']) {
        return Err(LoreCommandError::new(
            "invalid_branch_name",
            "The branch name must not contain line breaks",
        ));
    }
    Ok(branch.to_owned())
}

/// Revision 可使用完整哈希或 Lore 支持的唯一短签名，但不能携带空白行。
fn validate_revision(revision: &str) -> Result<String, LoreCommandError> {
    let revision = revision.trim();
    if revision.is_empty() {
        return Err(LoreCommandError::new(
            "empty_revision",
            "The revision ID must not be empty",
        ));
    }
    if revision.chars().any(char::is_whitespace) {
        return Err(LoreCommandError::new(
            "invalid_revision",
            "The revision ID must not contain whitespace",
        ));
    }
    Ok(revision.to_owned())
}

/**
 * 校验文件历史的唯一起点。
 *
 * 固定 Lore 会拒绝同时提供 Revision 和 Branch。显式 Revision 优先，适用于从
 * 历史 Inspector 查询；没有 Revision 时才保留 Branch，供工作区文件历史使用。
 */
fn validate_file_history_start(
    branch: Option<String>,
    revision: Option<String>,
) -> Result<(String, String), LoreCommandError> {
    let revision = match revision {
        Some(value) if !value.trim().is_empty() => validate_revision(&value)?,
        _ => String::new(),
    };
    let branch = if revision.is_empty() {
        branch
            .map(|value| validate_branch_name(&value))
            .transpose()?
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok((branch, revision))
}

/// 服务器只返回仓库名称，适配层在单一位置构造完整 Lore URL。
fn build_repository_url(
    server_url: &str,
    repository_name: &str,
) -> Result<String, LoreCommandError> {
    let server_url = validate_server_url(server_url)?;
    let repository_name = validate_repository_name(repository_name)?;
    Ok(format!("{server_url}/{repository_name}"))
}

/// 与固定 Lore `is_valid_name` 保持一致，并额外要求是单一 URL 路径段。
fn validate_repository_name(repository_name: &str) -> Result<String, LoreCommandError> {
    let repository_name = repository_name.trim();
    let valid = !repository_name.is_empty()
        && repository_name.len() <= 1_000
        && repository_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        && repository_name != "."
        && repository_name != "..";
    if !valid {
        return Err(LoreCommandError::new(
            "invalid_repository_name",
            "The repository name may contain only ASCII letters, digits, hyphens, underscores, and dots, and must not exceed 1000 bytes",
        ));
    }
    Ok(repository_name.to_owned())
}

/// 仓库说明会进入 Lore 元数据与远端 Create 请求，限制空字符和异常尺寸。
fn validate_repository_description(description: &str) -> Result<String, LoreCommandError> {
    let description = description.trim();
    if description.chars().count() > 4_096 {
        return Err(LoreCommandError::new(
            "repository_description_too_long",
            "The repository description must not exceed 4096 characters",
        ));
    }
    if description.contains('\0') {
        return Err(LoreCommandError::new(
            "invalid_repository_description",
            "The repository description must not contain null characters",
        ));
    }
    Ok(description.to_owned())
}

/// Clone 的目标既可以是 Revision 签名，也可以是 Branch 名称。
///
/// 固定 Lore 会在远端上下文中完成最终解析，因此适配层只拒绝控制字符和异常长度，
/// 不把合法 Branch 名误判成哈希。空值继续表示默认 Branch 的最新 Revision。
fn validate_optional_clone_target(target: Option<String>) -> Result<String, LoreCommandError> {
    let target = target.unwrap_or_default().trim().to_owned();
    if target.is_empty() {
        return Ok(String::new());
    }
    if target.len() > 1_000 || target.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "invalid_clone_target",
            "The Clone target must not contain control characters or exceed 1000 bytes",
        ));
    }
    Ok(target)
}

/// 校验 Clone 初始 Layer 的远端仓库名与可选 Revision 匹配键。
///
/// Layer 仓库名会进入远端查询，沿用 Repository 名称白名单；Metadata Key 仅作为
/// 上游匹配键读取，不允许在没有 Layer 时单独传入，也不接受控制字符。
fn validate_clone_layer(
    repository: Option<String>,
    metadata_key: Option<String>,
) -> Result<(String, String), LoreCommandError> {
    let repository = repository.unwrap_or_default().trim().to_owned();
    let metadata_key = metadata_key.unwrap_or_default().trim().to_owned();
    if repository.is_empty() {
        if metadata_key.is_empty() {
            return Ok((String::new(), String::new()));
        }
        return Err(LoreCommandError::new(
            "clone_layer_repository_required",
            "A Layer repository is required when a Layer metadata key is provided",
        ));
    }
    let repository = validate_repository_name(&repository).map_err(|_| {
        LoreCommandError::new(
            "invalid_clone_layer_repository",
            "The Layer repository name may contain only ASCII letters, digits, hyphens, underscores, and dots",
        )
    })?;
    if metadata_key.len() > 1_000 || metadata_key.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "invalid_clone_layer_metadata",
            "The Layer metadata key must not contain control characters or exceed 1000 bytes",
        ));
    }
    Ok((repository, metadata_key))
}

/// Bare Clone 不物化文件，所有只影响物化结果的参数都必须为空。
///
/// 前端会在 Bare 模式下禁用并清空这些参数；Rust 仍需独立重验，避免旧客户端或
/// 手工 IPC 请求把被 Lore 静默忽略的组合伪装成已经生效。
#[allow(clippy::too_many_arguments)]
fn validate_bare_clone_options(
    bare: bool,
    view_path: Option<&str>,
    direct_file_io: bool,
    layer_repository: &str,
    dependency_root_files: &[String],
    dependency_tags: &[String],
    dependency_recursive: bool,
    dependency_depth_limit: u32,
) -> Result<(), LoreCommandError> {
    if bare
        && (view_path.is_some()
            || direct_file_io
            || !layer_repository.is_empty()
            || !dependency_root_files.is_empty()
            || !dependency_tags.is_empty()
            || dependency_recursive
            || dependency_depth_limit != 0)
    {
        return Err(LoreCommandError::new(
            "clone_bare_materialization_options",
            "Bare Clone cannot be combined with View, Direct File I/O, Layer, or dependency materialization options",
        ));
    }
    Ok(())
}

fn validate_clone_destination(
    destination_parent: &str,
    directory_name: &str,
) -> Result<PathBuf, LoreCommandError> {
    let parent = validate_existing_directory(destination_parent, "Clone parent directory")?;
    let directory_name = directory_name.trim();
    let directory_path = Path::new(directory_name);
    /*
     * `Path::components()` 只理解当前宿主的分隔符：`foo\bar` 在 Windows 是两级
     * 路径，在 Linux/macOS 却会被视为单个文件名。Clone 请求来自同一套 IPC，
     * 因此必须先按三个桌面目标的公共文件名子集校验，再使用原生 Path 拼接。
     */
    let is_portable_name = !directory_name.is_empty()
        && !directory_name.ends_with(['.', ' '])
        && !directory_name
            .chars()
            .any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
        && !is_windows_reserved_file_name(directory_name);
    let is_single_component = directory_path
        .components()
        .all(|component| matches!(component, std::path::Component::Normal(_)))
        && directory_path.components().count() == 1;
    if !is_portable_name || !is_single_component || directory_name == "." || directory_name == ".."
    {
        return Err(LoreCommandError::new(
            "invalid_clone_directory",
            "The clone directory name must be a single portable folder name supported by Windows, Linux, and macOS",
        ));
    }

    let destination = parent.join(directory_name);
    if destination.exists() {
        if !destination.is_dir() {
            return Err(LoreCommandError::new(
                "clone_destination_is_file",
                format!(
                    "The clone destination exists and is not a directory: {}",
                    destination.display()
                ),
            ));
        }
        let mut entries = std::fs::read_dir(&destination).map_err(|error| {
            LoreCommandError::new(
                "clone_destination_unavailable",
                format!(
                    "Failed to inspect clone destination {}: {error}",
                    destination.display()
                ),
            )
        })?;
        if entries.next().is_some() {
            return Err(LoreCommandError::new(
                "clone_destination_not_empty",
                format!(
                    "The clone destination directory is not empty: {}",
                    destination.display()
                ),
            ));
        }
    }
    Ok(destination)
}

/// Windows 设备名即使带扩展名也不能作为普通目录名；统一拒绝可让 Clone 输入
/// 在三平台保持同一语义，并避免项目从 Linux/macOS 迁移到 Windows 后无法落盘。
fn is_windows_reserved_file_name(file_name: &str) -> bool {
    let stem = file_name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }

    let Some(suffix) = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
    else {
        return false;
    };
    matches!(
        suffix,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
    )
}

fn validate_existing_directory(directory: &str, label: &str) -> Result<PathBuf, LoreCommandError> {
    let directory = Path::new(directory.trim());
    if !directory.is_dir() {
        return Err(LoreCommandError::new(
            "directory_missing",
            format!(
                "{label} does not exist or is not accessible: {}",
                directory.display()
            ),
        ));
    }
    std::fs::canonicalize(directory).map_err(|error| {
        LoreCommandError::new(
            "directory_unavailable",
            format!("Failed to resolve {label} {}: {error}", directory.display()),
        )
    })
}

fn validate_optional_file(
    path: Option<String>,
    label: &str,
) -> Result<Option<String>, LoreCommandError> {
    let Some(path) = path.map(|value| value.trim().to_owned()) else {
        return Ok(None);
    };
    if path.is_empty() {
        return Ok(None);
    }
    let path = Path::new(&path);
    if !path.is_file() {
        return Err(LoreCommandError::new(
            "file_missing",
            format!(
                "{label} does not exist or is not accessible: {}",
                path.display()
            ),
        ));
    }
    Ok(Some(
        std::fs::canonicalize(path)
            .map_err(|error| {
                LoreCommandError::new(
                    "file_unavailable",
                    format!("Failed to resolve {label} {}: {error}", path.display()),
                )
            })?
            .to_string_lossy()
            .into_owned(),
    ))
}

/// Clone 的 Shared Store 显式路径是 Store 容器目录，而不是其中的
/// `shared_store/` 实际数据目录。空路径表示让 Lore 按远端查找默认 Store。
fn validate_clone_shared_store_path(
    use_shared_store: bool,
    shared_store_path: Option<String>,
) -> Result<Option<String>, LoreCommandError> {
    if !use_shared_store {
        return Ok(None);
    }
    let Some(path) = shared_store_path.filter(|path| !path.trim().is_empty()) else {
        return Ok(None);
    };
    Ok(Some(display_path_without_windows_verbatim_prefix(
        &validate_existing_directory(&path, "Shared Store directory")?,
    )))
}

/// Lock 查询筛选器进入远端请求前拒绝控制字符和异常长度。
fn validate_optional_lock_filter(
    value: Option<String>,
    label: &str,
) -> Result<Option<String>, LoreCommandError> {
    let value = value.unwrap_or_default().trim().to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 4_096 || value.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "invalid_lock_filter",
            format!("{label} contains invalid characters or is too long"),
        ));
    }
    Ok(Some(value))
}

/// 依赖标签是用户定义的精确匹配值；限制长度、数量和控制字符，避免异常 IPC
/// 数据进入仓库元数据或远端查询。
fn validate_dependency_tags(tags: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
    if tags.len() > 128 {
        return Err(LoreCommandError::new(
            "too_many_dependency_tags",
            "A dependency operation accepts at most 128 tags",
        ));
    }
    let mut normalized = Vec::with_capacity(tags.len());
    for tag in tags {
        let tag = tag.trim().to_owned();
        if tag.is_empty() {
            continue;
        }
        if tag.len() > 256 || tag.chars().any(char::is_control) {
            return Err(LoreCommandError::new(
                "invalid_dependency_tag",
                "A dependency tag contains invalid characters or is too long",
            ));
        }
        if !normalized.contains(&tag) {
            normalized.push(tag);
        }
    }
    Ok(normalized)
}

/// Clone/Sync 不填写依赖根文件时表示保持普通完整物化语义。
fn validate_optional_dependency_paths(paths: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
    if paths.is_empty() {
        Ok(Vec::new())
    } else {
        validate_repository_relative_paths(paths)
    }
}

fn validate_dependency_depth_limit(depth_limit: u32) -> Result<(), LoreCommandError> {
    if depth_limit > 1_024 {
        Err(LoreCommandError::new(
            "dependency_depth_limit_too_large",
            "Dependency depth limit must not exceed 1024",
        ))
    } else {
        Ok(())
    }
}

/// 从 Lore 的并行数组事件构建稳定 Shared Store DTO。
///
/// 上游数组长度异常时只消费三者共同部分，避免错配远端和路径；但完全缺少 Info
/// 事件属于协议不兼容，必须明确失败，不能把它伪装成“尚未配置”。
fn parse_shared_store_info(events: &[Value]) -> Result<LoreSharedStoreInfo, LoreCommandError> {
    let data = events
        .iter()
        .find(|event| event["tagName"] == "sharedStoreInfo")
        .and_then(|event| event.get("data"))
        .ok_or_else(|| {
            LoreCommandError::new(
                "shared_store_info_event_missing",
                "Lore did not return Shared Store information",
            )
        })?;
    let remote_urls = data["remoteUrls"].as_array().cloned().unwrap_or_default();
    let paths = data["paths"].as_array().cloned().unwrap_or_default();
    let exists = data["exists"].as_array().cloned().unwrap_or_default();
    let count = remote_urls.len().min(paths.len()).min(exists.len());
    let mut stores = Vec::with_capacity(count);
    let mut total_size_bytes = 0_u64;

    for index in 0..count {
        let remote_url = remote_urls[index].as_str().unwrap_or_default().to_owned();
        let raw_path = paths[index].as_str().unwrap_or_default();
        let path = PathBuf::from(raw_path);
        let store_exists = exists[index].as_u64().unwrap_or_default() != 0;
        let (size_bytes, file_count, scan_error) = if store_exists {
            scan_directory_usage(&path)
        } else {
            (0, 0, None)
        };
        total_size_bytes = total_size_bytes.saturating_add(size_bytes);
        let container_path = path
            .parent()
            .map(display_path_without_windows_verbatim_prefix)
            .unwrap_or_default();
        stores.push(LoreSharedStoreEntry {
            remote_url,
            path: display_path_without_windows_verbatim_prefix(&path),
            container_path,
            exists: store_exists,
            size_bytes,
            file_count,
            scan_error,
        });
    }

    Ok(LoreSharedStoreInfo {
        use_automatically: data["useAutomatically"].as_u64().unwrap_or_default() != 0,
        stores,
        total_size_bytes,
        exact_savings_available: false,
    })
}

/// 统计 Store 当前可验证的实际磁盘占用。
///
/// 使用 `symlink_metadata` 且跳过所有符号链接，不跟随 Store 外路径；遇到权限或
/// 并发删除只返回已完成的部分统计和首个错误，管理页仍可显示其余健康 Store。
fn scan_directory_usage(root: &Path) -> (u64, u64, Option<String>) {
    let mut directories = vec![root.to_path_buf()];
    let mut size_bytes = 0_u64;
    let mut file_count = 0_u64;
    let mut first_error = None;
    while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                first_error.get_or_insert_with(|| {
                    format!("Failed to read {}: {error}", directory.display())
                });
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    first_error
                        .get_or_insert_with(|| format!("Failed to enumerate Store entry: {error}"));
                    continue;
                }
            };
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(error) => {
                    first_error.get_or_insert_with(|| {
                        format!("Failed to read Store entry metadata: {error}")
                    });
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                directories.push(entry.path());
            } else if metadata.is_file() {
                file_count = file_count.saturating_add(1);
                size_bytes = size_bytes.saturating_add(metadata.len());
            }
        }
    }
    (size_bytes, file_count, first_error)
}

/// 校验服务器地址的最小必要格式，并把末尾斜杠统一去除。
///
/// 更细的主机、证书和协议错误由 Lore Core 返回，这样前端能保留完整事件链。
fn validate_server_url(server_url: &str) -> Result<String, LoreCommandError> {
    let server_url = server_url.trim().trim_end_matches('/');
    if server_url.is_empty() {
        return Err(LoreCommandError::new(
            "empty_server_url",
            "Enter a Lore server address",
        ));
    }
    if !server_url.starts_with("lore://") {
        return Err(LoreCommandError::new(
            "invalid_server_scheme",
            "The Lore server address must start with lore://",
        ));
    }
    if server_url.chars().any(char::is_whitespace) {
        return Err(LoreCommandError::new(
            "invalid_server_url",
            "The Lore server address must not contain whitespace",
        ));
    }
    let authority = &server_url["lore://".len()..];
    if authority.is_empty() || authority.contains('/') || server_url.len() > 4_096 {
        return Err(LoreCommandError::new(
            "invalid_server_url",
            "The Lore server address must be a server root such as lore://host:41337 and must not include a repository path",
        ));
    }
    Ok(server_url.to_owned())
}

/// 把不成功的普通 Lore 操作转换为具有能力专属错误码的结构化错误。
fn ensure_command_success(
    result: &LoreOperationResult,
    code: &'static str,
    label: &str,
) -> Result<(), LoreCommandError> {
    if result.status == 0 {
        return Ok(());
    }
    let detail = result
        .events
        .iter()
        .rev()
        .find_map(|event| {
            event["data"]["error"]["message"]
                .as_str()
                .or_else(|| event["data"]["message"].as_str())
                .or_else(|| event["data"]["error"].as_str())
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("Lore did not provide additional error details");
    Err(LoreCommandError::new(
        code,
        format!("{label} failed (status code {}): {detail}", result.status),
    ))
}

/// 把非零 Lore 状态统一转换为结构化命令错误。
///
/// 低层 Revision Tree 与 Storage 接口会把具体失败写入事件流；客户端命令仍需要
/// 一个稳定错误码，避免调用方把“返回了事件”误判成读取成功。
fn ensure_operation_success(
    result: &LoreOperationResult,
    label: &str,
) -> Result<(), LoreCommandError> {
    if result.status == 0 {
        return Ok(());
    }

    /*
     * 固定 Lore 版本的批量 Storage 接口会把单项失败放在
     * `storageGetItemComplete.data.errorCode`，而操作级说明则放在
     * `complete.data.error.message`。它们都不一定额外发送 `error` 事件。
     * 这里按“具体单项错误 → 操作级说明 → 旧 error 事件”的顺序提取，避免再次
     * 把 AddressNotFound 等可诊断信息抹成“未提供额外错误信息”。
     */
    let item_error = result.events.iter().find_map(|event| {
        let error_code = event["data"]["errorCode"].as_str()?;
        (error_code != "None" && !error_code.is_empty()).then_some(error_code)
    });
    let operation_error = result.events.iter().find_map(|event| {
        event["data"]["error"]["message"]
            .as_str()
            .or_else(|| event["data"]["message"].as_str())
            .or_else(|| event["data"]["error"].as_str())
    });
    let detail = item_error
        .map(|error_code| format!("Lore error code {error_code}"))
        .or_else(|| operation_error.map(str::to_owned))
        .unwrap_or_else(|| "Lore did not provide additional error details".to_owned());
    Err(LoreCommandError::new(
        "revision_tree_read_failed",
        format!("{label} failed (status code {}): {detail}", result.status),
    ))
}

/// 为低层 Store 构造远端认证上下文。
///
/// 仓库配置中的 `identity` 是创建 Revision 时使用的作者身份；远端 Store 的
/// Token 则按设备账户绑定中的 user ID 查找。两者属于不同命名空间，不能用提交
/// 作者覆盖 `global_args` 已解析的账户，否则本地未缓存的二进制内容会在回源时
/// 失去认证，并被固定 Lore 版本折叠成 `Internal`。
fn revision_storage_globals(repository_path: &Path) -> Result<LoreGlobalArgs, LoreCommandError> {
    let repository_path_string = display_path_without_windows_verbatim_prefix(repository_path);
    global_args(&repository_path_string)
}

/// 打开指定仓库的只读内容存储，并从事件中恢复公开的 opaque handle。
fn open_revision_storage(repository_path: &str) -> Result<LoreStore, LoreCommandError> {
    let repository_path = validate_repository_path(repository_path)?;
    let configuration = read_repository_configuration(&repository_path)?;
    let globals = revision_storage_globals(&repository_path)?;
    let (remote_config, has_remote_config) = match configuration.remote_url {
        Some(remote_url) => (
            LoreStorageRemoteConfig {
                remote_url: remote_url.into(),
            },
            1,
        ),
        None => (LoreStorageRemoteConfig::default(), 0),
    };
    let result = run_operation("storage.open", move |callback| {
        lore::runtime().block_on(lore::storage::open::open(
            globals,
            LoreStorageOpenArgs {
                repository_path: repository_path.as_path().into(),
                remote_config,
                has_remote_config,
                ..Default::default()
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Open revision store")?;
    let handle_id = result
        .events
        .iter()
        .find(|event| event["tagName"] == "storageOpened")
        .and_then(|event| event["data"]["handleId"].as_u64())
        .ok_or_else(|| {
            LoreCommandError::new(
                "revision_storage_handle_missing",
                "Lore did not return a usable handle after opening the store",
            )
        })?;
    Ok(LoreStore { handle_id })
}

/// 尽力关闭 Revision Tree；主读取错误优先返回，清理失败不覆盖原始诊断。
fn close_revision_tree(handle: LoreRevisionTree) {
    let _ = run_operation("revision_tree.close", move |callback| {
        lore::runtime().block_on(lore::revision_tree::close::close(
            LoreGlobalArgs::default(),
            LoreRevisionTreeCloseArgs { id: 1, handle },
            callback,
        ))
    });
}

/// 尽力关闭低层 Storage handle，防止 Inspector 反复切换 Revision 时泄漏资源。
fn close_revision_storage(handle: LoreStore) {
    let _ = run_operation("storage.close", move |callback| {
        lore::runtime().block_on(lore::storage::close::close(
            LoreGlobalArgs::default(),
            LoreStorageCloseArgs { handle },
            callback,
        ))
    });
}

/// 从仓库状态事件取得稳定 Repository ID，供低层 Revision Tree 定位分区。
fn read_revision_repository_id(repository_path: &str) -> Result<String, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let result = run_operation("repository.status.revision", move |callback| {
        lore::runtime().block_on(lore::repository::status(
            globals,
            LoreRepositoryStatusArgs {
                staged: 0,
                scan: 0,
                check_dirty: 0,
                reset: 0,
                sync_point: 0,
                revision_only: 1,
                count: 0,
                paths: LoreArray::default(),
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Read repository identity")?;
    result
        .events
        .iter()
        .find(|event| event["tagName"] == "repositoryStatusRevision")
        .and_then(|event| event["data"]["repository"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            LoreCommandError::new(
                "repository_id_missing",
                "Lore repository status did not return a repository ID",
            )
        })
}

/// 枚举指定 Revision 的不可变文件树。
///
/// 遍历只消费 `revisionTreeChild`，不会读取工作区目录。Link 节点作为已提交对象
/// 保留但不跨仓库递归；跨 Link 继续遍历需要重新打开目标 Revision Tree，不能把
/// 目标仓库 Node ID 错当成本仓库 Node ID。
fn collect_revision_tree_files(
    repository_path: &str,
    revision: &str,
) -> Result<Vec<RevisionTreeFile>, LoreCommandError> {
    let repository_id = read_revision_repository_id(repository_path)?;
    let store = open_revision_storage(repository_path)?;
    let load_args = (|| {
        Ok::<_, LoreCommandError>(LoreRevisionTreeLoadArgs {
            store,
            repository: repository_id.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_repository_id",
                    "Lore repository status returned an invalid repository ID",
                )
            })?,
            revision_hash: revision.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_revision_hash",
                    "The revision tree requires a complete and valid revision hash",
                )
            })?,
        })
    })();
    let load_args = match load_args {
        Ok(args) => args,
        Err(error) => {
            close_revision_storage(store);
            return Err(error);
        }
    };
    let load_result = run_operation("revision_tree.load", {
        move |callback| {
            lore::runtime().block_on(lore::revision_tree::load::load(
                LoreGlobalArgs::default(),
                load_args,
                callback,
            ))
        }
    });

    let load_result = match load_result {
        Ok(result) => result,
        Err(error) => {
            close_revision_storage(store);
            return Err(error);
        }
    };
    if let Err(error) = ensure_operation_success(&load_result, "Load revision tree") {
        close_revision_storage(store);
        return Err(error);
    }
    let tree_handle = match load_result
        .events
        .iter()
        .find(|event| event["tagName"] == "revisionTreeLoaded")
        .and_then(|event| event["data"]["handleId"].as_u64())
    {
        Some(handle_id) => LoreRevisionTree { handle_id },
        None => {
            close_revision_storage(store);
            return Err(LoreCommandError::new(
                "revision_tree_handle_missing",
                "Lore did not return a usable handle after loading the revision tree",
            ));
        }
    };

    let read_result = (|| {
        let mut next_call_id = 1u64;
        let mut pending_directories = vec![(0u32, String::new())];
        let mut files = Vec::new();

        while let Some((parent_node_id, parent_path)) = pending_directories.pop() {
            let call_id = next_call_id;
            next_call_id += 1;
            let result = run_operation("revision_tree.list_children", move |callback| {
                lore::runtime().block_on(lore::revision_tree::list_children::list_children(
                    LoreGlobalArgs::default(),
                    LoreRevisionTreeListChildrenArgs {
                        id: call_id,
                        handle: tree_handle,
                        parent_node_id,
                    },
                    callback,
                ))
            })?;
            ensure_operation_success(&result, "Enumerate revision tree")?;

            let listed_repository = result
                .events
                .iter()
                .find(|event| event["tagName"] == "revisionTreeListChildrenBegin")
                .and_then(|event| event["data"]["repository"].as_str())
                .unwrap_or(&repository_id)
                .to_owned();

            for event in result
                .events
                .iter()
                .filter(|event| event["tagName"] == "revisionTreeChild")
            {
                let data = &event["data"];
                let name = data["name"].as_str().unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let path = if parent_path.is_empty() {
                    name.to_owned()
                } else {
                    format!("{parent_path}/{name}")
                };
                let kind = data["kind"].as_u64().unwrap_or_default();
                let node_id = data["nodeId"].as_u64().unwrap_or_default() as u32;

                match kind {
                    // LoreNodeType::Directory
                    0 => pending_directories.push((node_id, path)),
                    // LoreNodeType::File
                    1 => files.push(RevisionTreeFile {
                        path,
                        size: data["size"].as_u64().unwrap_or_default(),
                        address: data["address"].as_str().unwrap_or_default().to_owned(),
                        repository: listed_repository.clone(),
                    }),
                    // LoreNodeType::Link 是一个已提交对象，但不是本仓库普通文件。
                    _ => {}
                }
            }
        }

        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    })();

    close_revision_tree(tree_handle);
    close_revision_storage(store);
    read_result
}

/// 从内容寻址 Store 批量读取根修订中文本文件的真实字节。
fn read_revision_file_contents_matching(
    repository_path: &str,
    files: &[RevisionTreeFile],
    should_read: impl Fn(&RevisionTreeFile) -> bool,
) -> Result<BTreeMap<String, Vec<u8>>, LoreCommandError> {
    let requested = files
        .iter()
        .filter(|file| should_read(file))
        .enumerate()
        .map(|(index, file)| {
            let partition = file.repository.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_repository_id",
                    format!("Revision file {} has an invalid repository ID", file.path),
                )
            })?;
            let address = file.address.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_file_address",
                    format!("Revision file {} has an invalid content address", file.path),
                )
            })?;
            Ok((
                (index + 1) as u64,
                file.path.clone(),
                LoreStorageGetItem {
                    id: (index + 1) as u64,
                    partition,
                    address,
                    streaming: 0,
                    local_cache: 0,
                },
            ))
        })
        .collect::<Result<Vec<_>, LoreCommandError>>()?;

    if requested.is_empty() {
        return Ok(BTreeMap::new());
    }

    let store = open_revision_storage(repository_path)?;
    let path_by_id = requested
        .iter()
        .map(|(id, path, _)| (*id, path.clone()))
        .collect::<BTreeMap<_, _>>();
    let items = requested
        .into_iter()
        .map(|(_, _, item)| item)
        .collect::<Vec<_>>();
    let result = run_operation("storage.get", move |callback| {
        lore::runtime().block_on(lore::storage::get::get(
            LoreGlobalArgs::default(),
            LoreStorageGetArgs {
                handle: store,
                items: LoreArray::from_vec(items),
            },
            callback,
        ))
    });

    let read_result = result.and_then(|result| {
        ensure_operation_success(&result, "Read revision file content")?;
        let mut contents = BTreeMap::new();
        for event in result
            .events
            .iter()
            .filter(|event| event["tagName"] == "storageGetData")
        {
            let Some(id) = event["data"]["id"].as_u64() else {
                continue;
            };
            let Some(path) = path_by_id.get(&id) else {
                continue;
            };
            let bytes = event["data"]["bytes"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_u64().map(|byte| byte as u8))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            contents.insert(path.clone(), bytes);
        }
        Ok(contents)
    });

    close_revision_storage(store);
    read_result
}

/// 根 Revision 文本 Diff 使用的批量读取入口，继续维持既有二进制跳过策略。
fn read_revision_file_contents(
    repository_path: &str,
    files: &[RevisionTreeFile],
) -> Result<BTreeMap<String, Vec<u8>>, LoreCommandError> {
    read_revision_file_contents_matching(
        repository_path,
        files,
        should_materialize_revision_content,
    )
}

/// 二进制预览只读取已经过白名单与大小验证的单个 Revision 文件。
fn read_revision_file_content(
    repository_path: &str,
    file: &RevisionTreeFile,
) -> Result<Vec<u8>, LoreCommandError> {
    read_revision_file_contents_matching(repository_path, std::slice::from_ref(file), |_| true)?
        .remove(&file.path)
        .ok_or_else(|| {
            LoreCommandError::new(
                "revision_preview_content_missing",
                format!(
                    "Lore store did not return content for revision file {}",
                    file.path
                ),
            )
        })
}

/// 明确的文本扩展名始终读取；未知类型只在体积较小时探测 UTF-8 内容。
///
/// 覆盖 Unity Force Text 资产、Godot 文本场景/脚本，以及 Zig/Odin/Shell 等常见语言，
/// 避免本地更改与根修订 Diff 把可读文本误判为二进制。未知扩展名仍按体积探测，
/// 明确二进制类型始终只生成 marker。
fn is_text_like_revision_path(path: &str) -> bool {
    let path = Path::new(path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        file_name.as_str(),
        ".babelrc"
            | ".dockerignore"
            | ".editorconfig"
            | ".env"
            | ".eslintrc"
            | ".gitattributes"
            | ".gitignore"
            | ".npmrc"
            | ".nvmrc"
            | ".prettierrc"
            | "cmakelists.txt"
            | "dockerfile"
            | "gemfile"
            | "gnumakefile"
            | "jenkinsfile"
            | "makefile"
            | "procfile"
            | "rakefile"
            | "vagrantfile"
    ) {
        return true;
    }

    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        // 通用文档与配置
        "txt"
            | "md"
            | "markdown"
            | "rst"
            | "adoc"
            | "tex"
            | "bib"
            | "org"
            | "json"
            | "jsonc"
            | "json5"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "config"
            | "xml"
            | "csv"
            | "tsv"
            | "svg"
            | "plist"
            | "properties"
            | "editorconfig"
            // Web / 前端
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "htm"
            | "vue"
            | "svelte"
            | "graphql"
            | "gql"
            // 系统 / 原生 / 通用语言
            | "rs"
            | "cpp"
            | "cc"
            | "cxx"
            | "c"
            | "h"
            | "hpp"
            | "hh"
            | "hxx"
            | "py"
            | "pyi"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "scala"
            | "cs"
            | "fs"
            | "fsx"
            | "fsi"
            | "vb"
            | "swift"
            | "m"
            | "mm"
            | "rb"
            | "php"
            | "lua"
            | "r"
            | "sql"
            | "proto"
            | "dart"
            | "nim"
            | "groovy"
            | "gradle"
            | "cmake"
            | "zig"
            | "zon"
            | "odin"
            // Shell / 批处理
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "psm1"
            | "psd1"
            | "bat"
            | "cmd"
            // 着色器
            | "glsl"
            | "hlsl"
            | "wgsl"
            | "vert"
            | "frag"
            | "geom"
            | "comp"
            | "tesc"
            | "tese"
            | "metal"
            | "compute"
            // Unity 常见文本资产
            | "meta"
            | "unity"
            | "prefab"
            | "asset"
            | "mat"
            | "anim"
            | "controller"
            | "overridecontroller"
            | "mask"
            | "physicmaterial"
            | "physicsmaterial2d"
            | "guiskin"
            | "fontsettings"
            | "preset"
            | "asmdef"
            | "asmref"
            | "inputactions"
            | "shader"
            | "cginc"
            | "raytrace"
            | "template"
            | "uxml"
            | "uss"
            | "rsp"
            | "shadergraph"
            | "shadersubgraph"
            | "vfx"
            | "playable"
            | "signal"
            | "terrainlayer"
            | "brush"
            | "giparams"
            | "wlt"
            | "scenetemplate"
            | "spriteatlasv2"
            // Godot 文本场景 / 资源 / 脚本
            | "gd"
            | "tscn"
            | "tres"
            | "godot"
            | "import"
            | "gdshader"
            | "gdshaderinc"
            | "gdextension"
            | "uid"
    )
}

fn is_known_binary_revision_path(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "tga"
            | "tif"
            | "tiff"
            | "dds"
            | "ktx2"
            | "exr"
            | "pdf"
            | "obj"
            | "fbx"
            | "gltf"
            | "glb"
            | "zip"
            | "pak"
            | "assetbundle"
            | "bundle"
            | "unity3d"
            | "pck"
            | "7z"
            | "rar"
            | "gz"
            | "bz2"
            | "xz"
            | "mp3"
            | "wav"
            | "ogg"
            | "flac"
            | "mp4"
            | "mov"
            | "avi"
            | "dll"
            | "exe"
            | "so"
            | "dylib"
            | "uasset"
            | "umap"
            | "uexp"
            | "ubulk"
            | "assets"
            | "res"
            | "blend"
            | "ttf"
            | "otf"
    )
}

/// 构造单文件预览 DTO；内容来源在进入 Base64 编码前始终留在 Rust 适配层。
fn build_file_preview(
    repository_path: &str,
    path: &str,
    revision: Option<&str>,
) -> Result<LoreFilePreview, LoreCommandError> {
    let relative_path = validate_repository_relative_path(path)?;
    let normalized_path = relative_path
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let (kind, source_mime_type) = binary_preview_format(&relative_path).ok_or_else(|| {
        LoreCommandError::new(
            "binary_preview_unsupported",
            format!(
                "Embedded preview supports only common images, PDFs, and game assets: {normalized_path}"
            ),
        )
    })?;

    let bytes = if let Some(revision) = revision {
        let files = collect_revision_tree_files(repository_path, revision)?;
        let file = files
            .iter()
            .find(|file| file.path == normalized_path)
            .ok_or_else(|| {
                LoreCommandError::new(
                    "revision_preview_file_missing",
                    format!("File {normalized_path} does not exist in revision {revision}"),
                )
            })?;
        ensure_binary_preview_size(file.size)?;
        read_revision_file_content(repository_path, file)?
    } else {
        let workspace_path = validate_existing_workspace_file(repository_path, &normalized_path)?;
        let size = std::fs::metadata(&workspace_path)
            .map_err(|error| {
                LoreCommandError::new(
                    "workspace_preview_metadata_unavailable",
                    format!(
                        "Failed to read the preview file size for {}: {error}",
                        workspace_path.display()
                    ),
                )
            })?
            .len();
        ensure_binary_preview_size(size)?;
        std::fs::read(&workspace_path).map_err(|error| {
            LoreCommandError::new(
                "workspace_preview_read_failed",
                format!(
                    "Failed to read preview file {}: {error}",
                    workspace_path.display()
                ),
            )
        })?
    };
    ensure_binary_preview_size(bytes.len() as u64)?;
    // size 报告原始资产字节；纹理转码后的 PNG 只进入 data_base64。
    let original_size = bytes.len() as u64;
    let structured_preview = build_structured_preview(&relative_path, &bytes)
        .map_err(|error| LoreCommandError::new(error.code, error.message))?;
    let (mime_type, preview_bytes) =
        prepare_preview_payload(&relative_path, kind, source_mime_type, bytes)?;

    Ok(LoreFilePreview {
        path: normalized_path,
        kind,
        mime_type,
        data_base64: BASE64_STANDARD.encode(&preview_bytes),
        size: original_size,
        structured_preview,
    })
}

fn should_materialize_revision_content(file: &RevisionTreeFile) -> bool {
    const UNKNOWN_TEXT_PROBE_LIMIT: u64 = 8 * 1024 * 1024;
    is_text_like_revision_path(&file.path)
        || (!is_known_binary_revision_path(&file.path) && file.size <= UNKNOWN_TEXT_PROBE_LIMIT)
}

/// 为根修订中的新增文本文件生成最小但完整的 unified patch。
fn build_added_file_patch(path: &str, content: &[u8]) -> String {
    if content.is_empty() {
        return String::new();
    }
    let Ok(text) = std::str::from_utf8(content) else {
        return "Binary files differ\n".to_owned();
    };
    let line_count = text.lines().count().max(1);
    let mut patch = format!("--- /dev/null\n+++ {path}\n@@ -0,0 +1,{line_count} @@\n");
    for line in text.split_inclusive('\n') {
        patch.push('+');
        patch.push_str(line);
    }
    if !text.ends_with('\n') {
        patch.push('\n');
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

/// 根 Revision 没有父 Revision，必须显式以空树作为来源。
fn build_initial_revision_diff(
    repository_path: &str,
    target_revision: &str,
    paths: &[String],
    _context_lines: u32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let started_at = Instant::now();
    let files = collect_revision_tree_files(repository_path, target_revision)?;
    let files = files
        .into_iter()
        .filter(|file| paths.is_empty() || paths.contains(&file.path))
        .collect::<Vec<_>>();
    let contents = read_revision_file_contents(repository_path, &files)?;
    let events = files
        .iter()
        .map(|file| {
            let patch = contents
                .get(&file.path)
                .map(|content| build_added_file_patch(&file.path, content))
                .unwrap_or_else(|| "Binary files differ\n".to_owned());
            serde_json::json!({
                "tagName": "fileDiff",
                "data": {
                    "path": file.path,
                    "patch": patch,
                    "action": "add"
                }
            })
        })
        .collect();

    Ok(LoreOperationResult {
        operation: "file.diff.revision.initial",
        status: 0,
        duration_ms: started_at.elapsed().as_millis(),
        events,
    })
}

/// 用不可变树集合差补全 Lore 因“没有文本 hunk”而省略的结构变化事件。
fn supplement_structural_diff_events(
    events: &mut Vec<Value>,
    source_files: &[RevisionTreeFile],
    target_files: &[RevisionTreeFile],
    paths: &[String],
) {
    let existing = events
        .iter()
        .filter(|event| event["tagName"] == "fileDiff")
        .flat_map(|event| {
            let mut paths = Vec::new();
            if let Some(path) = event["data"]["path"].as_str() {
                paths.push(path.to_owned());
            }
            /*
             * Move 事件的主 path 是目标路径，来源路径保存在补丁头。把两端都标记
             * 为已覆盖，避免集合差再额外伪造一个 Delete 事件。
             */
            if let Some(patch) = event["data"]["patch"].as_str() {
                paths.extend(
                    patch
                        .lines()
                        .filter_map(|line| line.strip_prefix("move from ").map(str::to_owned)),
                );
            }
            paths
        })
        .collect::<BTreeSet<_>>();
    let source_paths = source_files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    let target_paths = target_files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();

    for path in source_paths.symmetric_difference(&target_paths) {
        if existing.contains(*path)
            || (!paths.is_empty() && !paths.iter().any(|item| item == *path))
        {
            continue;
        }
        let action = if target_paths.contains(path) {
            "add"
        } else {
            "delete"
        };
        events.push(serde_json::json!({
            "tagName": "fileDiff",
            "data": {
                "path": path,
                "patch": "",
                "action": action
            }
        }));
    }
}

/// 只使用不可变 Revision Tree 元数据生成稳定变化清单。
///
/// 同路径内容地址变化视为修改；来源消失且目标出现视为新增/删除。若删除项和新增项
/// 拥有相同非空内容地址，则合并为目标路径上的移动。来源中仍保留相同地址时，新路径
/// 属于复制；当前稳定前端 DTO 把复制与新增都投影为 `added`。
fn compare_revision_tree_files(
    source_files: &[RevisionTreeFile],
    target_files: &[RevisionTreeFile],
) -> Vec<LoreRevisionChange> {
    let source_by_path = source_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let target_by_path = target_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut changes = Vec::new();
    let mut deleted = Vec::new();
    let mut added = Vec::new();

    for source in source_files {
        match target_by_path.get(source.path.as_str()) {
            Some(target)
                if source.address != target.address || source.repository != target.repository =>
            {
                changes.push(LoreRevisionChange {
                    path: target.path.clone(),
                    source_path: None,
                    action: "modify",
                    size: target.size,
                });
            }
            Some(_) => {}
            None => deleted.push(source),
        }
    }
    for target in target_files {
        if !source_by_path.contains_key(target.path.as_str()) {
            added.push(target);
        }
    }

    let mut unmatched_deleted = deleted
        .iter()
        .map(|source| source.path.as_str())
        .collect::<BTreeSet<_>>();
    for target in added {
        let moved_source = deleted.iter().copied().find(|source| {
            unmatched_deleted.contains(source.path.as_str())
                && !source.address.is_empty()
                && source.address == target.address
                && source.repository == target.repository
        });
        if let Some(source) = moved_source {
            unmatched_deleted.remove(source.path.as_str());
            changes.push(LoreRevisionChange {
                path: target.path.clone(),
                source_path: Some(source.path.clone()),
                action: "move",
                size: target.size,
            });
            continue;
        }

        let copied = source_files.iter().any(|source| {
            !source.address.is_empty()
                && source.address == target.address
                && source.repository == target.repository
        });
        changes.push(LoreRevisionChange {
            path: target.path.clone(),
            source_path: None,
            action: if copied { "copy" } else { "add" },
            size: target.size,
        });
    }
    changes.extend(
        unmatched_deleted
            .into_iter()
            .filter_map(|path| source_by_path.get(path))
            .map(|source| LoreRevisionChange {
                path: source.path.clone(),
                source_path: None,
                action: "delete",
                size: source.size,
            }),
    );
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

/// 运行操作并捕获完整 LoreEvent 序列。
fn run_operation(
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
        emit_operation_stream(LoreOperationStreamEvent {
            operation_id: callback_operation_id.clone(),
            operation,
            phase: "streaming",
            event: Some(serialized.clone()),
            status: None,
            duration_ms: None,
            cancellable: false,
        });
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

fn serialize_lore_event(event: &LoreEvent) -> Value {
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
fn conflict_revision_ids(events: &[Value]) -> Option<(String, String, Option<String>)> {
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
fn classify_conflict_operation(
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

fn is_zero_hash(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte == b'0')
}

/// 规范化冲突动作的路径边界。
///
/// Lore 的部分路径参数把空集合解释成“全部”，因此文件级动作必须至少包含一个
/// 用户明确选择的仓库相对路径。Abort 是仓库级恢复动作，调用者传入的旧选区必须
/// 被丢弃，不能意外改变它的 Lore 语义。
fn validate_conflict_action_paths(
    action: LoreConflictAction,
    paths: Vec<String>,
) -> Result<Vec<String>, LoreCommandError> {
    if action == LoreConflictAction::Abort {
        return Ok(Vec::new());
    }
    if paths.is_empty() {
        return Err(LoreCommandError::new(
            "conflict_paths_required",
            "A conflict file action requires at least one explicit repository-relative path",
        ));
    }
    validate_repository_relative_paths(paths)
}

/// 冲突状态查询失败属于结构化读取错误；不能把错误当作“当前没有冲突”。
fn ensure_conflict_read_succeeded(
    result: &LoreOperationResult,
    action: &str,
) -> Result<(), LoreCommandError> {
    if result.status == 0 {
        return Ok(());
    }
    let detail = result
        .events
        .iter()
        .rev()
        .find_map(|event| event.pointer("/data/error/message").and_then(Value::as_str))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("Lore Core did not return error details");
    Err(LoreCommandError::new(
        "conflict_state_unavailable",
        format!("{action} failed (status {}): {detail}", result.status),
    ))
}

fn normalize_paths(paths: Vec<String>, use_repository_root_when_empty: bool) -> Vec<String> {
    let mut paths = paths
        .into_iter()
        .map(|path| path.trim().replace('\\', "/"))
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();

    if paths.is_empty() && use_repository_root_when_empty {
        paths.push(".".to_owned());
    }
    paths
}

/// 校验单个 Lore 仓库相对路径，禁止绝对路径、父目录跳转和平台路径前缀。
fn validate_repository_relative_path(path: &str) -> Result<PathBuf, LoreCommandError> {
    let mut normalized = path.trim().replace('\\', "/");
    // “./文件”仍是合法的仓库相对路径。前端会优先消除该前缀，这里再做一次
    // 防御性归一化，兼容旧会话和外部调用方，同时绝不放宽 “../” 跳转限制。
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_owned();
    }
    let parsed = Path::new(&normalized);
    let components = parsed.components().collect::<Vec<_>>();
    let is_safe = !normalized.is_empty()
        && !parsed.is_absolute()
        && !components.is_empty()
        && components
            .iter()
            .all(|component| matches!(component, std::path::Component::Normal(_)));

    if !is_safe {
        return Err(LoreCommandError::new(
            "invalid_repository_relative_path",
            format!("The file path must be relative to the repository: {path}"),
        ));
    }
    Ok(parsed.to_path_buf())
}

/// Windows `canonicalize` 会返回 `\\?\` 扩展路径；它适合系统调用，却不适合
/// 用户界面和持久化。UNC 路径需要还原为双反斜杠，其余路径直接移除前缀。
fn display_path_without_windows_verbatim_prefix(path: &Path) -> String {
    let display = path.to_string_lossy();
    if let Some(unc_path) = display.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc_path}")
    } else {
        display
            .strip_prefix(r"\\?\")
            .unwrap_or(display.as_ref())
            .to_owned()
    }
}

/// 批量校验并统一为 Lore 使用的正斜杠路径。
fn validate_repository_relative_paths(paths: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
    if paths.is_empty() {
        return Err(LoreCommandError::new(
            "empty_reset_paths",
            "Select at least one file to restore",
        ));
    }

    paths
        .into_iter()
        .map(|path| {
            validate_repository_relative_path(&path).map(|validated| {
                validated
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/")
            })
        })
        .collect()
}

/// Diff 的空路径数组表示整个仓库；非空时仍复用严格的仓库相对路径校验。
fn validate_optional_diff_paths(paths: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
    if paths.is_empty() {
        Ok(Vec::new())
    } else {
        validate_repository_relative_paths(paths)
    }
}

/// 解析仓库内已存在的普通文件，并在解析符号链接后再次确认没有越过仓库根目录。
fn validate_existing_workspace_file(
    repository_path: &str,
    relative_path: &str,
) -> Result<PathBuf, LoreCommandError> {
    let repository_path = validate_repository_path(repository_path)?;
    let relative_path = validate_repository_relative_path(relative_path)?;
    let requested_path = repository_path.join(relative_path);
    if !requested_path.is_file() {
        return Err(LoreCommandError::new(
            "workspace_file_missing",
            format!(
                "The workspace file does not exist or cannot be opened: {}",
                requested_path.display()
            ),
        ));
    }
    let target_path = std::fs::canonicalize(&requested_path).map_err(|error| {
        LoreCommandError::new(
            "workspace_file_unavailable",
            format!(
                "Failed to resolve workspace file {}: {error}",
                requested_path.display()
            ),
        )
    })?;
    if !target_path.starts_with(&repository_path) {
        return Err(LoreCommandError::new(
            "workspace_file_outside_repository",
            "The target file resolves outside the Lore repository",
        ));
    }
    Ok(target_path)
}

/// 解析显式可执行文件路径或系统 PATH 中的命令名。
///
/// Windows 的命令通常省略 `.exe`，VS Code/Cursor 的命令行入口也可能是 `.cmd`；
/// 因此遵循 PATHEXT 顺序探测。返回真实文件路径后，菜单与启动阶段消费同一结论。
fn resolve_external_executable_with(
    executable: &str,
    path_value: Option<&std::ffi::OsStr>,
    extensions: &[String],
) -> Option<PathBuf> {
    let executable = executable.trim();
    if executable.is_empty() || executable.contains(['\0', '\r', '\n']) {
        return None;
    }
    let path = Path::new(executable);
    if path.is_absolute() {
        return path.is_file().then(|| path.to_path_buf());
    }
    if path.components().count() > 1 {
        return None;
    }

    path_value
        .into_iter()
        .flat_map(|value| std::env::split_paths(value).collect::<Vec<_>>())
        .flat_map(|directory| {
            extensions
                .iter()
                .map(move |extension| directory.join(format!("{executable}{extension}")))
        })
        .find(|candidate| candidate.is_file())
}

fn resolve_external_executable(executable: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let extensions = {
        let path = Path::new(executable.trim());
        let configured = std::env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|item| !item.trim().is_empty())
                    .map(|item| item.trim().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec![".COM".into(), ".EXE".into(), ".BAT".into(), ".CMD".into()]);
        if path.extension().is_some() {
            vec![String::new()]
        } else {
            std::iter::once(String::new())
                .chain(configured)
                .collect::<Vec<_>>()
        }
    };
    #[cfg(not(windows))]
    let extensions = vec![String::new()];

    resolve_external_executable_with(executable, std::env::var_os("PATH").as_deref(), &extensions)
}

/// 校验外部工具配置并生成替换后的独立参数。
fn resolve_external_diff_arguments(
    tool: &ExternalDiffTool,
    before_path: &Path,
    after_path: &Path,
    before_label: &str,
    after_label: &str,
) -> Result<Vec<String>, LoreCommandError> {
    let tool_name = tool.name.trim();
    let executable = tool.executable.trim();
    if tool_name.is_empty()
        || tool_name.len() > 128
        || executable.is_empty()
        || executable.len() > 4096
        || executable.contains(['\0', '\r', '\n'])
    {
        return Err(LoreCommandError::new(
            "external_diff_tool_invalid",
            "The external Diff tool name or executable is invalid",
        ));
    }
    if tool.arguments.is_empty()
        || tool.arguments.len() > 64
        || tool
            .arguments
            .iter()
            .any(|argument| argument.len() > 4096 || argument.contains('\0'))
    {
        return Err(LoreCommandError::new(
            "external_diff_arguments_invalid",
            "The external Diff argument template is invalid",
        ));
    }

    let template = tool.arguments.join("\n");
    if !template.contains("{before}") || !template.contains("{after}") {
        return Err(LoreCommandError::new(
            "external_diff_placeholders_missing",
            "The external Diff arguments must include {before} and {after}",
        ));
    }

    let before_path = before_path.to_string_lossy();
    let after_path = after_path.to_string_lossy();
    Ok(tool
        .arguments
        .iter()
        .map(|argument| {
            argument
                .replace("{before}", before_path.as_ref())
                .replace("{after}", after_path.as_ref())
                .replace("{beforeLabel}", before_label)
                .replace("{afterLabel}", after_label)
        })
        .collect())
}

/// 在首次需要不可变/空树内容时创建单次比较专用临时目录。
fn external_diff_temp_directory(
    directory: &mut Option<tempfile::TempDir>,
) -> Result<&tempfile::TempDir, LoreCommandError> {
    if directory.is_none() {
        *directory = Some(
            tempfile::Builder::new()
                .prefix("lore-client-external-diff-")
                .tempdir()
                .map_err(|error| {
                    LoreCommandError::new(
                        "external_diff_temp_create_failed",
                        format!("Failed to create the external Diff temporary directory: {error}"),
                    )
                })?,
        );
    }
    Ok(directory
        .as_ref()
        .expect("The external Diff temporary directory was initialized above"))
}

/// 把一侧内容解析为外部工具可直接打开的绝对路径。
fn materialize_external_diff_side(
    repository_path: &str,
    side: &ExternalDiffSide,
    slot: &str,
    temporary_directory: &mut Option<tempfile::TempDir>,
) -> Result<(PathBuf, bool), LoreCommandError> {
    let relative_path = validate_repository_relative_path(&side.path)?;
    if side.label.len() > 512 || side.label.contains('\0') {
        return Err(LoreCommandError::new(
            "external_diff_label_invalid",
            "The external Diff side label is invalid",
        ));
    }

    if side.kind == ExternalDiffSideKind::Workspace {
        if side.revision.is_some() {
            return Err(LoreCommandError::new(
                "external_diff_side_invalid",
                "A workspace external Diff side cannot include a revision",
            ));
        }
        return validate_existing_workspace_file(repository_path, &side.path)
            .map(|path| (path, false));
    }

    let directory = external_diff_temp_directory(temporary_directory)?;
    let destination = directory.path().join(slot).join(&relative_path);
    let parent = destination.parent().ok_or_else(|| {
        LoreCommandError::new(
            "external_diff_temp_path_invalid",
            "The external Diff temporary file has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        LoreCommandError::new(
            "external_diff_temp_create_failed",
            format!(
                "Failed to create the external Diff temporary directory {}: {error}",
                parent.display()
            ),
        )
    })?;

    let content = match side.kind {
        ExternalDiffSideKind::Empty => {
            if side.revision.is_some() {
                return Err(LoreCommandError::new(
                    "external_diff_side_invalid",
                    "An empty external Diff side cannot include a revision",
                ));
            }
            Vec::new()
        }
        ExternalDiffSideKind::Revision => {
            let revision = side.revision.as_deref().ok_or_else(|| {
                LoreCommandError::new(
                    "external_diff_revision_required",
                    "A revision external Diff side requires an exact revision",
                )
            })?;
            let revision = validate_revision(revision)?;
            let normalized_path = relative_path
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let files = collect_revision_tree_files(repository_path, &revision)?;
            let file = files
                .iter()
                .find(|file| file.path == normalized_path)
                .ok_or_else(|| {
                    LoreCommandError::new(
                        "external_diff_revision_file_missing",
                        format!("The file {normalized_path} does not exist in revision {revision}"),
                    )
                })?;
            read_revision_file_content(repository_path, file)?
        }
        ExternalDiffSideKind::Workspace => {
            unreachable!("Workspace sides return before materialization")
        }
    };

    fs::write(&destination, content).map_err(|error| {
        LoreCommandError::new(
            "external_diff_temp_write_failed",
            format!(
                "Failed to write external Diff temporary file {}: {error}",
                destination.display()
            ),
        )
    })?;
    Ok((destination, true))
}

/// 完成内容物化并启动一个不经过 Shell 的外部 Diff 进程。
fn launch_external_diff(
    repository_path: &str,
    tool: ExternalDiffTool,
    before: ExternalDiffSide,
    after: ExternalDiffSide,
) -> Result<ExternalDiffLaunchResult, LoreCommandError> {
    let repository_root = validate_repository_path(repository_path)?;
    let mut temporary_directory = None;
    let (before_path, before_is_temporary) = materialize_external_diff_side(
        repository_path,
        &before,
        "before",
        &mut temporary_directory,
    )?;
    let (after_path, after_is_temporary) =
        materialize_external_diff_side(repository_path, &after, "after", &mut temporary_directory)?;
    let arguments = resolve_external_diff_arguments(
        &tool,
        &before_path,
        &after_path,
        &before.label,
        &after.label,
    )?;
    let tool_name = tool.name.trim().to_owned();
    let configured_executable = tool.executable.trim().to_owned();
    let executable = resolve_external_executable(&configured_executable).ok_or_else(|| {
        LoreCommandError::new(
            "external_diff_executable_missing",
            format!("External Diff executable was not found: {configured_executable}"),
        )
    })?;
    let mut child = Command::new(&executable)
        .args(arguments)
        .current_dir(repository_root)
        .spawn()
        .map_err(|error| {
            LoreCommandError::new(
                "external_diff_launch_failed",
                format!(
                    "Failed to start external Diff tool {tool_name} ({}): {error}",
                    executable.display()
                ),
            )
        })?;
    let process_id = child.id();

    /*
     * 等待工作放在独立系统线程，不阻塞 Tauri async runtime。工具退出后再保留
     * 30 秒，兼容启动器先退出、实际窗口进程稍后才打开临时文件的常见桌面行为。
     */
    std::thread::spawn(move || {
        let _ = child.wait();
        if temporary_directory.is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
        drop(temporary_directory);
    });

    Ok(ExternalDiffLaunchResult {
        tool_name,
        process_id,
        temporary_file_count: u8::from(before_is_temporary) + u8::from(after_is_temporary),
    })
}

/// 读取一个 Revision 起点的显式父拓扑，并保留从近到远的稳定顺序。
fn external_merge_ancestor_order(
    repository_path: &str,
    start_revision: &str,
) -> Result<Vec<String>, LoreCommandError> {
    let repository_path = repository_path.to_owned();
    let result = collect_revision_history_with(
        1_000,
        Some(validate_revision(start_revision)?),
        move |revision, length| {
            let globals = global_args(&repository_path)?;
            run_operation("external.merge.history", move |callback| {
                lore::runtime().block_on(lore::revision::history(
                    globals,
                    build_revision_history_args(revision, None, 0, length, false),
                    callback,
                ))
            })
        },
    )?;
    ensure_operation_success(&result, "Read external Merge revision history")?;
    Ok(result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("revisionHistoryEntry")
        })
        .filter_map(|event| event.pointer("/data/revision").and_then(Value::as_str))
        .map(str::to_owned)
        .collect())
}

/// 使用两侧真实历史寻找最近共同祖先；找不到时让 BASE 显式退化为空文件。
fn external_merge_base(
    repository_path: &str,
    local_revision: &str,
    remote_revision: &str,
) -> Result<Option<String>, LoreCommandError> {
    let remote_ancestors = external_merge_ancestor_order(repository_path, remote_revision)?
        .into_iter()
        .collect::<BTreeSet<_>>();
    Ok(
        external_merge_ancestor_order(repository_path, local_revision)?
            .into_iter()
            .find(|revision| remote_ancestors.contains(revision)),
    )
}

/// 把 Merge 的历史版本写入独立临时槽；该 Revision 不含文件时使用同名空文件。
fn materialize_external_merge_revision(
    repository_path: &str,
    revision: Option<&str>,
    relative_path: &Path,
    slot: &str,
    temporary_directory: &mut Option<tempfile::TempDir>,
) -> Result<PathBuf, LoreCommandError> {
    let directory = external_diff_temp_directory(temporary_directory)?;
    let destination = directory.path().join(slot).join(relative_path);
    let parent = destination.parent().ok_or_else(|| {
        LoreCommandError::new(
            "external_merge_temp_path_invalid",
            "The external Merge temporary file has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        LoreCommandError::new(
            "external_merge_temp_create_failed",
            format!(
                "Failed to create external Merge temporary directory {}: {error}",
                parent.display()
            ),
        )
    })?;

    let content = if let Some(revision) = revision {
        let revision = validate_revision(revision)?;
        let normalized_path = relative_path
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        collect_revision_tree_files(repository_path, &revision)?
            .iter()
            .find(|file| file.path == normalized_path)
            .map(|file| read_revision_file_content(repository_path, file))
            .transpose()?
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    fs::write(&destination, content).map_err(|error| {
        LoreCommandError::new(
            "external_merge_temp_write_failed",
            format!(
                "Failed to write external Merge temporary file {}: {error}",
                destination.display()
            ),
        )
    })?;
    Ok(destination)
}

fn resolve_external_merge_arguments(
    tool: &ExternalDiffTool,
    paths: [&Path; 4],
    labels: &ExternalMergeLabels,
) -> Result<Vec<String>, LoreCommandError> {
    let template = tool.arguments.join("\n");
    for placeholder in ["{base}", "{local}", "{remote}", "{merged}"] {
        if !template.contains(placeholder) {
            return Err(LoreCommandError::new(
                "external_merge_placeholders_missing",
                "External Merge arguments must include {base}, {local}, {remote}, and {merged}",
            ));
        }
    }
    if tool.name.trim().is_empty()
        || tool.name.len() > 128
        || tool.arguments.is_empty()
        || tool.arguments.len() > 64
        || tool
            .arguments
            .iter()
            .any(|argument| argument.len() > 4096 || argument.contains('\0'))
    {
        return Err(LoreCommandError::new(
            "external_merge_tool_invalid",
            "The external Merge tool configuration is invalid",
        ));
    }
    let [base, local, remote, merged] = paths.map(|path| path.to_string_lossy());
    Ok(tool
        .arguments
        .iter()
        .map(|argument| {
            argument
                .replace("{base}", base.as_ref())
                .replace("{local}", local.as_ref())
                .replace("{remote}", remote.as_ref())
                .replace("{merged}", merged.as_ref())
                .replace("{baseLabel}", &labels.base)
                .replace("{localLabel}", &labels.local)
                .replace("{remoteLabel}", &labels.remote)
                .replace("{mergedLabel}", &labels.merged)
        })
        .collect())
}

/// 启动四路 Merge；历史三侧始终临时物化，结果侧优先直接使用真实工作区文件。
fn launch_external_merge(
    repository_path: &str,
    tool: ExternalDiffTool,
    path: &str,
    current_revision: &str,
    incoming_revision: &str,
    labels: ExternalMergeLabels,
) -> Result<ExternalDiffLaunchResult, LoreCommandError> {
    let repository_root = validate_repository_path(repository_path)?;
    let relative_path = validate_repository_relative_path(path)?;
    let current_revision = validate_revision(current_revision)?;
    let incoming_revision = validate_revision(incoming_revision)?;
    let base_revision =
        external_merge_base(repository_path, &current_revision, &incoming_revision)?;
    let mut temporary_directory = None;
    let base = materialize_external_merge_revision(
        repository_path,
        base_revision.as_deref(),
        &relative_path,
        "base",
        &mut temporary_directory,
    )?;
    let local = materialize_external_merge_revision(
        repository_path,
        Some(&current_revision),
        &relative_path,
        "local",
        &mut temporary_directory,
    )?;
    let remote = materialize_external_merge_revision(
        repository_path,
        Some(&incoming_revision),
        &relative_path,
        "remote",
        &mut temporary_directory,
    )?;

    let requested_merged = repository_root.join(&relative_path);
    let (merged, copy_back_target) = if requested_merged.is_file() {
        (
            validate_existing_workspace_file(repository_path, path)?,
            None,
        )
    } else {
        let merged = materialize_external_merge_revision(
            repository_path,
            None,
            &relative_path,
            "merged",
            &mut temporary_directory,
        )?;
        (merged, Some(requested_merged))
    };
    let arguments =
        resolve_external_merge_arguments(&tool, [&base, &local, &remote, &merged], &labels)?;
    let executable = resolve_external_executable(&tool.executable).ok_or_else(|| {
        LoreCommandError::new(
            "external_merge_executable_missing",
            format!(
                "External Merge executable was not found: {}",
                tool.executable.trim()
            ),
        )
    })?;
    let tool_name = tool.name.trim().to_owned();
    let copy_back_needed = copy_back_target.is_some();
    let copy_back_root = repository_root.clone();
    let mut child = Command::new(&executable)
        .args(arguments)
        .current_dir(&repository_root)
        .spawn()
        .map_err(|error| {
            LoreCommandError::new(
                "external_merge_launch_failed",
                format!(
                    "Failed to start external Merge tool {tool_name} ({}): {error}",
                    executable.display()
                ),
            )
        })?;
    let process_id = child.id();

    std::thread::spawn(move || {
        let succeeded = child.wait().is_ok_and(|status| status.success());
        if succeeded {
            if let Some(target) = copy_back_target {
                /*
                 * 工具启动时工作区没有该文件，按需求先使用临时 MERGED。退出后仅在
                 * 目标仍不存在时回写，避免覆盖合并期间由其他进程新建的真实内容。
                 */
                if !target.exists() {
                    if let Some(parent) = target.parent() {
                        let _ = fs::create_dir_all(parent);
                        let parent_is_safe = fs::canonicalize(parent)
                            .is_ok_and(|resolved| resolved.starts_with(&copy_back_root));
                        if parent_is_safe {
                            let _ = fs::copy(&merged, target);
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(30));
        drop(temporary_directory);
    });

    Ok(ExternalDiffLaunchResult {
        tool_name,
        process_id,
        temporary_file_count: 3 + u8::from(copy_back_needed),
    })
}

/// 限制通过 IPC 传入的补丁大小，避免意外把超大二进制内容复制到内存或磁盘。
fn validate_patch_content(patch: &str) -> Result<(), LoreCommandError> {
    const MAX_PATCH_BYTES: usize = 10 * 1024 * 1024;
    if patch.trim().is_empty() {
        return Err(LoreCommandError::new(
            "empty_patch",
            "The current selection has no exportable text differences",
        ));
    }
    if patch.len() > MAX_PATCH_BYTES {
        return Err(LoreCommandError::new(
            "patch_too_large",
            "The patch exceeds 10 MB; reduce the file selection",
        ));
    }
    Ok(())
}

/// 为临时补丁生成不包含目录语义的可读文件名。
fn sanitize_patch_name(file_name: &str) -> String {
    let sanitized = file_name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect::<String>();
    if sanitized.trim_matches(['.', '_']).is_empty() {
        "workspace-change".to_owned()
    } else {
        sanitized
    }
}

/// 从安全仓库路径生成 `.loreignore` 规则，扩展名模式会自动去重。
fn build_ignore_rules(
    paths: &[String],
    by_extension: bool,
) -> Result<Vec<String>, LoreCommandError> {
    let mut rules = Vec::new();
    for path in paths {
        let rule = if by_extension {
            let extension = Path::new(path)
                .extension()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    LoreCommandError::new(
                        "ignore_extension_missing",
                        format!("The file has no extension that can be ignored: {path}"),
                    )
                })?;
            format!("*.{extension}")
        } else {
            path.clone()
        };
        if !rules.iter().any(|current| current == &rule) {
            rules.push(rule);
        }
    }
    Ok(rules)
}

fn to_lore_array(paths: Vec<String>) -> LoreArray<LoreString> {
    LoreArray::from_vec(paths.into_iter().map(LoreString::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

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

        let error =
            normalize_auth_user_ids((0..=1_000).map(|index| format!("user-{index}")).collect())
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
        fs::create_dir_all(root.join("nested")).expect("temporary Store directory should exist");
        fs::write(root.join("first.fragment"), [1_u8, 2, 3])
            .expect("first Store file should be writable");
        fs::write(root.join("nested").join("second.fragment"), [4_u8, 5])
            .expect("second Store file should be writable");

        let (size_bytes, file_count, error) = scan_directory_usage(&root);

        assert_eq!(size_bytes, 5);
        assert_eq!(file_count, 2);
        assert!(error.is_none());
        fs::remove_dir_all(&root).expect("temporary Store directory should be removable");
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
        let error = validate_optional_lock_filter(
            Some("Content/Maps/\nSecret.umap".to_owned()),
            "Lock path",
        )
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
        let error = collect_revision_history_with(100, None, |revision, _length| {
            match revision.as_deref() {
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
            }
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
        std::fs::create_dir_all(&image_directory)
            .expect("Temporary image directory should be created");
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
        )
        .expect("An allowlisted workspace image should return a preview DTO");

        assert_eq!(preview.path, "Content/Images/Preview.PNG");
        assert_eq!(preview.kind, "image");
        assert_eq!(preview.mime_type, "image/png");
        assert_eq!(preview.size, 8);
        assert_eq!(preview.data_base64, "iVBORw0KGgo=");
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
                .expect_err(
                    "A file-level conflict action must not interpret an empty set as all files"
                )
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
                .expect_err(
                    "Missing repository and client identities must fail before calling Lore"
                )
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

        let updated = update_repository_configuration(
            &repository_path,
            "new@example.com",
            "lore://new:41337/",
        )
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
            validate_file_history_start(
                Some("main".to_owned()),
                Some("abcdef1234567890".to_owned())
            )
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
        let error = validate_repository_relative_paths(Vec::new())
            .expect_err("An empty list must be rejected");
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
        let (repository_path, _cleanup) =
            create_configuration_test_repository("directory-probe", "");
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
        std::fs::create_dir_all(&repository_path)
            .expect("The ordinary test directory should be created");
        std::fs::write(repository_path.join("existing.txt"), "must be preserved")
            .expect("An existing file should be created in the directory");
        let _cleanup = TemporaryRepository::new(repository_path.clone());

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
        .expect("An empty repository should expose an empty history without resolving the zero Revision");
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
        let destination = parent.join("world");
        std::fs::create_dir_all(&destination).expect("The test directory should be created");
        std::fs::write(destination.join("existing.txt"), "preserve")
            .expect("The test file should be written");
        let _cleanup = TemporaryRepository::new(parent.clone());

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
        std::fs::create_dir_all(&parent).expect("The test parent directory should be created");
        let _cleanup = TemporaryRepository::new(parent.clone());
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
        std::fs::create_dir_all(&parent).expect("The test parent directory should be created");
        let _cleanup = TemporaryRepository::new(parent.clone());
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
        std::fs::create_dir_all(&parent).expect("The test parent directory should be created");
        let _cleanup = TemporaryRepository::new(parent.clone());

        let destination =
            validate_clone_destination(parent.to_string_lossy().as_ref(), "世界-project")
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
        std::fs::create_dir_all(&repository_path)
            .expect("The temporary test directory should be created");
        let _cleanup = TemporaryRepository::new(repository_path.clone());

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
        )
        .expect(
            "The root revision PNG should return real preview content from the immutable store",
        );
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
        let committed_files = collect_revision_tree_files(
            repository_path.to_string_lossy().as_ref(),
            &source_revision,
        )
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
            let _ = std::fs::remove_dir_all(&self.path);
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
        let metadata_path = repository_path.join(".lore");
        std::fs::create_dir_all(&metadata_path)
            .expect("The temporary Lore metadata directory should be created");
        std::fs::write(metadata_path.join("config.toml"), configuration)
            .expect("The temporary repository configuration should be written");
        let cleanup = TemporaryRepository::new(repository_path.clone());
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
}
