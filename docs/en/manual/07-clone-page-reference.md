# Clone Page Reference

Everyday required fields appear first; advanced materialization and compatibility choices
are collapsed. A normal Clone needs only a local directory name and parent directory.

![Lore Client Clone page with Advanced options in English](../../img/lore-client-clone-advanced-en.png)

_Advanced options expose the history anchor, selective-sync rules, and deeper materialization choices._

## Complete parameter map

| Parameter | Default | Accepted input | What it actually controls |
| --- | --- | --- | --- |
| **Local directory name** | Prefilled from remote repository name | One directory component | Folder name of the new Instance; does not rename the remote. |
| **Target parent directory** | Not selected | Existing writable directory | Where the new child folder is created. |
| **Target Revision or Branch** | Default Branch Latest | Branch name, full or unique short Revision ID | Exact initial history anchor. |
| **Selective sync rules** | Complete workspace | View rules file | Which historical paths are materialized locally; never edits the remote Revision. |
| **Use Shared Store** | Device policy/matching Store | On/off | Where reusable Fragments are stored; does not share work state. |
| **Bare Clone** | Off | On/off | Whether to skip workspace materialization entirely. |
| **Direct File I/O** | Off | On/off | Whether file materialization bypasses memory mapping. |
| **Layer repository** | Empty | Repository name/ID on the same remote | Source repository for an initial local overlay. |
| **Layer metadata key** | Empty | Metadata key | How main and Layer Revisions are paired by equal metadata value. |
| **Dependency root files** | Empty | Repository-relative paths, line/comma separated | Starting points of the materialized dependency closure. |
| **Dependency tags** | Empty | Tags, line/comma separated | Which tagged dependency edges can participate. |
| **Include transitive dependencies** | Off | On/off | Direct edges only versus recursive traversal. |
| **Dependency depth limit** | `0` | `0–1024` | Maximum edge distance; `0` is unlimited. |

These parameters separately control location, history anchor, materialized content,
storage/access method, and optional composition. They never modify the remote repository
or automatically Push.

## Remote repository summary

The read-only summary shows description/URL, default Branch, creator, creation time,
reported permissions, and the resolved or deferred target Revision. Creator is remote
metadata, not local commit identity. Unknown reported permissions do not imply write
access. A displayed target is the exact resolved Revision; otherwise Latest is resolved
again when Clone runs.

## Basic parameters

### Local directory name

Required. A single-level name created below the selected parent. Absolute paths, parent
traversal, nested names, and overwriting a non-empty directory are rejected.

Changing the prefilled name changes only the local folder, not Repository ID, remote
name, or default Branch. With parent `D:\Work` and name `Project-A`, the result is
`D:\Work\Project-A`; do not enter the full path in the name field.

### Target parent directory

Required. **Choose** opens the system directory picker. Picker failure appears beside
the field instead of looking like an ignored click.

The parent may contain other projects but must be writable. Clone creates a new child and
does not turn or scan the parent itself as the repository.

### Cancel and Start Clone

Cancel closes the dialog and is unavailable while cloning. Start Clone requires both
directory fields.

## Advanced options

### Target Revision or Branch

Optional. Accepts a full Revision ID, unique short Revision ID, or remote Branch name.
Blank means the default Branch Latest. A historical Revision remains that exact target;
it is not presented as the default Latest.

A Branch name resolves its real Latest when Clone executes. A Revision ID stays fixed
even if Branches later move. A short ID must be unique. This option does not create a
Branch or change remote Latest.

### Selective sync rules

**Choose File** selects a View rules file; **Clear** restores the complete workspace.
Bare mode disables this because no files are materialized.

Rules are repository-relative inbound materialization rules for the new Instance.
Excluded paths remain in history and can be materialized later by changing the View.

### Use Shared Store

Lore looks up a Store for this remote. When device-level automatic use is enabled, the
checkbox is fixed on. A matching Store shows size and file count. Missing configuration
returns an explicit Clone error.

Shared Store changes Fragment placement/reuse only. The new Instance still owns separate
Branch, View, staging, and local changes. Unchecking does not delete an existing Store.

## Advanced Clone modes

### Bare Clone

Clones repository state and the Revision tree without writing workspace files. It disables
View, Direct File I/O, initial Layer, and dependency materialization options.

### Direct File I/O

Bypasses memory-mapped file access for compatibility diagnosis and may reduce performance.
Leave it off unless a filesystem issue requires it. Unavailable with Bare.

It does not change Revision content, Fragment format, or the selected file set. Typical
reasons are special/network filesystems or security software incompatible with mapping.

## Initial Layer

| Parameter | Meaning |
| --- | --- |
| **Layer repository** | Repository name or identity on the same remote. It identifies an independent Partition, not a local path or mount point. Required before Metadata key is enabled. |
| **Layer metadata key** | Optional key such as `release`. Lore reads the main target Revision’s value and finds a Layer Revision with the same value; this field is not a version number. |

The Layer belongs only to the new Instance and does not enter main repository history.

Empty repository means no initial Layer. With a repository and no key, Lore uses its
default Layer resolution. A missing metadata match produces a failure rather than a
random Layer Revision.

## Dependency-driven selective Clone

- **Root files**: repository-relative paths separated by lines or commas. Blank keeps the
  normal View-defined workspace. Each root itself is included.
- **Dependency tags**: filter explicit edges; disabled without roots.
- **Include transitive dependencies**: traverse beyond direct dependencies.
- **Depth limit**: `0–1024`; `0` is unlimited and is enabled only with transitive traversal.

Bare disables the entire dependency area.

Tags filter dependency edges, not filenames. Empty tags impose no tag filter. With
transitive traversal off, roots plus one-hop direct dependencies are selected. Depth
counts dependency-edge hops, not folders: `1` is direct dependencies and `2` adds their
dependencies.

## How parameters combine

```text
target Branch/Revision
  → exact Revision file tree
  → View path scope
  → dependency roots and closure
  → Shared Store or regular storage
  → workspace materialization
  → optional initial Layer
```

View and dependency selection jointly constrain materialization; make sure roots are not
excluded by the View. Bare stops before materialization and therefore disables its
options. Direct File I/O changes how the final set is written, not which files are in it.

## Example combinations

### Normal team workspace

Leave target and View blank, follow the device Shared Store policy, and leave Bare,
Direct I/O, Layer, and dependency roots off.

### One map and its assets

Select a View containing the map subtree, or use the map as a dependency root with
transitive traversal and optional `runtime` tags. View is path-based; dependency closure
is edge-based. When combined, both selections constrain the result.

### Metadata-only CI

Enable Bare and leave all materialization options off.

### Private tool overlay

Use a normal Clone with an initial Layer and optional metadata pairing. This does not
propagate to collaborators.

## Common disabled states

| Symptom | Reason |
| --- | --- |
| Start Clone disabled | Parent or directory name is empty. |
| View/Layer/dependency controls disabled | Bare is enabled. |
| Direct File I/O disabled | Bare is enabled. |
| Layer metadata key disabled | Layer repository is empty. |
| Tags/recursive disabled | Dependency roots are empty. |
| Depth disabled | Transitive traversal is off or roots are empty. |
| Shared Store cannot be unchecked | Device automatic use is enabled. |

[Previous: Large Repositories](06-large-and-composite-repositories.md) · [Next: Repository Tools](08-repository-tools-reference.md)
