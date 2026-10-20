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
    workspace::{lore_open_external_merge, lore_stage, lore_write_patch_file},
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
