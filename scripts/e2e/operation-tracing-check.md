Run a built Linux application with a running `tauri-driver` on the same machine:

```sh
LORE_CLIENT_APP=/absolute/path/to/lore-client \
LORE_EXPECTED_APP_SHA256=<sha256-of-that-binary> \
E2E_EVIDENCE_DIR=/absolute/path/to/evidence \
node scripts/e2e/operation-tracing-check.mjs
```

The script does not build the application or start a driver. `TAURI_DRIVER_URL`
defaults to `http://127.0.0.1:4444`. The normal Linux desktop environment and its
`DISPLAY` must already be available to the driver.

Two disposable offline workspaces each receive 20,000 files of about 2 KiB.
`LORE_TRACE_FILE_COUNT` changes this size. Native progress opens after a delay, so
a smaller workload may finish before a stream is emitted and correctly fail the
stream assertions. The default matches the existing real Lore progress test.

The native checks cover missing-context rejection, simultaneous A/B requests,
stage → commit → typed history under one context per workflow, and distinct child
operation IDs with matching stream/result ownership. A trailing space in workspace
A's directory also checks that scope identity survives exactly.

The UI check opens both real workspaces, stages a real file through the app, and
temporarily holds delivery of the actual native stage and status responses. It
checks that stage and authoritative refresh share the app-generated context, and
that A remains counted once after switching to B. All delayed values are genuine
native responses; no synthetic stream or substitute native result is used.
`LORE_TRACE_UI=0` runs only the native checks, which is useful for the atomic
protocol batch before the workflow/UI batch is available.

The generated launcher isolates XDG config/data/cache/state and Lore global/auth
stores without replacing `HOME`. Repositories and stores are deleted only after
a successful run and successful WebDriver session close. Failed runs retain the
temporary workspace for diagnosis; its location is recorded in `summary.json`.
Evidence remains outside the owned workspace and includes native results/streams,
the UI invocation trace, screenshots, and a summary tied to the executable hash.
