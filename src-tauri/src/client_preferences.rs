use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::asset_preview::{binary_preview_limit_bytes, DEFAULT_BINARY_PREVIEW_LIMIT_MIB};
use crate::lore_adapter::{sync_auth_account_bindings, LoreCommandError};

/// 当前偏好文件格式版本；后续调整字段语义时在 Rust 边界执行显式迁移。
const CLIENT_PREFERENCES_VERSION: u32 = 4;
const PREFERENCES_FILE_NAME: &str = "client-preferences.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutPreference {
    pub sidebar_width: f64,
    pub inspector_width: f64,
}

/// 工作区与 Revision Diff 共用的持久化显示参数。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DiffPreference {
    pub context_lines: u32,
    pub ignore_whitespace_eol: bool,
    pub ignore_whitespace_inline: bool,
}

impl Default for DiffPreference {
    fn default() -> Self {
        Self {
            context_lines: 3,
            ignore_whitespace_eol: false,
            ignore_whitespace_inline: false,
        }
    }
}

impl Default for WorkspaceLayoutPreference {
    fn default() -> Self {
        Self {
            sidebar_width: 244.0,
            inspector_width: 520.0,
        }
    }
}

/// 外部 Diff 工具及其无 Shell 参数模板。
///
/// 参数数组会逐项传给 `std::process::Command`；偏好层只限制大小，模板完整性在实际
/// 启动时校验，使用户编辑中间态不会导致整个偏好文件保存失败。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExternalDiffPreference {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub executable: String,
    pub arguments: Vec<String>,
    pub primary: bool,
}

/// 仓库到账户的脱敏绑定；Token 只由 Lore 凭据存储持有。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepositoryAuthAccountBinding {
    pub repository_path: String,
    pub auth_url: String,
    pub user_id: String,
}

impl Default for ExternalDiffPreference {
    fn default() -> Self {
        Self {
            id: "diff-none".to_owned(),
            kind: "none".to_owned(),
            name: String::new(),
            executable: String::new(),
            arguments: vec!["{before}".to_owned(), "{after}".to_owned()],
            primary: false,
        }
    }
}

fn default_external_tools(mode: &str) -> Vec<ExternalDiffPreference> {
    ["beyondCompare", "cursor", "p4merge", "vscode"]
        .into_iter()
        .map(|kind| {
            let (name, executable) = match kind {
                "beyondCompare" => ("Beyond Compare", "BCompare"),
                "cursor" => ("Cursor", "cursor"),
                "p4merge" => ("P4Merge", "p4merge"),
                _ => ("Visual Studio Code", "code"),
            };
            let arguments = if mode == "diff" {
                match kind {
                    "vscode" | "cursor" => vec!["--wait", "--diff", "{before}", "{after}"],
                    "beyondCompare" => vec![
                        "/lefttitle={beforeLabel}",
                        "/righttitle={afterLabel}",
                        "{before}",
                        "{after}",
                    ],
                    _ => vec![
                        "-nl",
                        "{beforeLabel}",
                        "-nr",
                        "{afterLabel}",
                        "{before}",
                        "{after}",
                    ],
                }
            } else {
                match kind {
                    "vscode" | "cursor" => {
                        vec![
                            "--wait", "--merge", "{remote}", "{local}", "{base}", "{merged}",
                        ]
                    }
                    "p4merge" => vec!["{base}", "{remote}", "{local}", "{merged}"],
                    _ => vec!["{remote}", "{local}", "{base}", "{merged}"],
                }
            };
            ExternalDiffPreference {
                id: format!("{mode}-{kind}"),
                kind: kind.to_owned(),
                name: name.to_owned(),
                executable: executable.to_owned(),
                arguments: arguments.into_iter().map(str::to_owned).collect(),
                primary: kind == "beyondCompare",
            }
        })
        .collect()
}

fn default_external_diff_tools() -> Vec<ExternalDiffPreference> {
    default_external_tools("diff")
}

fn default_external_merge_tools() -> Vec<ExternalDiffPreference> {
    default_external_tools("merge")
}

/// Lore Client 的单一磁盘偏好格式。
///
/// 所有字段都有默认值，使旧版本缺少新字段时仍能安全加载；路径列表和活动路径
/// 作为同一个会话整体保存，避免重启后只恢复最后一个项目。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientPreferences {
    pub version: u32,
    pub theme: String,
    /// 界面语言使用稳定 BCP 47 标签；旧偏好缺失字段时回退简体中文，
    /// 真正的首次启动默认值由前端按操作系统语言解析后再写入。
    pub language: String,
    /// 仓库没有配置身份时用于单次提交的客户端默认值；空字符串表示未配置。
    pub default_identity: String,
    pub workspace_layout: WorkspaceLayoutPreference,
    pub inspector_tab: String,
    pub local_changes_view: String,
    pub local_changes_stage_split: f64,
    /// 本地更改工作区最右侧 Diff 面板是否显示。
    pub local_changes_diff_visible: bool,
    pub revision_changes_view: String,
    pub revision_changes_browser_width: f64,
    /// Revision“变更”页签内右侧 Diff 面板是否显示。
    pub revision_changes_diff_visible: bool,
    /// 工作区与 Revision 是否读取并显示可预览的二进制 Diff。
    pub binary_diff_visible: bool,
    /// 单个二进制文件允许进入完整内嵌预览链路的最大原始体积，单位为 MiB。
    pub binary_preview_limit_mib: u64,
    /// Revision History 左侧轨道使用完整多道拓扑或当前 Branch 单道投影。
    pub revision_history_lane_mode: String,
    pub diff: DiffPreference,
    #[serde(default = "default_external_diff_tools")]
    pub external_diff_tools: Vec<ExternalDiffPreference>,
    #[serde(default = "default_external_merge_tools")]
    pub external_merge_tools: Vec<ExternalDiffPreference>,
    pub auth_account_bindings: Vec<RepositoryAuthAccountBinding>,
    pub repository_paths: Vec<String>,
    pub active_repository_path: Option<String>,
}

impl Default for ClientPreferences {
    fn default() -> Self {
        Self {
            version: CLIENT_PREFERENCES_VERSION,
            theme: "system".to_owned(),
            language: "zh-CN".to_owned(),
            default_identity: String::new(),
            workspace_layout: WorkspaceLayoutPreference::default(),
            inspector_tab: "overview".to_owned(),
            local_changes_view: "tree".to_owned(),
            local_changes_stage_split: 0.58,
            local_changes_diff_visible: true,
            revision_changes_view: "tree".to_owned(),
            revision_changes_browser_width: 220.0,
            revision_changes_diff_visible: true,
            binary_diff_visible: true,
            binary_preview_limit_mib: DEFAULT_BINARY_PREVIEW_LIMIT_MIB,
            revision_history_lane_mode: "flat".to_owned(),
            diff: DiffPreference::default(),
            external_diff_tools: default_external_diff_tools(),
            external_merge_tools: default_external_merge_tools(),
            auth_account_bindings: Vec::new(),
            repository_paths: Vec::new(),
            active_repository_path: None,
        }
    }
}

/// 返回 `None` 表示偏好文件尚未创建，前端可在这一时机执行一次旧数据迁移。
#[tauri::command]
pub fn lore_client_preferences_load(
    app: AppHandle,
) -> Result<Option<ClientPreferences>, LoreCommandError> {
    let path = preferences_file_path(&app)?;
    let preferences = read_preferences_file(&path)?;
    sync_auth_account_bindings(
        preferences
            .as_ref()
            .map(|value| value.auth_account_bindings.as_slice())
            .unwrap_or_default(),
    )?;
    Ok(preferences)
}

/// 保存完整偏好快照，避免多个组件分别修改文件时发生字段覆盖。
#[tauri::command]
pub fn lore_client_preferences_save(
    app: AppHandle,
    mut preferences: ClientPreferences,
) -> Result<(), LoreCommandError> {
    preferences.version = CLIENT_PREFERENCES_VERSION;
    validate_preferences(&preferences)?;
    sync_auth_account_bindings(&preferences.auth_account_bindings)?;
    let path = preferences_file_path(&app)?;
    write_preferences_file(&path, &preferences)
}

fn preferences_file_path(app: &AppHandle) -> Result<PathBuf, LoreCommandError> {
    let directory = app.path().app_config_dir().map_err(|error| {
        LoreCommandError::new(
            "preferences_directory_unavailable",
            format!("Failed to locate the Lore Client configuration directory: {error}"),
        )
    })?;
    Ok(directory.join(PREFERENCES_FILE_NAME))
}

fn read_preferences_file(path: &Path) -> Result<Option<ClientPreferences>, LoreCommandError> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| {
        LoreCommandError::new(
            "preferences_read_failed",
            format!(
                "Failed to read client preferences from {}: {error}",
                path.display()
            ),
        )
    })?;
    let preferences = serde_json::from_str::<ClientPreferences>(&content).map_err(|error| {
        LoreCommandError::new(
            "preferences_invalid",
            format!(
                "Client preferences at {} are invalid: {error}",
                path.display()
            ),
        )
    })?;
    validate_preferences(&preferences)?;
    Ok(Some(preferences))
}

fn write_preferences_file(
    path: &Path,
    preferences: &ClientPreferences,
) -> Result<(), LoreCommandError> {
    let parent = path.parent().ok_or_else(|| {
        LoreCommandError::new(
            "preferences_path_invalid",
            "The client preferences path is invalid",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        LoreCommandError::new(
            "preferences_directory_create_failed",
            format!(
                "Failed to create the client configuration directory {}: {error}",
                parent.display()
            ),
        )
    })?;
    let content = serde_json::to_string_pretty(preferences).map_err(|error| {
        LoreCommandError::new(
            "preferences_serialize_failed",
            format!("Failed to serialize client preferences: {error}"),
        )
    })?;
    fs::write(path, format!("{content}\n")).map_err(|error| {
        LoreCommandError::new(
            "preferences_write_failed",
            format!(
                "Failed to write client preferences to {}: {error}",
                path.display()
            ),
        )
    })
}

fn validate_preferences(preferences: &ClientPreferences) -> Result<(), LoreCommandError> {
    let valid_theme = matches!(preferences.theme.as_str(), "system" | "dark" | "light");
    let valid_language = matches!(preferences.language.as_str(), "zh-CN" | "en-US");
    let valid_inspector = matches!(
        preferences.inspector_tab.as_str(),
        "overview" | "changes" | "tree"
    );
    let valid_view = |value: &str| matches!(value, "flat" | "tree");
    let valid_history_lane_mode = matches!(
        preferences.revision_history_lane_mode.as_str(),
        "topology" | "flat"
    );
    let finite_layout = preferences.workspace_layout.sidebar_width.is_finite()
        && preferences.workspace_layout.inspector_width.is_finite()
        && preferences.local_changes_stage_split.is_finite()
        && preferences.revision_changes_browser_width.is_finite();
    let valid_layout = preferences.workspace_layout.sidebar_width >= 120.0
        && preferences.workspace_layout.inspector_width >= 240.0
        && (0.15..=0.85).contains(&preferences.local_changes_stage_split)
        && preferences.revision_changes_browser_width >= 100.0;
    let valid_diff = preferences.diff.context_lines <= 100;
    let valid_binary_preview_limit =
        binary_preview_limit_bytes(preferences.binary_preview_limit_mib).is_ok();
    let valid_external_tool = |tool: &ExternalDiffPreference| {
        matches!(
            tool.kind.as_str(),
            "none" | "vscode" | "cursor" | "beyondCompare" | "p4merge" | "custom"
        ) && !tool.id.is_empty()
            && tool.id.len() <= 128
            && tool.name.len() <= 128
            && tool.executable.len() <= 4096
            && tool.arguments.len() <= 64
            && tool
                .arguments
                .iter()
                .all(|argument| argument.len() <= 4096 && !argument.contains('\0'))
    };
    let valid_external_diff = preferences.external_diff_tools.len() <= 32
        && preferences.external_merge_tools.len() <= 32
        && preferences
            .external_diff_tools
            .iter()
            .all(valid_external_tool)
        && preferences
            .external_merge_tools
            .iter()
            .all(valid_external_tool)
        && preferences
            .external_diff_tools
            .iter()
            .filter(|tool| tool.primary)
            .count()
            <= 1
        && preferences
            .external_merge_tools
            .iter()
            .filter(|tool| tool.primary)
            .count()
            <= 1;
    let valid_identity = preferences.default_identity.len() <= 512
        && !preferences.default_identity.contains(['\r', '\n']);
    let valid_auth_bindings = preferences.auth_account_bindings.len() <= 256
        && preferences.auth_account_bindings.iter().all(|binding| {
            !binding.repository_path.trim().is_empty()
                && binding.repository_path.len() <= 4096
                && !binding.auth_url.trim().is_empty()
                && binding.auth_url.len() <= 2048
                && !binding.user_id.trim().is_empty()
                && binding.user_id.len() <= 512
                && !binding.repository_path.contains('\0')
                && !binding.auth_url.contains('\0')
                && !binding.user_id.contains('\0')
        });
    if !valid_theme
        || !valid_language
        || !valid_inspector
        || !valid_view(&preferences.local_changes_view)
        || !valid_view(&preferences.revision_changes_view)
        || !valid_history_lane_mode
        || !finite_layout
        || !valid_layout
        || !valid_diff
        || !valid_binary_preview_limit
        || !valid_external_diff
        || !valid_identity
        || !valid_auth_bindings
    {
        return Err(LoreCommandError::new(
            "preferences_value_invalid",
            "Client preferences contain unsupported or non-finite values",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_preferences_file_returns_none_instead_of_fake_saved_state() {
        // TempDir 在正常结束和 panic 展开时都会清理测试专属目录。
        let directory = tempfile::tempdir().expect("The temporary directory should be created");
        let path = directory.path().join(PREFERENCES_FILE_NAME);
        assert!(read_preferences_file(&path).unwrap().is_none());
    }

    #[test]
    fn preferences_round_trip_preserves_repository_tabs_and_active_repository() {
        // 避免断言失败时把偏好文件遗留在系统临时目录中。
        let directory = tempfile::tempdir().expect("The temporary directory should be created");
        let path = directory.path().join(PREFERENCES_FILE_NAME);
        let preferences = ClientPreferences {
            repository_paths: vec!["E:\\A".to_owned(), "E:\\B".to_owned()],
            active_repository_path: Some("E:\\A".to_owned()),
            binary_preview_limit_mib: 64,
            external_diff_tools: vec![ExternalDiffPreference {
                id: "diff-custom".to_owned(),
                kind: "custom".to_owned(),
                name: "Studio Diff".to_owned(),
                executable: "E:\\Tools\\Studio Diff.exe".to_owned(),
                arguments: vec!["{before}".to_owned(), "{after}".to_owned()],
                primary: true,
            }],
            ..Default::default()
        };

        write_preferences_file(&path, &preferences).unwrap();
        let serialized = std::fs::read_to_string(&path)
            .expect("The serialized preferences should remain readable");
        // MiB 的缩写必须与 TypeScript DTO 完全同名；普通 camelCase 会产生 Mib，
        // 这条断言防止前端再次写入一个被 serde 静默忽略的 MiB 变体。
        assert!(serialized.contains("\"binaryPreviewLimitMib\": 64"));
        assert!(!serialized.contains("binaryPreviewLimitMiB"));
        let restored = read_preferences_file(&path).unwrap().unwrap();
        assert_eq!(restored.repository_paths, preferences.repository_paths);
        assert_eq!(
            restored.active_repository_path,
            preferences.active_repository_path
        );
        assert_eq!(restored.language, "zh-CN");
        assert_eq!(restored.external_diff_tools[0].kind, "custom");
        assert_eq!(restored.external_diff_tools[0].name, "Studio Diff");
        assert_eq!(restored.binary_preview_limit_mib, 64);
        assert_eq!(
            restored.external_diff_tools[0].executable,
            "E:\\Tools\\Studio Diff.exe"
        );
    }

    #[test]
    fn preferences_file_rejects_unknown_application_language() {
        let preferences = ClientPreferences {
            language: "fr-FR".to_owned(),
            ..Default::default()
        };

        let error = validate_preferences(&preferences).unwrap_err();
        assert_eq!(error.code, "preferences_value_invalid");
    }

    #[test]
    fn older_preferences_default_new_display_fields() {
        /*
         * 旧版偏好文件没有新增显示字段。Rust 边界必须补齐两个 Diff 面板为显示，
         * 并按新的产品默认值进入平铺模式。
         */
        let preferences: ClientPreferences = serde_json::from_str(
            r#"{
                "version": 1,
                "theme": "system",
                "language": "zh-CN",
                "defaultIdentity": "",
                "workspaceLayout": {
                    "sidebarWidth": 244.0,
                    "inspectorWidth": 520.0
                },
                "inspectorTab": "overview",
                "localChangesView": "tree",
                "localChangesStageSplit": 0.58,
                "revisionChangesView": "tree",
                "revisionChangesBrowserWidth": 220.0,
                "diff": {
                    "contextLines": 3,
                    "ignoreWhitespaceEol": false,
                    "ignoreWhitespaceInline": false
                },
                "repositoryPaths": [],
                "activeRepositoryPath": null
            }"#,
        )
        .unwrap();

        assert!(preferences.local_changes_diff_visible);
        assert!(preferences.revision_changes_diff_visible);
        assert!(preferences.binary_diff_visible);
        assert_eq!(preferences.binary_preview_limit_mib, 20);
        assert_eq!(preferences.revision_history_lane_mode, "flat");
        assert_eq!(preferences.external_diff_tools.len(), 4);
        assert_eq!(preferences.external_merge_tools.len(), 4);
    }

    #[test]
    fn preferences_reject_unknown_revision_history_lane_mode() {
        let preferences = ClientPreferences {
            revision_history_lane_mode: "diagonal".to_owned(),
            ..Default::default()
        };

        let error = validate_preferences(&preferences).unwrap_err();
        assert_eq!(error.code, "preferences_value_invalid");
    }

    #[test]
    fn preferences_reject_zero_binary_preview_limit() {
        let preferences = ClientPreferences {
            binary_preview_limit_mib: 0,
            ..Default::default()
        };

        let error = validate_preferences(&preferences).unwrap_err();
        assert_eq!(error.code, "preferences_value_invalid");
    }
}
