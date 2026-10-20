# Measuring LocalChanges performance

Use the production `LocalChanges` component fixture to measure list rendering
and interaction costs independently of repository loading and native operations.
Keep generated JSON, logs and screenshots in the ignored `artifacts/` directory
or outside the checkout. Attach run evidence to CI artifacts when needed; do not
commit it as source.

## Run

With repository dependencies and Chromium installed:

```sh
bunx tsc -p scripts/performance/tsconfig.json --pretty false
bun scripts/measure-local-changes.mjs \
  --sizes=1000,5000,10000,20000 \
  --repeats=3 \
  --output=artifacts/performance/local-changes.json
```

`LORE_CLIENT_BROWSER_PATH` selects an installed Chromium executable. The runner
builds a separate fixture entry using the repository's production Vite and React
Compiler configuration. It owns its loopback server, browsers and temporary
profiles, and cleans them on success and failure.

For selection, keyboard, filtering, resize and menu-focus regressions:

```sh
LORE_WINDOW_EVIDENCE=artifacts/performance/local-changes-window.json \
  bun scripts/check-local-changes-window.mjs
```

## Compare runs

Use the same hardware, browser, viewport, fixture data and build configuration
before and after a change. Pause unrelated builds and browser suites. Record
the actual component dimensions: stylesheet minimum widths can override the
requested fixture width.

Each measurement starts a fresh browser/profile, warms up with 100 files, then
mounts the requested number of modified text files in tree and flat views. It
selects a visible file, filters to an exact filename and clears the filter.
The fixture uses real preferences, translations, CSS and React state updates.
It verifies the full matching file count even when only a window of rows mounts.

Mount timing starts at `root.render`; interaction timing starts at the browser
input capture listener. Both end two animation frames after the expected visible
state, with checks polling every 10 ms. These are component measurements with
observation/frame overhead, not INP or full desktop-workflow latency. Three
samples do not support small-percent or sub-frame speedup claims.

DOM counts describe mounted HTML/SVG elements. Retained JavaScript heap is read
after forced GC. On Linux, process-tree RSS is sampled approximately every
100 ms; shared pages may be counted repeatedly and brief peaks may be missed.
It is not PSS or exact peak memory.

The runner stops a repetition above its configured RSS budget and skips larger
sizes after excessive latency or sampled memory use. Preserve those failures
and omissions in the run artifact. Do not claim a speedup for a size whose
baseline did not complete. Resource limits are experiment safeguards, not
product requirements or CI gates.

Native preview measurements have a separate [measurement guide](previews.md).
