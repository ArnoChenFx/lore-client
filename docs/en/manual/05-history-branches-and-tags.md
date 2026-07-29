# History, Branches, and Tags

## Revision History

Flat mode focuses on the current Branch. Topology mode displays real parent relationships
and Merge lines. Rows can show ID, title, author, time, exact Branch pointers, Tags,
workspace HEAD, selection, and Revisions ahead of the local workspace.

A Branch badge means the Branch currently points to that Revision; it does not claim
historical ownership. Tag badges open Tag actions, not Revision actions.

Lore Client submits the author identities from the currently loaded history to the Auth
service as one batch. A real user ID is replaced by the returned username. Successfully
resolved names are stored in a repository-scoped, token-free display cache, so they remain
readable after the repository goes offline or its account signs out. A bound account's
local profile can refresh its own entry without contacting the server. Free-form identities,
unknown user IDs, unauthorized repositories, and identities that have never been resolved
keep the exact historical value. The current viewer's username never replaces another
historical author.

Filters include Merge-only, starting Revision, Branch, date, limit, and Branch ancestry.
Display options control columns and lane mode.

## Inspector

Overview shows identity, time, parents, and source. Author presentation follows one
stable rule set:

- `Name <email>` shows the name and a separate email; the email supplies Gravatar.
- An email-only identity shows the complete email once as the author while still using
  it for Gravatar.
- A username or identity without an email is shown in full and uses the local initials
  avatar.

Offline, missing-avatar, and unavailable-crypto cases keep author text and local
initials. Changes is a real parent-child Diff with selectable baseline for a Merge
Revision. File Tree is the complete immutable file set and preserves exact Show in File
Tree targets while loading.

Revision-file menus can open changes, run external Diff, show in the file explorer, open
history, restore to a selected state, and copy paths.

## Revision context actions

| Action | Result |
| --- | --- |
| **Open in Inspector** | Read-only inspection. |
| **Checkout** | Materialize that exact Revision in the workspace. |
| **New Branch** | Point a new Branch at the selected Revision and its real source Branch. |
| **New Tag** | Attach a Tag to the exact Revision. |
| **Cherry-pick onto current Branch** | Replay its change as a new Revision. |
| **Revert** | Create a new Revision that counteracts it. |
| **Copy ID/Information** | Copy text only. |

High-impact actions show the target and effect before writing. Right-click itself only
selects context.

## Branch Overview and menus

Overview separates selected Branch, attached workspace Branch, and Branch Latest.
Double-click performs Checkout. Ahead means local work is not yet pushed; Synced reflects
the latest loaded state.

A local Branch can Switch, create Branch/Tag, Push, Merge into current, Archive, and
Copy. It cannot merge into itself or archive the currently attached Branch. Remote
Branch checkout creates or attaches an appropriate local working Branch. Archived
Branches are read-only pointers with locate, Tag, and copy actions.

## Create a Branch

The dialog displays source Branch, source Revision, and new name. Creating from history
uses the selected Revision’s real source Branch. Creating from a Branch uses its exact
Latest. On success, the workspace attaches to the new Branch.

## Tags

Tag List shows name, target, description, and update time. Create/Edit shows target
Branch, exact target Revision, name, description, and the repository-shared metadata
boundary.

Tag actions include details, locate Revision, edit, delete, and copy name, Revision ID,
or full information. Deleting a Tag never deletes its Revision.

## Merge, Cherry-pick, and Revert

Merge combines another Branch into the current Branch and may create a two-parent
Revision. Cherry-pick replays one Revision’s change. Revert creates a counteracting
Revision. None edits an existing Revision in place, and all can enter a conflict session.

Advanced Branch protection, Latest history, Reset, and read-only Branch Diff are covered
in [Repository Tools](08-repository-tools-reference.md#7-branch-collaboration).

[Previous: Local Changes](04-local-changes-and-revisions.md) · [Next: Large and Composite Repositories](06-large-and-composite-repositories.md)
