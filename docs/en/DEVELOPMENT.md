# Lore Client Developer Guide

[中文](../zh/DEVELOPMENT.md) · [User guide](../../README.md)

This guide is the shortest path from a fresh checkout to a validated contribution. For product features, read the user guide.

## Quick start

### Prerequisites

Install:

- The latest stable Bun release (CI uses `bun-version: latest`).
- The stable Rust toolchain with Cargo.
- Git LFS 3.x.
- The platform dependencies required by Tauri: WebView2 and Windows build tools on Windows, WebKitGTK 4.1 development packages on Linux, or Xcode Command Line Tools on macOS.

Install the locked dependencies:

```powershell
git lfs install
git lfs pull
bun install --frozen-lockfile
```

### Choose a development mode

Use the browser preview for fast UI work:

```powershell
bun run dev
```

The preview opens at `http://127.0.0.1:1420` and uses sample data. Use the desktop application whenever a change needs real repositories, native dialogs, filesystem access, or Lore operations:

```powershell
bun tauri dev
```

Create a production frontend build or validate the desktop shell with:

```powershell
bun run build
bun tauri build --debug --no-bundle
```

## Find the right place to work

| Task                                                                   | Main locations                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| Application-level UI, shell, and dialogs                               | `src/app/`, `src/App.tsx`, `src/styles.css`                    |
| Domain UI and workflows such as revisions, local changes, and branches | `src/features/<domain>/`                                       |
| Cross-domain primitives and pure helpers                               | `src/shared/ui/`, `src/shared/lib/`                            |
| Stable frontend data types                                             | `src/types.ts`                                                 |
| Frontend Lore calls                                                    | `src/services/lore/`                                           |
| Native Lore operations                                                 | `src-tauri/src/lore_adapter.rs`, `src-tauri/src/lib.rs`        |
| Offline Revision author display cache                                  | `src-tauri/src/revision_author_cache.rs`, `src/services/lore/` |
| Preferences and persisted layout                                       | `src/services/preferences.ts`, `src/hooks/`                    |
| English and Chinese UI text                                            | `src/i18n/locales/`                                            |
| Browser-preview sample data                                            | `src/data.ts`                                                  |
| UI and visual validation                                               | `scripts/`                                                     |
| Public documentation and images                                        | `README.md`, `docs/en/`, `docs/zh/`, `docs/img/`               |

Do not commit generated dependencies, build output, Rust targets, temporary browser profiles, or generated analysis directories.

The `bun run test` script enables Bun's `--isolate` mode so module mocks and global state do not leak across test files. Use this script in local development and CI to apply the same isolation settings.

## Common development tasks

### Change the interface

Start with `bun run dev`, update the relevant component and shared styles, then add or update nearby `bun run test` coverage. Use semantic design tokens so the same change works in light and dark themes.

All user-visible text, accessible names, tooltips, confirmations, and errors must use the localization resources. Update the English and Simplified Chinese resources together.

Keep domain components and their tests in the matching `src/features/<domain>/components/`
directory, and keep application-shell components in `src/app/components/`. Cross-domain consumers
should import from the domain root `index.ts` instead of reaching into another domain's internal
`components/` path. Only controls and pure helpers with real multi-domain reuse belong in
`src/shared/`.

### Add or change a Lore-backed feature

Keep the integration path consistent:

1. Define or update the stable frontend DTO in `src/types.ts`.
2. Add the frontend operation in the matching domain module under `src/services/lore/`.
3. Keep feature state and orchestration in the matching `src/features/<domain>/` module; let
   `src/app/` compose its narrow controller interface and keep `src/App.tsx` as the application root.
4. Implement the native command in `src-tauri/src/lore_adapter.rs` and register it in `src-tauri/src/lib.rs`.
5. Return structured results and errors that the interface can localize.
6. Add frontend and Rust coverage appropriate to the behavior.

Desktop mode must show real failures. Do not substitute sample data or report success when a Lore operation fails.

### Upgrade the pinned Lore version

An upstream upgrade usually changes the C API, the FFI error codes, and protocol
semantics at once. Work through it in this order:

1. Point both `lore` and `lore-revision` in `src-tauri/Cargo.toml` at the commit the
   target tag resolves to (both `rev` values must match, or the protocol
   implementations drift apart).
2. Diff the upstream root `Cargo.toml` `[patch.crates-io]` section. Upstream path
   patches do not propagate through an external Git dependency, so every entry needs
   the same vendored crate on the client side plus a local patch entry. Today that is
   `vendor/quinn-proto` and `vendor/glob-match`.
3. Compare the `#[ffi_code(N)]` allocation table in `lore-base/src/error.rs` against
   `lore_error_code_name` in `src-tauri/src/lore_adapter/runtime.rs`, plus the
   `LORE_FFI_ERROR_NOT_AUTHENTICATED` / `LORE_FFI_ERROR_NOT_CONNECTED` constants and
   the frontend `localizedLoreErrorCodeKey`. Relocated codes do not break the build,
   they silently break error classification.
4. `cargo check` reports struct fields that were added or removed. Decide each new
   field's value from its documented semantics rather than defaulting to whatever
   compiles, especially for switches that change behavior. Run `cargo check --tests`
   too: test code builds event structs literally, so new fields show up there first.
5. Read the dependency's `build.rs` and native link inputs. A new prebuilt library
   (v0.14.0 added a static SWFS library on Windows) changes what the desktop binary
   links, so run `bun tauri build --debug --no-bundle` and read its linker warnings.
6. Event JSON is not fully visible in `lore.h`: some types serialize their own way (an
   `InstanceId` is `{ "data": [16 bytes] }`, not a hex string). Run the ignored real-Lore
   contract test named in the section for the pinned version and compare real events
   with the frontend parsers.

### Embedded Lore v0.14.0

Both Lore dependencies are pinned to the official `v0.14.0` tag's commit,
`317f48b918f0b4d43de104d99e80ac4a57b697df` (previously `v0.13.0`,
`9e0b4519a8a246e471d01853955f63bf0cecbeca`). The tag declares `0.13.1-nightly`
in its workspace; the source revision identifies the release. Unreleased
changes on upstream main are outside this upgrade. The vendored `glob-match`
and `quinn-proto` match the tag, the upstream `[patch.crates-io]` list is
unchanged, and the FFI error-code table is identical to v0.13.0's.

Client compatibility assessment and adaptations:

- **Push progress.** Push events (fragment begin/progress/end, revision push,
  branch create) now start with the `repository` and `branch` they belong to,
  and `lore push` uploads up to eight targets (the main repository, layers and
  links) at once, so the events of different targets interleave. Progress is
  kept per `(repository, branch)` and summed for display; the stream shape the
  interface consumes is unchanged. Targets of one repository still run one at a
  time.
- **Refused requests.** Requests the server or authentication service refuses
  now fail with `NotAuthenticated` (16) or `NotAuthorized` (17) instead of an
  internal error, `NotConnected` (29) or a not-found code. Codes 16, 17 and the
  retryable `SlowDown` (31) get a localized message that keeps Lore's detail;
  `MountsBusy` (51) is named in the native table. A server answers a token it
  cannot verify (expired, malformed) with a `PermissionDenied` that cannot be
  told apart from a real permission denial, so 17 still does not start
  reauthentication; its message points to Accounts instead.
- **Lock query.** Lore refuses a query that names both an owner and a path
  before it asks the remote. The native command refuses it first
  (`lock_query_filters_conflict`); the interface never sent that combination.
  A path without a branch now queries the current branch.
- **Author names.** `local_user_info` now refreshes an expired stored login, and
  drops the refresh token when that refresh is refused, whenever it derives the
  auth endpoint from a repository. The adapter keeps passing an explicit
  endpoint and no repository, which cannot reach that branch. Keep it that way,
  or looking up author names would contact the network and could end a login.
- **Not affected, checked against the source.** Branch metadata `set`/`clear`
  (the client only reads metadata), `instance move`/`delete` (not exposed), the
  zero-id and invalid-name changes of `branch create` (the client passes no id),
  the archived-branch changes of switch/reset/push (archived branches are read
  only, and the library's push recreates a deleted remote branch itself), the
  strict `LORE_AUTH_STORE` and `config.toml` validation (only the CLI entry point
  calls it; the library's token store still reads leniently), `fast_flush` (off
  by default), and the global `force` flag of `stage` (never set).
- **Event JSON beyond `lore.h`.** An `InstanceId` serializes as
  `{ "data": [16 bytes] }`, not as a hex string like branch and repository ids
  (this was already so in v0.13.0). `readInstanceId` converts it for the instance
  list and the clone result; the old string read returned empty ids, which
  became duplicate list keys.

New capabilities consumed:

- **Clone Instance** (Repository Tools → Diagnostics).
  `lore_repository_instance_clone` previews with Lore's own dry run, then
  clones. Only an instance on a Shared Store can be cloned. The destination
  must not exist (checked at the native boundary). Where the volume cannot
  share data blocks Lore refuses unless the user allows copying and it fits.
  The clone holds the instance and store locks, so it runs through the
  repository write queue after a confirmation that names the method, and its
  progress events stream; a preview never opens a stream.
- **Instance ignore rules.** Local Changes → Ignore → "on this instance only"
  writes `<Lore directory>/ignore` (`.lore/ignore`, or `.urc/ignore` in an old
  repository). The rules apply only to this working copy and only to untracked
  paths, are never committed, and can only exclude.

Not adopted: FUSE virtual clones (Linux only, and the application would have
to host `lore service run`; the adapter must keep passing `LoreVfsType::None`
because `Default` now means FUSE on Linux), `--fast-flush` (a crash drops every
index entry the file held, including unpushed revisions and branches),
`[auth]` in the user-level `config.toml`, `lore-unix://` remotes, and restoring
an archived branch with `branch create <name> --id <id>`, which also attaches
the working copy to the restored branch at its old revision and so needs its
own interface design.

Build and test notes:

- Lore v0.14.0 links a prebuilt static SWFS library on Windows x86-64
  (`lore-revision/native/swfs`: `swfs_d.lib` for the dev profile, `swfs.lib` for
  release). Its build script notes that the binary's own `+crt-static` supplies
  the C runtime, which upstream's `.cargo/config.toml` sets and this client does not.
  Both profiles link with this client's configuration. The only trace is linker
  warning `LNK4099` about the missing `swfs.pdb`, which is expected, and the binaries
  import only system DLLs (the Universal CRT API sets), no VC runtime DLL. Re-check
  this when upgrading.
- `lore-fuse` is Linux-only, speaks `/dev/fuse` directly and needs no system
  library.
- `cargo test instance_clone_matches_the_real_lore -- --ignored --test-threads=1`
  drives a real shared-store repository and checks the event contract the
  frontend parses. Run it after every Lore upgrade; it isolates Lore's global
  state through `LORE_GLOBAL_PATH`, which is why it is ignored by default.

Deployment compatibility: the branch metadata keys `archived`, `restored`,
`restoring` and `released` are now reserved for archives and restores. A value an
application stored under one of them must be removed or renamed before Lore
Server or the library is upgraded; the client never writes them. A call relayed
to the Lore service carries one more variable, so end a running Lore service
after upgrading the desktop client. Lore Server changes (the mutable-store swap
contract, `remote` immutable stores trusting their upstream by default, the QUIC
request-failure log target) apply when the server is upgraded, which this
change does not do. The E2E stack's pinned `0.10.1` server is unchanged, so live
compatibility must still be tested against the deployment in use.

### Behavior carried forward from v0.13.0

The v0.13.0 upgrade made these adaptations, and they still hold for the pinned version:

- Interactive login now has `reuse_session`. The adapter sets it to `0` so an
  explicit login still opens authentication and lets the user change accounts.
  Local user-info emits `AuthUserToken` before `AuthUserInfo` for stored logins;
  our calls keep `with_identity_token` and `with_access_token` at `0`, so the
  new token event contains no token string. Display-name parsing still consumes
  `AuthUserInfo`. New refresh/session fields do not change the current UI.
- FFI code `52` is `LinkDivergent`. The native name table and both UI languages
  identify it and preserve the upstream path/branch details. Authentication/connection recovery codes
  `16` and `29` retain their meanings. No existing code was renumbered.
- View and ignore patterns now follow gitignore component boundaries and ancestor
  exclusions. Selective Sync uses Lore's own `Filter` for validation and preview,
  replacing the client's duplicate matcher. For example, `!/Engine/Content**`
  does not include that directory's contents; use `!/Engine/Content`. Inclusions
  beginning with a globstar component, including `!/**/a/b`, are rejected before
  applying a view. The vendored `glob-match` exactly matches the tag;
  `quinn-proto` and the upstream patch list are unchanged.
- Names that Windows resolves to a different entry are refused on every platform,
  including names ending in a space or dot, drive designators and reserved control
  directory aliases. Stage/Unstage now validate these names before calling Lore,
  returning a localized error instead of an apparent successful no-op. Leading
  spaces in otherwise valid names remain distinct. Existing unsupported names
  need renaming before they can be tracked by the upgraded library.
- Tracked files continue to participate even when an ignore rule matches them.
  Reset sync and branch switching preserve untracked files; explicit reset purge
  deletes untracked files regardless of ignore rules. The client does not add a
  purge flag or enable the new instance move/delete APIs. The release also fixes
  sparse-view staging, link mounts and merges, history paging, and interrupted
  sync recovery, and improves sync/filter/storage performance.

Deployment compatibility needs separate attention: a `lores://` server must
advertise authenticated endpoints (such as `lores://`), or connections fail with
`NotSupported`. When upgrading Lore Server, a configured `user_url` must implement
`lore.user.v1.RepositoryRegistryService` before the server upgrade; the old
Partition RPCs were removed. Repository writes, branch protection, and presigned
URLs enforce the new documented permissions. Servers without `user_url` do not
need the directory migration. This dependency update does not upgrade a running
server or the E2E stack's pinned `0.10.1` server; live compatibility must be tested
against the deployment in use. Restart external Lore services with a matching
build after upgrading the desktop client.

### Change persisted settings

Use the preferences service and `client-preferences.json` flow for durable settings. Do not add runtime `localStorage` writes.

### Record runtime logs

Use `src/services/logging.ts` for frontend logs instead of adding scattered
`console.error` calls. Lore IPC goes through `invokeLogged`; log command names, durations,
and outcomes only. Never serialize arguments, Token DTOs, or file content. Error text must
pass through `sanitizeLogMessage`.

### Work with a Lore server

Set an explicit server address before starting the desktop application:

```powershell
$env:VITE_LORE_SERVER_URL = "lore://server.example:41337"
bun tauri dev
```

Explicit network tests use the same environment variable. The default test suite must remain offline.

To run the live tests against a local Lore server and the lore-auth-service, follow [E2E_LOCAL_STACK.md](E2E_LOCAL_STACK.md).

### Update public documentation

Keep English and Chinese public documents in sync. Store public images in `docs/img/`, then verify that Git LFS owns each new or replaced image:

```powershell
git check-attr filter -- docs/img/example.png
git lfs ls-files
```

## Project boundaries

These rules protect the most important cross-module behavior:

- React components depend on the stable DTOs in `src/types.ts`, not Lore Rust or C types.
- Frontend Lore operations go through `src/services/lore/`; native validation and repository operations stay in `src-tauri`.
- User-visible text is localized in both supported languages.
- Repository writes must preserve real state and expose failures; destructive actions require clear user confirmation.
- Persistent application preferences use the shared preferences flow.
- Public user and developer documentation remains bilingual.
- Existing unrelated working-tree changes must not be overwritten.

## Validate your change

Run checks in proportion to the files and behavior you changed.

| Change                                   | Required checks                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation only                       | Check links and bilingual parity; run `git diff --check`                                                                                 |
| Frontend logic or components             | `bun run check`, `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`                                                     |
| Rust or Lore adapter                     | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, and targeted Rust tests |
| Desktop permissions, shell, or packaging | `bun tauri build --debug --no-bundle`                                                                                                    |

The baseline delivery checks are:

```powershell
bun run test
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

Committed tests must be self-contained and reproducible across supported platforms. Use temporary
directories, fixtures, mocks, or dependency injection instead of real repositories, local services,
installed browsers, personal accounts, wall-clock performance thresholds, or machine-specific paths.
Test suites and test cases use English names.

## Before opening a pull request

- Review `git status` and the final diff; include only files related to the change.
- Keep English and Chinese interface text and public documentation synchronized.
- Add tests for changed behavior and record any checks that could not be run.
- Confirm that public images are stored through Git LFS.
- Do not commit generated output or temporary browser data.
- For a release, keep the Git tag, `package.json`, Tauri configuration, and Cargo package version aligned.

## Troubleshooting

- **Port 1420 is already in use:** reuse the existing Vite process or stop the specific process that owns the port.
- **The browser preview works but desktop mode fails:** reproduce the issue with `bun tauri dev`; browser sample data does not exercise native repository operations.
- **Local work succeeds but server operations fail:** check `VITE_LORE_SERVER_URL`, connectivity, permissions, and Lore service compatibility.
- **Documentation images appear as ordinary Git objects:** run `git lfs install`, then verify `.gitattributes` and `git check-attr filter`.
- **`cargo test` fails to start on Windows with `STATUS_ENTRYPOINT_NOT_FOUND` (`0xc0000139`):** the test binary has no Common
  Controls v6 manifest. `tauri-plugin-dialog` (through `rfd 0.17`) shows message dialogs with `TaskDialogIndirect`, which only
  comctl32 v6 provides, so every binary that links it needs the manifest. `tauri-build` embeds its manifest into the application
  only, so `build.rs` turns that default off (`WindowsAttributes::new_without_app_manifest`) and links
  `windows-app-manifest.xml`, a copy of tauri-build's default manifest, into every target with `embed-resource`'s
  `compile_for_everything`. Keep the two changes together: having both duplicates the manifest resource. To check a binary, run
  `mt.exe -inputresource:<exe>;#1 -out:<file>`; the application and the test binary must each carry exactly one, identical
  manifest. If a future `tauri-build` links its manifest into every target itself, remove this workaround.
