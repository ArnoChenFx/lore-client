# Local E2E stack for Lore Client

This guide runs the Epic Games Lore server (`loreserver`) and the Lore authentication service on one machine, then runs Lore Client's live tests against them. Nothing is mocked on the server or auth side. The scripts live in `scripts/e2e/`, and everything they create goes under `LORE_E2E_HOME` (default `~/lore-e2e`), which must stay outside the repository.

**Last verified** on 2026-10-14 on Linux x86_64 with lore-auth-service `f3742a7` and `loreserver` 0.10.1. On a fresh auth database the auth probes passed 12 of 12 checks. The live tests have not been run on `f3742a7`: they need Rust 1.85 or newer, and the verification host has Rust 1.83. The earlier verification on `b4be18d` reported all 10 live tests passing. The findings and the probe output are in [Findings in lore-auth-service](#findings-in-lore-auth-service) and [Auth service probes](#auth-service-probes).

## What runs

| Component | Version pinned by the scripts | Role |
| --- | --- | --- |
| `loreserver` | `ghcr.io/arnochenfx/lore-server:0.10.1`, linux/amd64 manifest `sha256:6dad04dc1280cfb3…`, upstream revision `95a9a834f18402cbacf43d43518c0ac771e029eb` | Lore server: repositories, branches, storage, QUIC/gRPC transport. |
| `lore-auth-service` | [ArnoChenFx/lore-auth-service](https://github.com/ArnoChenFx/lore-auth-service) at `f3742a7`, the head of [PR #1](https://github.com/ArnoChenFx/lore-auth-service/pull/1) (`lore-auth` 0.1.13, Bun) | Browser login, RS256 JWTs, JWKS, ReBAC permissions, admin API, sign-in throttling. |
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
- [Node.js](https://nodejs.org) 18 or newer, for `scripts/e2e/auth-service-probes.mjs`.
- Network access to `ghcr.io` (the image layers, about 100 MB) and `github.com` (the auth-service clone).
- For the live tests: Rust 1.85 or newer, plus the Tauri Linux build dependencies, as in [DEVELOPMENT.md](DEVELOPMENT.md). The upstream Lore crates use edition 2024, and `run-live-tests.sh` refuses an older `rustc`.
- For the packaged-app check only: `tauri-driver` (`cargo install tauri-driver --locked`), `WebKitWebDriver` (package `webkit2gtk-driver`), and a running X display.

## Set up and start

```bash
scripts/e2e/setup-stack.sh     # downloads the image on the first run, then reuses bin/loreserver
scripts/e2e/start-stack.sh     # starts both services, waits for them, creates alice and bob
```

`setup-stack.sh` is idempotent. On the first run it generates `ADMIN_PASSWORD`, which `lore-auth-service` requires (see [Auth service settings](#auth-service-settings)). On a re-run it keeps the CA, the server certificate, the auth signing keys, the admin password and the test passwords. It regenerates `stack.toml`, the trust bundle and the `xdg-open` shim, so ports changed in the environment take effect, and it tightens the modes of auth state left by an earlier run.

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
| `LORE_AUTH_SERVICE_REF` | `f3742a7` | Commit of `lore-auth-service` to check out. The default is the head of PR #1, which carries the fixes. Set `f257d43` to reproduce the findings. |
| `LORE_AUTH_SERVICE_DIR` | `$LORE_E2E_HOME/src/lore-auth-service` | Existing checkout to use instead of a clone. |
| `LORE_E2E_SYSTEM_CA_BUNDLE` | `/etc/ssl/certs/ca-certificates.crt` | System roots that are merged with the E2E CA. |
| `RUST_LOG` | `info` | Log level for `loreserver`. |

### Auth service settings

`setup-stack.sh` writes `auth/auth.env`, which also sets the listen addresses, paths, TLS files, issuer, audience and administrator username. The table lists the administrator password and the settings for tokens, sessions and sign-in throttling, with the value the stack uses. Any of those settings not listed keeps its service default, so the probes test the defaults. `setup-stack.sh` rewrites `auth.env` on each run, so put an override in the environment of `start-stack.sh` instead, for example `LOGIN_MAX_FAILURES_PER_IP=0 scripts/e2e/start-stack.sh`.

| Variable | Stack value | Service default | Purpose |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | generated, 48 hex characters | none, required | Password of the bootstrap administrator. Startup is refused when it is missing, shorter than 8 characters, or one of the public values `changeme` and `replace-with-a-long-random-password`, unless `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD=true`. It is used when the administrator is first created, and on later starts only when the stored administrator still has one of those two public values. |
| `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD` | service default | `false` | Local development only. Permits the public values `changeme` and `replace-with-a-long-random-password`, and makes `changeme` the default when `ADMIN_PASSWORD` is unset. The stack never sets it. |
| `TOKEN_TTL` | service default | `864000` (10 days) | Lifetime of an access token, in seconds. |
| `REFRESH_TOKEN_TTL` | service default | `604800` (7 days) | Lifetime of a refresh token, in seconds. |
| `AUTH_SESSION_TTL` | `300` | `300` | Lifetime of a browser login session, in seconds. |
| `AUTH_SESSION_MAX_ATTEMPTS` | service default | `5` | Failed approvals in one browser session before that session locks. |
| `AUTH_SESSION_LOCK_SECONDS` | service default | `60` | Lock length for one browser session. |
| `LOGIN_MAX_FAILURES_PER_USER_IP` | service default | `5` | Failed passwords for one username from one address before a lock. `0` disables this scope. |
| `LOGIN_MAX_FAILURES_PER_IP` | service default | `100` | Failed passwords from one address, across usernames, before a lock. `0` disables this scope. |
| `LOGIN_MAX_FAILING_IPS_PER_ACCOUNT` | service default | `50` | Distinct addresses that failed against one account within 15 minutes, before the account locks for everyone. `0` disables this scope. `1` is refused at startup. |
| `LOGIN_LOCK_BASE_SECONDS` | service default | `60` | First login lock. It doubles with each further failure. |
| `LOGIN_LOCK_MAX_SECONDS` | service default | `900` | Upper bound for a login lock. |
| `LOGIN_RECENT_SUCCESS_SECONDS` | service default | `2592000` (30 days) | Sources that signed in to an account successfully within this many seconds are not blocked by that account's lock. `0` disables this exemption. |
| `TRUSTED_PROXY_COUNT` | service default | `0` | Number of reverse proxies in front of the service. The stack has none, so clients are identified by their TCP address. The proxy warning below explains the log line that this setting produces. |

- **Sign-in throttling.** Password checks on `/auth/login` and on browser approval count failures in three scopes: one username from one address, one address, and one account across addresses. An IPv6 address counts as its /64 prefix in each scope. A throttled request gets `429 Too Many Requests` and a `Retry-After` header, in seconds. It is not checked against the password and is not counted, so continued guessing cannot extend the lock. A successful sign-in clears only the username-and-address counter. Every probe comes from `127.0.0.1`, so the probes count toward the username-and-address scope and the address scope; see [Re-running the probes](#re-running-the-probes). A source that signed in to an account successfully within `LOGIN_RECENT_SUCCESS_SECONDS` is not blocked by that account's lock, but its own counters still apply. The probes do not test this exemption.
- **Approvals across sessions.** Browser approvals count toward the same username-and-address counter as `/auth/login`. Starting a new browser session with `StartAuthSession` does not reset that counter, so a new session for that username from the same address is refused too. The per-session lock (`AUTH_SESSION_MAX_ATTEMPTS`, `AUTH_SESSION_LOCK_SECONDS`) still applies inside one session.
- **Body limits.** JSON bodies on `/auth/login`, `/auth/refresh` and the admin API are limited to 64 KiB, and browser login forms to 16 KiB. The limits count the bytes received, so a chunked body is capped too. A larger body gets `413`.
- **Deleted users.** Deleting a user takes effect in the auth service at once. The user's access token gets `401` from `/auth/me`, the refresh token gets `401` from `/auth/refresh`, and the gRPC token exchange returns `UNAUTHENTICATED`.
- **Lore Server.** Lore Server checks each token's signature and expiry offline, with the keys from `/.well-known/jwks.json`. For an identity token (the token `/auth/login` returns), it then asks the auth service whether the user still exists and has access, so a deleted user's identity token is refused at once. A repository-scoped token carries its grants in a `resources` claim, which Lore Server evaluates without calling the auth service. Such a token keeps working until it expires, even after its user is deleted or the user's repository permissions change. The live tests and the probes use identity tokens, so this stack does not test the repository-scoped case. The window described here comes from the upstream source and the auth service README, not from a run on this stack.
- **`TOKEN_TTL` guidance.** `TOKEN_TTL` is the longest time a removed user's repository-scoped token can keep working on Lore Server. The default of 10 days lets a signed-in client work without a daily browser login, because Lore Client does not refresh browser sessions (`RefreshAuthSession` returns `UNIMPLEMENTED`). For sensitive deployments, set `TOKEN_TTL=28800` (eight hours) or less, as the auth service README recommends. The stack keeps the default.
- **Proxy warning.** While `TRUSTED_PROXY_COUNT` is `0`, the service logs one `[proxy]` warning per process, on the first request from a private, loopback or other non-public address. The stack's clients connect from `127.0.0.1`, so `logs/auth.log` shows this warning after each start: `[proxy] Requests arrive from a non-public address while TRUSTED_PROXY_COUNT=0. ...`. It is expected on this stack, which has no reverse proxy, and it changes no result. Keep `TRUSTED_PROXY_COUNT=0`. The startup banner prints `Proxies:     TRUSTED_PROXY_COUNT=0`.
- **Upgrading an existing stack.** A stack set up by `setup-stack.sh` already has a generated `ADMIN_PASSWORD`, so nothing needs to change. If the stored administrator still has one of the two public values, `changeme` or `replace-with-a-long-random-password`, the first start with this auth service replaces that password with `ADMIN_PASSWORD` and revokes that administrator's refresh tokens. The `login_throttles` and `login_successes` tables are created automatically. Sources that signed in before this version are exempt from an account lock only after they sign in again. A database written by the pre-fix commit `f257d43` gets both tables on the first start, and the probes pass on it.

### Trust

Lore Client's TLS uses `rustls-native-certs`, which reads `SSL_CERT_FILE` instead of the system store when it is set. The scripts therefore build `tls/trust-bundle.pem` from the system roots plus the local CA, and export `SSL_CERT_FILE` only for the `loreserver` process and the test run. Nothing is installed into the system trust store.

## Test users

`seed-users.py` uses the admin API to create two non-admin users, `alice` and `bob`. Their passwords are in `$LORE_E2E_HOME/auth/users.env`, and the admin password is in `$LORE_E2E_HOME/auth/auth.env`. Both files are mode 600.

## Run the live tests

```bash
scripts/e2e/run-live-tests.sh                    # all ten live tests, serially
scripts/e2e/run-live-tests.sh live_conflicting   # one test by name prefix
```

The runner first checks that `rustc` is 1.85 or newer. It then sets `LORE_E2E_SERVER`, a scratch directory under `$LORE_E2E_HOME/work/`, `LORE_E2E_SHIM_DIR`, and `SSL_CERT_FILE`, and runs:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib live_ -- --ignored --test-threads=1 --nocapture
```

`--nocapture` keeps the evidence lines that each test prints (timings, counts, file paths) in the output. Run the tests serially: login state and the Lore runtime are process-wide. The tests are `#[ignore]`d so `cargo test` stays offline.

### Browser login

The tests do not drive a browser. When the client opens the login URL through `xdg-open`, `$LORE_E2E_HOME/bin/xdg-open` takes the place of the desktop browser. It reads `session_code` and `client_state` from that URL and approves the session as the test user, with the same request a person would send from the login form. The user comes from `LORE_E2E_LOGIN_USER` (default `alice`), and the password from `LORE_E2E_LOGIN_PASSWORD` or `users.env`. Each invocation is logged to `$LORE_E2E_HOME/logs/xdg-open-shim.log`: the login-page path, then `approve user=<name> http=<status>` for each approval, with no session codes or passwords. A throttled sign-in is logged as `http=429`; see [Troubleshooting](#troubleshooting).

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

## Auth service probes

`scripts/e2e/auth-service-probes.mjs` checks the findings in [Findings in lore-auth-service](#findings-in-lore-auth-service) against the running auth service, through its HTTPS API and its gRPC port. It loads the gRPC packages from the auth checkout's `node_modules`, which `setup-stack.sh` installs. Run it after `start-stack.sh`:

```bash
node scripts/e2e/auth-service-probes.mjs                 # all four groups
node scripts/e2e/auth-service-probes.mjs login session   # only the named groups
```

Each check prints `PASS` or `FAIL` with status codes and counts. The script exits 1 when any check fails. It creates `probe-*` users and never prints passwords, tokens or session codes.

| Group | Check | Expected on the fixed service |
| --- | --- | --- |
| `login` | wrong passwords are throttled | some `429` responses and no `200` in 30 attempts |
| `login` | correct password is refused while throttled | `429` |
| `login` | throttled response carries `Retry-After` | a positive number of seconds |
| `body` | oversized JSON is refused with 413 for every transfer encoding | `413` for a 200 KiB body with Content-Length or chunked encoding, with a wrong or a right password |
| `deleted` | sign-in works before deletion | login `200`, `/auth/me` `200`, gRPC code `0` |
| `deleted` | access token is refused after deletion | `/auth/me` `401` |
| `deleted` | access token is refused by gRPC after deletion | gRPC code `16` (UNAUTHENTICATED) |
| `deleted` | refresh token is refused after deletion | `/auth/refresh` `401` |
| `session` | wrong guesses lock the session | four `401:invalid`, then `429:locked` |
| `session` | correct password is refused after the session lock | `429:locked` |
| `session` | new sessions share the lock | `429:locked` for each of ten new sessions |
| `session` | correct password in a new session is refused while locked | `429:locked` |

Output of the run on `f3742a7`, on a fresh auth database:

```text
login: 30 consecutive wrong passwords -> 401 x5, 429 x25
login: correct password after 30 failures -> HTTP 429
PASS login: wrong passwords are throttled: 401 x5, 429 x25
PASS login: correct password is refused while throttled: HTTP 429
PASS login: throttled response carries Retry-After: Retry-After 60
body: 200 KiB JSON, Content-Length, wrong password -> 413
body: 200 KiB JSON, Content-Length, right password -> 413
body: 200 KiB JSON, chunked, wrong password -> 413
body: 200 KiB JSON, chunked, right password -> 413
PASS body: oversized JSON is refused with 413 for every transfer encoding: 413 413 413 413
deleted: login -> HTTP 200; /auth/me before delete -> HTTP 200; gRPC exchange before delete -> code 0
PASS deleted: sign-in works before deletion: login 200, /auth/me 200, gRPC code 0
deleted: DELETE /admin/users/probe-deleted-c413b389 -> HTTP 200
deleted: /auth/me with the access token after delete -> HTTP 401
PASS deleted: access token is refused after deletion: HTTP 401
deleted: gRPC exchange of the access token after delete -> code 16
PASS deleted: access token is refused by gRPC after deletion: gRPC code 16
deleted: /auth/refresh with the refresh token after delete -> HTTP 401
PASS deleted: refresh token is refused after deletion: HTTP 401
session: one session, 5 wrong guesses then one more -> 401:invalid 401:invalid 401:invalid 401:invalid 429:locked 429:locked
session: correct password in the same session after the lock -> 429:locked
session: 10 new sessions via unauthenticated StartAuthSession, one wrong guess each -> 429:locked x10
session: new session with the correct password -> 429:locked
PASS session: wrong guesses lock the session: 401:invalid 401:invalid 401:invalid 401:invalid 429:locked 429:locked
PASS session: correct password is refused after the session lock: 429:locked
PASS session: new sessions share the lock: 429:locked x10
PASS session: correct password in a new session is refused while locked: 429:locked
12 of 12 checks passed
```

Against the pre-fix commit (`LORE_AUTH_SERVICE_REF=f257d43 scripts/e2e/setup-stack.sh`, then `start-stack.sh`), the same script prints `5 of 12 checks passed`. The seven failing checks are the three login checks, the body check, `deleted: access token is refused after deletion`, and the two new-session checks. The pre-fix service also accepts the correct password in a new session with `200`.

### Re-running the probes

Each run records ten failed sign-ins from `127.0.0.1`: five on `/auth/login` and five on browser approval. The wrong-password live test records one more. A count is forgotten an hour after its last failure (or `LOGIN_LOCK_MAX_SECONDS` after it, if that is longer). Once one address has 100 failures (`LOGIN_MAX_FAILURES_PER_IP`), each further failed sign-in from `127.0.0.1` extends the refusal, up to `LOGIN_LOCK_MAX_SECONDS` (900 seconds by default), and sign-ins from `127.0.0.1` get `429` in the meantime. After one live-test run and one probe run on this stack, the address counter held 11. Before another full pass, either:

- stop the stack, delete `auth/lore-auth.db*` (this also removes the counters and the `alice` and `bob` users, which `start-stack.sh` creates again), and start the stack again; or
- start the stack with `LOGIN_MAX_FAILURES_PER_IP=0 scripts/e2e/start-stack.sh`. This turns off only the per-address scope, and it is meant for local repeat runs.

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
auth/lore-auth.db        auth-service SQLite database (users, permissions, sessions, login counters)
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
- `auth-service-probes.mjs` and the shim log status codes and counts only, never passwords, tokens or session codes.

## Findings in lore-auth-service

These findings were reproduced on this stack before lore-auth-service PR #1. They are fixed on the PR branch at `f3742a7`. `auth-service-probes.mjs` checks items 1 to 4 against the running service, and the auth repository's tests (`test/config.test.ts`) cover item 5. Item 6 is in the image, not in lore-auth-service, and is still open.

1. **Sign-in attempt limit (fixed).** `/auth/login` had no limit: thirty wrong passwords each returned 401, and the correct password then returned 200. Five failed passwords for one username from one address (an IPv6 address counts as its /64 prefix) now lock that pair for 60 seconds, and the lock doubles with each further failure up to 900 seconds. Throttled requests get `429` with `Retry-After`.
2. **Approval lockout across sessions (fixed).** The lockout after `AUTH_SESSION_MAX_ATTEMPTS` failed approvals applied to one browser session. `StartAuthSession` on the gRPC port needs no credentials, so each new session started unlocked: ten wrong passwords in ten new sessions were all refused as invalid, and a correct password in a new session was then accepted. Approvals now count toward the same username-and-address throttle as `/auth/login`, so a new session for that username from that address gets `429`.
3. **Body limit for chunked requests (fixed).** The 64 KiB limit applied only when a request declared a `Content-Length`. An oversized request that declared its length got `400 Missing username or password`, even with the correct password. The same body sent chunked was accepted and signed in with the correct password (`200`). The limit now counts received bytes, so both transfer encodings get `413`.
4. **Deleted user's access token on `/auth/me` (fixed).** A deleted user's access token kept returning 200 from `/auth/me` until it expired, while `/auth/refresh` already refused the refresh token. `/auth/me` now refuses the access token. The gRPC token exchange already refused it. What Lore Server does with tokens issued before the deletion is described in [Auth service settings](#auth-service-settings).
5. **Default admin password (fixed).** `ADMIN_PASSWORD` defaulted to `changeme`, and the service only logged a `[security]` warning at startup. Startup is now refused unless `ADMIN_PASSWORD` is set to a password of at least 8 characters that is not `changeme` or the example placeholder, unless `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD=true`. The probes do not check this, because a refused startup is not visible through a running service.
6. **Image labels (open).** The `lore-server:0.10.1` image's `title`, `description` and `url` labels name the auth service, while its `source` label names `EpicGames/lore` (see "What runs").

## Troubleshooting

- `lore-auth-service did not answer` or `loreserver did not open`: read `logs/auth.log` or `logs/server.log`. A port may already be in use; check with `netstat -ltnup`.
- Certificate errors from the client or the auth service: confirm `tls/trust-bundle.pem` ends with the E2E CA, and that `tls/server.pem` matches `LORE_E2E_HOST`.
- Login hangs and times out: read `logs/xdg-open-shim.log`. No entry means the client did not call the shim, which happens when `LORE_E2E_SHIM_DIR` is not first on `PATH`. `run-live-tests.sh` sets this for you.
- `admin login failed` from `start-stack.sh`: the admin password in `auth/auth.env` does not match the database. This happens when the database was created with another password. Restore the old value or remove `auth/lore-auth.db` to start over.
- `ADMIN_PASSWORD must ...` in `logs/auth.log`: `auth/auth.env` has no usable admin password (missing, shorter than 8 characters, or a public value). Remove the `ADMIN_PASSWORD` line and run `setup-stack.sh` again, which generates a new one. If the administrator in the database has a different, non-public password, `start-stack.sh` then fails with `admin login failed`; see above.
- Sign-in fails with `http=429` in `logs/xdg-open-shim.log`, or the probes report `HTTP 429` for the admin sign-in: the address is in a sign-in lock. See [Re-running the probes](#re-running-the-probes).
- `[proxy] Requests arrive from a non-public address` in `logs/auth.log`: expected on this stack, which has no reverse proxy. Keep `TRUSTED_PROXY_COUNT=0`. If a proxy does sit in front of the service, set `TRUSTED_PROXY_COUNT` to the number of proxies instead; see [Auth service settings](#auth-service-settings).
