# Offline Revision Author Cache

Lore Client stores Auth-confirmed Revision `userId → display name` mappings in a local,
redacted cache. Entries are scoped by stable Repository ID and user ID, so moving a local
repository does not lose the mapping and identical IDs from different repositories do not mix.

## User-visible behavior

- While online, names returned by Auth override older cache entries and appear immediately.
- After a repository goes offline, Auth becomes unavailable, or the account signs out,
  previously resolved authors remain readable.
- A user ID that has never been resolved remains unchanged; the current repository identity
  is never guessed as a historical author.
- A partial Auth response does not erase cached names for other authors.

## Privacy and capacity boundaries

The cache lives in a dedicated `revision-author-cache.json` file under the application
configuration directory; regular interface preferences remain in `client-preferences.json`.
The author cache contains only Repository ID, user ID, display name, and update time. It never
stores tokens, JWTs, authentication requests, or avatar URLs. It keeps at most 4,096 recent
mappings and rejects empty, oversized, or control-character-bearing fields.

## Runtime I/O strategy

The Rust adapter lazily reads the author cache on its first access. Later Revision History
refreshes query the in-process copy without repeatedly reading or parsing JSON. The dedicated
cache file is written synchronously only when Auth returns a display name that differs from the
stored mapping; a failed write does not replace the in-memory state prematurely.
