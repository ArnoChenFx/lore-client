//! 仓库探测、初始化、发布、目录、共享存储、锁、依赖、通知、克隆、配置入口、View 与状态命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
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
pub(super) fn operation_requires_authentication(result: &LoreOperationResult) -> bool {
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
    /*
     * 文件锁状态只查询调用方给出的少量路径，不会构造完整 Tree、Diff 或二进制载荷。
     * 它不能进入全局重型读取通道，否则另一个仓库的新查询会把当前合法请求淘汰。
     */
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
    run_notification_lore_task(move || {
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
    run_notification_lore_task(move || {
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
    direct_file_write: bool,
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
        direct_file_write,
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
                    direct_file_write: u8::from(direct_file_write),
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

/// 读取仓库状态，并对旧版本可能遗留的结构事件做保守归一化。
///
/// 旧客户端或外部 Lore 写入式扫描可能把未提交新增留在 staged state；若该路径随后
/// 在提交前被删除，后续 Status 会把它误报为 Delete。这里以当前 Revision Tree 为权威基线，
/// 只对无冲突的结构变化做精确归一化：不存在于基线的未暂存 Delete，以及磁盘已
/// 明确不存在的未暂存 Add 被剔除；唯一的“删除源内容地址 = 新增目标工作区哈希”
/// 配对在相同 Stage 分区内被提升为 Move。
/// 已暂存与未暂存事件绝不跨区合并，避免把“已暂存新增后又从工作区删除”等双层语义
/// 错误折叠；任何冲突状态则完整保留上游事件。
pub(super) fn normalize_unstaged_structural_status(
    repository_path: &str,
    mut result: LoreOperationResult,
) -> LoreOperationResult {
    if result.status != 0 || result.events.iter().any(status_event_has_conflict) {
        return result;
    }

    let missing_unstaged_adds = collect_missing_unstaged_add_paths(repository_path, &result.events);

    let deleted_paths = result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/type").and_then(Value::as_str) == Some("file")
                && event.pointer("/data/action").and_then(Value::as_str) == Some("delete")
        })
        .filter_map(|event| event.pointer("/data/path").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if deleted_paths.is_empty() {
        rewrite_unstaged_structural_status_events(
            &mut result.events,
            &[],
            &BTreeMap::new(),
            &missing_unstaged_adds,
        );
        return result;
    }

    let Some(current_revision) = result
        .events
        .iter()
        .find(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusRevision")
        })
        .and_then(|event| event.pointer("/data/revision").and_then(Value::as_str))
        .filter(|revision| !revision.is_empty())
    else {
        return result;
    };
    let baseline_files = if is_zero_hash(current_revision) {
        Vec::new()
    } else {
        match collect_revision_tree_files_at_paths(
            repository_path,
            current_revision,
            &deleted_paths,
        ) {
            Ok(files) => files,
            Err(error) => {
                log::debug!(
                    "Skipping structural status normalization because the current revision tree could not be read: {}",
                    error.message
                );
                return result;
            }
        }
    };

    let deleted_sizes = baseline_files
        .iter()
        .map(|file| file.size)
        .collect::<BTreeSet<_>>();
    let added_candidates = result
        .events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/type").and_then(Value::as_str) == Some("file")
                && event.pointer("/data/action").and_then(Value::as_str) == Some("add")
        })
        .filter_map(|event| {
            let path = event.pointer("/data/path").and_then(Value::as_str)?;
            let size = event.pointer("/data/size").and_then(Value::as_u64)?;
            deleted_sizes
                .contains(&size)
                .then(|| (path.to_owned(), size))
        })
        .collect::<Vec<_>>();
    let workspace_hashes = hash_workspace_status_candidates(repository_path, &added_candidates);
    rewrite_unstaged_structural_status_events(
        &mut result.events,
        &baseline_files,
        &workspace_hashes,
        &missing_unstaged_adds,
    );
    result
}

/// 为工作区 Status 文件事件补充稳定的内容分类。
///
/// 只有未暂存文件才能用当前工作区正文作为权威来源；Stage 内容属于独立不可变快照，
/// 直接读取同路径工作区文件会在“暂存后继续修改”时得到错误结论，因此暂存项保持
/// `unknown/deferred`，等主要选择加载真实 Lore Diff 后再收敛。
pub(super) fn enrich_workspace_status_content_classification(
    repository_path: &str,
    events: &mut [Value],
) {
    for event in events {
        if event.get("tagName").and_then(Value::as_str) != Some("repositoryStatusFile")
            || event.pointer("/data/type").and_then(Value::as_str) == Some("directory")
        {
            continue;
        }

        let classification = if event.pointer("/data/flagStaged").and_then(Value::as_bool)
            == Some(true)
        {
            FileContentClassification::deferred()
        } else if let Some(path) = event.pointer("/data/path").and_then(Value::as_str) {
            match validate_existing_workspace_file(repository_path, path).and_then(
                |absolute_path| {
                    classify_file_content(&absolute_path).map_err(|error| {
                        LoreCommandError::new(
                            "workspace_content_classification_unavailable",
                            format!("Failed to sample workspace file {path}: {error}"),
                        )
                    })
                },
            ) {
                Ok(classification) => classification,
                Err(error) => {
                    // 删除、权限变化或并发文件替换不应让完整 Status 失败。结构化 unknown
                    // 会让前端继续尝试真实 Diff，而 debug 日志保留诊断上下文。
                    log::debug!(
                        "Workspace content classification unavailable for {path}: {}",
                        error.message
                    );
                    FileContentClassification::unknown(FileContentClassificationSource::Unavailable)
                }
            }
        } else {
            FileContentClassification::unknown(FileContentClassificationSource::Unavailable)
        };

        if let Some(data) = event.get_mut("data").and_then(Value::as_object_mut) {
            data.insert(
                "contentClassification".to_owned(),
                serde_json::to_value(classification)
                    .expect("File content classification is always serializable"),
            );
        }
    }
}

/// 找出 Lore 仍报告为未暂存 Add、但工作区文件系统已经明确返回不存在的路径。
///
/// 只接受通过仓库相对路径校验且 `symlink_metadata` 返回 NotFound 的证据。权限失败、
/// 其他 I/O 错误和仍存在的符号链接都保留原事件，避免一次只读状态修正隐藏真实变化。
fn collect_missing_unstaged_add_paths(repository_path: &str, events: &[Value]) -> BTreeSet<String> {
    events
        .iter()
        .filter(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/type").and_then(Value::as_str) == Some("file")
                && event.pointer("/data/action").and_then(Value::as_str) == Some("add")
                && event.pointer("/data/flagStaged").and_then(Value::as_bool) != Some(true)
        })
        .filter_map(|event| event.pointer("/data/path").and_then(Value::as_str))
        .filter_map(|path| {
            let relative_path = validate_repository_relative_path(path).ok()?;
            match std::fs::symlink_metadata(Path::new(repository_path).join(relative_path)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(path.to_owned()),
                _ => None,
            }
        })
        .collect()
}

/// 冲突事件包含多个互斥或组合标记；任一个为真都必须跳过结构归一化。
fn status_event_has_conflict(event: &Value) -> bool {
    event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
        && [
            "flagConflict",
            "flagConflictUnresolved",
            "flagConflictAutomerged",
            "flagConflictMine",
            "flagConflictTheirs",
        ]
        .iter()
        .any(|flag| {
            event
                .pointer(&format!("/data/{flag}"))
                .and_then(Value::as_bool)
                == Some(true)
        })
}

/// 通过 Lore 自身的流式文件哈希读取候选目标，避免为了识别大型资产移动而把正文整体
/// 载入客户端内存。路径先经过仓库相对路径与符号链接越界校验；任一候选在扫描后发生
/// 漂移时只放弃该候选的 Move 提升，仍可继续剔除已有 Tree 证据支持的幽灵 Delete。
fn hash_workspace_status_candidates(
    repository_path: &str,
    candidates: &[(String, u64)],
) -> BTreeMap<String, String> {
    let validated = candidates
        .iter()
        .filter_map(|(relative_path, size)| {
            match validate_existing_workspace_file(repository_path, relative_path) {
                Ok(absolute_path) => Some((relative_path.clone(), *size, absolute_path)),
                Err(error) => {
                    log::debug!(
                        "Skipping workspace move hash for {relative_path}: {}",
                        error.message
                    );
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    if validated.is_empty() {
        return BTreeMap::new();
    }

    let globals = match global_args(repository_path) {
        Ok(globals) => globals,
        Err(error) => {
            log::debug!(
                "Skipping workspace move hashes because repository globals are unavailable: {}",
                error.message
            );
            return BTreeMap::new();
        }
    };
    let paths = validated
        .iter()
        .map(|(_, _, path)| LoreString::from_path(path))
        .collect::<Vec<_>>();
    let hash_result = run_operation("file.hash.status-move", move |callback| {
        lore::runtime().block_on(lore::file::hash(
            globals,
            LoreFileHashArgs {
                paths: LoreArray::from_vec(paths),
            },
            callback,
        ))
    });
    let hash_result = match hash_result {
        Ok(result) if result.status == 0 => result,
        Ok(result) => {
            log::debug!(
                "Skipping workspace move hashes because Lore file hash returned status {}",
                result.status
            );
            return BTreeMap::new();
        }
        Err(error) => {
            log::debug!(
                "Skipping workspace move hashes because Lore file hash failed: {}",
                error.message
            );
            return BTreeMap::new();
        }
    };

    let hashes = hash_result
        .events
        .iter()
        .filter(|event| event.get("tagName").and_then(Value::as_str) == Some("fileHash"))
        .collect::<Vec<_>>();
    /*
     * 固定 Lore 的 File Hash 按请求数组顺序同步遍历并逐项发出事件；以相同顺序配对可
     * 避免 Windows 扩展路径在跨 FFI 序列化时出现额外前缀。大小仍需一致，防止哈希
     * 期间文件被外部编辑后把旧 Status 的目标误配成 Move。
     */
    validated
        .iter()
        .zip(hashes)
        .filter_map(|((relative_path, expected_size, _), event)| {
            let size = event.pointer("/data/size").and_then(Value::as_u64)?;
            let hash = event.pointer("/data/hash").and_then(Value::as_str)?;
            (*expected_size == size).then(|| (relative_path.clone(), hash.to_owned()))
        })
        .collect()
}

/// 依据已经取得的不可变 Tree 元数据与工作区内容哈希改写事件流。
///
/// 只有同一 Stage 分区内的哈希分组两端都恰好各一项时才合并 Move；一个来源对应多个
/// 同内容目标、多个同内容来源对应一个目标，或来源与目标跨 Stage 分区，都保持
/// Add/Delete，明确拒绝在有歧义时随意选择路径关系。
pub(super) fn rewrite_unstaged_structural_status_events(
    events: &mut Vec<Value>,
    baseline_files: &[RevisionTreeFile],
    workspace_hashes: &BTreeMap<String, String>,
    missing_unstaged_adds: &BTreeSet<String>,
) {
    let baseline_by_path = baseline_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut removed_indices = events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            if event.get("tagName").and_then(Value::as_str) != Some("repositoryStatusFile")
                || event.pointer("/data/type").and_then(Value::as_str) != Some("file")
                || event.pointer("/data/flagStaged").and_then(Value::as_bool) == Some(true)
            {
                return false;
            }
            let Some(path) = event.pointer("/data/path").and_then(Value::as_str) else {
                return false;
            };
            match event.pointer("/data/action").and_then(Value::as_str) {
                Some("delete") => !baseline_by_path.contains_key(path),
                Some("add") => missing_unstaged_adds.contains(path),
                _ => false,
            }
        })
        .map(|(index, _)| index)
        .collect::<BTreeSet<_>>();

    let address_hash = |address: &str| {
        address
            .split_once('-')
            .map(|(hash, _)| hash)
            .filter(|hash| hash.len() == 64 && hash.chars().any(|character| character != '0'))
            .map(str::to_owned)
    };
    let mut deleted_by_content = BTreeMap::<(String, u64, bool), Vec<(usize, String)>>::new();
    let mut added_by_content = BTreeMap::<(String, u64, bool), Vec<(usize, String)>>::new();
    for (index, event) in events.iter().enumerate() {
        if removed_indices.contains(&index)
            || event.get("tagName").and_then(Value::as_str) != Some("repositoryStatusFile")
            || event.pointer("/data/type").and_then(Value::as_str) != Some("file")
        {
            continue;
        }
        let Some(path) = event.pointer("/data/path").and_then(Value::as_str) else {
            continue;
        };
        let staged = event.pointer("/data/flagStaged").and_then(Value::as_bool) == Some(true);
        match event.pointer("/data/action").and_then(Value::as_str) {
            Some("delete") => {
                let Some(file) = baseline_by_path.get(path) else {
                    continue;
                };
                let Some(hash) = address_hash(&file.address) else {
                    continue;
                };
                deleted_by_content
                    .entry((hash, file.size, staged))
                    .or_default()
                    .push((index, path.to_owned()));
            }
            Some("add") => {
                let Some(hash) = workspace_hashes.get(path) else {
                    continue;
                };
                let Some(size) = event.pointer("/data/size").and_then(Value::as_u64) else {
                    continue;
                };
                added_by_content
                    .entry((hash.clone(), size, staged))
                    .or_default()
                    .push((index, path.to_owned()));
            }
            _ => {}
        }
    }

    for (content, deleted) in deleted_by_content {
        let Some(added) = added_by_content.get(&content) else {
            continue;
        };
        if deleted.len() != 1 || added.len() != 1 {
            continue;
        }
        let (deleted_index, source_path) = &deleted[0];
        let (added_index, _) = &added[0];
        let Some(data) = events[*added_index]
            .get_mut("data")
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        data.insert("action".to_owned(), Value::String("move".to_owned()));
        data.insert("fromPath".to_owned(), Value::String(source_path.clone()));
        removed_indices.insert(*deleted_index);
    }

    let mut index = 0_usize;
    events.retain(|_| {
        let keep = !removed_indices.contains(&index);
        index += 1;
        keep
    });
}

/// 在 Lore 的只读 RepositoryContext 中执行完整 Status 扫描。
///
/// 顶层 `lore::repository::status` 会在 `scan` 或 `check_dirty` 开启时自动选择写调用，
/// 但固定 Lore 没有公开“扫描但不持久化”的 FFI 参数。底层 Status 已经把持久化严格
/// 绑定到 `RepositoryWriteToken`，因此这里重建最小公开执行边界：继续使用绑定账户、
/// Lore EventDispatcher、结构化错误与 End/Complete 生命周期，只把仓库访问模式固定为
/// `ReadOnly`。扫描产生的临时 dirty 标记随内存 State 释放，不会写回 staged anchor。
fn run_read_only_repository_status(
    repository_path: PathBuf,
    globals: LoreGlobalArgs,
    callback: LoreEventCallback,
) -> i32 {
    let execution = Arc::new(lore_revision::interface::ExecutionContext::new_client(
        globals,
        lore_revision::relay::EventDispatcher::new(callback),
    ));
    let scoped_execution = execution.clone();

    lore::runtime().block_on(
        lore_revision::runtime::LORE_CONTEXT.scope(execution, async move {
            let repository = match lore_revision::repository::load_and_connect(
                &repository_path,
                lore_revision::repository::RepositoryAccess::ReadOnly,
            )
            .await
            {
                Ok(repository) => repository,
                Err(error) => {
                    return scoped_execution
                        .dispatcher
                        .complete_result::<(), _>(Err(error))
                        .await;
                }
            };

            let result = lore_revision::repository::status::status(
                repository,
                None,
                lore_revision::repository::status::StatusOptions {
                    staged: true,
                    /*
                     * 仓库快照必须同时包含 staged 路径与当前文件系统差异。若按旧
                     * `scan=false` 只返回已持久化节点，后台远端刷新会用残缺快照
                     * 覆盖仍然存在的本地变化。只读上下文保证完整扫描不会序列化。
                     */
                    scan: true,
                    check_dirty: false,
                    reset: false,
                    sync_point: true,
                    revision_only: false,
                    count: true,
                },
            )
            .await;
            scoped_execution.dispatcher.complete_result(result).await
        }),
    )
}

#[tauri::command]
pub async fn lore_repository_status(
    repository_path: String,
    scan: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        // 保留 `scan` 形参名称维持 Tauri IPC 契约；完整快照现在无条件执行只读扫描。
        let _scan_requested = scan;
        let globals = global_args(&repository_path)?;
        /*
         * 必须与 Lore 顶层调用使用同一套路径清理。Windows `canonicalize` 产生的
         * `\\?\` 路径和 Lore 清理后的普通路径若同时作为 RepositoryLock 键，会让
         * 同一进程尝试再次取得自己的 OS 文件锁，直到旧 Flush 释放才恢复。
         */
        let validated_repository_path = lore_revision::util::path::make_absolute_from(
            globals.repository_path.as_str(),
            globals.working_directory().map(Path::new),
        )
        .map_err(|error| {
            LoreCommandError::new(
                "repository_path_unavailable",
                format!("Failed to normalize repository path for read-only status: {error}"),
            )
        })?;
        let result = run_operation("repository.status", move |callback| {
            /*
             * Lore 顶层 `repository::status(scan=1)` 会主动取得写令牌，并把扫描得到的
             * Dirty flags 序列化到 staged anchor。工作区查看不应改变待提交树，因此
             * 这里直接复用 Lore 的只读调用边界和底层 Status 实现：完整扫描仍使用
             * Lore 自身的 Filter、Layer、Link 与内容比较规则，但只读 RepositoryContext
             * 没有写令牌，Status 结束时无法持久化临时 dirty state。
             *
             * IPC 暂时保留旧 `scan` 参数以兼容前端和外部调用方，但仓库快照的契约
             * 是完整快照，因此读路径始终扫描。若将来需要仅刷新远端元数据，应新增
             * 不包含 `changes` 的独立 DTO，不能用残缺 Status 冒充完整快照。
             */
            run_read_only_repository_status(validated_repository_path, globals, callback)
        })?;
        let mut result = normalize_unstaged_structural_status(&repository_path, result);
        enrich_workspace_status_content_classification(&repository_path, &mut result.events);
        Ok(result)
    })
    .await
}
