//! 仓库配置的保真读取、字段规范化、局部更新与提交身份解析。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use super::*;
use crate::atomic_file::write_file_atomically;

/// 返回仓库当前格式对应的配置路径；旧 `.urc` 仓库继续使用自己的目录，
/// 不能在旁边新建 `.lore` 后造成双配置来源。
pub(super) fn repository_configuration_path(
    repository_path: &Path,
) -> Result<PathBuf, LoreCommandError> {
    Ok(repository_metadata_directory(repository_path)?.join("config.toml"))
}

/// 读取配置文档。真实仓库即使缺少 config.toml，Lore 也按默认配置打开，因此这里
/// 返回空文档并允许用户补充 identity 或 remote_url。
pub(super) fn read_repository_configuration_document(
    repository_path: &Path,
) -> Result<(PathBuf, toml_edit::DocumentMut), LoreCommandError> {
    let path = repository_configuration_path(repository_path)?;
    if !path.exists() {
        return Ok((path, toml_edit::DocumentMut::new()));
    }
    let content = std::fs::read_to_string(&path).map_err(|error| {
        LoreCommandError::new(
            "repository_config_read_failed",
            format!(
                "Failed to read repository configuration {}: {error}",
                path.display()
            ),
        )
    })?;
    let document = content.parse::<toml_edit::DocumentMut>().map_err(|error| {
        LoreCommandError::new(
            "repository_config_invalid",
            format!(
                "Repository configuration at {} is invalid: {error}",
                path.display()
            ),
        )
    })?;
    Ok((path, document))
}

/// 只接受顶层字符串字段；类型错误必须显式暴露，不能把损坏配置伪装成“未配置”。
pub(super) fn repository_configuration_string(
    document: &toml_edit::DocumentMut,
    key: &str,
) -> Result<Option<String>, LoreCommandError> {
    let Some(item) = document.get(key) else {
        return Ok(None);
    };
    let Some(value) = item.as_str() else {
        return Err(LoreCommandError::new(
            "repository_config_value_invalid",
            format!("Repository configuration key {key} must be a string"),
        ));
    };
    let value = value.trim();
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

pub(super) fn read_repository_configuration(
    repository_path: &Path,
) -> Result<RepositoryConfiguration, LoreCommandError> {
    let (_, document) = read_repository_configuration_document(repository_path)?;
    Ok(RepositoryConfiguration {
        identity: repository_configuration_string(&document, "identity")?,
        remote_url: repository_configuration_string(&document, "remote_url")?,
    })
}

/// 身份是 Lore 的不透明字符串，但需要限制换行和异常尺寸，避免把配置文件变成
/// 难以审阅的多行值。字符串内部的普通空格会保留。
pub(super) fn normalize_identity(identity: &str) -> Result<Option<String>, LoreCommandError> {
    let identity = identity.trim();
    if identity.is_empty() {
        return Ok(None);
    }
    if identity.contains(['\r', '\n']) || identity.chars().count() > 512 {
        return Err(LoreCommandError::new(
            "invalid_commit_identity",
            "The commit identity must not contain line breaks or exceed 512 characters",
        ));
    }
    Ok(Some(identity.to_owned()))
}

/// 仓库远端地址允许被清除；非空值遵循当前 Lore 客户端使用的 lore:// 协议。
pub(super) fn normalize_repository_remote_url(
    remote_url: &str,
) -> Result<Option<String>, LoreCommandError> {
    let remote_url = remote_url.trim().trim_end_matches('/');
    if remote_url.is_empty() {
        return Ok(None);
    }
    validate_server_url(remote_url)
        .map(Some)
        .map_err(|error| LoreCommandError::new("invalid_repository_remote_url", error.message))
}

/// 以原子替换方式写入仓库配置：崩溃时只会留下旧文件或完整的新文件。
pub(super) fn write_repository_configuration_document(
    path: &Path,
    document: &toml_edit::DocumentMut,
) -> Result<(), LoreCommandError> {
    write_file_atomically(path, document.to_string().as_bytes()).map_err(|error| {
        LoreCommandError::new(
            "repository_config_write_failed",
            format!(
                "Failed to write repository configuration {}: {error}",
                path.display()
            ),
        )
    })
}

pub(super) fn update_repository_configuration(
    repository_path: &Path,
    identity: &str,
    remote_url: &str,
) -> Result<RepositoryConfiguration, LoreCommandError> {
    let identity = normalize_identity(identity)?;
    let remote_url = normalize_repository_remote_url(remote_url)?;
    let (path, mut document) = read_repository_configuration_document(repository_path)?;

    if let Some(identity) = identity.as_deref() {
        document["identity"] = toml_edit::value(identity);
    } else {
        document.remove("identity");
    }
    if let Some(remote_url) = remote_url.as_deref() {
        document["remote_url"] = toml_edit::value(remote_url);
    } else {
        document.remove("remote_url");
    }

    write_repository_configuration_document(&path, &document)?;
    read_repository_configuration(repository_path)
}
