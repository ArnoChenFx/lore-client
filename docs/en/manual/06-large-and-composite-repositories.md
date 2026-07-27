# Large and Composite Repositories

Lore Client’s large-project features control what appears in this workspace, what is
retrieved through explicit dependencies, what composition enters shared history, and
what remains a private local overlay.

## Reduce the workspace with a View

1. Open **Repository Tools → Selective Sync View**.
2. Enter ordered path rules.
3. Click **Preview impact**.
4. Review included files, materialize/dematerialize counts, estimated size, and paths.
5. Click **Apply View** only while the preview remains current and valid.

Example:

```text
# Exclude everything
**
# Include the current map subtree
!Content/Maps/
```

Applying a View can remove historical files from local disk, but never deletes them from
the Revision. Local changes, staging, or conflicts block application.

## Use file dependencies for a task closure

A dependency edge states that a source file requires a target file. Tags can distinguish
purposes such as `runtime` or `high-resolution`.

Enter root files, optional tags, recursion, a depth (`0` means unlimited), and optionally
reverse direction to ask “what depends on this?” The result graph supports left-button
panning, pointer-centered wheel zoom, zoom buttons, and Fit. Selecting a node can fill
the edge editor; selecting an edge shows exact paths/tags and enables deletion.

**Dependency-driven Sync** materializes the selected closure after confirmation. It
cannot discover unregistered dependencies by guessing file contents.

## Layer: a private local overlay

Layer creation uses Mount path, Source repository, Source path, and optional Metadata.
Removing one can either keep untracked Layer files or **Purge Layer files**, which is a
destructive local-disk action.

A Layer never enters the parent history. Use it for private tools, assets, or CI overlays;
use a Link when every collaborator must reproduce the same composition.

## Link: a pinned dependency in parent history

Link creation uses Repository URL, Mount path, Source path, optional Pin, and **Disable
automatic Link branching**. Add, pin update, and removal are staged for the next parent
Revision.

A Pin fixes an exact source Revision; a moving source Branch cannot silently upgrade the
parent. The linked repository remains a separate permission boundary.

## Shared Store: reuse content across Instances

Create a Shared Store under **Client Settings → Storage** and optionally enable automatic
use. Future Clones locate a Store by remote. Automatic mode cannot be overridden off for
one Clone in the current supported Lore version.

Shared Store reuses Fragments and cache, not View, Branch, staging, or local changes. A
missing directory is reported even if its configuration still exists.

## Binary and structured Diff

| Type | Preview |
| --- | --- |
| Images, TGA, TIFF, DDS, EXR | In-app image preview; non-browser formats are converted at the Rust boundary, with HDR tone mapping for EXR. |
| KTX2 | WebGL Canvas using the app-bundled Basis transcoder, without a CDN. |
| PDF | In-app parser drawing the current page only. |
| CSV | Bounded, read-only table. |
| OBJ, FBX, GLTF, GLB | In-app Canvas without external resource loading. |
| WAV, OGG, MP3, FLAC | Non-autoplay in-app audio controls; the underlying codec must still be available to the system media pipeline. |
| TTF, OTF | Lifecycle-bound in-memory font specimen, unloaded when the preview closes. |
| ZIP, Quake PAK | Read-only directory and size information without extracting entry bodies. |
| Unity AssetBundle, Godot PCK | Bounded directories; LZMA, legacy, or encrypted directories explicitly fall back to container information. |
| Unreal PAK | Reliable footer and index metadata; versioned indexes are not guessed as directory entries. |
| UAsset/UMap, Unity `.assets`, Godot `.res`, Blender `.blend` | Stable headers, versions, sizes, and safely countable object types. |
| Other binary | Metadata/comparison or an explicit unsupported reason. |

Content is read on demand for the primary selection. Disabling Binary Diff stops those
reads in both workspace and Revision changes.

Container directories are entry-limited, texture decoding has dimension and memory budgets,
and every source file remains subject to the 20 MiB embedded-preview limit. Previewing never
extracts archives, executes scripts, follows symlinks, or reads resources outside the container.

## Choosing the mechanism

| Need | Use |
| --- | --- |
| Only selected paths on this machine | View |
| Root assets and explicit dependencies | Dependency-driven Clone/Sync |
| Private local overlay | Layer |
| Reproducible pinned external component | Link |
| Reuse storage across directories | Shared Store |
| Independent work states for one repository | Multiple Instances |

[Previous: History](05-history-branches-and-tags.md) · [Next: Clone Page Reference](07-clone-page-reference.md)
