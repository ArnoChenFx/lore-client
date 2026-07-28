//! 仓库相对路径、外部 Diff/Merge、临时文件、补丁、忽略规则与 Lore 数组转换。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 规范化冲突动作的路径边界。
///
/// Lore 的部分路径参数把空集合解释成“全部”，因此文件级动作必须至少包含一个
/// 用户明确选择的仓库相对路径。Abort 是仓库级恢复动作，调用者传入的旧选区必须
/// 被丢弃，不能意外改变它的 Lore 语义。
pub(super) fn validate_conflict_action_paths(
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
pub(super) fn ensure_conflict_read_succeeded(
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

pub(super) fn normalize_paths(
    paths: Vec<String>,
    use_repository_root_when_empty: bool,
) -> Vec<String> {
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
pub(super) fn validate_repository_relative_path(path: &str) -> Result<PathBuf, LoreCommandError> {
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
pub(super) fn display_path_without_windows_verbatim_prefix(path: &Path) -> String {
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
pub(super) fn validate_repository_relative_paths(
    paths: Vec<String>,
) -> Result<Vec<String>, LoreCommandError> {
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
pub(super) fn validate_optional_diff_paths(
    paths: Vec<String>,
) -> Result<Vec<String>, LoreCommandError> {
    if paths.is_empty() {
        Ok(Vec::new())
    } else {
        validate_repository_relative_paths(paths)
    }
}

/// 解析仓库内已存在的普通文件，并在解析符号链接后再次确认没有越过仓库根目录。
pub(super) fn validate_existing_workspace_file(
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
pub(super) fn resolve_external_executable_with(
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

pub(super) fn resolve_external_executable(executable: &str) -> Option<PathBuf> {
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
pub(super) fn resolve_external_diff_arguments(
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
pub(super) fn external_diff_temp_directory(
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
pub(super) fn materialize_external_diff_side(
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
            let files = collect_revision_tree_files_at_paths(
                repository_path,
                &revision,
                std::slice::from_ref(&normalized_path),
            )?;
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
pub(super) fn launch_external_diff(
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
pub(super) fn external_merge_ancestor_order(
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
pub(super) fn external_merge_base(
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
pub(super) fn materialize_external_merge_revision(
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
        collect_revision_tree_files_at_paths(
            repository_path,
            &revision,
            std::slice::from_ref(&normalized_path),
        )?
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

pub(super) fn resolve_external_merge_arguments(
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
pub(super) fn launch_external_merge(
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
pub(super) fn validate_patch_content(patch: &str) -> Result<(), LoreCommandError> {
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
pub(super) fn sanitize_patch_name(file_name: &str) -> String {
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
pub(super) fn build_ignore_rules(
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

pub(super) fn to_lore_array(paths: Vec<String>) -> LoreArray<LoreString> {
    LoreArray::from_vec(paths.into_iter().map(LoreString::from).collect())
}
