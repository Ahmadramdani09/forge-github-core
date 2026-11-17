// GitHub GraphQL v4 surface: a small but real GraphQL engine (lexer, parser,
// executor) covering the documents gh and github-mcp-server send — viewer,
// repository, node, introspection of the core types, issue/pull-request
// connections with cursor pagination, and the five mutations — all resolved
// against the same store REST and git use.

import { squashMerge, mergeFiles } from './store.ts';
import type { Forge as ForgeT, Repo as RepoT, Issue as IssueT, Pull as PullT } from './store.ts';
import { mergeBase } from './gitobj.ts';
import { nodeId, pullFiles } from './rest.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { tag: 'string'; value: string }
  | { tag: 'number'; value: number }
  | { tag: 'boolean'; value: boolean }
  | { tag: 'null' }
  | { tag: 'enum'; value: string }
  | { tag: 'list'; items: Value[] }
  | { tag: 'object'; fields: Map<string, Value> }
  | { tag: 'variable'; name: string };

interface FieldNode {
  alias?: string;
  name: string;
  args: Map<string, Value>;
  selection?: SelectionNode[];
}

type SelectionNode =
  | { tag: 'field'; field: FieldNode }
  | { tag: 'inline'; typeName: string; selection: SelectionNode[] }
  | { tag: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

class Parser {
  tokens: Token[];
  pos = 0;
  fragments = new Map<string, SelectionNode[]>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        // Directives on the operation are skipped.
        while (this.peek().kind === 'punct' && this.peek().value === '@') {
          this.next();
          this.expectName();
          if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
        }
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment without type condition');
        this.expectName(); // the type name
        this.fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${keyword}`);
    }
    return operations;
  }

  parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      if (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName();
      }
    }
  }

  parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        const token = this.peek();
        if (token.kind === 'name' && token.value === 'on') {
          this.next();
          const typeName = this.expectName();
          selections.push({ tag: 'inline', typeName, selection: this.parseSelectionSet() });
        } else {
          selections.push({ tag: 'spread', name: this.expectName() });
        }
        continue;
      }
      selections.push({ tag: 'field', field: this.parseField() });
    }
    return selections;
  }

  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args = new Map<string, Value>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    // Field directives are skipped.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { tag: 'string', value: token.value };
    if (token.kind === 'number') return { tag: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { tag: 'boolean', value: true };
      if (token.value === 'false') return { tag: 'boolean', value: false };
      if (token.value === 'null') return { tag: 'null' };
      return { tag: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { tag: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { tag: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { tag: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

/** Resolve a parsed Value against the operation's variables into plain JS data. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.tag) {
    case 'string':
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
    case 'variable':
      return variables[value.name];
  }
}

// ------------------------------------------------------------------ schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'commits', 'repository', 'author', 'createdAt', 'updatedAt',
    'mergedAt', 'mergeCommit', 'url',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

// ------------------------------------------------------------------ values

type GqlObject =
  | { kind: 'Query' }
  | { kind: 'Mutation' }
  | { kind: 'User' }
  | { kind: 'Repository'; repo: RepoT }
  | { kind: 'Issue'; repo: RepoT; issue: IssueT }
  | { kind: 'PullRequest'; repo: RepoT; pull: PullT }
  | { kind: 'Record'; typeName: string; data: Record<string, unknown> };

interface ExecContext {
  forge: ForgeT;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

function globalId(kind: string, repo: RepoT, number: number): string {
  return nodeId(kind, repo.id * 1_000_000 + number);
}

function decodeGlobalId(id: string): { kind: string; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1], num: Number(match[2]) };
  } catch {
    return null;
  }
}

function repoByGlobalId(forge: ForgeT, num: number): RepoT | null {
  for (const repo of forge.repos.values()) if (repo.id === num) return repo;
  return null;
}

function issueState(issue: IssueT): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullT): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: RepoT, pull: PullT): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const baseOid = mergeBase(repo.store, baseTip, headTip);
  const merged = mergeFiles(repo.filesAt(baseOid ?? undefined), repo.filesAt(baseTip), repo.filesAt(headTip));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

interface Connection<T> {
  items: T[];
  total: number;
  hasNext: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginate<T>(ordered: T[], args: Map<string, unknown>, keyOf: (item: T) => number): Connection<T> {
  let start = 0;
  const after = args.get('after');
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const index = ordered.findIndex((item) => keyOf(item) === Number(match[1]));
        if (index !== -1) start = index + 1;
      }
    } catch {
      // An undecodable cursor starts from the beginning.
    }
  }
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : ordered.length;
  const slice = ordered.slice(start, start + Math.max(0, first));
  return {
    items: slice,
    total: ordered.length,
    hasNext: start + slice.length < ordered.length,
    endCursor: slice.length > 0 ? cursorFor(keyOf(slice[slice.length - 1])) : null,
    startCursor: slice.length > 0 ? cursorFor(keyOf(slice[0])) : null,
  };
}

// ------------------------------------------------------------------ executor

function argsOf(field: FieldNode, ctx: ExecContext): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [name, value] of field.args) out.set(name, resolveValue(value, ctx.variables));
  return out;
}

function typeRecord(name: string): GqlObject {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  const data: Record<string, unknown> = {
    name,
    kind: TYPE_KIND[name] ?? 'OBJECT',
    description: null,
    fields: fields ? fields.map((fieldName) => ({ kind: 'Record', typeName: '__Field', data: { name: fieldName, description: null, isDeprecated: false, deprecationReason: null } })) : null,
    enumValues: enumValues ? enumValues.map((valueName) => ({ kind: 'Record', typeName: '__EnumValue', data: { name: valueName, description: null, isDeprecated: false, deprecationReason: null } })) : null,
    possibleTypes: null,
    inputFields: null,
    ofType: null,
  };
  return { kind: 'Record', typeName: '__Type', data };
}

function resolveRoot(ctx: ExecContext, field: FieldNode, rootKind: 'Query' | 'Mutation'): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  if (rootKind === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { kind: 'User' } as GqlObject;
      case 'repository': {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        const repo = forge.resolveRepo(owner, name);
        return repo ? ({ kind: 'Repository', repo } as GqlObject) : null;
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.get('id') ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(forge, decoded.num);
          return repo ? ({ kind: 'Repository', repo } as GqlObject) : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const repoId = Math.floor(decoded.num / 1_000_000);
          const number = decoded.num % 1_000_000;
          const repo = repoByGlobalId(forge, repoId);
          if (!repo) return null;
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.get(number);
            return issue && !issue.isPull ? ({ kind: 'Issue', repo, issue } as GqlObject) : null;
          }
          const pull = repo.pulls.get(number);
          return pull ? ({ kind: 'PullRequest', repo, pull } as GqlObject) : null;
        }
        return null;
      }
      case '__type': {
        const name = String(args.get('name') ?? '');
        if (!TYPE_FIELDS[name] && !ENUM_VALUES[name]) return null;
        return typeRecord(name);
      }
      case '__schema':
        return {
          kind: 'Record',
          typeName: '__Schema',
          data: {
            queryType: { kind: 'Record', typeName: '__Type', data: { name: 'Query', kind: 'OBJECT' } },
            mutationType: { kind: 'Record', typeName: '__Type', data: { name: 'Mutation', kind: 'OBJECT' } },
            subscriptionType: null,
            types: [],
            directives: [],
          },
        } as GqlObject;
      case 'rateLimit':
        return { kind: 'Record', typeName: 'RateLimit', data: { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2025-01-01T01:00:00Z' } } as GqlObject;
      default:
        return undefined;
    }
  }
  // Mutations.
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'Repository' ? repoByGlobalId(forge, decoded.num) : null;
      if (!repo) return null;
      const issue = forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : null, []);
      return { kind: 'Record', typeName: 'CreateIssuePayload', data: { issue: { kind: 'Issue', repo, issue } as GqlObject, clientMutationId: input.clientMutationId ?? null } } as GqlObject;
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded) return null;
      const repo = repoByGlobalId(forge, Math.floor(decoded.num / 1_000_000));
      const issue = repo?.issues.get(decoded.num % 1_000_000);
      if (!repo || !issue) return null;
      issue.state = 'closed';
      issue.updatedAt = forge.now();
      return { kind: 'Record', typeName: 'CloseIssuePayload', data: { issue: { kind: 'Issue', repo, issue } as GqlObject, clientMutationId: input.clientMutationId ?? null } } as GqlObject;
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'Repository' ? repoByGlobalId(forge, decoded.num) : null;
      if (!repo) return null;
      const head = String(input.headRefName ?? '').replace(/^refs\/heads\//, '');
      const base = String(input.baseRefName ?? '').replace(/^refs\/heads\//, '');
      const pull = forge.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : null, head, base);
      if (!pull) return null;
      return { kind: 'Record', typeName: 'CreatePullRequestPayload', data: { pullRequest: { kind: 'PullRequest', repo, pull } as GqlObject, clientMutationId: input.clientMutationId ?? null } } as GqlObject;
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded) return null;
      const repo = repoByGlobalId(forge, Math.floor(decoded.num / 1_000_000));
      const pull = repo?.pulls.get(decoded.num % 1_000_000);
      if (!repo || !pull) return null;
      const outcome = squashMerge(forge, repo, pull);
      if (outcome.kind === 'conflict') {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return null;
      }
      return { kind: 'Record', typeName: 'MergePullRequestPayload', data: { pullRequest: { kind: 'PullRequest', repo, pull } as GqlObject, clientMutationId: input.clientMutationId ?? null } } as GqlObject;
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded) return null;
      const repo = repoByGlobalId(forge, Math.floor(decoded.num / 1_000_000));
      const issue = repo?.issues.get(decoded.num % 1_000_000);
      if (!repo || !issue) return null;
      const comment = { id: repo.commentSeq, body: String(input.body ?? ''), createdAt: forge.now() };
      repo.commentSeq += 1;
      issue.comments.push(comment);
      const node: GqlObject = {
        kind: 'Record',
        typeName: 'IssueComment',
        data: { id: globalId('IssueComment', repo, comment.id), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.createdAt },
      };
      return {
        kind: 'Record',
        typeName: 'AddCommentPayload',
        data: {
          commentEdge: { kind: 'Record', typeName: 'IssueCommentEdge', data: { node, cursor: cursorFor(issue.number) } } as GqlObject,
          subject: { kind: 'Issue', repo, issue } as GqlObject,
          clientMutationId: input.clientMutationId ?? null,
        },
      } as GqlObject;
    }
    default:
      return undefined;
  }
}

function resolveField(ctx: ExecContext, obj: GqlObject, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  switch (obj.kind) {
    case 'Query':
    case 'Mutation': {
      const value = resolveRoot(ctx, field, obj.kind);
      if (value === undefined) ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${obj.kind}'` });
      return value ?? null;
    }
    case 'User': {
      if (field.name === 'login') return forge.login();
      if (field.name === 'id') return nodeId('User', forge.userId);
      if (field.name === 'name') return forge.login();
      if (field.name === 'url') return `https://forge.invalid/${forge.login()}`;
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'User'` });
      return null;
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (field.name) {
        case 'id':
          return nodeId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${forge.login()}/${repo.name}`;
        case 'owner':
          return { kind: 'User' } as GqlObject;
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          if (!tip) return null;
          return { kind: 'Record', typeName: 'Ref', data: { name: repo.defaultBranch, prefix: 'refs/heads/', target: { oid: tip } } } as GqlObject;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasPullRequestsEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.createdAt;
        case 'url':
          return `https://forge.invalid/${forge.login()}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue && !issue.isPull ? ({ kind: 'Issue', repo, issue } as GqlObject) : null;
        }
        case 'issues': {
          let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
          const states = args.get('states');
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state)));
            list = list.filter((issue) => wanted.has(issueState(issue)));
          }
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
          list.sort((a, b) => {
            const cmp = a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1;
            return direction === 'ASC' ? cmp : -cmp;
          });
          const page = paginate(list, args, (issue) => issue.number);
          return {
            kind: 'Record',
            typeName: 'IssueConnection',
            data: {
              nodes: page.items.map((issue) => ({ kind: 'Issue', repo, issue }) as GqlObject),
              edges: page.items.map((issue) => ({
                kind: 'Record',
                typeName: 'IssueEdge',
                data: { node: { kind: 'Issue', repo, issue } as GqlObject, cursor: cursorFor(issue.number) },
              })),
              pageInfo: {
                kind: 'Record',
                typeName: 'PageInfo',
                data: { hasNextPage: page.hasNext, hasPreviousPage: false, startCursor: page.startCursor, endCursor: page.endCursor },
              },
              totalCount: page.total,
            },
          } as GqlObject;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull ? ({ kind: 'PullRequest', repo, pull } as GqlObject) : null;
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = args.get('states');
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state)));
            list = list.filter((pull) => wanted.has(pullState(pull)));
          }
          list.sort((a, b) => b.number - a.number);
          const page = paginate(list, args, (pull) => pull.number);
          return {
            kind: 'Record',
            typeName: 'PullRequestConnection',
            data: {
              nodes: page.items.map((pull) => ({ kind: 'PullRequest', repo, pull }) as GqlObject),
              edges: page.items.map((pull) => ({
                kind: 'Record',
                typeName: 'PullRequestEdge',
                data: { node: { kind: 'PullRequest', repo, pull } as GqlObject, cursor: cursorFor(pull.number) },
              })),
              pageInfo: {
                kind: 'Record',
                typeName: 'PageInfo',
                data: { hasNextPage: page.hasNext, hasPreviousPage: false, startCursor: page.startCursor, endCursor: page.endCursor },
              },
              totalCount: page.total,
            },
          } as GqlObject;
        }
        default:
          ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Repository'` });
          return null;
      }
    }
    case 'Issue': {
      const { repo, issue } = obj;
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        case 'author':
          return { kind: 'User' } as GqlObject;
        case 'repository':
          return { kind: 'Repository', repo } as GqlObject;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'url':
          return `https://forge.invalid/${forge.login()}/${repo.name}/issues/${issue.number}`;
        case 'labels':
          return {
            kind: 'Record',
            typeName: 'LabelConnection',
            data: { nodes: issue.labels.map((name) => ({ kind: 'Record', typeName: 'Label', data: { name } }) as GqlObject) },
          } as GqlObject;
        case 'comments':
          return {
            kind: 'Record',
            typeName: 'IssueCommentConnection',
            data: {
              nodes: issue.comments.map((comment) => ({
                kind: 'Record',
                typeName: 'IssueComment',
                data: { id: globalId('IssueComment', repo, comment.id), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.createdAt },
              }) as GqlObject),
            },
          } as GqlObject;
        default:
          ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Issue'` });
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = obj;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return { kind: 'Record', typeName: 'Ref', data: { name: pull.headRef, prefix: 'refs/heads/' } } as GqlObject;
        case 'baseRef':
          return { kind: 'Record', typeName: 'Ref', data: { name: pull.baseRef, prefix: 'refs/heads/' } } as GqlObject;
        case 'repository':
          return { kind: 'Repository', repo } as GqlObject;
        case 'author':
          return { kind: 'User' } as GqlObject;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit':
          return pull.mergeCommitSha ? { kind: 'Record', typeName: 'Commit', data: { oid: pull.mergeCommitSha } } : null;
        case 'url':
          return `https://forge.invalid/${forge.login()}/${repo.name}/pull/${pull.number}`;
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : files.length;
          return {
            kind: 'Record',
            typeName: 'PullRequestChangedFileConnection',
            data: {
              nodes: files.slice(0, Math.max(0, first)).map((file) => ({
                kind: 'Record',
                typeName: 'PullRequestChangedFile',
                data: {
                  path: file.filename,
                  additions: file.additions,
                  deletions: file.deletions,
                  changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
                },
              }) as GqlObject),
            },
          } as GqlObject;
        }
        case 'commits':
          return { kind: 'Record', typeName: 'PullRequestCommitConnection', data: { nodes: [] } } as GqlObject;
        default:
          ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'PullRequest'` });
          return null;
      }
    }
    case 'Record': {
      if (field.name in obj.data) return obj.data[field.name];
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${obj.typeName}'` });
      return null;
    }
  }
}

function completeValue(ctx: ExecContext, value: unknown, selection: SelectionNode[] | undefined, typeName: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selection, typeName));
  if (typeof value === 'object' && value !== null && 'kind' in (value as Record<string, unknown>)) {
    const obj = value as GqlObject;
    if (!selection) return obj.kind === 'Record' ? obj.data : {};
    return executeSelectionSet(ctx, obj, selection);
  }
  return value;
}

function executeSelectionSet(ctx: ExecContext, obj: GqlObject, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.tag === 'inline') {
      const objType = obj.kind === 'Record' ? obj.typeName : obj.kind;
      if (selection.typeName === objType || selection.typeName === 'Node' || selection.typeName === 'Repository') {
        Object.assign(out, executeSelectionSet(ctx, obj, selection.selection));
      }
      continue;
    }
    if (selection.tag === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(ctx, obj, fragment));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, obj, field);
    out[key] = completeValue(ctx, value, field.selection, field.name);
  }
  return out;
}

// ------------------------------------------------------------------ entry

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function runOperation(forge: ForgeT, query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  const parser = new Parser(query);
  const operations = parser.parseDocument();
  const operation = operations.find((op) => operationName === undefined || op.name === operationName) ?? operations[0];
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { forge, variables, fragments: parser.fragments, errors: [] };
  const root: GqlObject = operation.type === 'mutation' ? { kind: 'Mutation' } : { kind: 'Query' };
  const data = executeSelectionSet(ctx, root, operation.selection);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

export function handleGraphQL(forge: Forge, payload: unknown): GraphQLReply {
  try {
    if (Array.isArray(payload)) {
      const results = payload.map((entry) => {
        const item = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
        return runOperation(
          forge,
          String(item.query ?? ''),
          (item.variables ?? {}) as Record<string, unknown>,
          typeof item.operationName === 'string' ? item.operationName : undefined,
        );
      });
      return { status: 200, body: results };
    }
    const item = (payload ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    const result = runOperation(
      forge,
      String(item.query ?? ''),
      (item.variables ?? {}) as Record<string, unknown>,
      typeof item.operationName === 'string' ? item.operationName : undefined,
    );
    return { status: 200, body: result };
  } catch (err) {
    return { status: 200, body: { errors: [{ message: err instanceof Error ? err.message : 'GraphQL error' }] } };
  }
}
