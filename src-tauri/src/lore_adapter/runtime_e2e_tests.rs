//! Runtime checks that need no Lore server.
//!
//! These drive the same Tauri command functions the IPC layer calls, against real
//! repositories, real child processes and real symlinks. They cover the external merge
//! copy-back path (the copy runs on a background thread after the tool exits) and the
//! patch export destination rules.

use super::*;
use super::{
    operations::lore_commit,
    repository_lifecycle::initialize_repository,
    workspace::{
        lore_file_reset, lore_open_external_merge, lore_read_revision_text,
        lore_read_workspace_text, lore_stage, lore_unstage, lore_workspace_diff,
        lore_write_patch_file,
    },
};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn labels() -> ExternalMergeLabels {
    ExternalMergeLabels {
        base: "base".to_owned(),
        local: "local".to_owned(),
        remote: "remote".to_owned(),
        merged: "merged".to_owned(),
    }
}

/// Creates a local repository whose `doc.txt` changed from "one" (first revision) to "two"
/// (second revision). Returns the repository path and both revisions.
fn local_repository_with_two_revisions(root: &Path) -> (String, String, String) {
    let repository = root.join("repository");
    std::fs::create_dir_all(&repository).unwrap();
    let repository_text = repository.to_string_lossy().into_owned();
    initialize_repository(
        &repository_text,
        "runtime-e2e",
        "Runtime E2E",
        "tester",
        Some("tester"),
        false,
        None,
    )
    .expect("the local repository should initialize");

    let mut revisions = Vec::new();
    for content in ["one\n", "two\n"] {
        std::fs::write(repository.join("doc.txt"), content).unwrap();
        tauri::async_runtime::block_on(lore_stage(
            test_operation_context(),
            repository_text.clone(),
            vec!["doc.txt".to_owned()],
        ))
        .expect("stage should succeed");
        let commit = tauri::async_runtime::block_on(lore_commit(
            test_operation_context(),
            repository_text.clone(),
            format!("Write {}", content.trim()),
            Some("tester".to_owned()),
        ))
        .expect("commit should succeed");
        revisions.push(committed_revision_of(&commit));
    }
    (repository_text, revisions.remove(0), revisions.remove(0))
}

fn committed_revision_of(result: &LoreOperationResult) -> String {
    result
        .events
        .iter()
        .find(|event| event["tagName"] == "revisionCommitRevision")
        .and_then(|event| event["data"]["revision"].as_str())
        .expect("the commit event should provide the created revision")
        .to_owned()
}

/// Writes a POSIX shell tool. `body` runs after the tool receives `{base} {local} {remote} {merged}`
/// as `$1..$4`, so `$4` is the temporary MERGED file the copy-back reads.
#[cfg(unix)]
fn write_fake_merge_tool(directory: &Path, body: &str) -> ExternalDiffTool {
    use std::os::unix::fs::PermissionsExt;

    let script = directory.join("fake-merge.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    ExternalDiffTool {
        id: "fake-merge".to_owned(),
        name: "fake-merge".to_owned(),
        executable: script.to_string_lossy().into_owned(),
        arguments: ["{base}", "{local}", "{remote}", "{merged}"]
            .map(str::to_owned)
            .to_vec(),
    }
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// The copy-back runs after the tool exits, so a negative assertion needs a grace period
/// after the tool's completion marker appears.
fn wait_for_tool_completion(marker: &Path) {
    assert!(
        wait_until(Duration::from_secs(20), || marker.exists()),
        "the fake merge tool should finish"
    );
    std::thread::sleep(Duration::from_millis(800));
}

#[cfg(unix)]
#[test]
fn external_merge_copies_the_tool_result_into_a_missing_workspace_file() {
    let _operation_scope = test_operation_scope();
    let sandbox = tempfile::tempdir().unwrap();
    let (repository, current, incoming) = local_repository_with_two_revisions(sandbox.path());
    let target = PathBuf::from(&repository).join("doc.txt");
    std::fs::remove_file(&target).unwrap();

    let tool = write_fake_merge_tool(
        sandbox.path(),
        "printf 'merged by tool\\n' > \"$4\"\nexit 0",
    );
    let launched = tauri::async_runtime::block_on(lore_open_external_merge(
        test_operation_context(),
        repository.clone(),
        tool,
        "doc.txt".to_owned(),
        current,
        incoming,
        labels(),
    ))
    .expect("the external merge should launch");
    assert_eq!(
        launched.temporary_file_count, 4,
        "a copy-back target adds one temporary file"
    );

    assert!(
        wait_until(Duration::from_secs(20), || {
            std::fs::read_to_string(&target).is_ok_and(|content| content == "merged by tool\n")
        }),
        "the merged result should be copied into the workspace"
    );
}

#[cfg(unix)]
#[test]
fn external_merge_never_overwrites_a_file_created_while_the_tool_ran() {
    let _operation_scope = test_operation_scope();
    let sandbox = tempfile::tempdir().unwrap();
    let (repository, current, incoming) = local_repository_with_two_revisions(sandbox.path());
    let target = PathBuf::from(&repository).join("doc.txt");
    std::fs::remove_file(&target).unwrap();
    let marker = sandbox.path().join("tool-finished");

    let body = format!(
        "printf 'merged by tool\\n' > \"$4\"\nprintf 'written during merge\\n' > '{}'\ntouch '{}'\nexit 0",
        target.display(),
        marker.display()
    );
    let tool = write_fake_merge_tool(sandbox.path(), &body);
    tauri::async_runtime::block_on(lore_open_external_merge(
        test_operation_context(),
        repository,
        tool,
        "doc.txt".to_owned(),
        current,
        incoming,
        labels(),
    ))
    .expect("the external merge should launch");
    wait_for_tool_completion(&marker);

    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "written during merge\n",
        "the copy-back must not replace content another process created"
    );
}

#[cfg(unix)]
#[test]
fn external_merge_copy_back_does_not_follow_a_link_created_during_the_merge() {
    let _operation_scope = test_operation_scope();
    let sandbox = tempfile::tempdir().unwrap();
    let (repository, current, incoming) = local_repository_with_two_revisions(sandbox.path());
    let target = PathBuf::from(&repository).join("doc.txt");
    std::fs::remove_file(&target).unwrap();
    let outside = sandbox.path().join("outside-victim.txt");
    std::fs::write(&outside, "outside original\n").unwrap();
    let dangling = sandbox.path().join("never-created.txt");
    let marker = sandbox.path().join("tool-finished");

    let body = format!(
        "printf 'merged by tool\\n' > \"$4\"\nln -s '{}' '{}'\ntouch '{}'\nexit 0",
        outside.display(),
        target.display(),
        marker.display()
    );
    let tool = write_fake_merge_tool(sandbox.path(), &body);
    tauri::async_runtime::block_on(lore_open_external_merge(
        test_operation_context(),
        repository.clone(),
        tool,
        "doc.txt".to_owned(),
        current.clone(),
        incoming.clone(),
        labels(),
    ))
    .expect("the external merge should launch");
    wait_for_tool_completion(&marker);

    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "outside original\n"
    );
    assert!(std::fs::symlink_metadata(&target)
        .unwrap()
        .file_type()
        .is_symlink());

    std::fs::remove_file(&target).unwrap();
    std::fs::remove_file(&marker).unwrap();
    let body = format!(
        "printf 'merged by tool\\n' > \"$4\"\nln -s '{}' '{}'\ntouch '{}'\nexit 0",
        dangling.display(),
        target.display(),
        marker.display()
    );
    let tool = write_fake_merge_tool(sandbox.path(), &body);
    tauri::async_runtime::block_on(lore_open_external_merge(
        test_operation_context(),
        repository,
        tool,
        "doc.txt".to_owned(),
        current,
        incoming,
        labels(),
    ))
    .expect("the external merge should launch");
    wait_for_tool_completion(&marker);

    assert!(
        !dangling.exists(),
        "a dangling link created during the merge must not be materialized outside the repository"
    );
}

#[cfg(unix)]
#[test]
fn external_merge_result_is_discarded_when_the_tool_fails() {
    let _operation_scope = test_operation_scope();
    let sandbox = tempfile::tempdir().unwrap();
    let (repository, current, incoming) = local_repository_with_two_revisions(sandbox.path());
    let target = PathBuf::from(&repository).join("doc.txt");
    std::fs::remove_file(&target).unwrap();
    let marker = sandbox.path().join("tool-finished");

    let body = format!(
        "printf 'partial\\n' > \"$4\"\ntouch '{}'\nexit 3",
        marker.display()
    );
    let tool = write_fake_merge_tool(sandbox.path(), &body);
    tauri::async_runtime::block_on(lore_open_external_merge(
        test_operation_context(),
        repository,
        tool,
        "doc.txt".to_owned(),
        current,
        incoming,
        labels(),
    ))
    .expect("the external merge should launch");
    wait_for_tool_completion(&marker);

    assert!(
        !target.exists(),
        "a tool that exits unsuccessfully must not have its partial output copied back"
    );
}

#[cfg(unix)]
#[test]
fn patch_export_without_confirmation_refuses_a_symlink_destination() {
    let sandbox = tempfile::tempdir().unwrap();
    let victim = sandbox.path().join("victim.txt");
    std::fs::write(&victim, "keep me\n").unwrap();
    let destination = sandbox.path().join("review.patch");
    std::os::unix::fs::symlink(&victim, &destination).unwrap();

    let result = tauri::async_runtime::block_on(lore_write_patch_file(
        test_operation_context(),
        destination.to_string_lossy().into_owned(),
        "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n".to_owned(),
        false,
    ));

    assert_eq!(result.unwrap_err().code, "patch_destination_exists");
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me\n");
}

/// POSIX files whose names differ only by edge spaces must remain distinct through
/// the actual Lore commands, including destructive restoration of one selected file.
#[cfg(unix)]
#[test]
fn whitespace_file_names_survive_stage_preview_diff_and_reset() {
    let _operation_scope = test_operation_scope();
    let sandbox = tempfile::tempdir().unwrap();
    let repository = sandbox.path().join("repository");
    std::fs::create_dir(&repository).unwrap();
    let repository_text = repository.to_string_lossy().into_owned();
    initialize_repository(
        &repository_text,
        "whitespace-paths",
        "Whitespace file paths",
        "tester",
        Some("tester"),
        false,
        None,
    )
    .unwrap();
    let files = [
        ("asset", "plain\n"),
        ("asset ", "trailing space\n"),
        (" asset", "leading space\n"),
        (" ", "space only\n"),
    ];
    for (name, content) in files {
        std::fs::write(repository.join(name), content).unwrap();
    }

    // Only the requested trailing-space file may enter the first immutable tree.
    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec!["asset ".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&staged, "Stage the exact trailing-space path").unwrap();
    let commit = tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        repository_text.clone(),
        "Commit the selected path".to_owned(),
        Some("tester".to_owned()),
    ))
    .unwrap();
    let revision = committed_revision_of(&commit);
    let tree = collect_revision_tree_files(&repository_text, &revision).unwrap();
    assert_eq!(
        tree.iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["asset "],
        "staging one file must not select its trimmed sibling"
    );

    for (name, content) in files {
        let text = tauri::async_runtime::block_on(lore_read_workspace_text(
            test_operation_context(),
            repository_text.clone(),
            name.to_owned(),
            None,
        ))
        .unwrap();
        assert_eq!(text, content, "workspace read must retain {name:?}");
        let preview = build_file_preview(&repository_text, name, None, true, 1024).unwrap();
        assert_eq!(preview.path, name);
        assert_eq!(preview.size, content.len() as u64);
    }
    let text = tauri::async_runtime::block_on(lore_read_revision_text(
        test_operation_context(),
        repository_text.clone(),
        revision.clone(),
        "asset ".to_owned(),
        None,
    ))
    .unwrap();
    assert_eq!(text, "trailing space\n");
    let preview =
        build_file_preview(&repository_text, "asset ", Some(&revision), true, 1024).unwrap();
    assert_eq!(preview.path, "asset ");
    assert_eq!(preview.size, "trailing space\n".len() as u64);

    std::fs::write(repository.join("asset "), "changed trailing file\n").unwrap();
    std::fs::write(repository.join("asset"), "keep sibling change\n").unwrap();
    let diff = tauri::async_runtime::block_on(lore_workspace_diff(
        test_operation_context(),
        repository_text.clone(),
        vec!["asset ".to_owned()],
        Some(3),
        None,
        None,
    ))
    .unwrap();
    ensure_operation_success(&diff, "Diff the exact trailing-space path").unwrap();
    let diff_paths = diff
        .events
        .iter()
        .filter(|event| event["tagName"] == "fileDiff")
        .map(|event| event["data"]["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(diff_paths, vec!["asset "]);
    let reset = tauri::async_runtime::block_on(lore_file_reset(
        test_operation_context(),
        repository_text.clone(),
        vec!["asset ".to_owned()],
        revision,
    ))
    .unwrap();
    ensure_operation_success(&reset, "Reset the exact trailing-space path").unwrap();
    assert_eq!(
        std::fs::read_to_string(repository.join("asset ")).unwrap(),
        "trailing space\n"
    );
    assert_eq!(
        std::fs::read_to_string(repository.join("asset")).unwrap(),
        "keep sibling change\n"
    );

    // A whitespace-only name must stay a file selection, never become repository root.
    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec![" ".to_owned(), " asset".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&staged, "Stage the whitespace-only file").unwrap();
    let unstaged = tauri::async_runtime::block_on(lore_unstage(
        test_operation_context(),
        repository_text.clone(),
        vec![" ".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&unstaged, "Unstage the whitespace-only file").unwrap();
    let status = tauri::async_runtime::block_on(lore_repository_status(
        test_operation_context(),
        repository_text.clone(),
    ))
    .unwrap();
    ensure_operation_success(&status, "Read the remaining staged file").unwrap();
    let staged_paths = status
        .events
        .iter()
        .filter(|event| {
            event["tagName"] == "repositoryStatusFile" && event["data"]["flagStaged"] == true
        })
        .map(|event| event["data"]["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        staged_paths,
        vec![" asset"],
        "unstaging the whitespace-only file must preserve other staged files"
    );
    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec![" ".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&staged, "Stage both exact whitespace paths").unwrap();
    let commit = tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        repository_text.clone(),
        "Commit whitespace paths".to_owned(),
        Some("tester".to_owned()),
    ))
    .unwrap();
    let tree =
        collect_revision_tree_files(&repository_text, &committed_revision_of(&commit)).unwrap();
    let paths = tree
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(paths.len(), 3);
    assert!(paths.contains(&"asset "));
    assert!(paths.contains(&" asset"));
    assert!(paths.contains(&" "));
    assert!(!paths.contains(&"asset"));

    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec!["asset".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&staged, "Prepare all exact lock resources").unwrap();
    let mut globals = global_args(&repository_text).unwrap();
    globals.dry_run = 1;
    let lock_paths = validate_repository_relative_paths(
        files.iter().map(|(name, _)| (*name).to_owned()).collect(),
    )
    .unwrap();
    // Lore resolves these against the real staged tree before its dry-run boundary.
    // No remote lock is acquired, and this is not a live-server lock test.
    let locks = run_operation("lock.file-acquire.path-regression", move |callback| {
        lore::runtime().block_on(lore::lock::file_acquire(
            globals,
            LoreLockFileAcquireArgs {
                paths: to_lore_array(lock_paths),
                branch: LoreString::default(),
            },
            callback,
        ))
    })
    .unwrap();
    ensure_operation_success(&locks, "Resolve distinct dry-run lock resources").unwrap();
    let lock_paths = locks
        .events
        .iter()
        .filter(|event| event["tagName"] == "lockFileAcquire")
        .map(|event| event["data"]["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lock_paths, vec![" ", " asset", "asset", "asset "]);
}

#[cfg(unix)]
#[test]
fn whitespace_file_names_select_the_exact_optional_file_and_executable() {
    let sandbox = tempfile::tempdir().unwrap();
    for name in ["tool", "tool ", " tool", " "] {
        let path = sandbox.path().join(name);
        std::fs::write(&path, name).unwrap();
        assert_eq!(
            validate_optional_file(Some(path.to_string_lossy().into_owned()), "View file").unwrap(),
            Some(
                std::fs::canonicalize(&path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            ),
            "a selected existing file must not resolve to its trimmed sibling"
        );
        assert_eq!(
            resolve_external_executable_with(path.to_str().unwrap(), None, &[String::new()],),
            Some(path),
            "an executable path must retain its exact file name"
        );
    }
    let path_value = std::env::join_paths([sandbox.path()]).unwrap();
    assert_eq!(
        resolve_external_executable_with("tool ", Some(&path_value), &[String::new()]),
        Some(sandbox.path().join("tool "))
    );
}
