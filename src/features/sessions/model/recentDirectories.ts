import type { Session } from "./index";

const RECENT_SESSION_LIMIT = 50;

export type RecentDirectory = {
  cwd: string;
  repository?: string;
  gitRoot?: string;
};

/**
 * Returns the unique working directories of unarchived sessions in most-recently-used order. A
 * session's own worktree belongs to that session, so it is never offered to another.
 */
export function getRecentDirectories(
  sessions: Session[],
  archivedSessionIds: readonly string[],
): RecentDirectory[] {
  const directories = new Map<string, RecentDirectory>();
  const archived = new Set(archivedSessionIds);
  const recentSessions = sessions
    .filter(({ id, worktree }) => !archived.has(id) && !worktree)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, RECENT_SESSION_LIMIT);

  for (const session of recentSessions) {
    const cwd = session.context?.directory?.trim();
    if (!cwd) continue;
    const previous = directories.get(cwd);
    if (previous?.repository || previous?.gitRoot) continue;
    directories.set(cwd, {
      cwd,
      repository: session.context?.repository,
      gitRoot: session.context?.gitRoot,
    });
  }

  return [...directories.values()];
}

/** Directories to offer for new work: each channel's directory, then the recent ones no channel uses. */
export function groupDirectoryChoices(
  recentDirectories: readonly RecentDirectory[],
  channelDirectories: readonly (string | undefined)[],
): { channel: RecentDirectory[]; recent: RecentDirectory[] } {
  const channelCwds = new Set(channelDirectories.filter((cwd) => cwd !== undefined));
  return {
    channel: [...channelCwds].map(
      (cwd) => recentDirectories.find((recent) => recent.cwd === cwd) ?? { cwd },
    ),
    recent: recentDirectories.filter(({ cwd }) => !channelCwds.has(cwd)),
  };
}
