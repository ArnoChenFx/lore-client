use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy, WEBVIEW_TARGET};

/// 单个活动日志文件的上限。轮转发生在写入下一条记录前，因此不会无限增长。
pub const MAX_LOG_FILE_SIZE_BYTES: u128 = 5 * 1024 * 1024;
/// 包含当前活动文件在内最多保留的日志文件数量。
pub const RETAINED_LOG_FILE_COUNT: usize = 5;
const LOG_FILE_BASENAME: &str = "lore-client";

/// 前端维护页只消费稳定的日志目录投影，不直接拼接平台路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationLogInfo {
    pub directory_path: String,
    pub active_file_path: String,
    pub max_file_size_bytes: u128,
    pub retained_file_count: usize,
}

/// 构建统一日志插件。
///
/// 第三方依赖默认只保留 Warning 及以上，避免网络库和文件扫描在正常运行时淹没
/// 诊断信息；本应用 Rust 模块保留 Info，WebView 桥接保留 Debug，便于重现 IPC 时序。
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some(LOG_FILE_BASENAME.to_string()),
            }),
        ])
        .level(log::LevelFilter::Warn)
        .level_for("lore_client_lib", log::LevelFilter::Info)
        .level_for(WEBVIEW_TARGET, log::LevelFilter::Debug)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(MAX_LOG_FILE_SIZE_BYTES)
        // KeepSome 只计算归档文件，活动文件不在计数内；减一后总数稳定为 5。
        .rotation_strategy(RotationStrategy::KeepSome(RETAINED_LOG_FILE_COUNT - 1))
        .build()
}

/// 在日志插件已经安装后注册 panic hook，使后台线程崩溃也能在落盘日志中留下原因。
pub fn install_panic_hook() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        log::error!(target: "lore_client_lib::panic", "Unhandled Rust panic: {panic_info}");
        // 调试构建仍保留 Rust 默认的终端输出和 backtrace 行为。
        previous_hook(panic_info);
    }));
}

fn resolve_log_info<R: Runtime>(app: &AppHandle<R>) -> Result<ApplicationLogInfo, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("Unable to resolve the application log directory: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create the application log directory: {error}"))?;
    let active_file = directory.join(LOG_FILE_BASENAME).with_extension("log");
    Ok(ApplicationLogInfo {
        directory_path: directory.to_string_lossy().into_owned(),
        active_file_path: active_file.to_string_lossy().into_owned(),
        max_file_size_bytes: MAX_LOG_FILE_SIZE_BYTES,
        retained_file_count: RETAINED_LOG_FILE_COUNT,
    })
}

/// 返回平台原生的固定日志目录和轮转参数，供设置页明确展示。
#[tauri::command]
pub fn application_log_info<R: Runtime>(app: AppHandle<R>) -> Result<ApplicationLogInfo, String> {
    resolve_log_info(&app)
}

/// 用操作系统文件管理器打开固定日志目录；路径始终由 Tauri 解析，不接受前端输入。
#[tauri::command]
pub fn application_log_open_directory<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let info = resolve_log_info(&app)?;
    open::that(&info.directory_path)
        .map_err(|error| format!("Unable to open the application log directory: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_log_storage_bounded() {
        assert_eq!(MAX_LOG_FILE_SIZE_BYTES, 5_242_880);
        assert_eq!(RETAINED_LOG_FILE_COUNT, 5);
        assert!(!LOG_FILE_BASENAME.contains(['/', '\\']));
    }
}
