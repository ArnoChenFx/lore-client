# Repository Tools Reference

Repository Tools uses vertical navigation and an independently scrolling content area.
Arrow keys, Home, and End move focus and selection. **Refresh** reloads repository state;
relevant controls are disabled during writes.

![Lore Client Repository Tools Dependencies page in English](../../img/lore-client-repository-tools-dependencies-en.png)

_The Dependencies section combines parameterized queries, exact edge management, and an interactive graph._

## 1. Configuration

### Repository commit identity

Enter Author name and Email. Repository identity overrides the client default. **Save
repository configuration** edits only identity and server address while preserving other
configuration.

| Parameter/status | Input/default | Exact effect |
| --- | --- | --- |
| **Author name** | Up to 240 characters; client default appears only as a placeholder | Combined with Email into this repository’s identity for future Revisions. |
| **Email** | Email format, up to 254 characters | Enters future author identity and local avatar fallback; never rewrites historical authors. |
| **Active identity** | Read-only resolution | States whether repository identity, client default, or no usable identity will be used. |
| **Save repository configuration** | Enabled only for a real change | Writes identity and server root; does not Publish, Push, or create a Revision. |

Clear and save both identity fields to return to client-default fallback. Placeholder text
is not a saved repository value.

### Lore server address

Enter a server root such as `lore://host:41337`, without a remote repository name. It is
used by Accounts, Push, Sync, and Publish.

Blank means no persistent remote. A value ending in `/repository-name` is inappropriate
here because that name belongs to Publish. Push is disabled while the edited value is
unsaved so the destination cannot be ambiguous.

### Publish local repository

| Control | Input/default | Exact effect |
| --- | --- | --- |
| **Remote repository name** | Prefilled from the local name, or from the server's canonical name when the same Repository ID already exists; up to 1000 characters; ASCII letters, digits, dot, underscore, hyphen | URL suffix used to create the remote. It does not rename the local repository. |
| **Remote description** | Optional, up to 4096 characters | Remote directory description, not a Revision message. |
| **Publishing account** | Optional; lists signed-in Lore accounts and defaults to the repository binding when one exists | A selected account supplies Token Store credentials for Create and Push and becomes the binding for later remote operations. **Do not use an account** explicitly disables credentials for this publication, even when the repository has a binding. |
| **Publish target** | Read-only server root plus name | Lets the user verify the complete destination. |
| **Push current Branch** | Requires saved remote and clean configuration | Pushes to an existing remote; never creates one. |
| **Create remote and Push** | Requires server root, name, and capability | Performs remote creation, configuration update, then current-Branch Push. |

Only committed content is published. Select a signed-in account for servers that require
authentication, or keep **Do not use an account** for servers that allow anonymous creation.
Partial success is reported by remote creation, configuration update, and Push stage; Lore
Client does not claim a remote rollback. A retry first checks the server by stable Repository
ID: an existing ID with the same name skips duplicate creation and continues with configuration
and Push; a different name reports the server's canonical name and prevents an overwrite.

## 2. Selective Sync View

| Parameter/output | Input/default | Exact effect |
| --- | --- | --- |
| **View file path** | Read-only `.lore/view` or legacy `.urc/view` | Instance-local file location, not shared remote state. |
| **View rules** | Ordered glob text, up to about 256 KiB | Selects Revision paths to materialize. Comments and later include rules can refine exclusions. |
| **Diagnostics** | Read-only line/severity/reason | Identifies invalid rules before Apply. |
| **Included files** | Preview output | Total Revision files in resulting View, not just new downloads. |
| **Files to materialize** | Preview `+N` | Missing local historical files that will be written. |
| **Files to dematerialize** | Preview `−N` | Local historical files removed from disk, not from the Revision. |
| **Estimated materialized size** | Preview output | Resulting file size estimate, not necessarily network bytes. |
| **Impact file list** | Preview output, possibly display-truncated | Shows materialize/dematerialize paths; Apply still uses the complete set. |
| **Preview impact** | Requires a current Revision | Read-only calculation against exact history. |
| **Apply View** | Changed rules, matching valid preview, clean workspace | Saves rules and safely reconciles the complete workspace. |

## 3. Layers

| Parameter | Input | Exact effect |
| --- | --- | --- |
| **Mount path** | Required repository-relative directory such as `Content/Shared` | Where Layer content appears in the parent workspace. |
| **Source repository** | Required Repository ID | Independent source Partition; not a URL or local folder. |
| **Source path** | Required source-repository path; `/` means root | Selects the entire source tree or one subtree. |
| **Metadata** | Optional key such as `release` | Pairs a source Revision by equal parent/source metadata value. Blank uses Lore’s default resolution. |
| **Revision** | Read-only list value | Currently resolved Layer Revision. |
| **Staged file count** | Read-only list value | Pending work in that Layer, separate from parent staging. |

Removal first opens a confirmation area. **Purge Layer files** also removes materialized
local content; leaving it off preserves untracked files. Layers are local, not parent
Revision data.

## 4. Links

| Parameter | Input/default | Exact effect |
| --- | --- | --- |
| **Repository URL** | Required full target such as `lore://host:41337/repository` | Identifies both remote and independent linked repository. |
| **Mount path** | Required, e.g. `Tools` | Location of the Link subtree in the parent Revision tree. |
| **Source path** | Required; `/` means target root | Subtree pinned from the linked repository. |
| **Pin** | Optional Branch/Revision resolution; blank uses Lore default | Fixes the exact target Revision recorded by the parent. |
| **Disable automatic Link branching** | Off by default | Prevents parent Branch operations from coordinating same-named linked Branches; does not make an existing pin move. |
| **Resolved Branch/Revision** | Read-only list status | Shows what the current pin actually references. |
| **Staged file count** | Read-only | Link changes waiting for the next parent Revision. |

Create, pin update, and removal are staged. **Edit Pin** does not commit automatically.

## 5. Dependencies

### Inspect a closure

| Parameter | Input/default | Exact effect |
| --- | --- | --- |
| **Root files** | Repository-relative paths; empty by default | Query origins. Roots are included; Query/Sync is disabled with none. |
| **Tags** | Line/comma separated; empty means no tag filter | Filters edges, not filenames. |
| **Depth** | `0–1024`, default `0` | Edge-hop limit; `0` unlimited and disabled without recursion. |
| **Include transitive dependencies** | On by default on this page | Recursively traverses indirect dependencies; off reads one hop. |
| **Show reverse dependencies** | Off | Changes “what roots require” to “what requires the roots.” |
| **Query state** | Current staged state automatically | Uses the current Revision as its baseline and overlays staged dependency metadata. Add/remove refreshes immediately, without requiring a new Revision. |

**Query Dependencies** is read-only. **Dependency-driven Sync** changes materialized
workspace content after confirmation.

### Add an edge

| Parameter | Exact effect |
| --- | --- |
| **Source path** | Required file that requires another file; establishes edge direction. |
| **Target path** | Required depended-on file. |
| **Edge tags** | Optional labels on this exact edge for selective Clone/Sync. |
| **Skip dependency cycle detection** | Off by default. Turning it on bypasses the safety check and requires confirmation. |

The graph supports pan, zoom, fit, node-to-editor actions, and exact edge deletion.

## 6. Collaborative Locks

| Parameter/status | Exact effect |
| --- | --- |
| **Repository-relative path** | Required single file; never enter an absolute local path. Deleted files cannot acquire a new lock. |
| **Current Branch** | Automatic lock scope and list context; changing management selection does not Checkout. |
| **Current identity** | Comes from credentials and determines ownership/release authority. |
| **Path/owner filter** | Filters loaded rows only; never modifies remote locks. |
| **Owner and locked time** | Read-only context; unknown owner is not “unlocked,” and age does not auto-expire it. |
| **Acquire** | Registers advisory intent for the exact path. |
| **Release** | Releases the current identity’s exact-path lock. |

## 7. Branch Collaboration

| Parameter/status | Exact effect |
| --- | --- |
| **Local Branch** | Active local Branch management target only; selection does not Checkout. |
| **Category** | Read-only Lore classification, not an editable Tag. |
| **Latest Revision** | Exact current pointer used for drift checks. |
| **Protection** | Blocks applicable Latest writes; separate from file locks. |
| **Refresh** | Reloads Branch information and Latest history. |

Latest history lists real prior pointers:

| Parameter/output | Exact effect |
| --- | --- |
| **Reset target Revision** | Selected only from real prior Latest records; arbitrary IDs cannot be typed. |
| **Skipped count** | Number of pointer records crossed, not number of deleted Revisions. |
| **Expected workspace/Latest** | Automatically carried and revalidated to prevent stale-preview Reset. |
| **Reset Branch Latest** | Moves the pointer; immutable Revisions remain, though they may become unreachable from this Branch. |

Branch Diff parameters:

- **Source Branch**: line supplying changes.
- **Target Branch**: comparison/merge baseline; must differ from Source.
- **Optional repository path**: limits read-only comparison to a subtree; blank means all.
- Changes display action and auto-merge status; Conflicts preview source/target actions.
  **Compare Branches** never runs Merge.

## 8. Revision Recovery

| Parameter/output | Exact effect |
| --- | --- |
| **Revision** | Exact loaded-history object; options show short ID and title. |
| **Revision number** | Positive human-facing history number, not a hash substitute. |
| **Parents** | Immutable topology parents; Merge can have two. |
| **Changed files** | File delta count, not complete tree size. |
| **Metadata** | Read-only key/value set used for audit and lookup. |

Find parameters are positive Revision number, or required metadata key plus optional
value. Blank value means “key exists”; supplied value requires both. Clicking a result
locates and inspects without Checkout.

| Action | Boundary |
| --- | --- |
| Action/parameter | Boundary |
| --- | --- |
| **Amend message** | Required. Allowed only when workspace anchor equals true Branch Latest; creates replacement history instead of editing an object. |
| **Known-good Revision** | Bisect endpoint verified as good; review the prefilled older value. |
| **Known-bad Revision** | Bisect endpoint verified as bad, commonly current; must differ from good. |
| **Sync to Bisect midpoint** | Performs one step and changes workspace content. |
| **Restore message** | Required explanation for the new Revision. |
| **Restore as new Revision** | Replays checked-out content onto newest remote head; not Checkout or pointer Reset. |

All are high-impact and confirm targets/effects.

## 9. Accounts

Accounts are device-level resources and remain available from the sidebar without an open
repository. The left pane lists stored accounts; the right pane switches between Account
details and repository assignments. Raw JWTs remain inside the Rust/Lore credential store.

| Parameter | Exact effect |
| --- | --- |
| **Remote server** | Temporary server root for this sign-in; it does not edit repository configuration. |
| **Token type** | Authentication-service type identifier; not a display label. |
| **Auth service URL** | Optional override only when authentication lives at another endpoint; blank uses Lore default. |
| **Access Token** | Required one-time secret in a password field, cleared immediately after submission. |

**Sign in with browser** opens system authentication. Token is not returned, persisted,
toasted, or stored in account data.

- **Refresh** lists identities, auth URLs, resource/domains, and expiration.
- The display name comes from the locally stored credential issued by the Auth service and falls back to the stable User ID when the credential has no usable name. Empty authorized domains do not mean full access.
- **Sign out** targets an exact auth URL and user ID, not a fuzzy display name.
- **Clear all** is a confirmed dangerous credential removal.

Under the **Repositories** tab, each open local repository can select a specific account or
return to **Automatic selection**. The preference file stores only repository path, Auth URL,
and User ID; it never stores a token or rewrites `.lore/config.toml`.

The fixed Lore 0.x API uses the same identity to select a JWT and to record the Revision
creator for protected operations. An assigned account therefore affects that identity;
removing the assignment leaves the repository's original commit identity configuration intact.

## 10. Metadata

| Parameter | Input/default | Exact effect |
| --- | --- | --- |
| **Object type** | Repository/Branch/Revision/File; Repository by default | Changes target semantics and clears inapplicable results. |
| **Branch** | Active local Branch | Reads Branch object metadata, not remote/archived working state. |
| **Revision** | Exact Revision, current by default | Reads immutable Revision metadata. |
| **File path** | Required repository-relative path in File mode | Identifies the file object; free input is briefly debounced. |
| **File Revision** | Optional, current by default | Selects the immutable snapshot for file metadata. |
| **Key/Type/Value** | Read-only columns | Preserves Lore’s reported data type. |

Complete parameters auto-load; **Read metadata** retries. The table shows key, type, and
value and has no editing action.

## 11. Advanced Diagnostics

### Repository state verification

| Parameter/action | Exact effect |
| --- | --- |
| **Optional repository-relative path** | Blank verifies all; any edit invalidates the prior Heal preflight. |
| **Verify read-only** | Produces a report and remembers the exact checked path without writes. |
| **Heal detected problems** | Enabled only for that identical path and confirms repository/scope. |

### Fragment verification

**Fragment hash** is a required content address, not a file path or Revision. Optional
**context** helps resolve the correct storage/Partition context and should be blank when
unknown. Verify Fragment is read-only and does not automatically Heal.

### Repository state dump

| Parameter | Input/default | Exact effect |
| --- | --- | --- |
| **Revision** | Current by default, exact ID allowed | Immutable state to dump, not uncommitted workspace content. |
| **Optional path** | Blank means repository root | Limits output to a subtree. |
| **Maximum depth** | `1–32`, default `4` | Bounds tree expansion and log volume; never changes state. |

### Repository Instances

| Status/action | Exact effect |
| --- | --- |
| **Instance ID** | Stable identity of one peer working directory. |
| **Path** | Recorded working-directory location, which can become stale after a move. |
| **Branch/Revision** | That Instance’s independent last state. |
| **stale** | Unreachable/invalid record; verify disk before pruning. |
| **Update current Instance path** | Re-registers only the currently open Instance. |
| **Prune stale Instances** | Removes listed stale metadata records after confirmation. |

## 12. Maintenance

| Action | Parameters/scope | Purpose | Risk |
| --- | --- | --- | --- |
| **Start verification** | No parameters; current repository | Check local objects, pointers, and workspace state. | Read-only; use Advanced Diagnostics for path/Heal. |
| **Run GC** | No parameters; current local Store | Reclaim locally unreferenced content. | May remove reusable offline cache, but never remote Revisions. |

For repair, prefer Advanced Diagnostics’ verify-then-Heal flow. GC is not a general
repository repair command.

[Previous: Clone](07-clone-page-reference.md) · [Next: Client Settings](09-client-settings-reference.md)
