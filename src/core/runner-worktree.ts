/**
 * Pure worktree planning: bind path and attemptKey to the exact repository,
 * SHA, mission, work and attempt. No Git calls, filesystem writes or
 * symlink/TOCTOU protection are provided by this planner.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RunnerGrant } from './runner-grants.js';

export interface WorktreePlan {
  repository: string;
  detachedSha: string;
  worktreePath: string;
  attemptKey: string;
}
export class UnsafeWorktreePlan extends Error {
  constructor() { super('Unsafe worktree plan'); this.name='UnsafeWorktreePlan'; }
}
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
// Match runner-grants.ts safeId exactly. Hashes, not raw grant IDs, become path components.
const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;
const hashComponent = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export function planWorktree(root: string, scope: Pick<RunnerGrant,
  'repository' | 'candidateSha' | 'missionId' | 'workId' | 'attemptId'>): WorktreePlan {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') ||
      typeof scope !== 'object' || !scope ||
      typeof scope.repository !== 'string' || !REPOSITORY.test(scope.repository) ||
      typeof scope.candidateSha !== 'string' || !SHA.test(scope.candidateSha)) {
    throw new UnsafeWorktreePlan();
  }
  const ids = [scope.missionId, scope.workId, scope.attemptId];
  if (ids.some(x => typeof x !== 'string' || !ID.test(x))) {
    throw new UnsafeWorktreePlan();
  }
  const cleanRoot = resolve(root);
  if (cleanRoot === '/' || cleanRoot === '.') throw new UnsafeWorktreePlan();

  // Full SHA and full SHA-256 components prevent cross-repository/SHA/attempt
  // reuse while keeping path segments bounded below common NAME_MAX=255.
  const parts = [hashComponent(scope.repository), scope.candidateSha,
    ...ids.map(hashComponent)];
  const worktreePath = join(cleanRoot, 'worktrees', ...parts);
  const fromRoot = relative(cleanRoot, worktreePath);
  if (!fromRoot || fromRoot.startsWith('..'+sep) || fromRoot==='..' || isAbsolute(fromRoot)) {
    throw new UnsafeWorktreePlan();
  }
  return Object.freeze({
    repository: scope.repository,
    detachedSha: scope.candidateSha,
    worktreePath,
    attemptKey: parts.join(':'),
  });
}
