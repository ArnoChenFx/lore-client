//! 运行时信息、认证账户、仓库账户绑定与认证上下文刷新命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
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
        let result = run_operation("auth.login-interactive", move |callback| {
            lore::runtime().block_on(lore::auth::login_interactive(
                LoreGlobalArgs::default(),
                LoreAuthLoginInteractiveArgs {
                    remote_url: remote_url.into(),
                    no_browser: 0,
                },
                callback,
            ))
        })?;
        invalidate_authentication_connections_with(&result, || {
            lore_revision::interface::drop_connections()
        });
        Ok(result)
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
        let result = run_operation("auth.login-with-token", move |callback| {
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
        })?;
        invalidate_authentication_connections_with(&result, || {
            lore_revision::interface::drop_connections()
        });
        Ok(result)
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
        let result = run_operation("auth.logout", move |callback| {
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
        })?;
        invalidate_authentication_connections_with(&result, || {
            lore_revision::interface::drop_connections()
        });
        Ok(result)
    })
    .await
}

/// 清空 Lore 凭据存储中的全部身份；只在全局危险确认后调用。
#[tauri::command]
pub async fn lore_auth_clear() -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let result = run_operation("auth.clear", move |callback| {
            lore::runtime().block_on(lore::auth::clear(
                LoreGlobalArgs::default(),
                LoreAuthClearArgs::default(),
                callback,
            ))
        })?;
        invalidate_authentication_connections_with(&result, || {
            lore_revision::interface::drop_connections()
        });
        Ok(result)
    })
    .await
}

/// 认证 Token 发生变化后失效 Lore Transport 的进程级连接缓存。
///
/// `invalidate` 参数让单元测试不依赖真实远端服务器。失败的认证操作不能中断已有
/// 连接；只有 Token Store 已成功变化时才清理全部服务器连接并让后续操作重新鉴权。
pub(super) fn invalidate_authentication_connections_with<F>(
    result: &LoreOperationResult,
    mut invalidate: F,
) where
    F: FnMut(),
{
    if result.status == 0 {
        invalidate();
    }
}

/// 认证账户变化后，释放前端当前已打开仓库的 Lore Store 上下文。
///
/// Transport 连接由认证命令直接失效；这里继续释放路径级 Store 缓存，确保下一次
/// Status 不会复用认证变化前建立的底层对象。
#[tauri::command]
pub async fn lore_auth_repository_contexts_refresh(
    repository_paths: Vec<String>,
) -> Result<(), LoreCommandError> {
    if repository_paths.len() > 1_000 {
        return Err(LoreCommandError::new(
            "repository_context_limit_exceeded",
            "At most 1000 repository authentication contexts can be refreshed at once",
        ));
    }
    run_lore_task(move || {
        let repository_paths = repository_paths
            .iter()
            .map(|path| validate_repository_path(path))
            .collect::<Result<Vec<_>, _>>()?;
        release_repository_authentication_contexts_with(&repository_paths, |path| {
            release_repository_cache(path)
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
