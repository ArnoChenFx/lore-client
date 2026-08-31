//! Commit、Sync、Push、Checkout、Merge、冲突处理、归档与工作区定位等写操作命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
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
        recover_conflict_session(&repository_path, &status)
    })
    .await
}

/**
 * 从一次真实 Status 结果恢复冲突会话。
 *
 * 读命令与行内写命令共享本函数，确保写边界比较的是同一套 staged Revision、
 * incoming Revision 和元数据分类，而不是只相信前端传入的操作类型。
 */
fn recover_conflict_session(
    repository_path: &str,
    status: &LoreOperationResult,
) -> Result<Option<LoreConflictSession>, LoreCommandError> {
    ensure_conflict_read_succeeded(status, "Read conflict status")?;
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

    let info_globals = global_args(repository_path)?;
    let staged_for_info = staged_revision.clone();
    let info = run_operation("conflict.session.revision-info", move |callback| {
        lore::runtime().block_on(lore::revision::info(
            info_globals,
            LoreRevisionInfoArgs {
                revision: staged_for_info.into(),
                // 顶层 Revision 元数据无论此开关都会发出；关闭它避免遍历逐文件元数据。
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

/// 行内冲突解决的结果：内容是否已不含冲突标记，以及本次 Lore 操作结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoreConflictResolutionWriteResult {
    /// 内容已不含任何冲突标记时为 true，此时 Lore 会把该路径标记为已解决。
    pub resolved: bool,
    /// 写回与（可能发生的）resolve 的完整事件流；仍含标记时只包含写回事件。
    pub operation: LoreOperationResult,
}

/// 把行内解决后的完整文本写回工作区，并在内容干净时标记为已解决。
///
/// 这是 Diffs 库行内冲突解决（Accept current / incoming / both）的 Rust 写入口：
/// 前端提交单条仓库相对路径、读取时会话、读取时正文与解决后的 UTF-8 正文；Rust
/// 在写入前重新恢复真实会话并重读正文，任一前置条件漂移都拒绝覆盖。内容仍包含
/// 冲突标记时只写回不标记，全部区域解决后 Lore 才把该路径标记为 resolved。
#[tauri::command]
pub async fn lore_write_conflict_resolution(
    repository_path: String,
    expected_session: LoreConflictSession,
    path: String,
    expected_content: String,
    content: String,
) -> Result<LoreConflictResolutionWriteResult, LoreCommandError> {
    if expected_session.kind == LoreConflictOperationKind::Unknown {
        return Err(LoreCommandError::new(
            "unknown_conflict_operation",
            "The current Lore conflict operation type is unknown; refresh the repository state or verify the repository",
        ));
    }
    let text_limit = crate::lore_adapter::workspace::DEFAULT_WORKSPACE_TEXT_LIMIT_BYTES as usize;
    if content.len() > text_limit || expected_content.len() > text_limit {
        return Err(LoreCommandError::new(
            "workspace_text_too_large",
            "The resolved content exceeds the inline text limit; resolve large files with an external merge tool",
        ));
    }

    run_lore_task(move || {
        let status_globals = global_args(&repository_path)?;
        let status = run_operation("conflict.resolve-write.status", move |callback| {
            lore::runtime().block_on(lore::repository::status(
                status_globals,
                LoreRepositoryStatusArgs {
                    staged: 1,
                    scan: 0,
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
        let actual_session = recover_conflict_session(&repository_path, &status)?;
        let normalized_path = validate_repository_relative_paths(vec![path.clone()])?
            .into_iter()
            .next()
            .expect("validated single path always yields one entry");
        let is_conflict_file = status.events.iter().any(|event| {
            event.get("tagName").and_then(Value::as_str) == Some("repositoryStatusFile")
                && event.pointer("/data/path").and_then(Value::as_str)
                    == Some(normalized_path.as_str())
                && event.pointer("/data/flagConflict").is_some_and(|value| {
                    value.as_bool().unwrap_or(false) || value.as_u64().is_some_and(|flag| flag != 0)
                })
        });
        if !is_conflict_file {
            return Err(LoreCommandError::new(
                "conflict_path_not_in_conflict",
                format!("File {normalized_path} is not currently in conflict"),
            ));
        }

        let target_path = validate_existing_workspace_file(&repository_path, &normalized_path)?;
        let actual_content = std::fs::read_to_string(&target_path).map_err(|error| {
            LoreCommandError::new(
                "workspace_text_decode_failed",
                format!(
                    "Failed to re-read workspace file {} before writing its resolution: {error}",
                    target_path.display()
                ),
            )
        })?;
        validate_conflict_resolution_preconditions(
            &expected_session,
            actual_session.as_ref(),
            &expected_content,
            &actual_content,
        )?;
        std::fs::write(&target_path, &content).map_err(|error| {
            LoreCommandError::new(
                "workspace_text_write_failed",
                format!(
                    "Failed to write resolved content to {}: {error}",
                    target_path.display()
                ),
            )
        })?;

        let resolved = !contains_conflict_markers(&content);
        let operation_result = if resolved {
            let globals = global_args(&repository_path)?;
            let lore_paths = || LoreArray::from_vec(vec![normalized_path.clone().into()]);
            match expected_session.kind {
                LoreConflictOperationKind::Merge => {
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
                LoreConflictOperationKind::CherryPick => {
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
                LoreConflictOperationKind::Revert => {
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
                LoreConflictOperationKind::Unknown => {
                    unreachable!("Unknown operation types are rejected before the task starts")
                }
            }?
        } else {
            LoreOperationResult {
                operation: "conflict.resolve-write",
                status: 0,
                duration_ms: 0,
                events: Vec::new(),
            }
        };

        Ok(LoreConflictResolutionWriteResult {
            resolved,
            operation: operation_result,
        })
    })
    .await
}

/**
 * 校验行内解决所基于的冲突会话与正文仍是当前值。
 *
 * React 的仓库串行门闩只能约束本应用内写入；这里的乐观并发前置条件用于拒绝
 * 外部编辑器、另一个 Lore 客户端或刷新后的新冲突会话覆盖旧 UI 读取到的内容。
 */
pub(super) fn validate_conflict_resolution_preconditions(
    expected_session: &LoreConflictSession,
    actual_session: Option<&LoreConflictSession>,
    expected_content: &str,
    actual_content: &str,
) -> Result<(), LoreCommandError> {
    if actual_session != Some(expected_session) {
        return Err(LoreCommandError::new(
            "conflict_session_changed",
            "The conflict session changed after the inline resolution view was loaded",
        ));
    }
    if actual_content != expected_content {
        return Err(LoreCommandError::new(
            "conflict_content_changed",
            "The conflict file changed after the inline resolution view was loaded",
        ));
    }
    Ok(())
}

/// 检测正文是否仍包含标准冲突标记行（`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`）。
pub(super) fn contains_conflict_markers(content: &str) -> bool {
    content.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("<<<<<<<")
            || trimmed.starts_with(">>>>>>>")
            || trimmed.starts_with("|||||||")
            || trimmed == "======="
            || trimmed.starts_with("======= ")
    })
}

/// 归档指定本地 Branch；联网模式下 Lore Core 同步归档其远端指针。
///
/// `include_layers` 请求同时归档仓库中每个已配置 Layer 里的同名 Branch；
/// 由用户在确认弹窗中显式选择，适配层不会默认递归。
#[tauri::command]
pub async fn lore_branch_archive(
    repository_path: String,
    branch: String,
    include_layers: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let branch = validate_branch_name(&branch)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("branch.archive", move |callback| {
            lore::runtime().block_on(lore::branch::archive(
                globals,
                LoreBranchArchiveArgs {
                    branch: branch.into(),
                    // 归档在本地与远端主仓库执行；空 layer/link 表示不限定
                    // 挂载目标。include_layers 由前端确认弹窗决定，
                    // include_links 始终为 0：Link 子仓库的分支不属于
                    // 本仓库的归档语义。
                    layer: LoreString::default(),
                    include_layers: u8::from(include_layers),
                    link: LoreString::default(),
                    include_links: 0,
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
