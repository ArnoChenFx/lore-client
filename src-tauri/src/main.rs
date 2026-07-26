// Windows 发布构建不额外打开控制台窗口；调试构建仍保留控制台便于诊断。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lore_client_lib::run();
}
