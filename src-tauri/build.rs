use std::{env, fs, path::Path};

use toml_edit::DocumentMut;

/// Cargo 锁文件中 Lore 依赖必须使用的上游 Git 来源。
///
/// 构建脚本同时校验来源与提交格式，避免同名注册表包或本地补丁被误识别为
/// 产品声明的固定 Lore 上游版本。
const LORE_GIT_SOURCE_PREFIX: &str = "git+https://github.com/EpicGames/lore.git";

/// Windows 应用清单，内容与 `tauri-build` 的默认清单逐字节一致：声明对 Common Controls v6 的依赖。
///
/// 清单独立成文件而不是内联字符串，便于直接对照 `tauri-build` 的 `windows-app-manifest.xml`；
/// `include_str!` 还会让 Cargo 在文件变化时重新编译并运行构建脚本。
const WINDOWS_APP_MANIFEST: &str = include_str!("windows-app-manifest.xml");

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");

    let manifest_dir =
        env::var("CARGO_MANIFEST_DIR").expect("Cargo must provide CARGO_MANIFEST_DIR to build.rs");
    let lock_path = Path::new(&manifest_dir).join("Cargo.lock");
    let revision = read_lore_source_revision(&lock_path)
        .unwrap_or_else(|error| panic!("Failed to determine the Lore source revision: {error}"));

    // `env!` 会在编译 lore-client crate 时读取这个值，因此运行期无需访问源码仓库、
    // Cargo 元数据或外部命令，打包后的诊断信息仍然可复现。
    println!("cargo:rustc-env=LORE_SOURCE_REVISION={revision}");

    // 由 tauri-build 根据 tauri.conf.json 生成平台资源（图标、版本信息）与运行时上下文。
    //
    // 必须关闭它自带的应用清单：tauri-build 只会把清单链接进 `bin`，而库内单元测试等其他产物
    // 同样需要它。清单改由 `embed_windows_app_manifest` 统一链接进所有产物，两边并存会产生重复的
    // 清单资源。
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    let attributes = tauri_build::Attributes::new().windows_attributes(windows);
    if let Err(error) = tauri_build::try_build(attributes) {
        // 与 `tauri_build::build()` 的失败处理保持一致：完整错误链交给 Cargo 输出后以失败退出。
        println!("{error:#}");
        std::process::exit(1);
    }

    embed_windows_app_manifest();
}

/// 把 Common Controls v6 清单链接进本包的全部产物：应用本体、库内单元测试、集成测试等。
///
/// `tauri-build` 默认只把清单当作资源链接进 `bin`。但 `tauri-plugin-dialog` 自 2.8.4 起经
/// `rfd 0.17` 用 `TaskDialogIndirect` 弹出消息框，这个函数只存在于 comctl32 v6：没有清单的库测试
/// 程序在加载阶段就会以 `STATUS_ENTRYPOINT_NOT_FOUND`（`0xc0000139`）退出，`cargo test` 连一个
/// 用例都跑不起来；应用本体因为有清单而不受影响。`tauri-build` 目前没有暴露“链接进所有产物”的选项，
/// 所以这里直接使用 `embed-resource`（`tauri-winres` 的 `compile_for_everything` 所用的底层实现）。
///
/// 资源脚本不能叫 `resource.rc`：那是 `tauri-winres` 的固定文件名，同名会覆盖 tauri-build 生成的
/// 图标与版本资源及其 `.lib`。
fn embed_windows_app_manifest() {
    // 其他平台没有应用清单这一概念，也不需要资源编译器。
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let out_dir = env::var("OUT_DIR").expect("Cargo must provide OUT_DIR to build.rs");
    let out_dir = Path::new(&out_dir);

    // 清单与资源脚本放在同一目录，脚本里只按文件名引用，避免把源码路径里的反斜杠、空格或非 ASCII
    // 字符写进资源脚本（embed-resource 会把该目录作为资源编译器的包含路径）。
    // `1 24` 即进程清单资源 ID 1 与资源类型 `RT_MANIFEST`，与 tauri-build 原先嵌入的位置一致。
    fs::write(out_dir.join("app-manifest.xml"), WINDOWS_APP_MANIFEST)
        .expect("Failed to write the Windows application manifest");
    let resource_script = out_dir.join("app-manifest.rc");
    fs::write(&resource_script, "1 24 \"app-manifest.xml\"\n")
        .expect("Failed to write the Windows application manifest resource script");

    // `compile_for_everything` 输出的是不带目标限定的 `cargo:rustc-link-arg`，覆盖应用、`#[test]`
    // 与 doctest 等所有可链接产物。
    embed_resource::compile_for_everything(&resource_script, embed_resource::NONE)
        .manifest_required()
        .expect("Failed to compile the Windows application manifest resource");
}

/// 从 Cargo 最终解析的锁文件中读取 Lore Git 提交。
///
/// `Cargo.toml` 中的 `rev` 是依赖请求，而 `Cargo.lock` 中 `#` 后的哈希才是 Cargo
/// 实际选中的完整提交。以后升级 Lore 只需更新依赖和锁文件，不再同步修改 Rust
/// 诊断常量。
fn read_lore_source_revision(lock_path: &Path) -> Result<String, String> {
    let lock_content = fs::read_to_string(lock_path)
        .map_err(|error| format!("Failed to read {}: {error}", lock_path.display()))?;
    let lock_document = lock_content
        .parse::<DocumentMut>()
        .map_err(|error| format!("Failed to parse {}: {error}", lock_path.display()))?;
    let packages = lock_document
        .get("package")
        .and_then(|item| item.as_array_of_tables())
        .ok_or_else(|| format!("{} does not contain a package list", lock_path.display()))?;

    let lore_source = packages
        .iter()
        .filter(|package| package.get("name").and_then(|item| item.as_str()) == Some("lore"))
        .filter_map(|package| package.get("source").and_then(|item| item.as_str()))
        .find(|source| source.starts_with(LORE_GIT_SOURCE_PREFIX))
        .ok_or_else(|| {
            format!(
                "{} does not contain a lore package from {LORE_GIT_SOURCE_PREFIX}",
                lock_path.display()
            )
        })?;

    let revision = lore_source
        .rsplit_once('#')
        .map(|(_, revision)| revision)
        .ok_or_else(|| {
            format!("The locked Lore source is missing a revision hash: {lore_source}")
        })?;

    if revision.len() != 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "The locked Lore revision is not a 40-character hexadecimal hash: {revision}"
        ));
    }

    Ok(revision.to_ascii_lowercase())
}
