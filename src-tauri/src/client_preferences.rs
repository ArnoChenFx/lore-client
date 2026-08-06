use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::asset_preview::{binary_preview_limit_bytes, DEFAULT_BINARY_PREVIEW_LIMIT_MIB};
use crate::lore_adapter::{sync_auth_account_bindings, LoreCommandError};

/// 当前偏好文件格式版本；后续调整字段语义时在 Rust 边界执行显式迁移。
const CLIENT_PREFERENCES_VERSION: u32 = 5;
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
    /// Diff 视图布局：`unified`（统一视图）或 `split`（左右分栏），与前端枚举保持一致。
    pub diff_style: String,
    /// unified 模式下是否展开全文：开启后按需读取完整前后文件内容并显示所有未变化行。
    pub expand_full_file: bool,
    pub ignore_whitespace_eol: bool,
    pub ignore_whitespace_inline: bool,
}

impl Default for DiffPreference {
    fn default() -> Self {
        Self {
            context_lines: 3,
            diff_style: "unified".to_owned(),
            expand_full_file: false,
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

/// 本地项目的客户端名称、Tab 颜色与工作区图标覆盖；不会写入 Lore 仓库配置。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepositoryTabCustomization {
    pub repository_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
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
    ["beyondCompare", "cursor", "p4merge", "vscode", "meld"]
        .into_iter()
        .map(|kind| {
            let (name, executable) = match kind {
                "beyondCompare" => ("Beyond Compare", "BCompare"),
                "cursor" => ("Cursor", "cursor"),
                "p4merge" => ("P4Merge", "p4merge"),
                "meld" => ("Meld", "meld"),
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
                    "meld" => vec![
                        "--label={beforeLabel}",
                        "{before}",
                        "--label={afterLabel}",
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
                    "meld" => vec!["{local}", "{base}", "{remote}", "--output={merged}"],
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
    /// 启动时是否自动检查更新；设置对话框可切换，必须随偏好文件往返，否则关闭选择会在重启后丢失。
    pub automatically_check_for_updates: bool,
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
    pub repository_tab_customizations: Vec<RepositoryTabCustomization>,
    pub repository_paths: Vec<String>,
    pub active_repository_path: Option<String>,
}

impl Default for ClientPreferences {
    fn default() -> Self {
        Self {
            version: CLIENT_PREFERENCES_VERSION,
            theme: "system".to_owned(),
            language: "zh-CN".to_owned(),
            automatically_check_for_updates: true,
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
            repository_tab_customizations: Vec::new(),
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

/**
 * Rust 偏好层只验证跨边界颜色的稳定传输格式，不复制前端产品色板。
 *
 * 具体可选颜色由前端单一来源维护并在读取偏好时再次收敛；这里保留 `#RRGGBB`
 * 语法检查，可拒绝超长字符串、CSS 函数和其它不应进入偏好文件的任意样式值，
 * 同时允许未来调整色板而无需同步修改 Rust 常量。
 */
fn is_rgb_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
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
    // 布局字段枚举受 Rust 边界约束；未知值让整个偏好文件加载失败，由前端回退默认并修复。
    let valid_diff = preferences.diff.context_lines <= 100
        && matches!(preferences.diff.diff_style.as_str(), "unified" | "split");
    let valid_binary_preview_limit =
        binary_preview_limit_bytes(preferences.binary_preview_limit_mib).is_ok();
    let valid_external_tool = |tool: &ExternalDiffPreference| {
        matches!(
            tool.kind.as_str(),
            "none" | "vscode" | "cursor" | "beyondCompare" | "p4merge" | "meld" | "custom"
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
    let valid_repository_tab_customizations = preferences.repository_tab_customizations.len()
        <= 256
        && preferences
            .repository_tab_customizations
            .iter()
            .all(|customization| {
                let valid_name = customization.name.as_ref().is_none_or(|name| {
                    !name.trim().is_empty()
                        && name.len() <= 80
                        && !name.contains(['\r', '\n', '\0'])
                });
                let valid_color = customization
                    .color
                    .as_ref()
                    .is_none_or(|color| is_rgb_hex_color(color));
                let valid_icon = customization.icon.as_ref().is_none_or(|icon| {
                    matches!(
                        icon.as_str(),
                        "boxes"
                            | "folder-git"
                            | "code"
                            | "gamepad"
                            | "globe"
                            | "database"
                            | "package"
                            | "book"
                            | "palette"
                            | "image"
                            | "music"
                            | "film"
                            | "flask"
                            | "cpu"
                            | "terminal"
                            | "rocket"
                    )
                });
                !customization.repository_path.trim().is_empty()
                    && customization.repository_path.len() <= 4096
                    && !customization.repository_path.contains('\0')
                    && (customization.name.is_some()
                        || customization.color.is_some()
                        || customization.icon.is_some())
                    && valid_name
                    && valid_color
                    && valid_icon
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
        || !valid_repository_tab_customizations
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
            automatically_check_for_updates: false,
            repository_paths: vec!["E:\\A".to_owned(), "E:\\B".to_owned()],
            active_repository_path: Some("E:\\A".to_owned()),
            repository_tab_customizations: vec![RepositoryTabCustomization {
                repository_path: "E:\\A".to_owned(),
                name: Some("Environment".to_owned()),
                color: Some("#4aa7ad".to_owned()),
                icon: Some("gamepad".to_owned()),
            }],
            binary_preview_limit_mib: 64,
            diff: DiffPreference {
                diff_style: "split".to_owned(),
                expand_full_file: true,
                ..Default::default()
            },
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
        // 关闭自动更新的选择必须随偏好文件往返，否则重启后会被前端默认值覆盖。
        assert!(!restored.automatically_check_for_updates);
        assert_eq!(restored.external_diff_tools[0].kind, "custom");
        assert_eq!(restored.external_diff_tools[0].name, "Studio Diff");
        assert_eq!(restored.binary_preview_limit_mib, 64);
        // 前端新增的 Diff 参数必须随偏好文件往返，否则重启后会静默丢失布局选择。
        assert_eq!(restored.diff.diff_style, "split");
        assert!(restored.diff.expand_full_file);
        assert_eq!(restored.repository_tab_customizations.len(), 1);
        assert_eq!(
            restored.repository_tab_customizations[0].name.as_deref(),
            Some("Environment")
        );
        assert_eq!(
            restored.repository_tab_customizations[0].icon.as_deref(),
            Some("gamepad")
        );
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
        // 旧文件缺省启动检查字段时保持既有行为，不因升级静默关闭自动更新。
        assert!(preferences.automatically_check_for_updates);
        // 旧文件缺少前端新增的 Diff 布局字段时按升级前行为回退统一视图，且不自动展开全文。
        assert_eq!(preferences.diff.diff_style, "unified");
        assert!(!preferences.diff.expand_full_file);
        assert_eq!(preferences.external_diff_tools.len(), 5);
        assert_eq!(preferences.external_merge_tools.len(), 5);
        assert!(preferences.repository_tab_customizations.is_empty());
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
    fn preferences_reject_unknown_diff_style() {
        let preferences = ClientPreferences {
            diff: DiffPreference {
                diff_style: "side-by-side".to_owned(),
                ..Default::default()
            },
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

    #[test]
    fn preferences_reject_repository_tab_customization_with_invalid_color_syntax() {
        let preferences = ClientPreferences {
            repository_tab_customizations: vec![RepositoryTabCustomization {
                repository_path: "E:\\A".to_owned(),
                name: None,
                color: Some("hotpink".to_owned()),
                icon: None,
            }],
            ..Default::default()
        };

        let error = validate_preferences(&preferences).unwrap_err();
        assert_eq!(error.code, "preferences_value_invalid");
    }

    #[test]
    fn preferences_accept_repository_tab_color_without_backend_palette_knowledge() {
        let preferences = ClientPreferences {
            repository_tab_customizations: vec![RepositoryTabCustomization {
                repository_path: "E:\\A".to_owned(),
                name: None,
                color: Some("#123456".to_owned()),
                icon: None,
            }],
            ..Default::default()
        };

        assert!(validate_preferences(&preferences).is_ok());
    }

    #[test]
    fn preferences_reject_unknown_repository_icon() {
        let preferences = ClientPreferences {
            repository_tab_customizations: vec![RepositoryTabCustomization {
                repository_path: "E:\\A".to_owned(),
                name: None,
                color: None,
                icon: Some("arbitrary-svg".to_owned()),
            }],
            ..Default::default()
        };

        let error = validate_preferences(&preferences).unwrap_err();
        assert_eq!(error.code, "preferences_value_invalid");
    }
}
