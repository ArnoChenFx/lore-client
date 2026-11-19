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

/// POSIX files whose names differ only by leading spaces must remain distinct through
/// the actual Lore commands, including destructive restoration of one selected file.
#[cfg(unix)]
#[test]
fn leading_space_file_names_survive_stage_preview_diff_and_reset() {
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
        ("  asset", "double leading space\n"),
        (" asset", "leading space\n"),
        ("   asset", "space only\n"),
    ];
    for (name, content) in files {
        std::fs::write(repository.join(name), content).unwrap();
    }

    for name in ["asset ", " ", "asset."] {
        std::fs::write(repository.join(name), "unsupported sibling\n").unwrap();
        let error = tauri::async_runtime::block_on(lore_stage(
            test_operation_context(),
            repository_text.clone(),
            vec![name.to_owned()],
        ))
        .unwrap_err();
        assert_eq!(error.code, "invalid_lore_node_name");
        assert_eq!(
            std::fs::read_to_string(repository.join(name)).unwrap(),
            "unsupported sibling\n"
        );
        std::fs::remove_file(repository.join(name)).unwrap();
    }

    // Only the requested double-leading-space file may enter the first immutable tree.
    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec!["  asset".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&staged, "Stage the exact double-leading-space path").unwrap();
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
        vec!["  asset"],
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
        "  asset".to_owned(),
        None,
    ))
    .unwrap();
    assert_eq!(text, "double leading space\n");
    let preview =
        build_file_preview(&repository_text, "  asset", Some(&revision), true, 1024).unwrap();
    assert_eq!(preview.path, "  asset");
    assert_eq!(preview.size, "double leading space\n".len() as u64);

    std::fs::write(repository.join("  asset"), "changed double-leading file\n").unwrap();
    std::fs::write(repository.join("asset"), "keep sibling change\n").unwrap();
    let diff = tauri::async_runtime::block_on(lore_workspace_diff(
        test_operation_context(),
        repository_text.clone(),
        vec!["  asset".to_owned()],
        Some(3),
        None,
        None,
    ))
    .unwrap();
    ensure_operation_success(&diff, "Diff the exact double-leading-space path").unwrap();
    let diff_paths = diff
        .events
        .iter()
        .filter(|event| event["tagName"] == "fileDiff")
        .map(|event| event["data"]["path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(diff_paths, vec!["  asset"]);
    let reset = tauri::async_runtime::block_on(lore_file_reset(
        test_operation_context(),
        repository_text.clone(),
        vec!["  asset".to_owned()],
        revision,
    ))
    .unwrap();
    ensure_operation_success(&reset, "Reset the exact double-leading-space path").unwrap();
    assert_eq!(
        std::fs::read_to_string(repository.join("  asset")).unwrap(),
        "double leading space\n"
    );
    assert_eq!(
        std::fs::read_to_string(repository.join("asset")).unwrap(),
        "keep sibling change\n"
    );

    // A three-leading-space name must stay a file selection, never become repository root.
    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec!["   asset".to_owned(), " asset".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&staged, "Stage the three-leading-space file").unwrap();
    let unstaged = tauri::async_runtime::block_on(lore_unstage(
        test_operation_context(),
        repository_text.clone(),
        vec!["   asset".to_owned()],
    ))
    .unwrap();
    ensure_operation_success(&unstaged, "Unstage the three-leading-space file").unwrap();
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
        "unstaging the three-leading-space file must preserve other staged files"
    );
    let staged = tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec!["   asset".to_owned()],
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
    assert!(paths.contains(&"  asset"));
    assert!(paths.contains(&" asset"));
    assert!(paths.contains(&"   asset"));
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
    assert_eq!(lock_paths, vec!["   asset", "  asset", " asset", "asset"]);
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

/// Restores `LORE_GLOBAL_PATH` even when an assertion fails.
struct GlobalPathGuard(Option<std::ffi::OsString>);

impl GlobalPathGuard {
    fn set(path: &Path) -> Self {
        let previous = std::env::var_os("LORE_GLOBAL_PATH");
        std::env::set_var("LORE_GLOBAL_PATH", path);
        Self(previous)
    }
}

impl Drop for GlobalPathGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("LORE_GLOBAL_PATH", previous),
            None => std::env::remove_var("LORE_GLOBAL_PATH"),
        }
    }
}

/// The lowercase hex form of an `InstanceId` event value, which Lore serializes as
/// `{ "data": [16 bytes] }` rather than as a string.
fn instance_id_hex(value: &Value) -> String {
    value["data"]
        .as_array()
        .expect("an instance id serializes as an object with a data array")
        .iter()
        .map(|byte| format!("{:02x}", byte.as_u64().expect("every id byte is a number")))
        .collect()
}

fn event<'a>(result: &'a LoreOperationResult, tag: &str) -> Option<&'a Value> {
    result
        .events
        .iter()
        .find(|event| event["tagName"] == tag)
        .map(|event| &event["data"])
}

/// Drives the real Lore instance clone on a shared-store repository and checks the event contract
/// the frontend parses: tag names, the `{ data: [..] }` instance id shape, and the status codes of
/// a refused and an allowed clone.
///
/// Ignored by default: it points the process-wide `LORE_GLOBAL_PATH` at a temporary directory so
/// Lore's global configuration and Shared Store registry never touch the developer's machine, and
/// another test running in parallel must not observe that. Run it alone after a Lore upgrade:
/// `cargo test instance_clone_matches_the_real_lore -- --ignored --test-threads=1`.
#[test]
#[ignore]
fn instance_clone_matches_the_real_lore_event_contract() {
    let root = tempfile::tempdir().unwrap();
    let global = root.path().join("global");
    std::fs::create_dir_all(&global).unwrap();
    let _global_path = GlobalPathGuard::set(&global);

    let repository = root.path().join("repository");
    let store = root.path().join("store");
    let parent = root.path().join("copies");
    for directory in [&repository, &store, &parent] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let repository_text = repository.to_string_lossy().into_owned();
    let parent_text = parent.to_string_lossy().into_owned();

    tauri::async_runtime::block_on(super::repository::lore_repository_initialize(
        test_operation_context(),
        repository_text.clone(),
        "instance-clone".to_owned(),
        "Instance clone".to_owned(),
        "tester".to_owned(),
        Some("tester".to_owned()),
        true,
        Some(store.to_string_lossy().into_owned()),
    ))
    .expect("the repository should initialize on a shared store");
    std::fs::write(
        repository.join("doc.txt"),
        "one
",
    )
    .unwrap();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        repository_text.clone(),
        vec!["doc.txt".to_owned()],
    ))
    .expect("stage should succeed");
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        repository_text.clone(),
        "Write one".to_owned(),
        Some("tester".to_owned()),
    ))
    .expect("commit should succeed");

    let clone = |allow_copy: bool, dry_run: bool| {
        tauri::async_runtime::block_on(super::maintenance::lore_repository_instance_clone(
            test_operation_context(),
            repository_text.clone(),
            parent_text.clone(),
            "copy".to_owned(),
            allow_copy,
            dry_run,
        ))
    };

    // A dry run always reports how the clone would be made. Where the volume cannot share blocks
    // a clone that does not allow copying is refused with NotSupported (9), after that report.
    let refused_or_ready = clone(false, true).expect("a dry run is not refused at the boundary");
    let plan = event(&refused_or_ready.result, "repositoryInstanceCloneBegin")
        .expect("a dry run always sends the clone plan");
    let method = plan["method"].as_str().expect("the method is a string");
    assert!(
        ["sharesBlocks", "copiesBytes"].contains(&method),
        "unexpected clone method {method}"
    );
    assert_eq!(
        refused_or_ready.result.status,
        if method == "copiesBytes" { 9 } else { 0 },
        "refusing a copy without permission is NotSupported (9)"
    );
    let source_id = instance_id_hex(&plan["instanceId"]);
    assert_eq!(source_id.len(), 32);

    // A dry run that is allowed to copy succeeds and names no new instance.
    let preview = clone(true, true).expect("the allowed dry run");
    assert_eq!(preview.result.status, 0);
    let preview_complete = event(&preview.result, "repositoryInstanceCloneComplete")
        .expect("a dry run ends with a complete event");
    assert_eq!(
        instance_id_hex(&preview_complete["instanceId"]),
        "0".repeat(32),
        "a dry run reports the zero instance id"
    );
    assert!(!parent.join("copy").exists(), "a dry run writes nothing");

    // The real clone creates the instance.
    let cloned = clone(true, false).expect("the real clone");
    assert_eq!(cloned.result.status, 0);
    let complete = event(&cloned.result, "repositoryInstanceCloneComplete")
        .expect("a clone ends with a complete event");
    let new_id = instance_id_hex(&complete["instanceId"]);
    assert_ne!(new_id, "0".repeat(32));
    assert_ne!(new_id, source_id);
    assert!(parent.join("copy").join("doc.txt").is_file());
    assert!(parent.join("copy").join(".lore").is_dir());

    // The instance list now holds both the source and the clone.
    let list = tauri::async_runtime::block_on(super::maintenance::lore_repository_instance_list(
        test_operation_context(),
        repository_text.clone(),
    ))
    .expect("the instance list");
    let listed: Vec<String> = list
        .events
        .iter()
        .filter(|event| event["tagName"] == "repositoryInstance")
        .map(|event| instance_id_hex(&event["data"]["instanceId"]))
        .collect();
    assert!(
        listed.contains(&source_id) && listed.contains(&new_id),
        "{listed:?}"
    );

    // The destination exists now, so the Rust boundary refuses another clone to it.
    let error = clone(true, true).expect_err("an existing destination is refused");
    assert_eq!(error.code, "instance_clone_destination_exists");
}
