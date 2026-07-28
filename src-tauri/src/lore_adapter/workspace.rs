//! 工作区 Stage、Diff、文件预览、历史、丢弃、外部工具、补丁与忽略规则命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
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
    run_heavy_lore_task(&WORKSPACE_DIFF_READ_LANE, move || {
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
    run_heavy_lore_task(&REVISION_FILES_READ_LANE, move || {
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
) -> Result<tauri::ipc::Response, LoreCommandError> {
    let revision = revision
        .map(|value| validate_revision(&value))
        .transpose()?;
    run_heavy_lore_task(&FILE_PREVIEW_READ_LANE, move || {
        build_file_preview(&repository_path, &path, revision.as_deref())
            .and_then(encode_file_preview_response)
    })
    .await
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
    run_heavy_lore_task(&REVISION_DIFF_READ_LANE, move || {
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
                 * 文件不会产生 fileDiff。这里恢复 Lore Diff 加完整不可变树结构补全的
                 * 原有语义；不能仅凭 paths 非空跳过，否则多路径和空白忽略模式都会
                 * 静默漏掉结构变化。前端已经改为真实选择后才发起该重读。
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
    run_heavy_lore_task(&REVISION_CHANGES_READ_LANE, move || {
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
