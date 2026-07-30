/// Lore Client 的公开项目仓库。
///
/// URL 固定在 Rust 边界，不接受前端传入任意地址，避免把该命令扩展成无约束的外部
/// 协议启动入口。前端同名常量只负责标准链接语义；桌面环境的实际打开目标以此处为准。
const PROJECT_REPOSITORY_URL: &str = "https://github.com/ArnoChenFx/lore-client";

/// Lore Client 的公开发布页；只允许在固定仓库范围内查看已发布版本。
const PROJECT_RELEASES_URL: &str = "https://github.com/ArnoChenFx/lore-client/releases";

/// 使用操作系统默认浏览器打开 Lore Client 的公开项目仓库。
#[tauri::command]
pub fn application_open_project_repository() -> Result<(), String> {
    open::that(PROJECT_REPOSITORY_URL)
        .map_err(|error| format!("Unable to open the project repository: {error}"))
}

/// 使用操作系统默认浏览器打开 Lore Client 的公开发布页。
#[tauri::command]
pub fn application_open_project_releases() -> Result<(), String> {
    open::that(PROJECT_RELEASES_URL)
        .map_err(|error| format!("Unable to open the project releases: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_project_repository_on_the_expected_https_origin() {
        assert_eq!(
            PROJECT_REPOSITORY_URL,
            "https://github.com/ArnoChenFx/lore-client"
        );
        assert!(PROJECT_REPOSITORY_URL.starts_with("https://github.com/"));
    }

    #[test]
    fn keeps_project_releases_under_the_expected_repository() {
        assert_eq!(
            PROJECT_RELEASES_URL,
            format!("{PROJECT_REPOSITORY_URL}/releases")
        );
    }
}
