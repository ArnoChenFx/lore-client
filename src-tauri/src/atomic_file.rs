//! 应用自有小文件（偏好、作者缓存等 JSON）的原子替换写入。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 先把完整内容写入同目录临时文件并 fsync，再替换目标文件。
///
/// 进程崩溃或断电最多留下旧文件或完整的新文件，不会留下截断内容。替换失败时删除
/// 临时文件并保持原文件不变。目标是符号链接时替换链接指向的文件，保留链接本身；
/// 已存在文件的权限（例如 0600）会复制到新内容上。
pub(crate) fn write_file_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    write_resolved_file_atomically(&replacement_target(path), content)
}

/// 与 `write_file_atomically` 相同，但 `path` 必须已经是真正要替换的位置，不再解析符号链接。
/// 仓库内文件应先经过 `repository_contained_write_path` 校验，再交给本函数。
pub(crate) fn write_resolved_file_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "path has no parent directory")
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary_path = parent.join(format!(
        ".{file_name}.lore-client-{}-{unique}.tmp",
        std::process::id()
    ));

    {
        let mut temporary = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        #[cfg(unix)]
        if let Ok(metadata) = fs::metadata(path) {
            let _ = temporary.set_permissions(metadata.permissions());
        }
        if let Err(error) = temporary
            .write_all(content)
            .and_then(|_| temporary.sync_all())
        {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
    }

    #[cfg(not(windows))]
    let replaced = fs::rename(&temporary_path, path);

    #[cfg(windows)]
    let replaced = {
        // 与仓库配置写入保持一致：先把旧文件移到唯一备份名，替换失败时立即回滚。
        let backup_path = parent.join(format!(
            ".{file_name}.lore-client-{}-{unique}.backup",
            std::process::id()
        ));
        let had_original = path.exists();
        let backed_up = if had_original {
            fs::rename(path, &backup_path)
        } else {
            Ok(())
        };
        match backed_up.and_then(|_| fs::rename(&temporary_path, path)) {
            Ok(()) => {
                if had_original {
                    let _ = fs::remove_file(&backup_path);
                }
                Ok(())
            }
            Err(error) => {
                if had_original {
                    let _ = fs::rename(&backup_path, path);
                }
                Err(error)
            }
        }
    };

    replaced.inspect_err(|_| {
        let _ = fs::remove_file(&temporary_path);
    })
}

/// 返回真正需要被替换的路径。直接 rename 到符号链接上会把链接换成普通文件，而旧的
/// `fs::write` 会写穿到链接指向的文件，这里保持后者的行为。悬空链接指向的位置同样沿用
/// `fs::write` 会创建的文件。
fn replacement_target(path: &Path) -> PathBuf {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            if let Ok(resolved) = fs::canonicalize(path) {
                return resolved;
            }
            match fs::read_link(path) {
                Ok(link) if link.is_absolute() => link,
                Ok(link) => path.parent().unwrap_or(Path::new("")).join(link),
                Err(_) => path.to_path_buf(),
            }
        }
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_files_in(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .expect("test directory should be readable")
            .map(|entry| {
                entry
                    .expect("directory entry should be readable")
                    .file_name()
            })
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp") || name.contains(".backup"))
            .collect()
    }

    #[test]
    fn creates_a_new_file_without_leaving_temporary_files() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("preferences.json");

        write_file_atomically(&path, b"{\"version\":1}\n").expect("write should succeed");

        assert_eq!(fs::read(&path).unwrap(), b"{\"version\":1}\n");
        assert!(temporary_files_in(directory.path()).is_empty());
    }

    #[test]
    fn replaces_existing_contents_completely() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("preferences.json");
        fs::write(
            &path,
            "a much longer previous document that must not leak through",
        )
        .unwrap();

        write_file_atomically(&path, b"short").expect("write should succeed");

        assert_eq!(fs::read_to_string(&path).unwrap(), "short");
        assert!(temporary_files_in(directory.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn failed_replacement_keeps_the_destination_and_removes_the_temporary_file() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        // 目标是一个非空目录：临时文件无法替换它，应当报错并清理临时文件。
        let path = directory.path().join("preferences.json");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("occupant"), "keep").unwrap();

        assert!(write_file_atomically(&path, b"new").is_err());

        assert_eq!(fs::read(path.join("occupant")).unwrap(), b"keep");
        assert!(temporary_files_in(directory.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn writing_through_a_symlink_keeps_the_link_and_updates_its_target() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let target = directory.path().join("real.json");
        let link = directory.path().join("preferences.json");
        fs::write(&target, "old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_file_atomically(&link, b"new").expect("write should succeed");

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(temporary_files_in(directory.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn resolved_writes_replace_a_symlink_instead_of_writing_through_it() {
        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let target = directory.path().join("elsewhere.json");
        let link = directory.path().join("preferences.json");
        fs::write(&target, "untouched").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_resolved_file_atomically(&link, b"new").expect("write should succeed");

        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");
        assert!(!fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&link).unwrap(), "new");
        assert!(temporary_files_in(directory.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn replacement_keeps_the_permissions_of_the_existing_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory should exist");
        let path = directory.path().join("revision-author-cache.json");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        write_file_atomically(&path, b"new").expect("write should succeed");

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
