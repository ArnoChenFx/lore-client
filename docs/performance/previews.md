# Measuring native previews

Use [the desktop fixture](../../scripts/e2e/file-path-check.md) with a built Linux
application and an existing `tauri-driver` to measure actual native reads,
Channel delivery and binary-envelope decoding.

For preview-only measurements, use the fixture's documented environment with
`LORE_PATH_CHECK_PATHS=0` and `LORE_PREVIEW_REPETITIONS=3`. Set
`E2E_EVIDENCE_DIR` to an absolute path under the ignored `artifacts/` directory
or outside the checkout. Generated JSON, logs and screenshots are run artifacts;
do not commit them as source.

The fixture generates PCM WAV and single-entry ZIP_STORED files of 1, 10 and
20 MiB. Each receives one warmup and the requested measured repetitions.
Assertions check WAV body size and boundary bytes, ZIP directory metadata
without the archive body, and a metadata-only WAV request.

## Interpret results

Record the source revision, binary SHA-256, build mode, runtime configuration,
hardware and cache conditions with each run. Compare like-for-like builds;
debug, release, JIT-disabled and cold-cache measurements are distinct workloads.
Pause unrelated compilation and browser measurement processes.

The measured duration includes native reading, actual Channel delivery and
envelope decoding. It does not include rendering an audio player or archive
view. The envelope contains a four-byte metadata length, JSON metadata and raw
body; byte counts exclude the separate Channel header and transport framing.

RSS is sampled every 25 ms for the application and its descendants. Summed RSS
may double-count shared pages, and short calls can finish between samples.
Report sample counts and sampled maxima, not exact peaks. `VmHWM` describes the
whole process lifetime. Baseline differences after earlier calls can reflect
allocator retention and do not establish per-call allocations or leaks.

Warm-cache, workspace-local files and single-entry stored ZIPs do not establish
performance for compressed or many-entry archives, revision Store reads, cold
starts or release builds. Measure the affected workload before choosing an
archive-read or IPC optimization.
