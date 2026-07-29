# Lore Client Developer Guide

[中文](../zh/DEVELOPMENT.md) · [User guide](../../README.md)

This guide is the shortest path from a fresh checkout to a validated contribution. For product features, read the user guide.

## Quick start

### Prerequisites

Install:

- Bun 1.3 or newer.
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

| Task                                                                   | Main locations                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Application-level UI, shell, and dialogs                               | `src/app/`, `src/App.tsx`, `src/styles.css`             |
| Domain UI and workflows such as revisions, local changes, and branches | `src/features/<domain>/`                                |
| Cross-domain primitives and pure helpers                               | `src/shared/ui/`, `src/shared/lib/`                     |
| Stable frontend data types                                             | `src/types.ts`                                          |
| Frontend Lore calls                                                    | `src/services/lore.ts`                                  |
| Native Lore operations                                                 | `src-tauri/src/lore_adapter.rs`, `src-tauri/src/lib.rs` |
| Offline Revision author display cache                                  | `src-tauri/src/revision_author_cache.rs`, `src/services/lore.ts` |
| Preferences and persisted layout                                       | `src/services/preferences.ts`, `src/hooks/`             |
| English and Chinese UI text                                            | `src/i18n/locales/`                                     |
| Browser-preview sample data                                            | `src/data.ts`                                           |
| UI and visual validation                                               | `scripts/`                                              |
| Public documentation and images                                        | `README.md`, `docs/en/`, `docs/zh/`, `docs/img/`        |

Do not commit generated dependencies, build output, Rust targets, temporary browser profiles, or generated analysis directories.

## Common development tasks

### Change the interface

Start with `bun run dev`, update the relevant component and shared styles, then add or update nearby Vitest coverage. Use semantic design tokens so the same change works in light and dark themes.

All user-visible text, accessible names, tooltips, confirmations, and errors must use the localization resources. Update the English and Simplified Chinese resources together.

Keep domain components and their tests in the matching `src/features/<domain>/components/`
directory, and keep application-shell components in `src/app/components/`. Cross-domain consumers
should import from the domain root `index.ts` instead of reaching into another domain's internal
`components/` path. Only controls and pure helpers with real multi-domain reuse belong in
`src/shared/`.

### Add or change a Lore-backed feature

Keep the integration path consistent:

1. Define or update the stable frontend DTO in `src/types.ts`.
2. Add the frontend operation in `src/services/lore.ts`.
3. Keep feature state and orchestration in the matching `src/features/<domain>/` module; let
   `src/app/` compose its narrow controller interface and keep `src/App.tsx` as the application root.
4. Implement the native command in `src-tauri/src/lore_adapter.rs` and register it in `src-tauri/src/lib.rs`.
5. Return structured results and errors that the interface can localize.
6. Add frontend and Rust coverage appropriate to the behavior.

Desktop mode must show real failures. Do not substitute sample data or report success when a Lore operation fails.

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

### Update public documentation

Keep English and Chinese public documents in sync. Store public images in `docs/img/`, then verify that Git LFS owns each new or replaced image:

```powershell
git check-attr filter -- docs/img/example.png
git lfs ls-files
```

## Project boundaries

These rules protect the most important cross-module behavior:

- React components depend on the stable DTOs in `src/types.ts`, not Lore Rust or C types.
- Frontend Lore operations go through `src/services/lore.ts`; native validation and repository operations stay in `src-tauri`.
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
| Frontend logic or components             | `bun run check`, `bun test`, `bun run lint`, `bun run format:check`, `bun run build`                                                     |
| Rust or Lore adapter                     | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, and targeted Rust tests |
| Desktop permissions, shell, or packaging | `bun tauri build --debug --no-bundle`                                                                                                    |

The baseline delivery checks are:

```powershell
bun test
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
