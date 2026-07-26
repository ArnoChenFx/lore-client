use std::{env, fs, path::Path};

use toml_edit::DocumentMut;

/// Cargo 锁文件中 Lore 依赖必须使用的上游 Git 来源。
///
/// 构建脚本同时校验来源与提交格式，避免同名注册表包或本地补丁被误识别为
/// 产品声明的固定 Lore 上游版本。
const LORE_GIT_SOURCE_PREFIX: &str = "git+https://github.com/EpicGames/lore.git";

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

    // 由 tauri-build 根据 tauri.conf.json 生成平台资源与运行时上下文。
    tauri_build::build()
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
