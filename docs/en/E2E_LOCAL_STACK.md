# Local E2E stack for Lore Client

This guide runs the Epic Games Lore server (`loreserver`) and the Lore authentication service on one machine, then runs Lore Client's live tests against them. Nothing is mocked on the server or auth side. The scripts live in `scripts/e2e/`, and everything they create goes under `LORE_E2E_HOME` (default `~/lore-e2e`), which must stay outside the repository.

## What runs

| Component | Version pinned by the scripts | Role |
| --- | --- | --- |
| `loreserver` | `ghcr.io/arnochenfx/lore-server:0.10.1`, linux/amd64 manifest `sha256:6dad04dc1280cfb3…`, upstream revision `95a9a834f18402cbacf43d43518c0ac771e029eb` | Lore server: repositories, branches, storage, QUIC/gRPC transport. |
| `lore-auth-service` | [ArnoChenFx/lore-auth-service](https://github.com/ArnoChenFx/lore-auth-service) at `f257d43` (`lore-auth` 0.1.12, Bun) | Browser login, RS256 JWTs, JWKS, ReBAC permissions, admin API. |
| Test client | This repository's `src-tauri` crate, `live_server_tests.rs` | Drives the Lore Client backend adapter against the stack. |

`loreserver` is not built from source. `setup-stack.sh` reads the image through the GHCR registry API, verifies the manifest digest and every blob digest, and extracts `usr/local/bin/loreserver`. Docker is not required. The 0.10.1 binary has sha256 `f6495aeedb807d9d181e3256ee022d6680eda0ed31766a6595594e7205757d51`.

The image is published by the `arnochenfx` GHCR account, not by Epic Games. Its `org.opencontainers.image.source` label names `EpicGames/lore`, but its `org.opencontainers.image.title` label is `lore-auth-service`, and its description and URL are the auth service's. Image metadata is therefore unreliable here; the digest pin is what identifies the binary.

```text
Lore Client tests ──lore://127.0.0.1:41337 (gRPC/TCP, QUIC/UDP)──► loreserver
       │                                                              │
       │ login: xdg-open shim approves the session                    │ auth_url, JWKS, ReBAC
       ▼                                                              ▼
    https://127.0.0.1:8080 (login, REST admin, JWKS) ◄─────────► https://127.0.0.1:50051 (gRPC)
                                 lore-auth-service
```

## Ports

| Port | Protocol | Listener |
| --- | --- | --- |
| 41337 | TCP | `loreserver` gRPC (`lore://`) |
| 41337 | UDP | `loreserver` QUIC |
| 41339 | TCP | `loreserver` HTTP listener (`[server.http]`) |
| 8080 | TCP, TLS | `lore-auth-service` login pages, REST API, `/.well-known/jwks.json`, `/health_check` |
| 50051 | TCP, TLS | `lore-auth-service` gRPC (`epic_urc.UrcAuthApi`, `ucs.auth.RebacApi`) |

All listeners bind `127.0.0.1` through the generated `stack.toml` and `auth.env`. Change them with the variables below. To see what is listening, run `netstat -ltnup`; `ss -ltnup` shows the same information where `netstat` is not installed.

## Prerequisites

- Linux x86_64 with `bash`, `git`, `curl`, `openssl` 1.1.1 or newer, `python3` 3.9 or newer, and `sed`.
- [Bun](https://bun.sh) 1.4 or newer, for `lore-auth-service`.
- Network access to `ghcr.io` (the image layers, about 100 MB) and `github.com` (the auth-service clone).
- For the live tests: a Rust toolchain plus the Tauri Linux build dependencies, as in [DEVELOPMENT.md](DEVELOPMENT.md).
- For the packaged-app check only: `tauri-driver` (`cargo install tauri-driver --locked`), `WebKitWebDriver` (package `webkit2gtk-driver`), and a running X display.

## Set up and start

```bash
scripts/e2e/setup-stack.sh     # downloads the image on the first run, then reuses bin/loreserver
scripts/e2e/start-stack.sh     # starts both services, waits for them, creates alice and bob
```

`setup-stack.sh` is idempotent. On a re-run it keeps the CA, the server certificate, the auth signing keys, the admin password and the test passwords. It regenerates `stack.toml`, the trust bundle and the `xdg-open` shim, so ports changed in the environment take effect, and it tightens the modes of auth state left by an earlier run.

`start-stack.sh` runs both services under `umask 077`, so the auth database, signing keys and logs are created private. It writes PID files to `$LORE_E2E_HOME/run/` and logs to `$LORE_E2E_HOME/logs/auth.log` and `server.log`. It exits non-zero if either service does not answer within its timeout. To stop the stack:

```bash
scripts/e2e/stop-stack.sh
```

Both `setup-stack.sh` and `start-stack.sh` print progress and never print secret values.

### Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `LORE_E2E_HOME` | `~/lore-e2e` | Stack home. Must be outside the repository; the scripts refuse otherwise. |
| `LORE_E2E_HOST` | `127.0.0.1` | Bind and advertised host. Changing it requires deleting `tls/server.pem` so the certificate is regenerated. |
| `LORE_E2E_SERVER_PORT` | `41337` | `loreserver` gRPC (TCP) and QUIC (UDP). |
| `LORE_E2E_SERVER_HTTP_PORT` | `41339` | `loreserver` HTTP listener. |
| `LORE_E2E_AUTH_PORT` | `8080` | `lore-auth-service` HTTPS. |
| `LORE_E2E_AUTH_GRPC_PORT` | `50051` | `lore-auth-service` gRPC. |
| `LORE_SERVER_TAG` | `0.10.1` | Image tag to extract. Delete `bin/loreserver` after changing it. |
| `LORE_SERVER_DIGEST` | `sha256:6dad04dc…` | Required digest of the linux/amd64 manifest. Set it to an empty value (`LORE_SERVER_DIGEST=`) to skip the pin. |
| `LORESERVER_BIN` | unset | Copy a local `loreserver` binary instead of pulling the image. |
| `LORE_AUTH_SERVICE_REF` | `f257d43` | Commit of `lore-auth-service` to check out. |
| `LORE_AUTH_SERVICE_DIR` | `$LORE_E2E_HOME/src/lore-auth-service` | Existing checkout to use instead of a clone. |
| `LORE_E2E_SYSTEM_CA_BUNDLE` | `/etc/ssl/certs/ca-certificates.crt` | System roots that are merged with the E2E CA. |
| `RUST_LOG` | `info` | Log level for `loreserver`. |

### Trust

Lore Client's TLS uses `rustls-native-certs`, which reads `SSL_CERT_FILE` instead of the system store when it is set. The scripts therefore build `tls/trust-bundle.pem` from the system roots plus the local CA, and export `SSL_CERT_FILE` only for the `loreserver` process and the test run. Nothing is installed into the system trust store.

## Test users

`seed-users.py` uses the admin API to create two non-admin users, `alice` and `bob`. Their passwords are in `$LORE_E2E_HOME/auth/users.env`, and the admin password is in `$LORE_E2E_HOME/auth/auth.env`. Both files are mode 600.

## Run the live tests

```bash
scripts/e2e/run-live-tests.sh                    # all ten live tests, serially
scripts/e2e/run-live-tests.sh live_conflicting   # one test by name prefix
```

The runner sets `LORE_E2E_SERVER`, a scratch directory under `$LORE_E2E_HOME/work/`, `LORE_E2E_SHIM_DIR`, and `SSL_CERT_FILE`, then runs:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib live_ -- --ignored --test-threads=1 --nocapture
```

`--nocapture` keeps the evidence lines that each test prints (timings, counts, file paths) in the output. Run the tests serially: login state and the Lore runtime are process-wide. The tests are `#[ignore]`d so `cargo test` stays offline.

### Browser login

The tests do not drive a browser. When the client opens the login URL through `xdg-open`, `$LORE_E2E_HOME/bin/xdg-open` takes the place of the desktop browser. It reads `session_code` and `client_state` from that URL and approves the session as the test user, with the same request a person would send from the login form. The user comes from `LORE_E2E_LOGIN_USER` (default `alice`), and the password from `LORE_E2E_LOGIN_PASSWORD` or `users.env`. Each invocation is logged to `$LORE_E2E_HOME/logs/xdg-open-shim.log` as the login-page path plus the HTTP status, with no session codes or passwords.

Setting `LORE_E2E_SHIM_DISABLE=1` makes the shim log `shim disabled, not approving` and exit without approving, so the sign-in cannot complete. `run-live-tests.sh` puts the shim first on `PATH`; a client that opens the URL some other way never reaches the shim.

### Test matrix

| Live test | What it checks against the real server and auth service |
| --- | --- |
| `live_login_publish_clone_push_and_sync_round_trip` | Browser login through the auth service, then publish, clone, commit, push and sync. |
| `live_clone_and_publish_report_progress_that_matches_the_transferred_bytes` | Progress events for a 48 MiB publish and clone match the bytes transferred and the fragment counts. |
| `live_stage_and_commit_progress_counts_every_file` | Stage and commit progress for 20,000 files in 200 directories counts every file. |
| `live_wrong_access_token_is_rejected_by_the_auth_service` | A wrong access token is rejected. |
| `live_wrong_password_interactive_login_fails_instead_of_signing_in` | A wrong password fails the login and does not sign in. |
| `live_unreachable_server_fails_without_hanging` | With no server listening, operations fail within a bounded time. |
| `live_repository_list_requires_authentication_without_an_identity` | Repository listing without an identity is refused, in an isolated child process. |
| `live_conflicting_edits_resolve_through_external_merge_and_push` | Conflict session, external merge copy-back, refusal of a stale resolution, then stage, commit, push and sync. |
| `live_loreignore_rule_hides_matching_files_from_status` | A rule appended to `.loreignore` hides matching files from status and leaves other files pending. |
| `live_repository_config_edit_is_read_back_by_the_runtime_and_stays_inside_the_repository` (Unix) | Identity and remote written to `.lore/config.toml` are read back by the runtime. A `config.toml` symlink that leads outside the repository is refused with `repository_file_outside_repository`, and the file behind it is unchanged. |

Offline tests cover the same areas without a server. `runtime_e2e_tests.rs` has five tests for external merge copy-back containment, symlink refusal and patch destinations. Run them with `cargo test --manifest-path src-tauri/Cargo.toml --lib`.

## Packaged-app check (WebDriver)

`scripts/e2e/packaged-app-check.mjs` runs the built desktop binary through `tauri-driver`. It does not sign in and does not open a repository, and it needs no running stack. It checks:

- the removed IPC commands (`lore_file_preview`, `lore_open_patch`) are not registered, and every frontend command name appears in the Rust handler list;
- patch export through the real `lore_write_patch_file` handler, in seven cases: extension check, a new file, refusal to overwrite without confirmation (`patch_destination_exists`), confirmed replacement, refusal of a symbolic link (`patch_destination_is_link`) that leaves its target untouched, a dangling link that is never created, and an empty patch;
- the Settings dialog loads from its lazy chunk;
- the Repository Tools dialog is reported as skipped when no repository is open;
- a progress snapshot injected through `plugin:event|emit` appears in the status bar, and the stall warning appears only after 15 seconds without a new snapshot. The snapshot is synthetic, so this checks the frontend's stall handling, not a real stage.

```bash
bun run tauri build --debug --no-bundle    # builds src-tauri/target/debug/lore-client
export DISPLAY=:1                          # an X server, for example Xvfb :1
tauri-driver --port 4444 &
node scripts/e2e/packaged-app-check.mjs    # screenshots go to $E2E_EVIDENCE_DIR
```

## Browser-driven check (CDP smoke, frontend only)

`bun run test:ui` runs `scripts/cdp-smoke.mjs`. It drives headless Chrome against the Vite dev server on port 1420 and covers frontend behavior only, with no Tauri backend. Its assertions expect Chinese UI strings, so run it with a zh_CN locale:

```bash
LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 bun run test:ui
```

Set `LORE_CLIENT_BROWSER_PATH` to use a specific Chrome or Chromium. Set `LORE_CDP_SCREENSHOT_DIR` to save a PNG of the failed-lazy-view state as `cdp-lazy-view-failure.png`.

## Layout of `LORE_E2E_HOME`

```text
bin/loreserver           extracted server binary
bin/xdg-open             login approval shim
auth/auth.env            auth-service settings, including ADMIN_PASSWORD (0600)
auth/users.env           test user credentials (0600)
auth/keys/               RS256 signing keys generated by the auth service (private.pem 0600)
auth/lore-auth.db        auth-service SQLite database (users, permissions, sessions)
server/config/stack.toml loreserver configuration
server/data/             repositories created by the tests
src/lore-auth-service/   checkout of the auth service at LORE_AUTH_SERVICE_REF
tls/                     local CA, server certificate and key, trust-bundle.pem
logs/                    auth.log, server.log, xdg-open-shim.log
run/                     PID files written by start-stack.sh
work/                    scratch directories for live test runs
```

To start from empty state, run `stop-stack.sh` and then remove `server/data/` (which deletes all test repositories) or the whole home directory.

## Security notes

- Keys, passwords and tokens are kept under `auth/` and `tls/`, which are mode 0700 with 0600 files. `start-stack.sh` runs the services under `umask 077`, and `setup-stack.sh` tightens modes that an earlier run left behind. `setup-stack.sh` refuses to run when the home is inside the repository. Do not copy these files into the repository or into CI logs.
- The stack is for testing only. It uses a generated local CA and generated test passwords. Do not expose ports 41337, 41339, 8080 or 50051 beyond loopback.
- The shim approves any login it is asked to approve, so only point `xdg-open` at this stack.

## Known issues in the stack under test

These were reproduced on this stack. They are in `lore-auth-service` and the image, not in this repository, and this repository does not change them. `scripts/e2e/auth-service-probes.mjs` reproduces items 1 to 4 against a running stack. It prints status codes and counts only, and it creates `probe-*` users.

1. `/auth/login` has no attempt limit. Thirty consecutive wrong passwords each returned 401, and the correct password then returned 200.
2. The approval lockout is per session. After `AUTH_SESSION_MAX_ATTEMPTS` (default 5) failed approvals, that session is locked for `AUTH_SESSION_LOCK_SECONDS` (default 60), and the correct password in the same session is still refused. `StartAuthSession` on the gRPC port needs no credentials, so each new session starts unlocked: ten wrong passwords in ten new sessions were all refused as invalid, and a correct password in a new session was then accepted.
3. Request body limit. `parseJsonBody` refuses a request whose `Content-Length` is above 64 KiB, and the handler then answers `400 Missing username or password`, even when the password is correct. A request without `Content-Length` (chunked) is read in full, so the same oversized body reaches the password check (wrong password 401, correct password 200). The cap applies only to clients that declare their length.
4. A deleted user's access token keeps working until it expires. With the default `TOKEN_TTL` of 10 days, `/auth/me` returned 200 after the user was deleted, while `/auth/refresh` returned 401. Refresh tokens and permissions are removed by `ON DELETE CASCADE`.
5. `ADMIN_PASSWORD` defaults to `changeme`. The service logs only a `[security]` warning at startup.
6. The `lore-server:0.10.1` image labels name the auth service (see "What runs").

## Troubleshooting

- `lore-auth-service did not answer` or `loreserver did not open`: read `logs/auth.log` or `logs/server.log`. A port may already be in use; check with `netstat -ltnup`.
- Certificate errors from the client or the auth service: confirm `tls/trust-bundle.pem` ends with the E2E CA, and that `tls/server.pem` matches `LORE_E2E_HOST`.
- Login hangs and times out: read `logs/xdg-open-shim.log`. No entry means the client did not call the shim, which happens when `LORE_E2E_SHIM_DIR` is not first on `PATH`. `run-live-tests.sh` sets this for you.
- `admin login failed` from `start-stack.sh`: the admin password in `auth/auth.env` does not match the database. This happens when the database was created with another password. Restore the old value or remove `auth/lore-auth.db` to start over.
