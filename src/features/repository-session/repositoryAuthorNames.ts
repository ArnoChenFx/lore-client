import { parseCommitIdentity } from '../../shared/lib'
import type { RepositorySnapshot } from '../../types'
import { repositoryPathKey } from './repositorySessionRequests'

/** Update only display fields on the latest snapshot; absent mappings leave other authors untouched. */
export function updateRepositoryAuthorNames(
  snapshots: RepositorySnapshot[],
  path: string,
  names: ReadonlyMap<string, string>
): RepositorySnapshot[] {
  let changed = false
  const next = snapshots.map((snapshot) => {
    if (repositoryPathKey(snapshot.repository.path) !== repositoryPathKey(path)) return snapshot
    let changedSnapshot = false
    const revisions = snapshot.revisions.map((revision) => {
      const identity = revision.authorIdentity
      const display = identity === undefined ? undefined : names.get(identity)
      if (display === undefined) return revision
      const { name, email } = parseCommitIdentity(display)
      const author = name || email
      const authorEmail = email || undefined
      const initials = author.slice(0, 1).toLocaleUpperCase()
      if (revision.author === author && revision.authorEmail === authorEmail && revision.initials === initials) {
        return revision
      }
      changedSnapshot = true
      return { ...revision, author, authorEmail, initials }
    })
    const branches = snapshot.branches.map((branch) => {
      const author = branch.creatorIdentity === undefined ? undefined : names.get(branch.creatorIdentity)
      if (author === undefined || branch.author === author) return branch
      changedSnapshot = true
      return { ...branch, author }
    })
    if (!changedSnapshot) return snapshot
    changed = true
    return { ...snapshot, revisions, branches }
  })
  return changed ? next : snapshots
}

export function repositoryAuthorIdentities(snapshot: RepositorySnapshot): string[] {
  return [
    ...new Set([
      ...snapshot.revisions.flatMap((revision) => (revision.authorIdentity ? [revision.authorIdentity] : [])),
      ...snapshot.branches.flatMap((branch) => (branch.creatorIdentity ? [branch.creatorIdentity] : []))
    ])
  ]
}
