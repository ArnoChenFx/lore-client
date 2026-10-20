# LocalChanges performance measurements

Windowing the 5,000-file tree fixture reduces mounted HTML/SVG elements from
65,719 to 357, median mount time from 1.39 seconds to 49 ms, and visible-file
selection from 443 to 65 ms. The complete file-selection model remains available
for actions on offscreen files. These are component measurements under the
conditions below.

## Reproduce

From the repository root, with its dependencies and Chromium installed:

```sh
bunx tsc -p scripts/performance/tsconfig.json --pretty false
bun scripts/measure-local-changes.mjs \
  --sizes=1000,5000,10000,20000 \
  --repeats=3 \
  --output=/tmp/local-changes-measurement.json
```

`LORE_CLIENT_BROWSER_PATH` can select an installed Chromium executable. The script
builds a separate fixture entry using the repository's production Vite and React
Compiler configuration, serves that temporary build on a loopback port, and
launches its own headless browser. It does not use an existing application server
or add a testing interface to production code. Owned servers, browsers and
temporary profiles are cleaned on success and failure.

Each measured repetition starts a fresh browser/profile, mounts 100 files and
selects a row as warmup, then mounts the target fixture. Files are modified text
files arranged in directories of 100; all are unstaged. Real `LocalChanges`,
preferences, translations, CSS and React state updates run in the fixture.
Selection and filtering use Chromium input events. The parent updates its
selected IDs; no repository scan, native operation or Diff panel is included.

The recorded actions are:

- Mount the requested file list.
- Select the second file row.
- Filter to the exact name `asset-000001.txt`.
- Delete the filter text to restore the complete list.

Mount timing starts immediately before `root.render`; interaction timing starts
in the browser's click/input capture listener. Both end two animation frames
after the expected visible state. State checks poll every 10 ms. These values
include observation/frame overhead; they are neither INP measurements nor
physical display latency. Frame/poll cadence imposes a floor on short results;
three samples do not support sub-frame or small-percent speedup claims.
The script verifies the summary's matching file count,
so the same harness supports both complete and windowed DOM rendering.

DOM elements are counted after mount. Retained JavaScript heap is read after
forced GC; `Memory.getDOMCounters` also includes detached nodes. Linux process RSS
is sampled approximately every 100 ms from `/proc/*/status` parent relationships.
The reported sum includes Chromium's browser/renderer/utility processes and can
count shared pages repeatedly. It is not PSS, unique memory use, native
application memory, or an exact instantaneous peak.

To keep the measurement bounded, a repetition exceeding 1,536 MiB sampled browser
RSS is stopped with an error and partial evidence. Larger sizes are skipped when
the previous size exceeds a 2-second mount, 500-ms selection, or 1,024 MiB sampled
RSS. These are experiment resource limits, not product requirements or CI gates.

## Baseline: 2026-10-20

Product source: `fcf7663084dadb6581b6e4a272707e7723bf8ffd`.
[Raw results](results/local-changes-before.json) record each sample and the
measurement-source SHA-256.

Environment: Linux 6.18.55, AMD EPYC 9V74, container CPU quota 4 cores, memory limit
32 GiB, Chrome 154.0.8037.57; viewport 1440 × 900, actual component width 980 CSS pixels,
device scale factor 1. Compilation and other browser suites were paused during
measurement. No CPU throttling was applied. Three independent browser samples
were recorded per row; times below are medians, RSS is the maximum sampled sum.
The fixture requested 720 pixels, but production `#root { min-width: 980px }`
overrode that width. The original JSON's `componentWidth: 720` records the
requested value; a real DOM check confirmed 980 × 900. The comparison uses the
same fixture and layout.

| View | Files | Mount ms | Select ms | Filter ms | Clear filter ms | DOM elements | Retained JS MiB | Browser RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tree | 1,000 | 286.9 | 118.3 | 52.3 | 274.2 | 13,239 | 7.0 | 697.9 |
| Tree | 5,000 | 1,385.4 | 442.6 | 148.4 | 1,350.6 | 65,719 | 24.4 | 1,145.1 |
| Flat | 1,000 | 320.4 | 108.5 | 63.9 | 307.5 | 14,099 | 7.1 | 707.2 |
| Flat | 5,000 | 1,632.0 | 519.7 | 156.9 | 1,620.6 | 70,099 | 25.1 | 1,199.1 |

Empty-fixture browser RSS was approximately 511–517 MiB before warmup. The
10,000-file baseline was skipped after the 5,000-file resource/latency thresholds
were reached. A separate preliminary 10,000-file attempt hit the 1,536 MiB hard
budget and produced no complete timings. A 20,000-file baseline was not attempted.
Neither omitted nor interrupted cases count as successful measurements.

At the measured viewport, directory rows were 29 CSS pixels and file rows were
36 pixels in both views. A separate two-file geometry probe also measured a
renamed file with its source/target description at 36 pixels. This does not prove
fixed geometry for arbitrary fonts, styles or display settings.

## After windowing: 2026-10-20

Combined product and measurement source:
`8afb978082a37fae7364799cd4e7dbf39e6262e7`.
[Raw results](results/local-changes-after.json) contain 24 successful independent
browser samples, with no skipped sizes or runtime exceptions. Every repetition
confirmed the complete matching file count and the actual 980 × 900 component
geometry. The same hardware, browser, fixture data, production build pipeline,
viewport, warmup, input actions and timing method were used.

The runner received a metadata-only correction between captures: it labels 720
as the requested width, reads the actual DOM dimensions after warmup, and records
cgroup CPU/memory limits. Thus the aggregate measurement-source hashes differ;
the HTML/TSX fixture files and timed operations are unchanged.

| View | Files | Mount ms | Select ms | Filter ms | Clear filter ms | Mounted file rows | DOM elements | Retained JS MiB | Browser RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tree | 1,000 | 49.6 | 42.7 | 35.9 | 43.7 | 15 | 357 | 3.3 | 590.2 |
| Tree | 5,000 | 48.9 | 65.1 | 48.9 | 52.2 | 15 | 357 | 5.3 | 605.5 |
| Tree | 10,000 | 81.1 | 81.5 | 37.8 | 57.3 | 15 | 357 | 7.7 | 618.3 |
| Tree | 20,000 | 93.6 | 108.2 | 42.8 | 87.5 | 15 | 357 | 13.2 | 638.2 |
| Flat | 1,000 | 49.5 | 37.1 | 32.9 | 51.1 | 17 | 355 | 3.4 | 590.4 |
| Flat | 5,000 | 49.5 | 63.5 | 39.1 | 59.6 | 17 | 355 | 5.8 | 605.8 |
| Flat | 10,000 | 81.4 | 79.1 | 50.9 | 57.6 | 17 | 355 | 8.8 | 620.0 |
| Flat | 20,000 | 93.9 | 117.7 | 55.0 | 71.2 | 17 | 355 | 15.0 | 652.7 |

The initial viewport now mounts a bounded number of rows as the model grows.
Model size still affects CPU and retained JavaScript memory; the 20,000-file
selection measurement remains approximately 108–118 ms with this observer.
There is no valid 10,000/20,000-file before/after speedup ratio because the
corresponding baseline did not complete.

This evidence supports the local list change. It does not establish full
desktop-workflow performance or justify unrelated Settings decomposition or
generic type generation. Native preview measurements are documented separately
in [the preview baseline](previews.md).
