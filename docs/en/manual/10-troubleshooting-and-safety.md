# Troubleshooting and Safety Boundaries

## Start with the error category

Lore Client distinguishes backend unavailable, incompatible version, permission denied,
offline/unreachable remote, repository damage, invalid path/parameter, and conflict or
state drift. Read the Toast, inline field error, and Operation History details before
assuming repository corruption.

## Cannot open a directory

Check path existence and access, `.lore` or legacy metadata in this directory or parents,
nested repository selection, and damaged metadata. Lore Client does not offer
initialization over damaged Lore metadata. Back up the directory before recovery.

## Cannot connect to a server

- Use `lore://host:port`.
- The server browser address is temporary; repository actions use Configuration.
- Check network, VPN, firewall, and account permissions.
- Use **Reauthenticate** in the recovery dialog, or sign in under Repository Tools → Accounts.

An open remote repository retries read-only snapshots with capped exponential backoff and
resubscribes after its notification stream ends. Returning the window to the foreground
or restoring network connectivity triggers an immediate probe. These probes never run
Sync or another write operation. A **Remote authentication required** state stops automatic
network retries and opens a recovery dialog. **Reauthenticate** refreshes account data and
every open repository on that server. **Skip and continue offline** pauses that server for
the current session without deleting credentials or bindings; local work remains available,
and a later explicit sign-in or account change resumes verification without an app restart.

Directory browsing success does not grant access to every repository or write operation.

## Clone failed

Common causes include an unwritable parent, invalid single-level directory name, existing
non-empty target, ambiguous Revision, missing Branch, invalid View, Bare plus materializing
options, missing automatic Shared Store, or unresolved Layer/dependency inputs.

Do not treat a partial target directory as a successful repository. Follow the reported
stage and use a new empty destination or explicitly clean the failed target.

## Historical file cannot be read

A Revision can exist while its Fragments are not cached. Check online state, remote URL,
Partition permission, View exclusion, Shared Store directory, and whether GC reclaimed
cache that can be refetched. Lore Client never substitutes workspace Status or demo text
for historical content.

## Push rejected

Remote Latest probably advanced:

1. Refresh and Sync.
2. Inspect the Merge Revision or conflict session.
3. Resolve all conflicts and create the finishing Revision.
4. Push again.

Previously uploaded Fragments may be reused, but do not imply that the remote Branch
pointer advanced.

## Conflict controls are disabled

Normal Stage, Unstage, Discard, and Ignore are intentionally unavailable during a conflict
session. Use operation-specific resolution and create a finishing Revision after all
files are resolved. Restart discards resolution progress; Abort attempts to restore
pre-operation state. Both confirm overwrite/recovery effects.

## View cannot be applied

Application requires no local changes, staging, or conflicts; no Revision drift since
preview; and a valid preview matching the current rules. Refresh, preview again, and apply.
Do not substitute ignore rules for a View.

## External tool will not start

Under Client Settings → Integrations, verify availability, executable path/`PATH` command,
one argument per line, `{before}` and `{after}` for Diff, and `{base}`, `{local}`,
`{remote}`, `{merged}` for Merge. Temporary files are controlled for the invocation;
the external application remains responsible for its own save/crash behavior.

## A lock did not prevent another write

Collaborative locks are advisory, not universal enforcement. Combine them with Branch
protection, review, and team workflow.

## Diagnostic order

1. Refresh and inspect Operation History.
2. Maintenance → Start verification.
3. Advanced Diagnostics → Verify read-only.
4. Heal only the identical preflight path after reviewing the report.
5. Use state Dump or Fragment verification when specifically needed.
6. Use GC for unreferenced content, not as general repair.

Heal, Prune stale Instances, GC, and Reset Branch Latest can produce irreversible state
changes. Keep a backup or confirm the remote can restore required content.

## 0.x preview

Lore and Lore Client remain pre-1.0. APIs, protocols, disk formats, and advanced behavior
may change with the pinned Lore version. Validate important Clone, Sync, View, Layer/Link,
conflict, and diagnostic workflows after upgrades.

## Useful problem reports

First open **Client Settings → Maintenance → Open Log Directory** and locate
`lore-client.log` plus any relevant recent rotated file. Reproduce the problem once, then
use timestamps to find the matching command's `started`, `succeeded`, or `failed` record.

Include Client version, operation and failed stage, error category/message, online state,
current Branch and short Revision ID, View/Layer/Link/Shared Store/dependency use, and
reproduction steps. Common credential patterns are redacted automatically, but logs may
still include local paths and upstream error details. Never send Access Tokens,
credentials, an unreviewed full log, or an unredacted sensitive state Dump.

[Previous: Client Settings](09-client-settings-reference.md) · [Back to manual index](README.md)
