//! Branch 查询、保护、Diff、Reset 与从精确来源创建分支命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
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
                    // 普通 Branch 信息查询不限定 Link 仓库；空值表示当前主仓库。
                    link: LoreString::default(),
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
pub(super) fn read_branch_protection(
    repository_path: &str,
    branch: &str,
) -> Result<bool, LoreCommandError> {
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
pub(super) fn read_branch_latest(
    repository_path: &str,
    branch: &str,
) -> Result<String, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let branch = branch.to_owned();
    let result = run_operation("branch.info.reset-check", move |callback| {
        lore::runtime().block_on(lore::branch::info(
            globals,
            LoreBranchInfoArgs {
                branch: branch.into(),
                // 读取本地 Latest 指针时同样不限定 Link 仓库。
                link: LoreString::default(),
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
pub(super) fn read_branch_latest_history(
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
pub(super) fn run_branch_create_from(
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
