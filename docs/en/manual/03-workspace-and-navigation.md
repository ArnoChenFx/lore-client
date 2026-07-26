# Workspace and Navigation

## Top toolbar

| Control | Purpose | Notes |
| --- | --- | --- |
| Repository switcher | Switch between open repositories. | Switching does not Sync or close other tabs. |
| Online/offline status | Shows remote reachability. | Local work remains available, but uncached content may not. |
| **Open project directory** | Open another local repository or regular directory. | Initialization requires confirmation. |
| **Sync** | Merge remote Branch progress locally. | Local writes or conflicts may block it. |
| **Push** | Advance the current Branch remotely. | Requires configuration and a non-diverged remote Latest. |
| **New Revision** | Enter the Revision creation flow. | Selection, staging, and a message are still required. |
| **Command** | Open the Command Palette. | Search and run major actions by keyboard. |
| **Global Search** | Search loaded Revisions, Branches, and file paths. | It is not a remote full-text index. |
| **Server Settings** | Browse the remote repository directory. | The address is temporary and does not edit repository configuration. |
| **Client Settings** | Open appearance, identity, integrations, storage, and maintenance. | Most settings apply immediately. |

## Repository tabs

Each open repository has a tab. Clicking switches repositories; closing a tab does not
delete its directory. Repository switching is not Branch checkout: checkout materializes
different content inside the same Instance.

## Sidebar

![Lore Client Branch Overview workspace in English](../../img/lore-client-branch-overview-light.png)

_Branch Overview presents workspace attachment, local and remote Branches, and the Revision file tree together._

Primary views are **Local Changes**, **Revision History**, **Branch Overview**, and
**Tag List**. The Branch tree separates local, remote, and archived Branches.

A single click selects a Branch; a double-click checks it out. Context menus differ:

- local: Switch, New Branch, New Tag, Push, Merge, Archive, and Copy;
- remote: attach/switch to a local working Branch or create Branch/Tag from its Revision;
- archived: locate its exact Revision, create a Tag, and copy metadata.

Repository shortcuts open Clone/selective sync, Configuration, Accounts, or all
Repository Tools. The bottom **Instance** and **Partition** rows are status information:
Instance identifies this working directory; Partition is the repository’s content and
permission boundary.

## Revision History controls

Text filtering works on loaded history. **Filter options** include Merge-only, starting
Revision, Branch, before date, result limit, and selected-Branch ancestry. **Display
options** control Author/Time columns and Topology versus Flat mode.

Topology uses real parent relationships. Flat mode focuses on the current Branch.
Filtering never rewrites history or infers topology from Branch names.

## Inspector

- **Overview**: Revision ID, identity, time, parents, and summary.
- **Changes**: real Diff against a selected parent; Merge Revisions can change baseline.
- **File Tree**: complete immutable tree for the Revision.

The File Tree supports expand/collapse all, desktop-style multi-selection, and locating
files in the workspace. Locating changes view and selection only; it does not Checkout.

## Search and Command Palette

Global Search groups loaded results into Revisions, Branches, and workspace files. A
result is located, not executed as a write action.

Open Command Palette with `Ctrl/Cmd+K`. It includes Sync, Push, Open, New Revision,
Switch Branch, View, Layers, locks, dependencies, Branch collaboration, Revision
recovery, Accounts, server browsing, verification, Search, Operation History, and
Client Settings. Use Arrow keys, Enter, and Escape.

## Operation History

Long work reports `queued`, `running`, `streaming`, `succeeded`, or `failed`. Frequent
successful actions such as refresh and staging may remain quiet, while errors, conflicts,
and long operations keep explicit feedback. **Clear completed records** removes display
history only; it does not undo work.

## Selection and keyboard rules

- `Ctrl/Cmd+K`: Command Palette.
- `Escape`: close the active menu, popover, or dialog.
- Arrow keys, Home, End: navigate supported tabs and menus.
- `Ctrl/Cmd+A`: select all in the current file list/tree.
- Enter: stage/unstage the current file or activate a menu item.
- Delete: request Discard for selected Local Changes; disabled during conflicts.
- Splitter Arrow keys: resize; double-click resets the splitter.

[Previous: Understanding Lore](02-understanding-lore.md) · [Next: Local Changes](04-local-changes-and-revisions.md)
