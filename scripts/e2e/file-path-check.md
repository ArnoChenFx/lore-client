Run against an already-built Linux application and an existing `tauri-driver`:

```sh
LORE_CLIENT_APP=/absolute/path/to/lore-client \
LORE_EXPECTED_APP_SHA256=<sha256-of-that-binary> \
E2E_EVIDENCE_DIR=/absolute/path/to/evidence \
LORE_PREVIEW_BUILD_MODE=debug \
LORE_PREVIEW_RUNTIME_NOTE='describe the actual desktop wrapper and JIT configuration' \
node scripts/e2e/file-path-check.mjs
```

`TAURI_DRIVER_URL` defaults to `http://127.0.0.1:4444`. Bun and Python 3.11+ must
be available. The script builds only a temporary browser bundle of the installed
Tauri `Channel`; it does not build the application, modify its assets or start
a driver. Its independent XDG and Lore profile leaves `HOME` untouched.

The path checks create actual files named `asset`, `asset `, ` asset`, ` ` and
` dir /leaf `. They exercise selective Stage/Unstage, Commit, typed Revision
files, workspace/Revision text and preview metadata, filtered Diff and Reset.
Sibling contents and exact path values are asserted. Empty explicit paths,
directory traversal, absolute paths and an external symbolic link are rejected.
These are native IPC checks; frontend menu/controller contracts have separate
tests. Remote locks require a server and are not claimed as an offline desktop
check.

The preview baseline creates valid PCM WAV and ZIP_STORED files of exactly 1,
10 and 20 MiB. Each receives one warm-up and three measured reads. Actual Tauri
Channel messages provide the envelope byte count, metadata and payload sizes;
WAV body length and boundary bytes are checked against the real source. ZIP
directory metadata must omit the archive body. A metadata-only request is also
checked. `LORE_PREVIEW_REPETITIONS` accepts 1–10, and
`LORE_PATH_CHECK_PREVIEWS=0` runs only the path regressions.
`LORE_PATH_CHECK_PATHS=0` runs only the preview measurements.

Timing includes actual native reads, Channel delivery and envelope decoding, but
does not include rendering an audio player or archive view. Separate Node wall
time includes WebDriver overhead. Every 25 ms the observer samples RSS of the
owned application and its descendants. Sum RSS counts shared pages repeatedly,
sampling can miss brief peaks, and process `VmHWM` is a lifetime high-water mark.
This is neither PSS nor a leak test. Warm-cache, single-entry stored ZIP results
do not establish cold-start, compressed-archive or many-entry performance.
Record the actual build/runtime mode when comparing results.

Evidence includes `path-results.json`, `preview-measurements.json` and
`summary.json`, tied to the executable SHA-256. On success the WebDriver session
is closed and only the script's own temporary repositories/profile are removed.
On failure the owned workspace is retained for diagnosis and its path is
recorded in the summary.
