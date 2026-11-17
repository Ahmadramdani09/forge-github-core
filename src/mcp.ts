// Model Context Protocol over streamable HTTP: JSON-RPC 2.0 answering plain
// application/json. Both protocol eras work: the 2026-07-28 revision through
// server/discover (no handshake, no session), and the handshake revisions
// through initialize + notifications/initialized with an Mcp-Session-Id.
// The tools act on the same store as REST, so objects keep their ids across
// surfaces.

import { Forge, squashMerge } from './store.ts';
import type { Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpReply {
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'forge-mcp-session';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'The owner/repo full name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'The owner/repo full name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'The owner/repo full name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'The owner/repo full name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'The owner/repo full name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
        additionalProperties: true,
      },
    })),
  };
}

const TOOLS_LIST_JSON = JSON.stringify(toolsList());

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolSuccess(payload: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Json,
    isError: false,
  };
}

function toolFailure(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split a full_name argument into owner/repo when the pair is not given directly. */
function ownerRepo(args: Json): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash !== -1) {
      if (!owner) owner = args.full_name.slice(0, slash);
      if (!repo) repo = args.full_name.slice(slash + 1);
    }
  }
  return { owner, repo };
}

function callTool(forge: Forge, name: string, rawArgs: unknown): Json {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return rpcErrorSentinel(-32602, `unknown tool: ${name}`);
  const args = (rawArgs ?? {}) as Json;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      // full_name can stand in for owner/repo.
      if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string') continue;
      return toolFailure(`missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.repoByName(repoName)) return toolFailure(`repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : null);
      if (!repo) return toolFailure('could not create repository');
      return toolSuccess(repoJson(forge, repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = forge.resolveRepo(owner, repoName);
      if (!repo) return toolFailure(`repository ${owner}/${repoName} not found`);
      return toolSuccess(repoJson(forge, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = forge.resolveRepo(owner, repoName);
      if (!repo) return toolFailure(`repository ${owner}/${repoName} not found`);
      const issue = forge.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : null, []);
      return toolSuccess(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = forge.resolveRepo(owner, repoName);
      if (!repo) return toolFailure(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => !issue.isPull)
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(forge, repo, issue));
      return toolSuccess(list);
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = forge.resolveRepo(owner, repoName);
      if (!repo) return toolFailure(`repository ${owner}/${repoName} not found`);
      const head = String(args.head).replace(/^.*:/, '').replace(/^refs\/heads\//, '');
      const base = String(args.base).replace(/^.*:/, '').replace(/^refs\/heads\//, '');
      const pull = forge.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : null, head, base);
      if (!pull) return toolFailure('could not create pull request: head or base branch does not exist');
      return toolSuccess(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = forge.resolveRepo(owner, repoName);
      if (!repo) return toolFailure(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolFailure(`pull request ${String(args.pull_number)} not found`);
      const outcome = squashMerge(forge, repo, pull);
      if (outcome.kind === 'conflict') return toolFailure('Pull Request is not mergeable');
      if (outcome.kind === 'not-open') return toolFailure('Pull Request is not open');
      return toolSuccess(pullJson(forge, repo, pull));
    }
    default:
      return rpcErrorSentinel(-32602, `unknown tool: ${name}`);
  }
}

/** Marker wrapper so callTool can signal a JSON-RPC error instead of a tool result. */
function rpcErrorSentinel(code: number, message: string): Json {
  return { __rpcError: { code, message } } as unknown as Json;
}

function isRpcErrorSentinel(value: Json): value is Json & { __rpcError: { code: number; message: string } } {
  return typeof value === 'object' && value !== null && '__rpcError' in value;
}

function handleRequest(forge: Forge, request: Json): { reply: Json | null; session: boolean } {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;
  const params = (request.params ?? {}) as Json;
  switch (method) {
    case 'server/discover':
      return {
        reply: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
        session: false,
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        reply: rpcResult(id, {
          protocolVersion: chosen,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
        session: true,
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { reply: null, session: false };
    case 'ping':
      return { reply: rpcResult(id, {}), session: false };
    case 'tools/list':
      return { reply: rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as unknown), session: false };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const result = callTool(forge, name, params.arguments);
      if (isRpcErrorSentinel(result)) {
        return { reply: rpcError(id, result.__rpcError.code, result.__rpcError.message), session: false };
      }
      return { reply: rpcResult(id, result), session: false };
    }
    default:
      if (isNotification) return { reply: null, session: false };
      return { reply: rpcError(id, -32601, `method not found: ${method}`), session: false };
  }
}

export async function handleMcp(
  forge: Forge,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  method: string,
): Promise<McpReply> {
  void headers;
  if (method === 'GET') {
    return { status: 405, body: '{"jsonrpc":"2.0","error":{"code":-32601,"message":"GET is not supported"},"id":null}', contentType: 'application/json' };
  }
  if (method === 'DELETE') {
    return { status: 200, body: '', contentType: 'application/json' };
  }
  if (method !== 'POST') {
    return { status: 405, body: '', contentType: 'application/json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }),
      contentType: 'application/json',
    };
  }
  const requests = Array.isArray(parsed) ? (parsed as Json[]) : [parsed as Json];
  const replies: Json[] = [];
  let session = false;
  for (const request of requests) {
    const { reply, session: wantsSession } = handleRequest(forge, request);
    if (wantsSession) session = true;
    if (reply !== null) replies.push(reply);
  }
  if (replies.length === 0) {
    return { status: 202, body: '', contentType: 'application/json', headers: session ? { 'mcp-session-id': SESSION_ID } : {} };
  }
  return {
    status: 200,
    body: JSON.stringify(Array.isArray(parsed) ? replies : replies[0]),
    contentType: 'application/json',
    headers: session ? { 'mcp-session-id': SESSION_ID } : {},
  };
}
