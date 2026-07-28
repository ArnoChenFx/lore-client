//! Revision 历史拓扑、元数据、详情、查找、Amend、Bisect 与 Restore 命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 一个 Revision Entry 及其隐式关联的全部 Metadata 事件。
#[derive(Debug)]
pub(super) struct RevisionHistoryEventGroup {
    revision: String,
    revision_number: u64,
    parent_ids: Vec<String>,
    events: Vec<Value>,
    discovery_order: usize,
}

/// 把 Lore 的线性事件流拆成不可分割的 Revision 事件组。
///
/// Metadata 在协议中没有重复携带 Revision ID，而是隐式归属于它前面的 Entry；
/// 因此聚合和排序必须移动完整事件组，不能分别处理 Entry 与 Metadata。
pub(super) fn parse_revision_history_event_groups(
    events: &[Value],
    next_discovery_order: &mut usize,
) -> Result<Vec<RevisionHistoryEventGroup>, LoreCommandError> {
    let mut groups = Vec::new();
    let mut current: Option<RevisionHistoryEventGroup> = None;

    for event in events {
        match event.get("tagName").and_then(Value::as_str) {
            Some("revisionHistoryEntry") => {
                if let Some(group) = current.take() {
                    groups.push(group);
                }
                let revision = event
                    .pointer("/data/revision")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        LoreCommandError::new(
                            "invalid_revision_history_entry",
                            "Lore history entry is missing a valid revision ID",
                        )
                    })?
                    .to_owned();
                let revision_number = event
                    .pointer("/data/revisionNumber")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        LoreCommandError::new(
                            "invalid_revision_history_entry",
                            format!("Revision {revision} is missing a valid sequence number"),
                        )
                    })?;
                let parent_ids = event
                    .pointer("/data/parent")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|parent| {
                        !parent.is_empty() && !is_zero_hash(parent) && *parent != revision
                    })
                    .map(str::to_owned)
                    .collect();
                current = Some(RevisionHistoryEventGroup {
                    revision,
                    revision_number,
                    parent_ids,
                    events: vec![event.clone()],
                    discovery_order: *next_discovery_order,
                });
                *next_discovery_order += 1;
            }
            Some("metadata") => {
                if let Some(group) = current.as_mut() {
                    group.events.push(event.clone());
                }
            }
            _ => {}
        }
    }

    if let Some(group) = current {
        groups.push(group);
    }
    Ok(groups)
}

/// 收录新的 Revision 事件组，并把尚未加载的第二及后续父节点加入补查队列。
///
/// 第一父链已经由单次 Lore History 查询线性返回；不继续追逐被分页截断的第一父节点，
/// 可以避免无 Merge 的长历史为了得到同一页结果额外读取数倍数据。
pub(super) fn insert_revision_history_groups(
    groups: &mut HashMap<String, RevisionHistoryEventGroup>,
    pending_secondary_parents: &mut VecDeque<String>,
    candidates: Vec<RevisionHistoryEventGroup>,
    candidate_limit: usize,
) {
    for group in candidates {
        if groups.len() >= candidate_limit || groups.contains_key(&group.revision) {
            continue;
        }
        for parent in group.parent_ids.iter().skip(1) {
            if !groups.contains_key(parent) {
                pending_secondary_parents.push_back(parent.clone());
            }
        }
        groups.insert(group.revision.clone(), group);
    }
}

/// 按显式父边生成“子 Revision 先于父 Revision”的稳定顺序。
///
/// 同时可用的节点优先选择较大的 Revision Number；序号相同则保持首次发现顺序，
/// 使 main 与来源 Branch 在同一代际交错显示，而不是先走完整条 main 再回到来源分支。
pub(super) fn topologically_order_revision_history(
    mut groups: HashMap<String, RevisionHistoryEventGroup>,
) -> Result<Vec<RevisionHistoryEventGroup>, LoreCommandError> {
    let mut visible_child_counts = groups
        .keys()
        .map(|revision| (revision.clone(), 0_usize))
        .collect::<HashMap<_, _>>();
    for group in groups.values() {
        for parent in &group.parent_ids {
            if let Some(child_count) = visible_child_counts.get_mut(parent) {
                *child_count += 1;
            }
        }
    }

    let mut ready = BinaryHeap::new();
    for (revision, child_count) in &visible_child_counts {
        if *child_count == 0 {
            let group = &groups[revision];
            ready.push((
                group.revision_number,
                Reverse(group.discovery_order),
                revision.clone(),
            ));
        }
    }

    let expected_count = groups.len();
    let mut ordered = Vec::with_capacity(expected_count);
    while let Some((_revision_number, _discovery_order, revision)) = ready.pop() {
        let group = groups.remove(&revision).ok_or_else(|| {
            LoreCommandError::new(
                "revision_history_topology_invalid",
                format!("Revision history topology processed node {revision} more than once"),
            )
        })?;
        for parent in &group.parent_ids {
            let Some(child_count) = visible_child_counts.get_mut(parent) else {
                continue;
            };
            *child_count = child_count.saturating_sub(1);
            if *child_count == 0 {
                if let Some(parent_group) = groups.get(parent) {
                    ready.push((
                        parent_group.revision_number,
                        Reverse(parent_group.discovery_order),
                        parent.clone(),
                    ));
                }
            }
        }
        ordered.push(group);
    }

    if ordered.len() != expected_count {
        return Err(LoreCommandError::new(
            "revision_history_cycle",
            "Revision history contains a cyclic parent relationship and cannot produce a reliable graph",
        ));
    }
    Ok(ordered)
}

/// 通过可替换的 Lore History 查询器收集 Revision 历史。
///
/// 查询器参数依次是可选起点 Revision 与本次最大返回数。生产路径调用固定 Lore
/// API，测试路径注入确定性的事件流，使多父遍历、去重和数量边界可以脱离真实仓库验证。
pub(super) fn collect_revision_history_with(
    limit: u32,
    primary_revision: Option<String>,
    mut fetch: impl FnMut(Option<String>, u32) -> Result<LoreOperationResult, LoreCommandError>,
) -> Result<LoreOperationResult, LoreCommandError> {
    const HISTORY_EXPANSION_FACTOR: usize = 4;

    /*
     * 显式主起点用于“工作区停在旧 Revision、Branch latest 仍在更新 Revision”的场景。
     * 后续第二父链查询继续复用同一个 fetch，不把工作区锚点误当成 Branch 历史边界。
     */
    let primary = fetch(primary_revision, limit)?;
    /*
     * 主查询失败时保留既有命令契约：把完整状态与事件交给前端统一映射。只有主查询
     * 成功后才开始组合额外查询，避免把原始错误改写成另一个聚合错误。
     */
    if primary.status != 0 {
        return Ok(primary);
    }

    let output_limit = limit as usize;
    let candidate_limit = output_limit.saturating_mul(HISTORY_EXPANSION_FACTOR);
    let header = primary
        .events
        .iter()
        .find(|event| event.get("tagName").and_then(Value::as_str) == Some("revisionHistory"))
        .cloned();
    let completion = primary
        .events
        .iter()
        .rev()
        .find(|event| event.get("tagName").and_then(Value::as_str) == Some("complete"))
        .cloned();
    let passthrough_events = primary
        .events
        .iter()
        .filter(|event| {
            !matches!(
                event.get("tagName").and_then(Value::as_str),
                Some("revisionHistory" | "revisionHistoryEntry" | "metadata" | "complete")
            )
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut next_discovery_order = 0;
    let primary_groups =
        parse_revision_history_event_groups(&primary.events, &mut next_discovery_order)?;
    let mut groups = HashMap::new();
    let mut pending_secondary_parents = VecDeque::new();
    insert_revision_history_groups(
        &mut groups,
        &mut pending_secondary_parents,
        primary_groups,
        candidate_limit,
    );

    let mut queried_secondary_parents = BTreeSet::new();
    let mut duration_ms = primary.duration_ms;
    while groups.len() < candidate_limit {
        let Some(parent) = pending_secondary_parents.pop_front() else {
            break;
        };
        if groups.contains_key(&parent) || !queried_secondary_parents.insert(parent.clone()) {
            continue;
        }
        let remaining_capacity = candidate_limit - groups.len();
        let supplemental = fetch(Some(parent.clone()), remaining_capacity as u32)?;
        let parent_hint = parent.chars().take(8).collect::<String>();
        ensure_operation_success(
            &supplemental,
            &format!("Read merge parent revision {parent_hint}"),
        )?;
        duration_ms = duration_ms.saturating_add(supplemental.duration_ms);
        let supplemental_groups =
            parse_revision_history_event_groups(&supplemental.events, &mut next_discovery_order)?;
        insert_revision_history_groups(
            &mut groups,
            &mut pending_secondary_parents,
            supplemental_groups,
            candidate_limit,
        );
    }

    let ordered = topologically_order_revision_history(groups)?;
    let mut events = Vec::new();
    if let Some(header) = header {
        events.push(header);
    }
    events.extend(passthrough_events);
    for group in ordered.into_iter().take(output_limit) {
        events.extend(group.events);
    }
    if let Some(completion) = completion {
        events.push(completion);
    }

    Ok(LoreOperationResult {
        operation: primary.operation,
        status: primary.status,
        duration_ms,
        events,
    })
}

/// 读取当前 Branch 的 Revision 历史，并补齐 Merge Revision 的其他父链。
pub(super) fn build_revision_history_args(
    revision: Option<String>,
    branch: Option<String>,
    date: u64,
    length: u32,
    only_branch: bool,
) -> LoreRevisionHistoryArgs {
    LoreRevisionHistoryArgs {
        revision: revision.unwrap_or_default().into(),
        branch: branch.unwrap_or_default().into(),
        date,
        length,
        only_branch: u8::from(only_branch),
    }
}

/// 读取当前 Branch 的 Revision 历史，并补齐 Merge Revision 的其他父链。
#[tauri::command]
pub async fn lore_revision_history(
    repository_path: String,
    limit: Option<u32>,
    revision: Option<String>,
    branch: Option<String>,
    date: Option<u64>,
    only_branch: Option<bool>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = revision
        .filter(|revision| !revision.trim().is_empty())
        .map(|revision| validate_revision(&revision))
        .transpose()?;
    let branch = branch
        .filter(|branch| !branch.trim().is_empty())
        .map(|branch| validate_branch_name(&branch))
        .transpose()?;
    let date = date.unwrap_or_default();
    let only_branch = only_branch.unwrap_or(false);
    run_lore_task(move || {
        let limit = limit.unwrap_or(100).clamp(1, 1_000);
        collect_revision_history_with(limit, revision, move |revision, length| {
            let globals = global_args(&repository_path)?;
            // Lore 不允许同时指定 revision 和 branch；查询合并父链时
            // fetch 会传入具体 revision，此时必须清除 branch 参数。
            let effective_branch = if revision.is_some() {
                None
            } else {
                branch.clone()
            };
            run_operation("revision.history", move |callback| {
                lore::runtime().block_on(lore::revision::history(
                    globals,
                    build_revision_history_args(
                        revision,
                        effective_branch,
                        date,
                        length,
                        only_branch,
                    ),
                    callback,
                ))
            })
        })
    })
    .await
}

/// 读取 Repository、Branch、Revision 或文件的原始 Lore 元数据事件。
///
/// 该入口刻意只读，不把 Metadata Set/Clear 暴露给前端。固定版本允许空 key 列出
/// Repository 与 Branch 元数据，而 Revision 与文件使用各自的 List API；组件只会
/// 消费 `services/lore.ts` 归一化后的稳定 DTO。
#[tauri::command]
pub async fn lore_metadata_list(
    repository_path: String,
    scope: String,
    target: Option<String>,
    revision: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let scope = scope.trim().to_owned();
    let target = target.unwrap_or_default();
    let revision = revision
        .filter(|value| !value.trim().is_empty())
        .map(|value| validate_revision(&value))
        .transpose()?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        match scope.as_str() {
            "repository" => run_operation("repository.metadata-get", move |callback| {
                lore::runtime().block_on(lore::repository::metadata_get(
                    globals,
                    LoreRepositoryMetadataGetArgs {
                        key: LoreString::default(),
                    },
                    callback,
                ))
            }),
            "branch" => {
                let branch = validate_branch_name(&target)?;
                run_operation("branch.metadata-get", move |callback| {
                    lore::runtime().block_on(lore::branch::metadata_get(
                        globals,
                        LoreBranchMetadataGetArgs {
                            branch: branch.into(),
                            key: LoreString::default(),
                        },
                        callback,
                    ))
                })
            }
            "revision" => {
                let revision = revision
                    .or_else(|| (!target.trim().is_empty()).then(|| target.clone()))
                    .ok_or_else(|| {
                        LoreCommandError::new(
                            "metadata_revision_required",
                            "Revision metadata requires an explicit revision",
                        )
                    })
                    .and_then(|value| validate_revision(&value))?;
                run_operation("revision.metadata-list", move |callback| {
                    lore::runtime().block_on(lore::revision::metadata_list(
                        globals,
                        LoreRevisionMetadataListArgs {
                            revision: revision.into(),
                        },
                        callback,
                    ))
                })
            }
            "file" => {
                let path = validate_repository_relative_path(&target)?;
                let path = path.to_string_lossy().replace('\\', "/");
                run_operation("file.metadata-list", move |callback| {
                    lore::runtime().block_on(lore::file::metadata_list(
                        globals,
                        LoreFileMetadataListArgs {
                            path: path.into(),
                            revision: revision.unwrap_or_default().into(),
                        },
                        callback,
                    ))
                })
            }
            _ => Err(LoreCommandError::new(
                "metadata_scope_invalid",
                "Metadata scope must be repository, branch, revision, or file",
            )),
        }
    })
    .await
}

/// 读取精确 Revision 的基础信息、父节点、文件 Delta 与元数据。
#[tauri::command]
pub async fn lore_revision_info(
    repository_path: String,
    revision: String,
    include_delta: bool,
    include_metadata: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let revision = validate_revision(&revision)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.info", move |callback| {
            lore::runtime().block_on(lore::revision::info(
                globals,
                LoreRevisionInfoArgs {
                    revision: revision.into(),
                    delta: u8::from(include_delta),
                    metadata: u8::from(include_metadata),
                },
                callback,
            ))
        })
    })
    .await
}

/// 按当前 Branch 的 Revision 编号或元数据查找一个精确 Revision。
#[tauri::command]
pub async fn lore_revision_find(
    repository_path: String,
    metadata_key: Option<String>,
    metadata_value: Option<String>,
    revision_number: Option<u64>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let key = metadata_key.unwrap_or_default().trim().to_owned();
    let value = metadata_value.unwrap_or_default().trim().to_owned();
    let number = revision_number.unwrap_or_default();
    if key.is_empty() == (number == 0) {
        return Err(LoreCommandError::new(
            "revision_find_mode_invalid",
            "Specify exactly one revision search mode: metadata key or positive revision number",
        ));
    }
    if key.chars().any(char::is_control) || value.contains('\0') {
        return Err(LoreCommandError::new(
            "revision_find_metadata_invalid",
            "Revision metadata search values must not contain control characters",
        ));
    }
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("revision.find", move |callback| {
            lore::runtime().block_on(lore::revision::find(
                globals,
                LoreRevisionFindArgs {
                    key: key.into(),
                    value: value.into(),
                    number,
                },
                callback,
            ))
        })
    })
    .await
}

/// 修改当前 Latest Revision 的消息，并在写入前重验工作区与分支指针。
#[tauri::command]
pub async fn lore_revision_amend(
    repository_path: String,
    message: String,
    branch: String,
    expected_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let message = validate_revision_message(&message)?;
    let branch = validate_branch_name(&branch)?;
    let expected_revision = validate_revision(&expected_revision)?;
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_revision)?;
        let latest = read_branch_latest(&repository_path, &branch)?;
        if latest != expected_revision {
            return Err(LoreCommandError::new(
                "revision_amend_not_latest",
                "Only the current branch LATEST revision can be amended safely",
            ));
        }
        let globals = global_args(&repository_path)?;
        run_operation("revision.amend", move |callback| {
            lore::runtime().block_on(lore::revision::amend(
                globals,
                LoreRevisionAmendArgs {
                    message: message.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 执行一步真实 Bisect，并把干净工作区同步到区间中点。
#[tauri::command]
pub async fn lore_revision_bisect(
    repository_path: String,
    start: String,
    end: String,
    expected_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let start = validate_revision(&start)?;
    let end = validate_revision(&end)?;
    let expected_revision = validate_revision(&expected_revision)?;
    if start == end {
        return Err(LoreCommandError::new(
            "revision_bisect_range_empty",
            "The known-good and known-bad revisions must be different",
        ));
    }
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_revision)?;
        let globals = global_args(&repository_path)?;
        run_operation("revision.bisect", move |callback| {
            lore::runtime().block_on(lore::revision::bisect(
                globals,
                LoreRevisionBisectArgs {
                    start: start.into(),
                    end: end.into(),
                },
                callback,
            ))
        })
    })
    .await
}

/// 把当前已检出的历史内容重放到远端最新头并自动创建新 Revision。
#[tauri::command]
pub async fn lore_revision_restore(
    repository_path: String,
    message: String,
    expected_revision: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let message = validate_revision_message(&message)?;
    let expected_revision = validate_revision(&expected_revision)?;
    run_lore_task(move || {
        ensure_repository_view_can_apply(&repository_path, &expected_revision)?;
        let globals = global_args(&repository_path)?;
        run_operation("revision.restore", move |callback| {
            lore::runtime().block_on(lore::revision::restore(
                globals,
                LoreRevisionRestoreArgs {
                    message: message.into(),
                },
                callback,
            ))
        })
    })
    .await
}
