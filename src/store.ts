// The forge's state and the domain operations every surface (REST, GraphQL,
// MCP, git) shares. Everything lives in memory; a deterministic logical clock
// (a fixed epoch plus a counter) stamps created_at/updated_at and the commits
// this forge authors, so two runs of the same request sequence produce the
// same bytes.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
} from './gitobj.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
  isPull: boolean;
}

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string; // branch name (short) in this repo
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string | null;
  defaultBranch = 'main';
  store = new ObjectStore();
  refs = new Map<string, string>(); // full ref (refs/heads/x) -> oid
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  nextNumber = 1;
  commentSeq = 1;
  createdAt: string;

  constructor(id: number, name: string, isPrivate: boolean, description: string | null, createdAt: string) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.createdAt = createdAt;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  tip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Files (path -> {mode, oid}) at a commit, or an empty map for an unborn/unknown commit. */
  filesAt(commitOid: string | undefined): Map<string, { mode: string; oid: string }> {
    if (!commitOid) return new Map();
    const obj = this.store.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return flattenTree(this.store, parseCommit(obj.data).tree);
  }

  /** Author a commit on top of `parent` (undefined = root) holding exactly `files`. */
  commitFiles(parent: string | undefined, files: Map<string, { mode: string; oid: string }>, message: string, forge: Forge): string {
    const tree = buildTreeFromFiles(this.store, files);
    const stamp = forge.gitStamp();
    const data = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: stamp,
      committer: stamp,
      message,
    });
    return this.store.put('commit', data);
  }
}

export class Forge {
  repos = new Map<string, Repo>(); // keyed by repo name (the token owns one namespace)
  repoSeq = 0;
  clockSeq = 0;
  boundLogin: string | null = null;
  userId = 1001;

  /** The next deterministic timestamp as an ISO string. */
  now(): string {
    this.clockSeq += 1;
    return new Date(EPOCH_MS + this.clockSeq * 1000).toISOString();
  }

  /** A git author/committer line on the logical clock. */
  gitStamp(): string {
    this.clockSeq += 1;
    const sec = Math.floor(EPOCH_MS / 1000) + this.clockSeq;
    return `Forge Bot <bot@forge.invalid> ${sec} +0000`;
  }

  /**
   * The token's login. The suite addresses the token's repositories under the
   * scenario's viewer login, which the forge cannot know in advance: the first
   * owner segment that successfully addresses an existing repository binds as
   * the login, and any other owner is a stranger (404).
   */
  login(): string {
    return this.boundLogin ?? 'forge-user';
  }

  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.boundLogin === null) {
      this.boundLogin = owner;
      return repo;
    }
    return this.boundLogin === owner ? repo : null;
  }

  /** Repo lookup for surfaces that carry no owner (creation, /user/repos). */
  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  createRepo(name: string, isPrivate: boolean, description: string | null): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, name, isPrivate, description, this.now());
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  createIssue(repo: Repo, title: string, body: string | null, labelNames: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const stamp = this.now();
    const issue: Issue = {
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      isPull: false,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string | null, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.branchTip(headRef);
    const baseSha = repo.branchTip(baseRef);
    if (!headSha || !baseSha) return null;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const stamp = this.now();
    const pull: Pull = {
      number,
      title,
      body,
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.pulls.set(number, pull);
    // GitHub models a pull request as an issue row too (shared numbering).
    repo.issues.set(number, {
      number,
      title,
      body,
      state: 'open',
      labels: [],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      isPull: true,
    });
    return pull;
  }
}

/**
 * Three-way file merge for a squash: returns the merged file map, or null on a
 * conflict (both sides changed the same path differently, or one side deleted
 * a path the other changed).
 */
export function mergeFiles(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const out = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(o, t)) {
      if (o) out.set(path, o);
    } else if (same(b, o)) {
      if (t) out.set(path, t);
    } else if (same(b, t)) {
      if (o) out.set(path, o);
    } else {
      return null;
    }
  }
  return out;
}

export type MergeOutcome =
  | { kind: 'merged'; sha: string }
  | { kind: 'conflict' }
  | { kind: 'not-open' };

/** Squash-merge a pull request onto its base branch: one new commit, base ref moved. */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.state !== 'open') return { kind: 'not-open' };
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  if (!baseTip) return { kind: 'conflict' };
  if (isAncestor(repo.store, headTip, baseTip)) {
    // Nothing to merge: the head is already contained in the base.
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = forge.now();
    pull.mergeCommitSha = baseTip;
    pull.updatedAt = pull.mergedAt;
    syncPullIssue(repo, pull);
    return { kind: 'merged', sha: baseTip };
  }
  const baseOid = mergeBase(repo.store, baseTip, headTip);
  const baseFiles = repo.filesAt(baseOid ?? undefined);
  const oursFiles = repo.filesAt(baseTip);
  const theirsFiles = repo.filesAt(headTip);
  const merged = mergeFiles(baseFiles, oursFiles, theirsFiles);
  if (merged === null) return { kind: 'conflict' };
  const message = `${pull.title} (#${pull.number})`;
  const sha = repo.commitFiles(baseTip, merged, message, forge);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.now();
  pull.mergeCommitSha = sha;
  pull.baseSha = baseTip;
  pull.updatedAt = pull.mergedAt;
  syncPullIssue(repo, pull);
  return { kind: 'merged', sha };
}

function syncPullIssue(repo: Repo, pull: Pull): void {
  const issue = repo.issues.get(pull.number);
  if (issue && issue.isPull) {
    issue.state = pull.state;
    issue.updatedAt = pull.updatedAt;
  }
}
