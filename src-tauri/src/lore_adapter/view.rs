//! Repository View 规则解析、预览、安全校验、物化撤除、写入与失败回滚。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
pub(super) const MAX_REPOSITORY_VIEW_BYTES: usize = 256 * 1024;
pub(super) const MAX_REPOSITORY_VIEW_IMPACT_FILES: usize = 200;

pub(super) fn validate_view_content_size(content: &str) -> Result<(), LoreCommandError> {
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
pub(super) fn repository_view_path(repository_path: &Path) -> Result<PathBuf, LoreCommandError> {
    Ok(repository_metadata_directory(repository_path)?.join("view"))
}

pub(super) fn repository_view_display_path(view_path: &Path) -> String {
    view_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .map(|directory| format!("{directory}/view"))
        .unwrap_or_else(|| "view".to_owned())
}

/// 按固定 Lore 版本 `filter.rs` 的顺序覆盖语义添加一条规则。
pub(super) fn push_repository_view_rule(
    parsed: &mut ParsedRepositoryView,
    glob: &str,
    negated: bool,
) {
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
pub(super) fn parse_repository_view(content: &str) -> ParsedRepositoryView {
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

pub(super) fn repository_view_is_valid(parsed: &ParsedRepositoryView) -> bool {
    !parsed
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == "error")
}

/// 判断文件是否被 View 排除；后出现且命中的规则覆盖此前状态。
pub(super) fn repository_view_excludes(parsed: &ParsedRepositoryView, path: &str) -> bool {
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

pub(super) fn read_repository_view(
    repository_path: &Path,
) -> Result<LoreRepositoryView, LoreCommandError> {
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

pub(super) fn repository_file_is_materialized(repository_path: &Path, path: &str) -> bool {
    fs::symlink_metadata(repository_path.join(path))
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

pub(super) fn build_repository_view_preview(
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
pub(super) fn build_repository_view_preview_with_dematerialize_paths(
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
pub(super) fn ensure_repository_view_can_apply(
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

pub(super) fn write_repository_view_temporary(
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

pub(super) fn run_repository_view_sync(
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

pub(super) fn restore_repository_view(view_path: &Path, backup_path: &Path, had_original: bool) {
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
pub(super) fn dematerialize_repository_view_files(
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

pub(super) fn apply_repository_view(
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
