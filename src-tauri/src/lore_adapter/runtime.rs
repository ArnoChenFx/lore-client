//! 异步任务调度、重型读取收敛、全局参数、输入校验、共享存储解析与错误映射。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 解析单次提交的最终身份。仓库配置始终优先，默认身份只作为缺失时的兜底；
/// 两者都为空时在调用 Lore 前失败，避免再出现没有作者或依赖认证缓存的修订。
pub(super) fn resolve_commit_identity(
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
pub(super) async fn run_lore_task<T>(
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

/**
 * 串行执行会构造完整文件树、补丁或二进制载荷的读取。
 *
 * 普通 Lore 读仍可并行；只有已知会在 Rust、Serde 与 WebView 边界同时持有大对象的
 * 命令经过该门。前端 latest-only 队列负责淘汰中间意图，这里作为进程级最后防线，
 * 保证不同面板或未来调用方也不能把多个数百 MiB 解码峰值叠加起来。
 */
pub(super) async fn run_heavy_lore_task<T>(
    lane: &'static HeavyReadLane,
    task: impl FnOnce() -> Result<T, LoreCommandError> + Send + 'static,
) -> Result<T, LoreCommandError>
where
    T: Send + 'static,
{
    let ticket = lane.reserve();
    let _permit = HEAVY_READ_LOCK
        .get_or_init(|| tauri::async_runtime::Mutex::new(()))
        .lock()
        .await;

    /*
     * 同一通道只执行首个活动任务和最新等待意图。已进入 blocking pool 的任务无法
     * 安全强制取消；但所有仍在异步门外等待的旧请求可以在创建 OS 线程前结束。
     */
    if !lane.is_latest(ticket) {
        return Err(LoreCommandError::new(
            "heavy_read_superseded",
            "The heavy Lore read was superseded by a newer request",
        ));
    }

    run_lore_task(task).await
}

/**
 * 在进入 blocking pool 前串行化通知生命周期调用。
 *
 * Subscribe 与 Unsubscribe 会进入 Lore runtime；快速切换 Repository 时，前端队列是
 * 第一层防线，此处仍作为原生边界兜底，确保异常调用方也不会让数百条阻塞线程同时
 * 等待 Lore 内部资源。
 */
pub(super) async fn run_notification_lore_task<T>(
    task: impl FnOnce() -> Result<T, LoreCommandError> + Send + 'static,
) -> Result<T, LoreCommandError>
where
    T: Send + 'static,
{
    let notification_lock =
        NOTIFICATION_LIFECYCLE_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()));
    let _notification_guard = notification_lock.lock().await;
    run_lore_task(task).await
}

/** 为一种重读维护单调意图序号，使异步门只放行该通道最新的等待请求。 */
pub(super) struct HeavyReadLane {
    latest_ticket: AtomicU64,
}

impl HeavyReadLane {
    pub(super) const fn new() -> Self {
        Self {
            latest_ticket: AtomicU64::new(0),
        }
    }

    fn reserve(&self) -> u64 {
        self.latest_ticket.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_latest(&self, ticket: u64) -> bool {
        self.latest_ticket.load(Ordering::SeqCst) == ticket
    }
}

/// 验证并规范化仓库路径，同时配置适合桌面客户端的短期 Store 复用。
pub(super) fn global_args(repository_path: &str) -> Result<LoreGlobalArgs, LoreCommandError> {
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

pub(super) fn validate_optional_auth_identity(
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
pub(super) fn validate_auth_user_info_request(
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
pub(super) fn normalize_auth_user_ids(
    user_ids: Vec<String>,
) -> Result<Vec<String>, LoreCommandError> {
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

pub(super) fn validate_repository_path(repository_path: &str) -> Result<PathBuf, LoreCommandError> {
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

pub(super) fn validate_branch_name(branch: &str) -> Result<String, LoreCommandError> {
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
pub(super) fn validate_revision(revision: &str) -> Result<String, LoreCommandError> {
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
pub(super) fn validate_file_history_start(
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
pub(super) fn build_repository_url(
    server_url: &str,
    repository_name: &str,
) -> Result<String, LoreCommandError> {
    let server_url = validate_server_url(server_url)?;
    let repository_name = validate_repository_name(repository_name)?;
    Ok(format!("{server_url}/{repository_name}"))
}

/// 与固定 Lore `is_valid_name` 保持一致，并额外要求是单一 URL 路径段。
pub(super) fn validate_repository_name(repository_name: &str) -> Result<String, LoreCommandError> {
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
pub(super) fn validate_repository_description(
    description: &str,
) -> Result<String, LoreCommandError> {
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
pub(super) fn validate_optional_clone_target(
    target: Option<String>,
) -> Result<String, LoreCommandError> {
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
pub(super) fn validate_clone_layer(
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
pub(super) fn validate_bare_clone_options(
    bare: bool,
    view_path: Option<&str>,
    virtually: bool,
    direct_file_write: bool,
    layer_repository: &str,
    dependency_root_files: &[String],
    dependency_tags: &[String],
    dependency_recursive: bool,
    dependency_depth_limit: u32,
) -> Result<(), LoreCommandError> {
    if bare
        && (view_path.is_some()
            || virtually
            || direct_file_write
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

pub(super) fn validate_clone_destination(
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
pub(super) fn is_windows_reserved_file_name(file_name: &str) -> bool {
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

pub(super) fn validate_existing_directory(
    directory: &str,
    label: &str,
) -> Result<PathBuf, LoreCommandError> {
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

pub(super) fn validate_optional_file(
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

/// Shared Store 显式路径是 Store 容器目录，而不是其中的
/// `shared_store/` 实际数据目录。空路径表示让 Lore 按远端查找默认 Store。
pub(super) fn validate_shared_store_path(
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
pub(super) fn validate_optional_lock_filter(
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
pub(super) fn validate_dependency_tags(tags: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
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
pub(super) fn validate_optional_dependency_paths(
    paths: Vec<String>,
) -> Result<Vec<String>, LoreCommandError> {
    if paths.is_empty() {
        Ok(Vec::new())
    } else {
        validate_repository_relative_paths(paths)
    }
}

pub(super) fn validate_dependency_depth_limit(depth_limit: u32) -> Result<(), LoreCommandError> {
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
pub(super) fn parse_shared_store_info(
    events: &[Value],
) -> Result<LoreSharedStoreInfo, LoreCommandError> {
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
pub(super) fn scan_directory_usage(root: &Path) -> (u64, u64, Option<String>) {
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
pub(super) fn validate_server_url(server_url: &str) -> Result<String, LoreCommandError> {
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
pub(super) fn ensure_command_success(
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
pub(super) fn ensure_operation_success(
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
