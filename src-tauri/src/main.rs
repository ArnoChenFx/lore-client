// Windows 发布构建不额外打开控制台窗口；调试构建仍保留控制台便于诊断。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/**
 * 在 Rust 运行时第一次分配内存前，让 Lore 选择 Windows 系统分配器。
 *
 * Lore 的全局分配器会在第一次 Rust 分配时把选择锁进 `OnceLock`，因此 `main` 已经
 * 太晚。这里注册 C Runtime 初始化回调，并直接更新 UCRT 的环境表；Win32 的
 * `SetEnvironmentVariableW` 只更新进程环境块，不能保证 Lore 使用的 `libc::getenv`
 * 立即看到新值。静态 C 字符串与 `_putenv_s` 都不经过 Rust 全局分配器。
 */
#[cfg(target_os = "windows")]
unsafe extern "C" fn select_memory_conservative_lore_allocator() {
    unsafe extern "C" {
        fn _putenv_s(name: *const std::ffi::c_char, value: *const std::ffi::c_char) -> i32;
    }

    const NAME: &[u8] = b"LORE_ALLOCATOR\0";
    const VALUE: &[u8] = b"system\0";

    // SAFETY: 两个参数都指向进程生命周期内有效、以 NUL 结尾的 ASCII 常量。
    unsafe {
        _putenv_s(NAME.as_ptr().cast(), VALUE.as_ptr().cast());
    }
}

// MSVC 会按 `.CRT$XC*` 段名字典序执行初始化器；`XCU` 是应用自定义初始化器段。
// `used` 防止链接优化丢弃这个没有普通 Rust 调用点的回调。
#[cfg(target_os = "windows")]
#[used]
#[unsafe(link_section = ".CRT$XCU")]
static SELECT_LORE_ALLOCATOR: unsafe extern "C" fn() = select_memory_conservative_lore_allocator;

fn main() {
    lore_client_lib::run();
}
