//! 标签元数据读写、去重、校验与时间戳支撑逻辑。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
/// 读取并解析全部标签元数据记录；无关仓库元数据和损坏记录不会进入 UI。
///
/// 损坏的单条标签不应阻断整个仓库打开。它仍保留在仓库元数据中，方便后续版本
/// 提供诊断或迁移工具；这里仅过滤无法安全解释的数据。
pub(super) fn read_tag_records(
    repository_path: &str,
) -> Result<Vec<LoreTagRecord>, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let result = run_operation("tag.list", move |callback| {
        lore::runtime().block_on(lore::repository::metadata_get(
            globals,
            LoreRepositoryMetadataGetArgs {
                key: LoreString::default(),
            },
            callback,
        ))
    })?;
    ensure_tag_operation_succeeded(&result, "tag_metadata_read_failed", "Read tag")?;

    Ok(result
        .events
        .iter()
        .filter_map(parse_tag_metadata_event)
        .collect())
}

/// 从 Lore 的带标签枚举事件中提取字符串元数据并反序列化客户端标签。
pub(super) fn parse_tag_metadata_event(event: &Value) -> Option<LoreTagRecord> {
    if event.get("tagName")?.as_str()? != "metadata" {
        return None;
    }
    let data = event.get("data")?;
    let key = data.get("key")?.as_str()?.to_owned();
    if !key.starts_with(TAG_METADATA_PREFIX) {
        return None;
    }

    let value = data.get("value")?;
    let serialized = if value.get("tagName")?.as_str()? == "string" {
        value.get("data")?.as_str()?
    } else {
        return None;
    };
    let tag = serde_json::from_str::<LoreTag>(serialized).ok()?;
    if tag.id.trim().is_empty()
        || validate_tag_name(&tag.name).is_err()
        || validate_branch_name(&tag.branch).is_err()
        || validate_revision(&tag.revision).is_err()
    {
        return None;
    }
    Some(LoreTagRecord { key, tag })
}

/// 按稳定 ID 合并改名部分成功留下的重复记录，并提供可预测的更新时间排序。
pub(super) fn deduplicate_tag_records(records: Vec<LoreTagRecord>) -> Vec<LoreTagRecord> {
    let mut newest_by_id = HashMap::<String, LoreTagRecord>::new();
    for record in records {
        let should_replace = newest_by_id
            .get(&record.tag.id)
            .map(|current| {
                record.tag.updated_at > current.tag.updated_at
                    || (record.tag.updated_at == current.tag.updated_at && record.key > current.key)
            })
            .unwrap_or(true);
        if should_replace {
            newest_by_id.insert(record.tag.id.clone(), record);
        }
    }

    let mut deduplicated = newest_by_id.into_values().collect::<Vec<_>>();
    deduplicated.sort_by(|left, right| {
        right
            .tag
            .updated_at
            .cmp(&left.tag.updated_at)
            .then_with(|| left.tag.name.cmp(&right.tag.name))
    });
    deduplicated
}

pub(super) fn newest_tag_record(
    records: &[LoreTagRecord],
    tag_id: &str,
) -> Result<LoreTagRecord, LoreCommandError> {
    records
        .iter()
        .filter(|record| record.tag.id == tag_id)
        .max_by(|left, right| {
            left.tag
                .updated_at
                .cmp(&right.tag.updated_at)
                .then_with(|| left.key.cmp(&right.key))
        })
        .cloned()
        .ok_or_else(|| {
            LoreCommandError::new(
                "tag_not_found",
                "The tag to update no longer exists; refresh the repository state",
            )
        })
}

/// 在去重前检查名称占用，防止旧键或部分成功记录被无意覆盖。
pub(super) fn ensure_tag_name_available(
    records: &[LoreTagRecord],
    name: &str,
    current_tag_id: Option<&str>,
) -> Result<(), LoreCommandError> {
    if records
        .iter()
        .any(|record| record.tag.name == name && Some(record.tag.id.as_str()) != current_tag_id)
    {
        return Err(LoreCommandError::new(
            "tag_name_exists",
            format!("Tag \"{name}\" already exists; choose another name"),
        ));
    }
    Ok(())
}

/// 写入单个标签的 JSON 字符串；Lore Core 会负责远端比较交换与本地缓存更新。
pub(super) fn write_tag(repository_path: &str, tag: &LoreTag) -> Result<(), LoreCommandError> {
    let key = tag_metadata_key(&tag.name);
    let value = serde_json::to_string(tag).map_err(|error| {
        LoreCommandError::new(
            "tag_serialization_failed",
            format!("Failed to serialize tag data: {error}"),
        )
    })?;
    let globals = global_args(repository_path)?;
    let result = run_operation("tag.write", move |callback| {
        lore::runtime().block_on(lore::repository::metadata_set(
            globals,
            LoreRepositoryMetadataSetArgs {
                keys: LoreArray::from_vec(vec![key.into()]),
                values: LoreArray::from_vec(vec![value.into()]),
                formats: LoreArray::from_vec(vec![LoreMetadataType::String]),
            },
            callback,
        ))
    })?;
    ensure_tag_operation_succeeded(&result, "tag_metadata_write_failed", "Save tag")
}

/// 批量清理标签键；空数组是本适配层的“无需操作”，绝不能传给 Lore，
/// 因为 Lore 的空 keys 语义是清除仓库全部用户元数据。
pub(super) fn clear_tag_keys(
    repository_path: &str,
    keys: Vec<String>,
) -> Result<(), LoreCommandError> {
    if keys.is_empty() {
        return Ok(());
    }
    let globals = global_args(repository_path)?;
    let result = run_operation("tag.clear", move |callback| {
        lore::runtime().block_on(lore::repository::metadata_clear(
            globals,
            LoreRepositoryMetadataClearArgs {
                keys: LoreArray::from_vec(keys.into_iter().map(LoreString::from).collect()),
            },
            callback,
        ))
    })?;
    ensure_tag_operation_succeeded(&result, "tag_metadata_clear_failed", "Delete tag")
}

/// 把 Lore 的终止错误转换为 Tauri 可序列化错误，同时尽量保留 Core 原始信息。
pub(super) fn ensure_tag_operation_succeeded(
    result: &LoreOperationResult,
    code: &'static str,
    action: &str,
) -> Result<(), LoreCommandError> {
    if result.status == 0 {
        return Ok(());
    }
    let detail = result
        .events
        .iter()
        .rev()
        .find_map(|event| {
            if event.get("tagName")?.as_str()? == "complete" {
                event
                    .pointer("/data/error/message")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
            } else if event.get("tagName")?.as_str()? == "error" {
                event
                    .pointer("/data/errorInner")
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
            } else {
                None
            }
        })
        .unwrap_or("Lore Core did not return error details");
    Err(LoreCommandError::new(
        code,
        format!("{action} failed (status {}): {detail}", result.status),
    ))
}

pub(super) fn tag_metadata_key(name: &str) -> String {
    format!("{TAG_METADATA_PREFIX}{name}")
}

pub(super) fn validate_tag_name(name: &str) -> Result<String, LoreCommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(LoreCommandError::new(
            "empty_tag_name",
            "The tag name must not be empty",
        ));
    }
    if name.chars().count() > 128 {
        return Err(LoreCommandError::new(
            "tag_name_too_long",
            "The tag name must not exceed 128 characters",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(LoreCommandError::new(
            "invalid_tag_name",
            "The tag name must not contain control characters or line breaks",
        ));
    }
    Ok(name.to_owned())
}

pub(super) fn validate_tag_id(tag_id: &str) -> Result<String, LoreCommandError> {
    let tag_id = tag_id.trim();
    if tag_id.is_empty() || tag_id.chars().any(char::is_whitespace) {
        return Err(LoreCommandError::new(
            "invalid_tag_id",
            "The tag ID is invalid",
        ));
    }
    Ok(tag_id.to_owned())
}

pub(super) fn validate_tag_message(message: &str) -> Result<String, LoreCommandError> {
    let message = message.trim();
    if message.chars().count() > 4_096 {
        return Err(LoreCommandError::new(
            "tag_message_too_long",
            "The tag description must not exceed 4096 characters",
        ));
    }
    if message.contains('\0') {
        return Err(LoreCommandError::new(
            "invalid_tag_message",
            "The tag description must not contain null characters",
        ));
    }
    Ok(message.to_owned())
}

/// Amend 与 Restore 都会写入 Revision 元数据，沿用提交消息的非空语义并限制体积。
pub(super) fn validate_revision_message(message: &str) -> Result<String, LoreCommandError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(LoreCommandError::new(
            "empty_revision_message",
            "The revision message must not be empty",
        ));
    }
    if message.chars().count() > 16_384 || message.contains('\0') {
        return Err(LoreCommandError::new(
            "invalid_revision_message",
            "The revision message is invalid or exceeds 16384 characters",
        ));
    }
    Ok(message.to_owned())
}

pub(super) fn unix_time_millis() -> Result<u64, LoreCommandError> {
    unix_time_duration().map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

pub(super) fn unix_time_nanos() -> Result<u128, LoreCommandError> {
    unix_time_duration().map(|duration| duration.as_nanos())
}

pub(super) fn unix_time_duration() -> Result<std::time::Duration, LoreCommandError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            LoreCommandError::new(
                "system_time_invalid",
                format!("Failed to create the tag because the system time is before the Unix epoch: {error}"),
            )
        })
}
