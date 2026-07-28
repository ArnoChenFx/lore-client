# Quick Start

## Three things to know first

1. Lore is bundled with Lore Client; a separate CLI installation is not required.
2. Browsing, Clone, Publish, Sync, and Push require a reachable Lore service. Cached
   history, staging, and local Revision creation can work offline.
3. The remote holds canonical state. A local directory is an independent Instance, and
   Clone does not necessarily download every historical binary immediately.

## First launch

The welcome page has two actions:

| Button | Purpose |
| --- | --- |
| **Choose a project directory** | Open an existing Lore repository. A regular directory asks for confirmation before initialization. |
| **Browse remote repositories** | Enter a Lore server address, browse its public directory read-only, and choose a repository to Clone. |

When you choose a directory, Lore Client searches upward for `.lore` or legacy metadata,
so selecting a child directory can still find the repository root. Existing but damaged
Lore metadata produces an error; the directory is not offered for reinitialization.

### Initialize a regular directory

Initialization creates a Lore repository in place and preserves existing files. Confirm
that the directory is not nested inside another Lore repository, its current files belong
in the new repository, and an author identity is configured before the first Revision.

Initialization is not Clone: it creates a new repository identity and local history and
does not automatically configure a remote.

## Browse a server and Clone

1. Open **Browse remote repositories**.
2. Enter `lore://host:port` in **Browse server address**, then press Enter or **Refresh**.
3. If authentication is required, choose **Reauthenticate** in the recovery dialog to open the system browser; the client refreshes the directory and every affected repository state after sign-in. Choose **Skip and continue offline** to close the server browser and keep using local features without restarting. With multiple saved accounts, you can first choose one under **Authentication account**.
4. Inspect the names and IDs, then click **Clone** on a repository.
5. Enter a **Local directory name** and choose a **Target parent directory**.
6. Leave Advanced options collapsed for the first Clone and click **Start Clone**.

Clone creates one new, single-level directory below the selected parent and refuses to
overwrite a non-empty directory. See [Clone Page Reference](07-clone-page-reference.md)
for an exact Revision, View, Bare mode, Layer, Shared Store, or dependency closure.

## The four workspace regions

![Lore Client Revision History workspace in English](../../img/lore-client-revision-history-dark.png)

_Revision History keeps navigation, the Revision graph, and the Inspector visible in one workspace._

- **Top toolbar**: repository switching, Sync, Push, New Revision, Command, Search,
  Server, and Settings.
- **Left sidebar**: Local Changes, Revision History, Branch Overview, Tags, the Branch
  tree, and repository tools.
- **Center workspace**: the selected primary view.
- **Right Inspector**: Overview, Changes, and the complete file tree for a Revision.

The sidebar, center, Inspector, and the two Local Changes areas are resizable. Splitters
support dragging, keyboard adjustment, and double-click reset. Sizes are remembered.

## Create your first local Revision

1. Open **Local Changes** and scan or refresh.
2. Select files. Click for one item, Ctrl/Cmd-click to toggle, and Shift-click for a range.
3. Double-click an unstaged item, press Enter, click its `+`, or use **Stage all**.
4. Inspect the real Diff on the right.
5. Enter a message under **Create Revision**.
6. Verify the displayed identity and click **Create Revision**.

Identity resolution is repository identity first, Client Settings default second, and a
structured failure when neither exists.

## Work with the team

- **Sync** brings remote Branch progress into the current local line and may start a
  guided conflict session.
- **Push** uploads missing data and then conditionally advances the remote Branch Latest.
  If another user has advanced it, Sync and Merge first.
- **New Revision** moves you into the creation workflow; it does not bypass staging.

Before the first online operation, open **Repository Tools → Configuration** and verify
the repository identity and Lore server root. The server root, remote repository name,
and Branch are separate values.

[Back to manual index](README.md) · [Next: Understanding Lore](02-understanding-lore.md)
