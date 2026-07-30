# Local Changes and Creating Revisions

## Scan and views

Local Changes has **Unstaged** content that will not enter the next Revision and **Staged**
content that will. Switch between Flat and Tree views. Expand/Collapse all changes folder
visibility only; it does not clear file or folder selection.

![Lore Client Local Changes, staging areas, and Diff in English](../../img/lore-client-local-changes-light.png)

_Unstaged and Staged content remain separate while the right pane loads the real Diff for the primary selection._

File and directory selections are independent. Selecting a directory does not implicitly
highlight every child file.

## Desktop selection

| Input | Result |
| --- | --- |
| Click | Select one object. |
| Ctrl/Cmd-click | Add or remove one object. |
| Shift-click | Select a contiguous range from the primary item. |
| Ctrl/Cmd+A | Select the current actionable set. |
| Right-click selected item | Preserve the aggregate selection and promote the clicked item as primary context. |

Collapsing a directory does not clear selected descendants.

## Stage and Unstage

Double-click, press Enter, click the hover-only `+`/`−`, use the context menu, or choose
**Stage all/Unstage all**. A directory action expands to explicit repository-relative
paths and does not change directory selection or expansion.

The horizontal splitter between areas supports drag, keyboard adjustment, and reset.

## Real Diff

The right side reads actual workspace and baseline content. Line statistics appear only
after the selected Diff loads; unknown values are not shown as `+0/−0`.

Text Diff supports context and whitespace preferences. Binary and structured previews
include common images, TGA/TIFF/DDS/KTX2/EXR textures, one PDF page at a time, bounded
CSV tables, common 3D formats, WAV/OGG/MP3/FLAC audio, TTF/OTF fonts, read-only
ZIP/PAK/AssetBundle/PCK directories, and bounded Unreal/Unity/Godot/Blender metadata.
Encrypted or version-dependent directories explicitly fall back to trusted container
metadata instead of guessed entries. For text-backed SVG and CSV, enabling binary Diff uses
the image/table preview; disabling it switches to the source text Diff. Other binary and
structured formats stop content reads in both workspace and Revision views when disabled.

## File context menu

Depending on state and selection, the menu includes Open, External Diff/Merge, Save as
Patch, Show in File Manager, Timeline, History, collaborative locks, Stage/Unstage,
Discard, Stage all, Ignore paths/extensions, and Copy paths.

If Lore has no recoverable file-level Stash, Stash is disabled with a reason. Save as
Patch is a one-way export and is not presented as Stash.

## External Diff and Merge

Local files can be passed directly. Historical or missing sides use controlled temporary
files. Arguments are passed individually without a Shell. Missing programs, invalid
paths, or incomplete templates produce explicit failures.

## Create a Revision

1. Verify the staged count.
2. Enter a message describing intent.
3. Verify repository or client-default identity.
4. Click **Create Revision**.

Only staged content enters the new immutable Revision. Unstaged work remains. Push is a
separate action.

## Conflict sessions

Merge, Cherry-pick, and Revert compare real before/after state. When a new conflict
session appears, Lore Client opens Local Changes, focuses conflicts, and disables normal
Stage, Unstage, Discard, and Ignore. Unknown conflict types remain read-only.

When unresolved count reaches zero, create the final conflict Revision using the
operation-specific editable message. The session ends only after that succeeds.

- **Restart** discards current resolution work and restores the operation’s initial conflict state.
- **Abort** attempts to restore the pre-operation state.

Both show repository, operation, and overwrite/recovery impact before running.

## Discard risk

Discard writes to local files and generally cannot be undone in Lore Client. Verify the
repository-relative paths, backup untracked work, and confirm the primary item and total
count before a batch action.

[Previous: Workspace](03-workspace-and-navigation.md) · [Next: History, Branches, and Tags](05-history-branches-and-tags.md)
