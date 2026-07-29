use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::lore_adapter::LoreCommandError;

const CACHE_FILE_NAME: &str = "revision-author-cache.json";
const CACHE_VERSION: u32 = 1;
const MAX_CACHE_ENTRIES: usize = 4_096;
const MAX_REQUESTED_USER_IDS: usize = 1_000;
const MAX_FIELD_LENGTH: usize = 512;

/// 作者缓存首次访问时从磁盘惰性加载，后续查询直接复用进程内副本。
///
/// 写操作仍在持锁期间同步持久化，确保两个并发仓库刷新不会相互覆盖，同时避免
/// 异步防抖在应用异常退出时丢失刚解析出的作者名称。缓存规模有严格上限，因此
/// 这里使用单一 Mutex 可以保持生命周期和失败语义简单、可预测。
static CACHE_STATE: OnceLock<Mutex<RevisionAuthorCacheState>> = OnceLock::new();

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct RevisionAuthorCacheFile {
    version: u32,
    entries: Vec<RevisionAuthorCacheEntry>,
}

/// 记录已经加载的文件路径和内存副本。
///
/// 正常应用生命周期只有一个配置目录；保留路径比较是为了测试、热重载和未来多实例
/// 场景不会错误复用其他配置目录的数据。
#[derive(Debug)]
struct RevisionAuthorCacheState {
    loaded_path: Option<PathBuf>,
    cache: RevisionAuthorCacheFile,
}

impl Default for RevisionAuthorCacheState {
    fn default() -> Self {
        Self {
            loaded_path: None,
            cache: RevisionAuthorCacheFile::empty(),
        }
    }
}

impl RevisionAuthorCacheState {
    /// 同一路径只读取一次；路径变化时重新加载，避免跨配置目录串用作者映射。
    fn load_if_needed(&mut self, path: &Path) -> Result<(), LoreCommandError> {
        if self.loaded_path.as_deref() == Some(path) {
            return Ok(());
        }
        self.cache = read_cache_file(path)?;
        self.loaded_path = Some(path.to_path_buf());
        Ok(())
    }
}

impl RevisionAuthorCacheFile {
    fn empty() -> Self {
        Self {
            version: CACHE_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RevisionAuthorCacheEntry {
    repository_id: String,
    user_id: String,
    display_name: String,
    updated_at: u64,
}

/// IPC 只返回历史展示需要的脱敏字段；仓库作用域和更新时间留在 Rust 文件边界内。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionAuthorCacheHit {
    user_id: String,
    display_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionAuthorCacheUpdate {
    user_id: String,
    display_name: String,
}

fn cache_state() -> &'static Mutex<RevisionAuthorCacheState> {
    CACHE_STATE.get_or_init(|| Mutex::new(RevisionAuthorCacheState::default()))
}

fn cache_file_path(app: &AppHandle) -> Result<PathBuf, LoreCommandError> {
    let directory = app.path().app_config_dir().map_err(|error| {
        LoreCommandError::new(
            "revision_author_cache_directory_unavailable",
            format!("Failed to locate the Revision author cache directory: {error}"),
        )
    })?;
    Ok(directory.join(CACHE_FILE_NAME))
}

fn validate_field(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_FIELD_LENGTH
        && !value.chars().any(char::is_control)
}

fn validate_cache(cache: &RevisionAuthorCacheFile) -> Result<(), LoreCommandError> {
    let valid = cache.version == CACHE_VERSION
        && cache.entries.len() <= MAX_CACHE_ENTRIES
        && cache.entries.iter().all(|entry| {
            validate_field(&entry.repository_id)
                && validate_field(&entry.user_id)
                && validate_field(&entry.display_name)
        });
    if valid {
        Ok(())
    } else {
        Err(LoreCommandError::new(
            "revision_author_cache_invalid",
            "Revision author cache contains unsupported values",
        ))
    }
}

fn read_cache_file(path: &Path) -> Result<RevisionAuthorCacheFile, LoreCommandError> {
    if !path.exists() {
        return Ok(RevisionAuthorCacheFile::empty());
    }
    let content = fs::read_to_string(path).map_err(|error| {
        LoreCommandError::new(
            "revision_author_cache_read_failed",
            format!(
                "Failed to read Revision author cache from {}: {error}",
                path.display()
            ),
        )
    })?;
    let cache = serde_json::from_str::<RevisionAuthorCacheFile>(&content).map_err(|error| {
        LoreCommandError::new(
            "revision_author_cache_invalid",
            format!(
                "Revision author cache at {} is invalid: {error}",
                path.display()
            ),
        )
    })?;
    validate_cache(&cache)?;
    Ok(cache)
}

fn write_cache_file(path: &Path, cache: &RevisionAuthorCacheFile) -> Result<(), LoreCommandError> {
    validate_cache(cache)?;
    let parent = path.parent().ok_or_else(|| {
        LoreCommandError::new(
            "revision_author_cache_path_invalid",
            "Revision author cache path is invalid",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        LoreCommandError::new(
            "revision_author_cache_directory_create_failed",
            format!(
                "Failed to create Revision author cache directory {}: {error}",
                parent.display()
            ),
        )
    })?;
    let content = serde_json::to_string_pretty(cache).map_err(|error| {
        LoreCommandError::new(
            "revision_author_cache_serialize_failed",
            format!("Failed to serialize Revision author cache: {error}"),
        )
    })?;
    fs::write(path, format!("{content}\n")).map_err(|error| {
        LoreCommandError::new(
            "revision_author_cache_write_failed",
            format!(
                "Failed to write Revision author cache to {}: {error}",
                path.display()
            ),
        )
    })
}

fn normalize_requested_user_ids(user_ids: Vec<String>) -> Result<Vec<String>, LoreCommandError> {
    if user_ids.len() > MAX_REQUESTED_USER_IDS {
        return Err(LoreCommandError::new(
            "revision_author_cache_request_too_large",
            "Revision author cache request exceeds the supported history limit",
        ));
    }
    let mut normalized = Vec::new();
    for value in user_ids {
        let value = value.trim().to_owned();
        if !validate_field(&value) {
            return Err(LoreCommandError::new(
                "revision_author_cache_identity_invalid",
                "Revision author cache request contains an invalid identity",
            ));
        }
        if !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

fn merge_cache_entries(
    cache: &mut RevisionAuthorCacheFile,
    repository_id: &str,
    updates: Vec<RevisionAuthorCacheUpdate>,
    updated_at: u64,
) -> Result<bool, LoreCommandError> {
    if !validate_field(repository_id) || updates.len() > MAX_REQUESTED_USER_IDS {
        return Err(LoreCommandError::new(
            "revision_author_cache_update_invalid",
            "Revision author cache update exceeds supported boundaries",
        ));
    }

    let mut changed = false;
    for update in updates {
        let user_id = update.user_id.trim().to_owned();
        let display_name = update.display_name.trim().to_owned();
        if !validate_field(&user_id) || !validate_field(&display_name) {
            return Err(LoreCommandError::new(
                "revision_author_cache_update_invalid",
                "Revision author cache update contains an invalid field",
            ));
        }
        let existing_index = cache
            .entries
            .iter()
            .position(|entry| entry.repository_id == repository_id && entry.user_id == user_id);
        if existing_index
            .and_then(|index| cache.entries.get(index))
            .is_some_and(|entry| entry.display_name == display_name)
        {
            continue;
        }
        if let Some(index) = existing_index {
            cache.entries.remove(index);
        }
        cache.entries.push(RevisionAuthorCacheEntry {
            repository_id: repository_id.to_owned(),
            user_id,
            display_name,
            updated_at,
        });
        changed = true;
    }
    if changed {
        cache.entries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.repository_id.cmp(&right.repository_id))
                .then_with(|| left.user_id.cmp(&right.user_id))
        });
        cache.entries.truncate(MAX_CACHE_ENTRIES);
    }
    Ok(changed)
}

#[tauri::command]
pub fn lore_revision_author_cache_get(
    app: AppHandle,
    repository_id: String,
    user_ids: Vec<String>,
) -> Result<Vec<RevisionAuthorCacheHit>, LoreCommandError> {
    let repository_id = repository_id.trim().to_owned();
    if !validate_field(&repository_id) {
        return Err(LoreCommandError::new(
            "revision_author_cache_repository_invalid",
            "Revision author cache requires a valid Repository ID",
        ));
    }
    let user_ids = normalize_requested_user_ids(user_ids)?;
    let path = cache_file_path(&app)?;
    let mut state = cache_state().lock().map_err(|_| {
        LoreCommandError::new(
            "revision_author_cache_lock_poisoned",
            "Revision author cache lock is unavailable",
        )
    })?;
    state.load_if_needed(&path)?;
    Ok(state
        .cache
        .entries
        .iter()
        .filter(|entry| entry.repository_id == repository_id && user_ids.contains(&entry.user_id))
        .map(|entry| RevisionAuthorCacheHit {
            user_id: entry.user_id.clone(),
            display_name: entry.display_name.clone(),
        })
        .collect())
}

#[tauri::command]
pub fn lore_revision_author_cache_store(
    app: AppHandle,
    repository_id: String,
    authors: Vec<RevisionAuthorCacheUpdate>,
) -> Result<(), LoreCommandError> {
    if authors.is_empty() {
        return Ok(());
    }
    let repository_id = repository_id.trim().to_owned();
    let path = cache_file_path(&app)?;
    let mut state = cache_state().lock().map_err(|_| {
        LoreCommandError::new(
            "revision_author_cache_lock_poisoned",
            "Revision author cache lock is unavailable",
        )
    })?;
    state.load_if_needed(&path)?;
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    /*
     * 先在副本中合并并完成磁盘写入，再替换内存状态。若持久化失败，当前进程不会
     * 暴露一个磁盘上并不存在的新名称，下一次调用也可以安全重试。
     */
    let mut next_cache = state.cache.clone();
    if merge_cache_entries(&mut next_cache, &repository_id, authors, updated_at)? {
        write_cache_file(&path, &next_cache)?;
        state.cache = next_cache;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trip_preserves_redacted_author_fields() {
        let directory = tempfile::tempdir().expect("The cache test directory should be created");
        let path = directory.path().join(CACHE_FILE_NAME);
        let mut cache = RevisionAuthorCacheFile::empty();
        assert!(merge_cache_entries(
            &mut cache,
            "repository-1",
            vec![RevisionAuthorCacheUpdate {
                user_id: "user-42".to_owned(),
                display_name: "Arno Chen".to_owned(),
            }],
            42,
        )
        .unwrap());

        write_cache_file(&path, &cache).unwrap();
        let restored = read_cache_file(&path).unwrap();
        assert_eq!(restored.entries.len(), 1);
        assert_eq!(restored.entries[0].repository_id, "repository-1");
        assert_eq!(restored.entries[0].user_id, "user-42");
        assert_eq!(restored.entries[0].display_name, "Arno Chen");
        assert_eq!(restored.entries[0].updated_at, 42);
    }

    #[test]
    fn unchanged_author_name_does_not_rewrite_timestamp() {
        let mut cache = RevisionAuthorCacheFile::empty();
        let update = || RevisionAuthorCacheUpdate {
            user_id: "user-42".to_owned(),
            display_name: "Arno Chen".to_owned(),
        };
        assert!(merge_cache_entries(&mut cache, "repository-1", vec![update()], 10).unwrap());
        assert!(!merge_cache_entries(&mut cache, "repository-1", vec![update()], 20).unwrap());
        assert_eq!(cache.entries[0].updated_at, 10);
    }

    #[test]
    fn cache_update_rejects_control_characters() {
        let mut cache = RevisionAuthorCacheFile::empty();
        let error = merge_cache_entries(
            &mut cache,
            "repository-1",
            vec![RevisionAuthorCacheUpdate {
                user_id: "user-42".to_owned(),
                display_name: "Unsafe\nName".to_owned(),
            }],
            1,
        )
        .unwrap_err();
        assert_eq!(error.code, "revision_author_cache_update_invalid");
    }

    #[test]
    fn cache_state_reads_the_same_file_only_once() {
        let directory = tempfile::tempdir().expect("The cache test directory should be created");
        let path = directory.path().join(CACHE_FILE_NAME);
        let mut first = RevisionAuthorCacheFile::empty();
        assert!(merge_cache_entries(
            &mut first,
            "repository-1",
            vec![RevisionAuthorCacheUpdate {
                user_id: "user-42".to_owned(),
                display_name: "First Name".to_owned(),
            }],
            1,
        )
        .unwrap());
        write_cache_file(&path, &first).unwrap();

        let mut state = RevisionAuthorCacheState::default();
        state.load_if_needed(&path).unwrap();

        // 模拟外部文件在运行期发生变化；同一路径的第二次访问必须继续命中内存副本。
        let mut second = RevisionAuthorCacheFile::empty();
        assert!(merge_cache_entries(
            &mut second,
            "repository-1",
            vec![RevisionAuthorCacheUpdate {
                user_id: "user-42".to_owned(),
                display_name: "Second Name".to_owned(),
            }],
            2,
        )
        .unwrap());
        write_cache_file(&path, &second).unwrap();
        state.load_if_needed(&path).unwrap();

        assert_eq!(state.cache.entries[0].display_name, "First Name");
    }
}
