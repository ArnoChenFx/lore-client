# Native preview baseline

The measured ZIP directory previews already send only a few hundred bytes over
the application binary envelope. These observations do not justify ZIP range
reads or a broader IPC rewrite. Audio previews deliver their complete body and
their observed latency grows with the payload; a release-build measurement of
that path would be more useful before choosing an optimization.

## Reproduce and scope

Use [the real desktop fixture](../../scripts/e2e/file-path-check.md) with a built
Linux application and an existing `tauri-driver`. Set `LORE_PATH_CHECK_PATHS=0`
for the isolated preview run and `LORE_PREVIEW_REPETITIONS=3`; record the binary
SHA-256, build mode and desktop runtime. The fixture generates real PCM WAV and
single-entry ZIP_STORED files of exactly 1, 10 and 20 MiB, performs one warmup and
three measured reads of each, and validates delivered metadata and contents.

This run used product source
`41a4f817f536f1e2b032bd411201e7f4c73b176e` and executable SHA-256
`b6e0ecdbe48c02e16ea937d62933dc803878c00da24a22fd1e403083eee533cc`.
Environment: Linux 6.18.55, AMD EPYC 9V74, cgroup quota 4 CPU cores/32 GiB,
**debug binary**, PRoot, Xvfb/WebKitGTK, **`JSC_useJIT=false`**. Other compilation
and browser measurement processes were paused. One independent blank UI session
served all fixtures in order; each fixture reused filesystem and allocator
caches. This is not a release-build, cold-cache or cold-start benchmark.

[Per-call evidence](results/previews.json) preserves byte counts, individual
timings, memory baselines, sampled maxima and sample counts. It omits repeated
payload boundary arrays and individual process samples, and records the SHA-256
of the full capture. The failed preliminary run that exposed incorrectly named
archive DTO fields is not included; these results are from the corrected
camelCase contract.

## Observations: 2026-10-20

Times are medians of the three warm samples. The measured duration starts in the
WebView and includes the native read, actual Channel delivery and binary-envelope
decoding. It does not include rendering an audio player or archive view.

| Fixture | Source MiB | Duration ms | Body bytes | Envelope bytes | Channel body chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| PCM WAV | 1 | 124 | 1,048,576 | 1,048,712 | 5 |
| PCM WAV | 10 | 521 | 10,485,760 | 10,485,898 | 41 |
| PCM WAV | 20 | 1,012 | 20,971,520 | 20,971,658 | 81 |
| ZIP_STORED | 1 | 14 | 0 | 326 | 1 |
| ZIP_STORED | 10 | 9 | 0 | 330 | 1 |
| ZIP_STORED | 20 | 14 | 0 | 330 | 1 |

The envelope consists of a four-byte metadata length, JSON metadata and raw
body. Counts exclude the separate small Channel header and transport framing,
so they are not total on-the-wire traffic. WAV body size and boundary bytes
match the real file. ZIP metadata contains the single expected entry and no
archive body. A separate metadata-only WAV request returned a 139-byte envelope
with zero body bytes.

RSS was sampled every 25 ms. The values below are the largest sampled values
among three calls, not exact peaks; the baseline column is the median native
application RSS immediately before those calls.

| Fixture | Source MiB | Baseline app RSS MiB | Sampled app max MiB | Sampled app + descendants max MiB | Samples per call |
| --- | ---: | ---: | ---: | ---: | --- |
| PCM WAV | 1 | 229.0 | 229.4 | 562.6 | 7 / 7 / 7 |
| PCM WAV | 10 | 260.3 | 268.6 | 627.1 | 28 / 22 / 23 |
| PCM WAV | 20 | 291.3 | 311.3 | 694.4 | 42 / 46 / 42 |
| ZIP_STORED | 1 | 229.7 | 229.8 | 561.8 | 3 / 3 / 2 |
| ZIP_STORED | 10 | 261.0 | 261.0 | 605.9 | 3 / 2 / 2 |
| ZIP_STORED | 20 | 270.6 | 270.6 | 614.3 | 2 / 2 / 2 |

The ZIP calls are shorter than the sampling interval in many repetitions: their
two or three samples cannot establish the true transient peak. Summed RSS can
double-count shared pages and is not PSS or an allocation count. `VmHWM` in the
evidence belongs to the entire application lifetime. Different fixture baselines
also reflect earlier calls and allocator retention; differences between table
rows must not be interpreted as per-call allocations or leaks.

The baseline covers bounded, workspace-local previews. Compressed or many-entry
archives, revision Store reads, cold caches and release builds need their own
measurements before extending these conclusions.
