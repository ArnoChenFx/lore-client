//! 仓库验证、Dump、Instance、远端信息与垃圾回收命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
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
