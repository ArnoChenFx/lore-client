//! Live checks against a running Lore server and lore-auth-service.
//!
//! Every test here is `#[ignore]`d because it needs the local stack described in
//! `docs/en/E2E_LOCAL_STACK.md`. Run them serially, since login state and the Lore
//! runtime are process-wide:
//!
//! ```text
//! LORE_E2E_SERVER=lore://127.0.0.1:41337 LORE_E2E_WORK_DIR=/tmp/lore-e2e-work \
//!   cargo test --manifest-path src-tauri/Cargo.toml --lib live_ -- --ignored --test-threads=1
//! ```

use super::auth::{
    lore_auth_list, lore_auth_login_interactive, lore_auth_login_with_token,
    lore_auth_repository_binding_set,
};
use super::operations::{
    lore_commit, lore_conflict_action, lore_conflict_session, lore_push, lore_sync,
    lore_write_conflict_resolution,
};
use super::repository::{
    lore_repository_clone, lore_repository_config_get, lore_repository_config_update,
    lore_repository_list, lore_repository_publish, lore_repository_status,
};
use super::repository_lifecycle::initialize_repository;
use super::workspace::{lore_ignore_paths, lore_open_external_merge, lore_stage};
use super::*;
use std::path::{Path, PathBuf};
use std::time::Instant;

struct LiveStack {
    server_url: String,
    work_root: PathBuf,
    run_id: String,
}

impl LiveStack {
    fn from_env() -> Self {
        let server_url = std::env::var("LORE_E2E_SERVER").expect(
            "LORE_E2E_SERVER must name the Lore server, for example lore://127.0.0.1:41337",
        );
        let work_root = PathBuf::from(
            std::env::var("LORE_E2E_WORK_DIR")
                .expect("LORE_E2E_WORK_DIR must point at a scratch directory"),
        );
        let run_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time should be later than the Unix epoch")
            .as_millis()
            .to_string();
        let global = work_root.join("lore-global");
        std::fs::create_dir_all(&global).expect("the isolated Lore global directory should exist");
        std::env::set_var("LORE_GLOBAL_PATH", &global);
        let shim_dir = std::env::var("LORE_E2E_SHIM_DIR").unwrap_or_else(|_| {
            format!("{}/lore-e2e/bin", std::env::var("HOME").unwrap_or_default())
        });
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{shim_dir}:{path}"));
        Self {
            server_url,
            work_root,
            run_id,
        }
    }

    fn directory(&self, name: &str) -> PathBuf {
        let path = self.work_root.join(format!("{name}-{}", self.run_id));
        std::fs::create_dir_all(&path).expect("the scratch directory should be created");
        path
    }

    fn sign_in(&self, user: &str) -> String {
        std::env::set_var("LORE_E2E_LOGIN_USER", user);
        let login = tauri::async_runtime::block_on(lore_auth_login_interactive(
            test_operation_context(),
            self.server_url.clone(),
        ))
        .expect("interactive login should return a result");
        assert_eq!(
            login.status, 0,
            "{user} should sign in through the auth service"
        );
        token_store_user_id(
            &tauri::async_runtime::block_on(lore_auth_list(test_operation_context()))
                .expect("auth list should succeed"),
        )
    }

    fn publish(&self, repository: &Path, name: &str, user_id: &str) -> LoreRepositoryPublishResult {
        tauri::async_runtime::block_on(lore_repository_publish(
            test_operation_context(),
            text(repository),
            name.to_owned(),
            "Live E2E".to_owned(),
            "alice".to_owned(),
            Some("alice".to_owned()),
            self.server_url.clone(),
            "main".to_owned(),
            Some(user_id.to_owned()),
        ))
        .expect("publish should return a result")
    }

    fn clone_into(&self, name: &str, directory: &str, user_id: &str) -> LoreCloneResult {
        let parent = self.work_root.join(format!("clones-{}", self.run_id));
        std::fs::create_dir_all(&parent).expect("the clone parent should exist");
        tauri::async_runtime::block_on(lore_repository_clone(
            test_operation_context(),
            self.server_url.clone(),
            name.to_owned(),
            text(&parent),
            directory.to_owned(),
            None,
            None,
            false,
            false,
            None,
            None,
            false,
            None,
            Vec::new(),
            Vec::new(),
            false,
            0,
            Some(user_id.to_owned()),
        ))
        .expect("clone should return a result")
    }
}

/// Restores an environment variable when dropped so one test cannot leak state into the next.
struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
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

fn token_store_user_id(accounts: &LoreOperationResult) -> String {
    accounts
        .events
        .iter()
        .find(|event| event["tagName"] == "authIdentity")
        .and_then(|event| event["data"]["userId"].as_str())
        .expect("auth list should report the signed-in Token Store user id")
        .to_owned()
}

fn evidence(label: &str, value: impl std::fmt::Debug) {
    eprintln!("[live-e2e] {label}: {value:?}");
}

fn random_bytes(seed: u64, length: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

/// Progress snapshots for one operation family. The stream names operations with a
/// suffix (for example `branch.push.publish`), so the match is by prefix.
fn progress_for(events: &[Value], operation_prefix: &str) -> Vec<Value> {
    events
        .iter()
        .filter(|event| {
            event["operation"]
                .as_str()
                .is_some_and(|operation| operation.starts_with(operation_prefix))
        })
        .filter_map(|event| event["event"].clone().into_progress())
        .collect()
}

trait IntoProgress {
    fn into_progress(self) -> Option<Value>;
}

impl IntoProgress for Value {
    fn into_progress(self) -> Option<Value> {
        self["tagName"]
            .as_str()
            .is_some_and(|tag| tag.ends_with("Progress"))
            .then_some(self)
    }
}

fn phases_for(events: &[Value], operation_prefix: &str) -> Vec<String> {
    events
        .iter()
        .filter(|event| {
            event["operation"]
                .as_str()
                .is_some_and(|operation| operation.starts_with(operation_prefix))
        })
        .filter_map(|event| event["phase"].as_str().map(str::to_owned))
        .collect()
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_login_publish_clone_push_and_sync_round_trip() {
    let _operation_scope = test_operation_scope();
    let stack = LiveStack::from_env();
    let user_id = stack.sign_in("alice");

    let repository_a = stack.directory("live-a");
    initialize_repository(
        &text(&repository_a),
        "live-roundtrip",
        "Live round-trip",
        "alice",
        Some("alice"),
        false,
        None,
    )
    .expect("the local repository should initialize");
    std::fs::write(repository_a.join("notes.txt"), "first line\n").unwrap();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository_a),
        vec!["notes.txt".to_owned()],
    ))
    .expect("stage should succeed");
    let commit = tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository_a),
        "Initial notes".to_owned(),
        Some("alice".to_owned()),
    ))
    .expect("commit should succeed");
    evidence("first revision", committed_revision_of(&commit));

    let repository_name = format!("live-roundtrip-{}", stack.run_id);
    let published = stack.publish(&repository_a, &repository_name, &user_id);
    evidence(
        "publish remote",
        (
            &published.repository_url,
            published.remote_created,
            published.pushed,
        ),
    );
    assert_eq!(published.failure_code, None, "publish should not fail");
    assert!(published.pushed, "publish should push the first revision");

    tauri::async_runtime::block_on(lore_auth_repository_binding_set(
        test_operation_context(),
        text(&repository_a),
        Some(user_id.clone()),
        None,
    ))
    .expect("binding should be set");

    let cloned = stack.clone_into(&repository_name, "b", &user_id);
    evidence("clone status", cloned.result.status);
    assert_eq!(
        cloned.result.status, 0,
        "clone should succeed against the live server"
    );
    let repository_b = PathBuf::from(&cloned.destination_path);
    assert_eq!(
        std::fs::read_to_string(repository_b.join("notes.txt")).unwrap(),
        "first line\n"
    );

    std::fs::write(repository_a.join("notes.txt"), "first line\nsecond line\n").unwrap();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository_a),
        vec!["notes.txt".to_owned()],
    ))
    .expect("second stage should succeed");
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository_a),
        "Add second line".to_owned(),
        Some("alice".to_owned()),
    ))
    .expect("second commit should succeed");
    let pushed = tauri::async_runtime::block_on(lore_push(
        test_operation_context(),
        text(&repository_a),
        None,
    ))
    .expect("push should return a result");
    evidence("push status", pushed.status);
    assert_eq!(
        pushed.status, 0,
        "push should succeed against the live server"
    );

    let synced = tauri::async_runtime::block_on(lore_sync(
        test_operation_context(),
        text(&repository_b),
        Vec::new(),
        Vec::new(),
        false,
        0,
    ))
    .expect("sync should return a result");
    evidence("sync status", synced.status);
    assert_eq!(
        synced.status, 0,
        "sync should succeed against the live server"
    );
    assert_eq!(
        std::fs::read_to_string(repository_b.join("notes.txt")).unwrap(),
        "first line\nsecond line\n"
    );
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_clone_and_publish_report_progress_that_matches_the_transferred_bytes() {
    let _operation_scope = test_operation_scope();
    let stack = LiveStack::from_env();
    let user_id = stack.sign_in("alice");

    let repository = stack.directory("bulk-a");
    initialize_repository(
        &text(&repository),
        "bulk",
        "Bulk payload",
        "alice",
        Some("alice"),
        false,
        None,
    )
    .expect("the local repository should initialize");
    const FILE_COUNT: u64 = 6;
    const FILE_BYTES: usize = 8 * 1024 * 1024;
    let mut names = Vec::new();
    for index in 0..FILE_COUNT {
        let name = format!("bulk-{index}.bin");
        std::fs::write(repository.join(&name), random_bytes(index + 1, FILE_BYTES)).unwrap();
        names.push(name);
    }
    let expected_bytes = FILE_COUNT * FILE_BYTES as u64;
    take_captured_operation_stream();

    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository),
        names.clone(),
    ))
    .expect("stage should succeed");
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository),
        "Bulk payload".to_owned(),
        Some("alice".to_owned()),
    ))
    .expect("commit should succeed");
    take_captured_operation_stream();

    let repository_name = format!("bulk-{}", stack.run_id);
    let published = stack.publish(&repository, &repository_name, &user_id);
    assert!(published.pushed, "publish should push the bulk payload");
    let pushed = take_captured_operation_stream();
    let push_progress = progress_for(&pushed, "branch.push");
    evidence("publish phases", phases_for(&pushed, "branch.push"));
    evidence("publish progress (last)", push_progress.last());
    assert!(
        !push_progress.is_empty(),
        "a 48 MiB publish should stream progress past the open delay"
    );

    tauri::async_runtime::block_on(lore_auth_repository_binding_set(
        test_operation_context(),
        text(&repository),
        Some(user_id.clone()),
        None,
    ))
    .unwrap();
    let cloned = stack.clone_into(&repository_name, "clone", &user_id);
    assert_eq!(cloned.result.status, 0, "clone should succeed");
    let clone_events = take_captured_operation_stream();
    let clone_progress = progress_for(&clone_events, "repository.clone");
    evidence(
        "clone phases",
        phases_for(&clone_events, "repository.clone"),
    );
    evidence("clone progress (last)", clone_progress.last());

    let cloned_bytes: u64 = names
        .iter()
        .map(|name| {
            std::fs::metadata(PathBuf::from(&cloned.destination_path).join(name))
                .unwrap()
                .len()
        })
        .sum();
    evidence(
        "ground truth bytes (staged, cloned)",
        (expected_bytes, cloned_bytes),
    );
    assert_eq!(
        cloned_bytes, expected_bytes,
        "the clone should contain every staged byte"
    );
    let last = clone_progress
        .last()
        .expect("clone should stream progress for a 48 MiB payload");
    assert_eq!(
        last["data"]["totalFinal"], true,
        "clone totals should be final at the end"
    );
    assert_eq!(
        last["data"]["current"], last["data"]["total"],
        "clone should end at 100%"
    );
    assert_eq!(
        last["data"]["total"], expected_bytes,
        "the reported total should equal the payload"
    );
    assert_eq!(
        last["data"]["files"], FILE_COUNT,
        "the reported file count should match"
    );
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_stage_and_commit_progress_counts_every_file() {
    let _operation_scope = test_operation_scope();
    let stack = LiveStack::from_env();
    stack.sign_in("alice");

    let repository = stack.directory("many-files");
    initialize_repository(
        &text(&repository),
        "many",
        "Many files",
        "alice",
        Some("alice"),
        false,
        None,
    )
    .expect("the local repository should initialize");
    const FILE_COUNT: usize = 20_000;
    let mut names = Vec::with_capacity(FILE_COUNT);
    for index in 0..FILE_COUNT {
        let directory = format!("dir-{}", index % 200);
        let name = format!("{directory}/file-{index}.txt");
        std::fs::create_dir_all(repository.join(&directory)).unwrap();
        std::fs::write(
            repository.join(&name),
            random_bytes(index as u64 + 7, 2 * 1024),
        )
        .unwrap();
        names.push(name);
    }
    take_captured_operation_stream();

    let stage_started = Instant::now();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository),
        names,
    ))
    .expect("stage should succeed");
    let stage_elapsed = stage_started.elapsed();
    let staged = take_captured_operation_stream();
    let stage_progress = progress_for(&staged, "file.stage");
    evidence("stage elapsed", stage_elapsed);
    evidence("stage phases", phases_for(&staged, "file.stage"));
    evidence("stage progress (last)", stage_progress.last());
    let stage_last = stage_progress
        .last()
        .expect("staging 20000 files should outlast the 300 ms progress open delay");
    assert_eq!(stage_last["data"]["unit"], "files");
    assert_eq!(
        stage_last["data"]["current"], FILE_COUNT as u64,
        "the final staged count should equal the file count"
    );
    assert_eq!(
        stage_last["data"]["total"], FILE_COUNT as u64,
        "the stage total should be finalised at the end"
    );
    assert_eq!(stage_last["data"]["totalFinal"], true);
    assert!(
        stage_progress.iter().all(|event| event["data"]["current"]
            .as_u64()
            .is_some_and(|current| current <= FILE_COUNT as u64)),
        "no snapshot may count more files than were staged"
    );
    assert!(
        stage_progress
            .windows(2)
            .all(|pair| pair[0]["data"]["current"].as_u64() <= pair[1]["data"]["current"].as_u64()),
        "the staged count should never go backwards"
    );

    let commit_started = Instant::now();
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository),
        "Many files".to_owned(),
        Some("alice".to_owned()),
    ))
    .expect("commit should succeed");
    let commit_elapsed = commit_started.elapsed();
    let committed = take_captured_operation_stream();
    let commit_progress = progress_for(&committed, "revision.commit");
    evidence("commit elapsed", commit_elapsed);
    evidence("commit phases", phases_for(&committed, "revision.commit"));
    evidence("commit progress (last)", commit_progress.last());
    let commit_last = commit_progress
        .last()
        .expect("a commit of 20000 files should outlast the 300 ms progress open delay");
    assert_eq!(
        commit_last["data"]["totalFinal"], true,
        "commit totals should be final at the end"
    );
    assert_eq!(
        commit_last["data"]["current"], commit_last["data"]["total"],
        "commit should end at 100%"
    );
    assert_eq!(
        commit_last["data"]["filesTotal"], FILE_COUNT as u64,
        "the commit should account for every staged file"
    );
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_wrong_access_token_is_rejected_by_the_auth_service() {
    let stack = LiveStack::from_env();
    let operation = tauri::async_runtime::block_on(lore_auth_login_with_token(
        test_operation_context(),
        stack.server_url.clone(),
        "not-a-real-access-token".to_owned(),
        "Bearer".to_owned(),
        None,
    ))
    .unwrap_or_else(|error| {
        panic!(
            "a rejected token should come back as an operation result, not a command error: {}",
            error.message
        )
    });
    evidence("bad token status", operation.status);
    evidence("bad token events", &operation.events);
    assert_ne!(operation.status, 0, "an invalid token must not be accepted");
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_wrong_password_interactive_login_fails_instead_of_signing_in() {
    let stack = LiveStack::from_env();
    let _password = EnvGuard::set("LORE_E2E_LOGIN_PASSWORD", "definitely-wrong-password");
    let _user = EnvGuard::set("LORE_E2E_LOGIN_USER", "alice");
    let started = Instant::now();
    let result = tauri::async_runtime::block_on(lore_auth_login_interactive(
        test_operation_context(),
        stack.server_url.clone(),
    ));
    let elapsed = started.elapsed();
    evidence("wrong password elapsed", elapsed);
    let operation = result.unwrap_or_else(|error| {
        panic!(
            "a wrong password should fail the login as an operation result, not a command error: {}",
            error.message
        )
    });
    evidence("wrong password status", operation.status);
    evidence("wrong password events", &operation.events);
    assert_ne!(
        operation.status, 0,
        "a rejected password must not produce a session"
    );
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_unreachable_server_fails_without_hanging() {
    let started = Instant::now();
    let result = tauri::async_runtime::block_on(lore_repository_list(
        test_operation_context(),
        "lore://127.0.0.1:41399".to_owned(),
        None,
    ));
    let elapsed = started.elapsed();
    evidence("unreachable server elapsed", elapsed);
    match &result {
        Ok(operation) => {
            evidence("unreachable server status", operation.status);
            evidence("unreachable server events", &operation.events);
            assert_ne!(
                operation.status, 0,
                "a closed port must not look like an empty server"
            );
        }
        Err(error) => evidence("unreachable server error", (error.code, &error.message)),
    }
    assert!(
        elapsed < Duration::from_secs(60),
        "a refused connection should fail well within the operation timeout"
    );
}

const ANONYMOUS_PROBE_VARIABLE: &str = "LORE_E2E_ANONYMOUS_PROBE";

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_repository_list_requires_authentication_without_an_identity() {
    if std::env::var_os(ANONYMOUS_PROBE_VARIABLE).is_some() {
        probe_anonymous_repository_list();
        return;
    }
    let stack = LiveStack::from_env();
    let scratch = stack.work_root.join(format!("anonymous-{}", stack.run_id));
    let output = std::process::Command::new(
        std::env::current_exe().expect("the test binary should know its own path"),
    )
    .args([
        "--ignored",
        "--exact",
        "--nocapture",
        "--test-threads=1",
        "lore_adapter::live_server_tests::live_repository_list_requires_authentication_without_an_identity",
    ])
    .env(ANONYMOUS_PROBE_VARIABLE, "1")
    .env("LORE_E2E_SERVER", &stack.server_url)
    .env("LORE_E2E_WORK_DIR", &scratch)
    .env("LORE_AUTH_PATH", scratch.join("token-store"))
    .output()
    .expect("the anonymous probe should start in a fresh process");
    eprintln!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(
        output.status.success(),
        "a fresh process with an empty token store should be refused by the protected server"
    );
}

/// Runs inside a fresh child process. The parent test's signed-in token store and cached
/// connections are process-wide, so only a new process proves that no identity is supplied.
fn probe_anonymous_repository_list() {
    let stack = LiveStack::from_env();
    let result = tauri::async_runtime::block_on(lore_repository_list(
        test_operation_context(),
        stack.server_url.clone(),
        None,
    ));
    match &result {
        Ok(operation) => {
            evidence("anonymous list status", operation.status);
            evidence("anonymous list events", &operation.events);
        }
        Err(error) => evidence("anonymous list error", (error.code, &error.message)),
    }
    let refused = match &result {
        Ok(operation) => operation.status != 0,
        Err(error) => error.code == "auth_required",
    };
    assert!(
        refused,
        "listing a protected server without credentials should be refused"
    );
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_conflicting_edits_resolve_through_external_merge_and_push() {
    let _operation_scope = test_operation_scope();
    let stack = LiveStack::from_env();
    let user_id = stack.sign_in("alice");
    let repository_name = format!("conflict-{}", stack.run_id);

    let repository_a = stack.directory("conflict-a");
    initialize_repository(
        &text(&repository_a),
        "conflict",
        "Conflict",
        "alice",
        Some("alice"),
        false,
        None,
    )
    .expect("the local repository should initialize");
    std::fs::write(repository_a.join("shared.txt"), "base\n").unwrap();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository_a),
        vec!["shared.txt".to_owned()],
    ))
    .unwrap();
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository_a),
        "Base".to_owned(),
        Some("alice".to_owned()),
    ))
    .unwrap();
    let published = stack.publish(&repository_a, &repository_name, &user_id);
    assert!(published.pushed, "publish should push the base revision");
    tauri::async_runtime::block_on(lore_auth_repository_binding_set(
        test_operation_context(),
        text(&repository_a),
        Some(user_id.clone()),
        None,
    ))
    .unwrap();

    let cloned = stack.clone_into(&repository_name, "bob-clone", &user_id);
    assert_eq!(cloned.result.status, 0, "clone should succeed");
    let repository_b = PathBuf::from(&cloned.destination_path);
    tauri::async_runtime::block_on(lore_auth_repository_binding_set(
        test_operation_context(),
        text(&repository_b),
        Some(user_id.clone()),
        None,
    ))
    .unwrap();

    std::fs::write(repository_a.join("shared.txt"), "from alice\n").unwrap();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository_a),
        vec!["shared.txt".to_owned()],
    ))
    .unwrap();
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository_a),
        "Alice edit".to_owned(),
        Some("alice".to_owned()),
    ))
    .unwrap();
    let alice_push = tauri::async_runtime::block_on(lore_push(
        test_operation_context(),
        text(&repository_a),
        None,
    ))
    .unwrap();
    assert_eq!(alice_push.status, 0, "alice's push should succeed");

    std::fs::write(repository_b.join("shared.txt"), "from bob\n").unwrap();
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository_b),
        vec!["shared.txt".to_owned()],
    ))
    .unwrap();
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository_b),
        "Bob edit".to_owned(),
        Some("alice".to_owned()),
    ))
    .unwrap();

    let sync = tauri::async_runtime::block_on(lore_sync(
        test_operation_context(),
        text(&repository_b),
        Vec::new(),
        Vec::new(),
        false,
        0,
    ))
    .expect("sync should return a result");
    evidence("bob sync status", sync.status);
    evidence(
        "bob sync events",
        sync.events
            .iter()
            .map(|event| event["tagName"].clone())
            .collect::<Vec<_>>(),
    );
    let session = tauri::async_runtime::block_on(lore_conflict_session(
        test_operation_context(),
        text(&repository_b),
    ))
    .expect("the conflict session query should succeed")
    .expect("bob's divergent edit should leave a merge conflict session");
    evidence("conflict session kind", session.kind);
    let incoming = session
        .incoming_revision
        .clone()
        .expect("a merge conflict should name the incoming revision");

    let tool = runtime_tool_writing(
        &stack.work_root.join(format!("tool-{}", stack.run_id)),
        "printf 'merged by external tool\\n' > \"$4\"\nexit 0",
    );
    let launched = tauri::async_runtime::block_on(lore_open_external_merge(
        test_operation_context(),
        text(&repository_b),
        tool,
        "shared.txt".to_owned(),
        session.current_revision.clone(),
        incoming,
        ExternalMergeLabels {
            base: "base".to_owned(),
            local: "local".to_owned(),
            remote: "remote".to_owned(),
            merged: "merged".to_owned(),
        },
    ))
    .expect("the external merge should launch");
    evidence(
        "external merge launched",
        (launched.tool_name, launched.temporary_file_count),
    );
    let shared = repository_b.join("shared.txt");
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20)
        && std::fs::read_to_string(&shared)
            .map_or(true, |content| content != "merged by external tool\n")
    {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        "merged by external tool\n",
        "the external tool result should replace the conflicted workspace file"
    );

    let stale = tauri::async_runtime::block_on(lore_write_conflict_resolution(
        test_operation_context(),
        text(&repository_b),
        session.clone(),
        "shared.txt".to_owned(),
        "content the user never saw\n".to_owned(),
        "overwritten\n".to_owned(),
    ));
    evidence(
        "stale conflict write",
        stale.as_ref().err().map(|error| error.code),
    );
    assert!(
        stale.is_err(),
        "a stale resolution must not overwrite the workspace"
    );
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        "merged by external tool\n"
    );

    let resolved = tauri::async_runtime::block_on(lore_conflict_action(
        test_operation_context(),
        text(&repository_b),
        session.kind,
        LoreConflictAction::Resolve,
        vec!["shared.txt".to_owned()],
    ))
    .expect("marking the file resolved should succeed");
    assert_eq!(resolved.status, 0, "resolving the conflict should succeed");
    tauri::async_runtime::block_on(lore_stage(
        test_operation_context(),
        text(&repository_b),
        vec!["shared.txt".to_owned()],
    ))
    .unwrap();
    tauri::async_runtime::block_on(lore_commit(
        test_operation_context(),
        text(&repository_b),
        "Resolve conflict".to_owned(),
        Some("alice".to_owned()),
    ))
    .expect("the resolution should commit");
    let pushed = tauri::async_runtime::block_on(lore_push(
        test_operation_context(),
        text(&repository_b),
        None,
    ))
    .unwrap();
    assert_eq!(pushed.status, 0, "bob's resolution should push");

    let synced = tauri::async_runtime::block_on(lore_sync(
        test_operation_context(),
        text(&repository_a),
        Vec::new(),
        Vec::new(),
        false,
        0,
    ))
    .unwrap();
    assert_eq!(synced.status, 0, "alice should sync bob's resolution");
    assert_eq!(
        std::fs::read_to_string(repository_a.join("shared.txt")).unwrap(),
        "merged by external tool\n",
        "alice should receive the resolved content"
    );
}

fn status_file_paths(repository: &Path) -> Vec<String> {
    tauri::async_runtime::block_on(lore_repository_status(
        test_operation_context(),
        text(repository),
    ))
    .expect("status should return a result")
    .events
    .iter()
    .filter(|event| event["tagName"] == "repositoryStatusFile" && event["data"]["type"] == "file")
    .filter_map(|event| event["data"]["path"].as_str().map(str::to_owned))
    .collect()
}

#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_loreignore_rule_hides_matching_files_from_status() {
    let _operation_scope = test_operation_scope();
    let stack = LiveStack::from_env();
    stack.sign_in("alice");

    let repository = stack.directory("ignore-rules");
    initialize_repository(
        &text(&repository),
        "ignore",
        "Ignore rules",
        "alice",
        Some("alice"),
        false,
        None,
    )
    .expect("the local repository should initialize");
    std::fs::write(repository.join("keep.txt"), "keep\n").unwrap();
    std::fs::write(repository.join("trace.log"), "noise\n").unwrap();

    let before = status_file_paths(&repository);
    assert!(
        before.iter().any(|path| path == "trace.log"),
        "trace.log should be pending before the rule: {before:?}"
    );

    let rules = lore_ignore_paths(text(&repository), vec!["trace.log".to_owned()], false)
        .expect("the ignore rule should be appended");
    evidence("rules appended", &rules);
    evidence(
        ".loreignore after rule",
        std::fs::read_to_string(repository.join(".loreignore")).unwrap(),
    );

    let after = status_file_paths(&repository);
    evidence("pending before", &before);
    evidence("pending after", &after);
    assert!(
        !after.iter().any(|path| path == "trace.log"),
        "the rule should hide trace.log from status: {after:?}"
    );
    assert!(
        after.iter().any(|path| path == "keep.txt"),
        "unmatched files must stay pending: {after:?}"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "live: needs the local Lore server and lore-auth-service; see docs/en/E2E_LOCAL_STACK.md"]
fn live_repository_config_edit_is_read_back_by_the_runtime_and_stays_inside_the_repository() {
    let _operation_scope = test_operation_scope();
    let stack = LiveStack::from_env();
    stack.sign_in("alice");

    let repository = stack.directory("config-edit");
    initialize_repository(
        &text(&repository),
        "config-edit",
        "Config edit",
        "alice",
        Some("alice"),
        false,
        None,
    )
    .expect("the local repository should initialize");

    let identity = "Alice E2E <alice@example.test>";
    let saved = tauri::async_runtime::block_on(lore_repository_config_update(
        test_operation_context(),
        text(&repository),
        identity.to_owned(),
        stack.server_url.clone(),
    ))
    .expect("the identity and remote should be written");
    assert_eq!(saved.identity.as_deref(), Some(identity));
    assert_eq!(saved.remote_url.as_deref(), Some(stack.server_url.as_str()));

    let read_back = tauri::async_runtime::block_on(lore_repository_config_get(
        test_operation_context(),
        text(&repository),
        "identity".to_owned(),
    ))
    .expect("the runtime should read the repository configuration");
    let runtime_identity = read_back
        .events
        .iter()
        .find(|event| event["tagName"] == "repositoryConfigGet")
        .and_then(|event| event["data"]["value"].as_str())
        .map(str::to_owned);
    evidence("runtime identity", &runtime_identity);
    assert_eq!(runtime_identity.as_deref(), Some(identity));

    let config = repository.join(".lore").join("config.toml");
    let outside = stack
        .work_root
        .join(format!("config-outside-{}.toml", stack.run_id));
    let outside_before = "identity = \"outside@example.test\"\n";
    std::fs::write(&outside, outside_before).unwrap();
    std::fs::remove_file(&config).unwrap();
    std::os::unix::fs::symlink(&outside, &config).unwrap();

    let refused = tauri::async_runtime::block_on(lore_repository_config_update(
        test_operation_context(),
        text(&repository),
        "Mallory <mallory@example.test>".to_owned(),
        stack.server_url.clone(),
    ))
    .expect_err("a configuration link that leaves the repository must be refused");
    evidence(
        "symlinked config refusal",
        (&refused.code, &refused.message),
    );
    assert_eq!(refused.code, "repository_file_outside_repository");
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        outside_before,
        "the file behind the link, outside the repository, must not change"
    );
}

#[cfg(unix)]
fn runtime_tool_writing(directory: &Path, body: &str) -> ExternalDiffTool {
    use std::os::unix::fs::PermissionsExt;

    std::fs::create_dir_all(directory).expect("the tool directory should exist");
    let script = directory.join("merge-tool.sh");
    std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).expect("the tool should be written");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .expect("the tool should be executable");
    ExternalDiffTool {
        id: "live-merge".to_owned(),
        name: "live-merge".to_owned(),
        executable: script.to_string_lossy().into_owned(),
        arguments: ["{base}", "{local}", "{remote}", "{merged}"]
            .map(str::to_owned)
            .to_vec(),
    }
}

#[cfg(not(unix))]
fn runtime_tool_writing(_directory: &Path, _body: &str) -> ExternalDiffTool {
    unreachable!("the live conflict test uses POSIX shell tools")
}
