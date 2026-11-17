// The GitHub REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, in GitHub's shapes and statuses.

import { Forge, squashMerge, ZERO_OID } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { parseCommit, mergeBase } from './gitobj.ts';

export interface RestRequest {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  rawBody: Buffer;
  baseUrl: string; // http://host as the client dialed it, for Link headers
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestReply => ({ status: 422, body: { message } });

// ---------------------------------------------------------------- shapes

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const login = forge.login();
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: forge.userId, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `https://forge.invalid/${login}/${repo.name}`,
    clone_url: `https://forge.invalid/${login}/${repo.name}.git`,
    git_url: `git://forge.invalid/${login}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`0${kind === 'Repository' ? '1' : '2'}:${kind}${id}`, 'utf8').toString('base64');
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label ? [...repo.labels.keys()].indexOf(name) + 1 : 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const login = forge.login();
  const json: Record<string, unknown> = {
    id: repo.id * 1_000_000 + issue.number,
    node_id: nodeId('Issue', repo.id * 1_000_000 + issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login, id: forge.userId, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://forge.invalid/${login}/${repo.name}/issues/${issue.number}`,
  };
  if (issue.isPull) {
    json.pull_request = { url: `https://forge.invalid/repos/${login}/${repo.name}/pulls/${issue.number}` };
  }
  return json;
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const login = forge.login();
  const repoRef = { id: repo.id, name: repo.name, full_name: `${login}/${repo.name}`, owner: { login, id: forge.userId, type: 'User' }, private: repo.isPrivate, default_branch: repo.defaultBranch };
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: nodeId('PullRequest', repo.id * 1_000_000 + pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    user: { login, id: forge.userId, type: 'User' },
    head: { ref: pull.headRef, sha: repo.branchTip(pull.headRef) ?? pull.headSha, label: `${login}:${pull.headRef}`, repo: repoRef },
    base: { ref: pull.baseRef, sha: repo.branchTip(pull.baseRef) ?? pull.baseSha, label: `${login}:${pull.baseRef}`, repo: repoRef },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://forge.invalid/${login}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- helpers

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; headers: Record<string, string>; base: string } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), headers: {}, base: '' };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, total: number): Record<string, string> {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${baseUrl}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (pageNum < lastPage) links.push(`${url(pageNum + 1)}; rel="next"`, `${url(lastPage)}; rel="last"`);
  if (pageNum > 1) links.push(`${url(pageNum - 1)}; rel="prev"`, `${url(1)}; rel="first"`);
  return links.length > 0 ? { link: links.join(', ') } : {};
}

/** Line-level diff counts between two texts (LCS on lines; inputs here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------- routing

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        installed_version: '1.0.0-forge',
        api: ['v3'],
      },
    };
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { login: forge.login(), id: forge.userId, type: 'User', site_admin: false } };
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') {
      const name = str(req.body?.name);
      if (!name) return unprocessable('name is required');
      if (forge.repoByName(name)) return unprocessable('name already exists on this account');
      const repo = forge.createRepo(name, req.body?.private === true, str(req.body?.description) ?? null);
      if (!repo) return unprocessable('name already exists on this account');
      return { status: 201, body: repoJson(forge, repo) };
    }
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      const { page } = paginate(all, req.query);
      return {
        status: 200,
        body: page.map((repo) => repoJson(forge, repo)),
        headers: linkHeader(req.baseUrl, '/api/v3/user/repos', req.query, all.length),
      };
    }
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1];
    const name = seg[2];
    const rest = seg.slice(3);
    if (rest.length === 0) {
      const repo = forge.resolveRepo(owner, name);
      if (method === 'GET') {
        if (!repo) return notFound();
        return { status: 200, body: repoJson(forge, repo) };
      }
      if (!repo) return notFound();
      if (method === 'PATCH') {
        if (str(req.body?.description) !== undefined) repo.description = str(req.body?.description) as string;
        if (str(req.body?.name) !== undefined && str(req.body?.name) !== repo.name) {
          const next = str(req.body?.name) as string;
          forge.repos.delete(repo.name);
          repo.name = next;
          forge.repos.set(next, repo);
        }
        if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
        return { status: 200, body: repoJson(forge, repo) };
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo.name);
        return { status: 204 };
      }
      return notFound();
    }
    const repo = forge.resolveRepo(owner, name);
    if (!repo) return notFound();
    return handleRepoScoped(forge, repo, rest, req);
  }

  return notFound();
}

function handleRepoScoped(forge: Forge, repo: Repo, seg: string[], req: RestRequest): RestReply {
  const method = req.method;

  // ----- branches & refs & commits
  if (seg[0] === 'git' && seg[1] === 'refs' && seg.length === 2 && method === 'POST') {
    const ref = str(req.body?.ref);
    const sha = str(req.body?.sha);
    if (!ref || !sha) return unprocessable('ref and sha are required');
    const target = repo.store.get(sha);
    if (!target || target.type !== 'commit') return unprocessable('sha is not a commit');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, node_id: nodeId('Ref', repo.id), object: { sha, type: 'commit' } } };
  }

  if (seg[0] === 'branches' && seg.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    return { status: 200, body: branches };
  }

  if (seg[0] === 'branches' && seg.length === 2 && method === 'GET') {
    const sha = repo.branchTip(seg[1]);
    if (!sha) return notFound();
    return { status: 200, body: { name: seg[1], commit: { sha }, protected: false } };
  }

  if (seg[0] === 'git' && seg[1] === 'refs' && seg.length > 2 && method === 'GET') {
    const ref = `refs/${seg.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (!sha) return notFound();
    return { status: 200, body: { ref, node_id: nodeId('Ref', repo.id), object: { sha, type: 'commit' } } };
  }

  if (seg[0] === 'commits' && seg.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha');
    let tip: string | undefined;
    if (shaParam) tip = repo.branchTip(shaParam) ?? (repo.store.has(shaParam) ? shaParam : undefined);
    else tip = repo.branchTip(repo.defaultBranch);
    if (!tip) return { status: 200, body: [] };
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      order.push(oid);
      queue.push(...parseCommit(obj.data).parents);
    }
    const { page } = paginate(order, req.query);
    return {
      status: 200,
      body: page.map((oid) => {
        const info = parseCommit((repo.store.get(oid) as { data: Buffer }).data);
        return {
          sha: oid,
          node_id: nodeId('Commit', repo.id),
          commit: {
            message: info.message,
            tree: { sha: info.tree },
            author: { name: info.author.replace(/ <.*$/, ''), email: '', date: repo.createdAt },
            committer: { name: info.committer.replace(/ <.*$/, ''), email: '', date: repo.createdAt },
          },
          parents: info.parents.map((parent) => ({ sha: parent })),
        };
      }),
    };
  }

  // ----- contents
  if (seg[0] === 'contents') {
    const path = seg.slice(1).join('/');
    return handleContents(forge, repo, path, req);
  }

  // ----- labels
  if (seg[0] === 'labels' && seg.length === 1) {
    if (method === 'POST') {
      const labelName = str(req.body?.name);
      if (!labelName) return unprocessable('name is required');
      if (repo.labels.has(labelName)) return unprocessable('Validation Failed: label already exists');
      repo.labels.set(labelName, {
        name: labelName,
        color: (str(req.body?.color) ?? 'ededed').replace(/^#/, ''),
        description: str(req.body?.description) ?? null,
      });
      return { status: 201, body: labelJson(repo, labelName) };
    }
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)) };
    }
    return notFound();
  }

  // ----- issues
  if (seg[0] === 'issues' && seg.length === 1) {
    if (method === 'POST') {
      const title = str(req.body?.title);
      if (!title) return unprocessable('title is required');
      const labelNames = readLabelNames(req.body?.labels);
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) return unprocessable(`Validation Failed: label "${labelName}" does not exist`);
      }
      const issue = forge.createIssue(repo, title, str(req.body?.body) ?? null, labelNames);
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = req.query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page } = paginate(list, req.query);
      return { status: 200, body: page.map((issue) => issueJson(forge, repo, issue)) };
    }
    return notFound();
  }

  if (seg[0] === 'issues' && seg.length >= 2) {
    const number = Number(seg[1]);
    const issue = repo.issues.get(number);
    if (seg.length === 2) {
      if (!issue) return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
      if (method === 'PATCH') {
        const state = str(req.body?.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        if (str(req.body?.title) !== undefined) issue.title = str(req.body?.title) as string;
        if (req.body && 'body' in req.body) issue.body = str(req.body.body) ?? null;
        if (req.body?.labels !== undefined) {
          const labelNames = readLabelNames(req.body.labels);
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return unprocessable(`Validation Failed: label "${labelName}" does not exist`);
          }
          issue.labels = labelNames;
        }
        issue.updatedAt = forge.now();
        const pull = repo.pulls.get(number);
        if (pull && issue.isPull) {
          pull.state = issue.state;
          pull.updatedAt = issue.updatedAt;
        }
        return { status: 200, body: issueJson(forge, repo, issue) };
      }
      return notFound();
    }
    if (seg.length === 3 && seg[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'POST') {
        const bodyText = str(req.body?.body);
        if (bodyText === undefined) return unprocessable('body is required');
        const comment = { id: repo.commentSeq, body: bodyText, createdAt: forge.now() };
        repo.commentSeq += 1;
        issue.comments.push(comment);
        return {
          status: 201,
          body: { id: comment.id, body: comment.body, user: { login: forge.login(), id: forge.userId, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt },
        };
      }
      if (method === 'GET') {
        return {
          status: 200,
          body: issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: forge.login(), id: forge.userId, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          })),
        };
      }
      return notFound();
    }
    return notFound();
  }

  // ----- pull requests
  if (seg[0] === 'pulls' && seg.length === 1) {
    if (method === 'POST') {
      const title = str(req.body?.title);
      const head = normalizeRef(str(req.body?.head) ?? '');
      const base = normalizeRef(str(req.body?.base) ?? '');
      if (!title || !head || !base) return unprocessable('title, head and base are required');
      if (!repo.branchTip(head) || !repo.branchTip(base)) return unprocessable('head or base branch does not exist');
      const pull = forge.createPull(repo, title, str(req.body?.body) ?? null, head, base);
      if (!pull) return unprocessable('cannot create pull request');
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page } = paginate(list, req.query);
      return { status: 200, body: page.map((pull) => pullJson(forge, repo, pull)) };
    }
    return notFound();
  }

  if (seg[0] === 'pulls' && seg.length >= 2) {
    const number = Number(seg[1]);
    const pull = repo.pulls.get(number);
    if (seg.length === 2) {
      if (!pull) return notFound();
      if (method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
      if (method === 'PATCH') {
        const state = str(req.body?.state);
        if (state === 'open' || state === 'closed') pull.state = state;
        if (str(req.body?.title) !== undefined) pull.title = str(req.body?.title) as string;
        if (req.body && 'body' in req.body) pull.body = str(req.body.body) ?? null;
        pull.updatedAt = forge.now();
        return { status: 200, body: pullJson(forge, repo, pull) };
      }
      return notFound();
    }
    if (!pull) return notFound();
    if (seg.length === 3 && seg[2] === 'files' && method === 'GET') {
      return { status: 200, body: pullFiles(repo, pull) };
    }
    if (seg.length === 3 && seg[2] === 'merge' && method === 'PUT') {
      const outcome = squashMerge(forge, repo, pull);
      if (outcome.kind === 'conflict') {
        return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      }
      if (outcome.kind === 'not-open') {
        return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      }
      return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return notFound();
  }

  return notFound();
}

function normalizeRef(ref: string): string {
  const colon = ref.lastIndexOf(':');
  const short = colon === -1 ? ref : ref.slice(colon + 1);
  return short.replace(/^refs\/heads\//, '');
}

function readLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseOid = mergeBase(repo.store, pull.baseSha, headTip) ?? pull.baseSha;
  const from = repo.filesAt(baseOid);
  const to = repo.filesAt(headTip);
  const paths = new Set([...from.keys(), ...to.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (a?.oid === b?.oid) continue;
    const oldText = a ? (repo.store.get(a.oid)?.data.toString('utf8') ?? '') : '';
    const newText = b ? (repo.store.get(b.oid)?.data.toString('utf8') ?? '') : '';
    const counts = lineDiff(oldText, newText);
    out.push({
      filename: path,
      status: !a ? 'added' : !b ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: b?.oid ?? a?.oid ?? ZERO_OID,
    });
  }
  return out;
}

// ---------------------------------------------------------------- contents

function handleContents(forge: Forge, repo: Repo, path: string, req: RestRequest): RestReply {
  const method = req.method;
  const branch = str(req.body?.branch) ?? req.query.get('ref') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;

  if (method === 'GET') {
    const refParam = req.query.get('ref') ?? repo.defaultBranch;
    const tip = repo.branchTip(refParam) ?? (repo.store.has(refParam) ? refParam : undefined);
    const files = repo.filesAt(tip);
    if (path === '') {
      return { status: 200, body: dirListing(repo, files, '') };
    }
    const file = files.get(path);
    if (file) {
      const blob = repo.store.get(file.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          name: path.split('/').pop(),
          path,
          sha: file.oid,
          size: data.length,
          content: data.toString('base64'),
        },
      };
    }
    const prefix = `${path}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) {
      return { status: 200, body: dirListing(repo, files, path) };
    }
    return notFound();
  }

  if (method === 'PUT') {
    const contentB64 = str(req.body?.content);
    const message = str(req.body?.message);
    if (contentB64 === undefined || message === undefined) return unprocessable('content and message are required');
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const parent = repo.refs.get(refName);
    const files = repo.filesAt(parent);
    const existing = files.get(path);
    if (existing) {
      const givenSha = str(req.body?.sha);
      if (givenSha !== existing.oid) return { status: 409, body: { message: 'Conflict: sha does not match' } };
    }
    const blobOid = repo.store.put('blob', data);
    files.set(path, { mode: '100644', oid: blobOid });
    const commit = repo.commitFiles(parent, files, message, forge);
    repo.refs.set(refName, commit);
    return {
      status: existing ? 200 : 201,
      body: {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      },
    };
  }

  if (method === 'DELETE') {
    const message = str(req.body?.message);
    const givenSha = str(req.body?.sha);
    if (message === undefined || givenSha === undefined) return unprocessable('message and sha are required');
    const parent = repo.refs.get(refName);
    const files = repo.filesAt(parent);
    const existing = files.get(path);
    if (!existing) return notFound();
    if (givenSha !== existing.oid) return { status: 409, body: { message: 'Conflict: sha does not match' } };
    files.delete(path);
    const commit = repo.commitFiles(parent, files, message, forge);
    repo.refs.set(refName, commit);
    return { status: 200, body: { content: null, commit: { sha: commit, message } } };
  }

  return notFound();
}

function dirListing(repo: Repo, files: Map<string, { mode: string; oid: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', oid: file.oid, size: repo.store.get(file.oid)?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', oid: '', size: 0 });
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, info]) => ({
      name,
      path: prefix + name,
      sha: info.oid,
      size: info.size,
      type: info.type,
    }));
}
