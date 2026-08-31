//! 仓库目录探测、初始化、发布、缓存释放与元数据目录解析。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 从所选目录向上寻找 Lore 元数据；损坏的元数据文件也视为“受 Lore 管理”，
/// 这样打开失败时会暴露损坏错误，而不是提供可能覆盖现场的初始化入口。
pub(super) fn probe_repository_directory(selected_path: &Path) -> RepositoryDirectoryProbe {
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
pub(super) fn initialize_repository(
    directory_path: &str,
    repository_name: &str,
    description: &str,
    repository_identity: &str,
    default_identity: Option<&str>,
    use_shared_store: bool,
    shared_store_path: Option<String>,
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
    let shared_store_path = validate_shared_store_path(use_shared_store, shared_store_path)?;
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
        // 初始化只在用户显式要求时启用共享存储；未选择时沿用机器级
        // `use_shared_store_automatically` 配置，与上游 CLI 语义保持一致。
        use_shared_store: if use_shared_store {
            LoreSharedStoreMode::Enabled
        } else {
            LoreSharedStoreMode::Inherit
        },
        shared_store_path: shared_store_path.unwrap_or_default().into(),
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
pub(super) fn publish_repository(
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
            // 在线 Create 的临时仓库未携带共享存储偏好，保持默认 Inherit（沿用机器配置）。
            use_shared_store: LoreSharedStoreMode::Inherit,
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
pub(super) fn resolve_publish_auth_identity(
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
pub(super) fn find_remote_repository_name<'a>(
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
pub(super) fn push_newly_created_repository_branch(
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
pub(super) fn published_branch_tips_are_zero(result: &LoreOperationResult, branch: &str) -> bool {
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
pub(super) fn read_repository_id(repository_path: &Path) -> Result<String, LoreCommandError> {
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
pub(super) fn release_repository_cache(repository_path: &Path) -> Result<(), LoreCommandError> {
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

/// 在认证状态变化后释放所有已打开仓库的 Lore 上下文。
///
/// 该辅助函数把“遍历、去重、全部尝试”的编排与真实 Lore 调用分离，便于在不连接
/// 远端服务器的单元测试中验证：一次账户更新不会只刷新当前仓库。
pub(super) fn release_repository_authentication_contexts_with<F>(
    repository_paths: &[PathBuf],
    mut release: F,
) -> Result<(), LoreCommandError>
where
    F: FnMut(&Path) -> Result<(), LoreCommandError>,
{
    let mut released_keys = BTreeSet::new();
    let mut first_error = None;
    for repository_path in repository_paths {
        /*
         * Windows 路径不区分大小写；复用绑定键规范化规则，避免同一仓库以不同大小写
         * 或重复 Tab 出现时反复释放。某个仓库失败也继续处理其余仓库，防止局部故障
         * 让其他账户状态继续陈旧。
         */
        if !released_keys.insert(repository_binding_key(repository_path)) {
            continue;
        }
        if let Err(error) = release(repository_path) {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// 从 Lore 终止事件中提取最具体的错误文本。
pub(super) fn operation_failure_message(result: &LoreOperationResult, fallback: &str) -> String {
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
        .unwrap_or_else(|| {
            format!(
                "{fallback} ({})",
                super::runtime::describe_status_code(result.status)
            )
        })
}

/// 返回仓库当前格式对应的元数据目录；旧 `.urc` 优先级与 Lore 自身保持一致。
pub(super) fn repository_metadata_directory(
    repository_path: &Path,
) -> Result<PathBuf, LoreCommandError> {
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
