# Understanding Lore

Lore is not Git with renamed nouns. It also uses immutable history and movable Branch
pointers, but it was designed around large binary assets, lazy retrieval, and a central
service. Understanding which layer an action changes—history, pointer, workspace, or
view—is more useful than memorizing labels.

## One mental model

Lore is a **binary-first version-control system with canonical remote state,
content-addressed fragments, and offline-capable local work**:

```text
file content → content-addressed Fragments → complete file tree → immutable Revision
                                                               ↑
                                              Branch Latest ───┘
```

An Instance materializes only the content needed for its current task. Other content
still exists in the Revision and can be fetched later.

## Revision: an immutable complete snapshot

A Revision freezes the complete repository tree; it is not merely a patch. A normal
Revision has one parent and a Merge Revision has two, making history a directed acyclic
graph.

- A Revision ID identifies exact content and parent relationships.
- Inspector metadata can appear before optional changes or file content is fetched.
- Amend, Cherry-pick, Revert, and Restore create new Revisions rather than editing old ones.
- Several Branches can point to the same Revision.

The **workspace HEAD** is the exact Revision currently materialized in this Instance. It
is distinct from the selected Revision and from any Branch Latest.

## Branch: a movable Latest pointer

A Branch is a stable identity and name whose main job is to point Latest at a Revision.
Creating one usually copies no data and creates no Revision.

- Clicking selects; double-clicking or an explicit Checkout action changes the workspace.
- Local and remote Branch pointers may temporarily differ.
- Archiving removes a Branch from active work without deleting Revisions.
- Reset Latest moves a pointer; it is not a file-restore command.
- Branch protection and advisory file locks solve different problems.

## Tag: a stable shared marker

A Tag attaches a name and description to an exact Revision as repository-shared metadata.
It is useful for releases, milestones, review conclusions, and readable aliases. Branch
Latest moves; a Tag remains attached until explicitly edited or deleted.

## Fragment: binary-scale storage and deduplication

Lore splits file content into content-addressed Fragments. Identical Fragments can be
reused across files and Revisions, and a local edit to a large asset normally introduces
only the affected chunks.

This means:

- many versions of a large file do not imply a full copy per Revision;
- range reads can fetch only overlapping Fragments;
- offline history access depends on whether the required Fragments are cached;
- Fragment verification checks a storage unit, not a filename.

## View: what this Instance materializes

A View is an inbound materialization filter used by Clone, Sync, Branch switching, and
Restore. Paths excluded by a View still exist in the Revision; they are simply absent
from this local workspace.

A View belongs to the Instance, does not travel with a Revision, and can materialize or
dematerialize files when changed. It is different from ignore rules: a View controls
historical content coming into the workspace, while ignore rules control local content
leaving through scan, stage, and commit.

## File dependencies: fetch a task closure

Lore stores explicit directed edges from a source file to the files it requires. Edges
can have tags. Starting from root files, Lore Client can inspect or materialize a selected
dependency closure.

Dependencies are not inferred by parsing every asset. Missing edges, mismatched tags, or
a low depth limit can omit required files. Cycle detection is a safety check; bypassing
it should be exceptional.

## Link and Layer: two different composition models

| Property | Link | Layer |
| --- | --- | --- |
| Stored in | Parent Revision | Local Instance configuration |
| Travels with history/Clone | Yes | No |
| Exact source Revision | Fixed by pin | Resolved by local policy |
| Typical use | Reproducible component version | Private tools, assets, or CI overlays |

A **Link** mounts an exact Revision and subtree from another repository into the parent
tree. The parent Revision records the pin, so the dependency cannot silently follow a
moving Branch. The linked repository remains a separate permission boundary.

A **Layer** mounts external content only while materializing this local Instance. It never
enters the parent history, so another user or CI job will not see it unless configured
separately.

## Shared Store and Instance

An Instance is an independent working directory with its own Branch, View, workspace,
staging state, and identity. Several Instances can use one Shared Store to reuse
Fragments and cache without sharing uncommitted work.

Deleting one Instance does not delete peer Instances or necessarily delete the Shared
Store. Reported Shared Store size is current unique content usage; Lore Client does not
invent a savings estimate when no trustworthy non-deduplicated baseline exists.

## Clone, Sync, and Push

- **Clone** creates an Instance and can select a Revision or Branch, View, Bare mode,
  Shared Store, initial Layer, and dependency closure. Completion does not imply every
  historical binary was downloaded.
- **Sync** fetches remote Branch progress and merges it into the local line. Divergence
  can create a Merge Revision and conflicts.
- **Push** uploads missing Fragments first, then conditionally advances remote Latest.
  If the pointer changed, the final step fails even though uploaded Fragments may be
  reusable later.

## Advisory lock boundary

Collaborative file locks communicate editing intent; they are not universal storage-level
write enforcement. Use them with Branch protection, reviews, and team practice.

## Correcting common Git assumptions

| Common assumption | More accurate Lore model |
| --- | --- |
| Clone is a complete peer copy | Clone creates a sparse, lazily hydrated Instance. |
| A Branch owns a set of commits | A Branch is a movable pointer into a shared Revision DAG. |
| Large binaries use a side channel | Fragment chunking, deduplication, and range reads are core storage. |
| Sparse checkout is optional | View and lazy fetch are normal operation. |
| Submodules and worktrees are subordinate | Links enter history; Layers stay local; Instances sharing a Store are peers. |

This mental model follows the
[official Epic Games Lore documentation](https://github.com/EpicGames/lore/tree/main/docs).
Lore remains pre-1.0, so behavior should be checked against the version supported by the
current application.

[Previous: Quick Start](01-quick-start.md) · [Next: Workspace and Navigation](03-workspace-and-navigation.md)
