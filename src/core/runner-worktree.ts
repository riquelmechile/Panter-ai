/**
 * Pure, non-effectful worktree plan. Never invokes git or touches the host.
 * An executor must separately pin the mirror, fd-walk directories with
 * O_NOFOLLOW/openat2, inspect symlinks and lock the attempt before writing.
 */
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
const COMPONENT = /^[A-Za-z0-9_-]{1,64}$/;
const DANGEROUS = new Set(['.','..']);

export function planWorktree(root: string, scope: Pick<RunnerGrant,
  'repository' | 'candidateSha' | 'missionId' | 'workId' | 'attemptId'>): WorktreePlan {
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') ||
      typeof scope !== 'object' || !scope ||
      typeof scope.repository !== 'string' || !REPOSITORY.test(scope.repository) ||
      typeof scope.candidateSha !== 'string' || !SHA.test(scope.candidateSha)) {
    throw new UnsafeWorktreePlan();
  }
  const components = [scope.missionId, scope.workId, scope.attemptId];
  if (components.some(x => typeof x !== 'string' || !COMPONENT.test(x) || DANGEROUS.has(x))) {
    throw new UnsafeWorktreePlan();
  }
  const cleanRoot=resolve(root);
  if (cleanRoot === '/' || cleanRoot === '.') throw new UnsafeWorktreePlan();
  const worktreePath=join(cleanRoot,'worktrees',...components);
  const fromRoot=relative(cleanRoot,worktreePath);
  if (!fromRoot || fromRoot.startsWith('..'+sep) || fromRoot==='..' || isAbsolute(fromRoot)) {
    throw new UnsafeWorktreePlan();
  }
  return Object.freeze({
    repository: scope.repository,
    detachedSha: scope.candidateSha,
    worktreePath,
    attemptKey: components.join(':'),
  });
}
