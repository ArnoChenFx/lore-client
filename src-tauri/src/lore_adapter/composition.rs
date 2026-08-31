//! 标签以及 Layer、Link 组合关系命令。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 列出当前仓库中由 Lore Client 管理的全部标签。
///
/// 读取会沿用 Lore Core 的远端优先、本地缓存回退策略。解析时按稳定 ID 去重，
/// 因而一次改名若只完成了“写入新键”，列表也只会展示更新时间较新的新名称。
#[tauri::command]
pub async fn lore_tag_list(repository_path: String) -> Result<Vec<LoreTag>, LoreCommandError> {
    run_lore_task(move || {
        let records = read_tag_records(&repository_path)?;
        Ok(deduplicate_tag_records(records)
            .into_iter()
            .map(|record| record.tag)
            .collect())
    })
    .await
}

/// 从明确的 Branch/Revision 创建仓库共享标签。
///
/// Lore 没有隐式“当前提交”标签语义，调用方必须传入精确 Revision，避免用户从历史
/// 列表创建标签时意外指向工作区当前 Revision。
#[tauri::command]
pub async fn lore_tag_create(
    repository_path: String,
    name: String,
    branch: String,
    revision: String,
    message: String,
) -> Result<LoreTag, LoreCommandError> {
    let name = validate_tag_name(&name)?;
    let branch = validate_branch_name(&branch)?;
    let revision = validate_revision(&revision)?;
    let message = validate_tag_message(&message)?;

    run_lore_task(move || {
        let existing = read_tag_records(&repository_path)?;
        ensure_tag_name_available(&existing, &name, None)?;

        let now_millis = unix_time_millis()?;
        let unique_nanos = unix_time_nanos()?;
        let revision_hint = revision.chars().take(8).collect::<String>();
        let tag = LoreTag {
            id: format!("tag-{unique_nanos:x}-{revision_hint}"),
            name,
            branch,
            revision,
            message,
            created_at: now_millis,
            updated_at: now_millis,
        };
        write_tag(&repository_path, &tag)?;
        Ok(tag)
    })
    .await
}

/// 修改标签名称或说明，但保持来源 Branch、Revision 与稳定 ID 不变。
///
/// 改名采用“先写新键、后清旧键”。即使网络在两步之间中断，新的有效标签仍然
/// 存在；下一次列表会按稳定 ID 去重，后续编辑或删除会继续清理遗留键。
#[tauri::command]
pub async fn lore_tag_update(
    repository_path: String,
    tag_id: String,
    name: String,
    message: String,
) -> Result<LoreTag, LoreCommandError> {
    let tag_id = validate_tag_id(&tag_id)?;
    let name = validate_tag_name(&name)?;
    let message = validate_tag_message(&message)?;

    run_lore_task(move || {
        let records = read_tag_records(&repository_path)?;
        ensure_tag_name_available(&records, &name, Some(&tag_id))?;
        let current = newest_tag_record(&records, &tag_id)?.tag;
        let mut updated = current;
        updated.name = name;
        updated.message = message;
        updated.updated_at = unix_time_millis()?;

        write_tag(&repository_path, &updated)?;
        let new_key = tag_metadata_key(&updated.name);
        let stale_keys = records
            .iter()
            .filter(|record| record.tag.id == tag_id && record.key != new_key)
            .map(|record| record.key.clone())
            .collect::<Vec<_>>();
        clear_tag_keys(&repository_path, stale_keys)?;
        Ok(updated)
    })
    .await
}

/// 删除稳定 ID 对应的全部标签元数据键。
///
/// 这里不会只删除当前显示名称对应的键；这样可以同时回收早先改名部分失败留下的
/// 旧键，保证一次成功删除后仓库中不再出现该标签。
#[tauri::command]
pub async fn lore_tag_delete(
    repository_path: String,
    tag_id: String,
) -> Result<(), LoreCommandError> {
    let tag_id = validate_tag_id(&tag_id)?;
    run_lore_task(move || {
        let records = read_tag_records(&repository_path)?;
        let keys = records
            .iter()
            .filter(|record| record.tag.id == tag_id)
            .map(|record| record.key.clone())
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return Err(LoreCommandError::new(
                "tag_not_found",
                "The tag to delete no longer exists; refresh the repository state",
            ));
        }
        clear_tag_keys(&repository_path, keys)
    })
    .await
}

/// 清理组合仓库表单中的外围空白，并在进入 Lore 写队列前拒绝空值和控制字符。
///
/// 路径是否越界仍由固定 Lore 版本的 `RelativePath` 在 Repository 边界校验；
/// 这里负责提供稳定、可本地化的客户端错误类型，避免空表单只得到内部错误码。
pub(super) fn required_composition_value(
    value: String,
    field_name: &'static str,
) -> Result<String, LoreCommandError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(LoreCommandError::new(
            "composition_field_required",
            format!("{field_name} must not be empty"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "composition_field_invalid",
            format!("{field_name} must not contain control characters"),
        ));
    }
    Ok(value.to_owned())
}

/// 可选的 Pin/Metadata 空字符串统一映射为 Lore 的默认空值。
pub(super) fn optional_composition_value(value: Option<String>) -> LoreString {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(LoreString::from)
        .unwrap_or_default()
}

pub(super) fn build_layer_add_args(
    target_path: String,
    source_repository: String,
    source_path: String,
    metadata: Option<String>,
) -> Result<LoreLayerAddArgs, LoreCommandError> {
    Ok(LoreLayerAddArgs {
        target_path: required_composition_value(target_path, "Layer mount path")?.into(),
        source_repository: required_composition_value(
            source_repository,
            "Layer source repository",
        )?
        .into(),
        source_path: required_composition_value(source_path, "Layer source path")?.into(),
        metadata: optional_composition_value(metadata),
    })
}

pub(super) fn build_layer_remove_args(
    target_path: String,
    source_repository: String,
    purge: bool,
) -> Result<LoreLayerRemoveArgs, LoreCommandError> {
    Ok(LoreLayerRemoveArgs {
        target_path: required_composition_value(target_path, "Layer mount path")?.into(),
        source_repository: required_composition_value(
            source_repository,
            "Layer source repository",
        )?
        .into(),
        purge: u8::from(purge),
    })
}

pub(super) fn build_link_add_args(
    link: String,
    link_path: String,
    source_path: String,
    pin: Option<String>,
    disable_branching: bool,
) -> Result<LoreLinkAddArgs, LoreCommandError> {
    Ok(LoreLinkAddArgs {
        link: required_composition_value(link, "Link repository address")?.into(),
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
        source_path: required_composition_value(source_path, "Link source path")?.into(),
        pin: optional_composition_value(pin),
        disable_branching: u8::from(disable_branching),
    })
}

pub(super) fn build_link_update_args(
    link_path: String,
    pin: Option<String>,
) -> Result<LoreLinkUpdateArgs, LoreCommandError> {
    Ok(LoreLinkUpdateArgs {
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
        pin: optional_composition_value(pin),
    })
}

/// 列出当前 Repository 已配置的 Layer。
#[tauri::command]
pub async fn lore_layer_list(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.list", move |callback| {
            lore::runtime().block_on(lore::layer::layer_list(
                globals,
                LoreLayerListArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 列出当前 Repository 中具有已暂存文件的 Layer。
///
/// 普通 Layer 列表只描述挂载关系；已暂存文件数必须消费 Lore 的专用事件，
/// 不能根据父仓库 Status 或 Revision 差异猜测。
#[tauri::command]
pub async fn lore_layer_list_staged(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.list-staged", move |callback| {
            lore::runtime().block_on(lore::layer::layer_list_staged(
                globals,
                LoreLayerListStagedArgs {},
                callback,
            ))
        })
    })
    .await
}

/// 把来源 Repository 的一个子树挂载为当前实例的本地 Layer。
#[tauri::command]
pub async fn lore_layer_add(
    repository_path: String,
    target_path: String,
    source_repository: String,
    source_path: String,
    metadata: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_layer_add_args(target_path, source_repository, source_path, metadata)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.add", move |callback| {
            lore::runtime().block_on(lore::layer::layer_add(globals, args, callback))
        })
    })
    .await
}

/// 从当前实例移除一个 Layer。
///
/// `purge` 会删除挂载目录中的未跟踪文件，因此只能由已经展示影响并取得确认的
/// 前端入口传入；适配层不会自动启用 Lore 的全局 Force。
#[tauri::command]
pub async fn lore_layer_remove(
    repository_path: String,
    target_path: String,
    source_repository: String,
    purge: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_layer_remove_args(target_path, source_repository, purge)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("layer.remove", move |callback| {
            lore::runtime().block_on(lore::layer::layer_remove(globals, args, callback))
        })
    })
    .await
}

/// 列出当前 Repository 已配置的 Link。
#[tauri::command]
pub async fn lore_link_list(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.list", move |callback| {
            lore::runtime().block_on(lore::link::list(globals, LoreLinkListArgs {}, callback))
        })
    })
    .await
}

/// 读取单条 Link 的完整详情。
///
/// Lore 0.9.0 的 `link info` 会额外报告仅列表不可见的字段：pinned branch 的
/// 远端 Latest（未查询时为零哈希）、Link 自身的暂存状态与内部暂存文件数；
/// 事件流保持原样返回，由前端解析成稳定 DTO。
#[tauri::command]
pub async fn lore_link_info(
    repository_path: String,
    link_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = LoreLinkInfoArgs {
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
    };
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.info", move |callback| {
            lore::runtime().block_on(lore::link::info(globals, args, callback))
        })
    })
    .await
}

/// 列出当前 Repository 中具有已暂存文件的 Link。
#[tauri::command]
pub async fn lore_link_list_staged(
    repository_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.list-staged", move |callback| {
            lore::runtime().block_on(lore::link::list_staged(globals, callback))
        })
    })
    .await
}

/// 添加随父 Revision 版本化的 Link，并把 Link 变更暂存到下一次 Revision。
#[tauri::command]
pub async fn lore_link_add(
    repository_path: String,
    link: String,
    link_path: String,
    source_path: String,
    pin: Option<String>,
    disable_branching: bool,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_link_add_args(link, link_path, source_path, pin, disable_branching)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.add", move |callback| {
            lore::runtime().block_on(lore::link::add(globals, args, callback))
        })
    })
    .await
}

/// 移除 Link，并把删除记录暂存到父 Repository 的下一次 Revision。
#[tauri::command]
pub async fn lore_link_remove(
    repository_path: String,
    link_path: String,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = LoreLinkRemoveArgs {
        link_path: required_composition_value(link_path, "Link mount path")?.into(),
    };
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.remove", move |callback| {
            lore::runtime().block_on(lore::link::remove(globals, args, callback))
        })
    })
    .await
}

/// 更新 Link 的 Branch/Revision Pin，并把结果暂存到父 Repository。
///
/// 固定 Lore 版本的 Update 只接受 Pin；`disable_branching` 只能在 Add 时设置，
/// 因此这里不提供一个无法兑现的 flags 编辑参数。
#[tauri::command]
pub async fn lore_link_update(
    repository_path: String,
    link_path: String,
    pin: Option<String>,
) -> Result<LoreOperationResult, LoreCommandError> {
    let args = build_link_update_args(link_path, pin)?;
    run_lore_task(move || {
        let globals = global_args(&repository_path)?;
        run_operation("link.update", move |callback| {
            lore::runtime().block_on(lore::link::update(globals, args, callback))
        })
    })
    .await
}
