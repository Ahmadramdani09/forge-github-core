// The forge's HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from a single in-memory store. Auth is the bearer token
// from MAKEFUN_SHOP_TOKEN; every reply carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest, type RestReply } from './src/rest.ts';
import { advertisement, decodePkts, fetchV0, fetchV2, lsRefs, receivePack } from './src/smart.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function createForgeServer(token: string): Server {
  const forge = new Forge();
  let requestSeq = 0;

  const server = createServer((req, res) => {
    requestSeq += 1;
    const requestId = `forge-${requestSeq.toString(16).padStart(8, '0')}`;
    handle(forge, token, req, res, requestId).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' }, requestId);
        else res.end();
      } catch {
        // The peer is gone; nothing more to do.
      }
    });
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    'x-github-request-id': requestId,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handle(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  // Everything else needs the bearer token.
  const authorization = req.headers.authorization ?? '';
  if (authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' }, requestId);
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const reply = restReply(forge, req, url, body, requestId);
    applyRestReply(res, reply, requestId);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON' }, requestId);
      return;
    }
    const reply = handleGraphQL(forge, parsed);
    sendJson(res, reply.status, reply.body, requestId);
    return;
  }

  if (path === '/mcp') {
    const reply = await handleMcp(forge, req.headers, body, method);
    const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(reply.headers ?? {}) };
    if (reply.contentType) headers['content-type'] = reply.contentType;
    const payload = reply.body ?? '';
    headers['content-length'] = String(Buffer.byteLength(payload));
    res.writeHead(reply.status, headers);
    res.end(payload);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const repo = forge.resolveRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }
    const endpoint = gitMatch[3];
    if (endpoint === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'Forbidden' }, requestId);
        return;
      }
      const protocolHeader = req.headers['git-protocol'] ?? '';
      const version2 = service === 'git-upload-pack' && protocolHeader.includes('version=2');
      sendBytes(res, 200, advertisement(forge, repo, service, version2), `application/x-${service}-advertisement`, requestId);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const { packets } = decodePkts(body);
      const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
      let out: Buffer;
      if (lines.length > 0 && lines[0].startsWith('command=')) {
        const command = lines[0].slice('command='.length);
        // Skip capability lines up to the delim; the rest are arguments.
        const delimIndex = packets.findIndex((p) => p.kind === 'delim');
        const argPackets = delimIndex === -1 ? [] : packets.slice(delimIndex + 1);
        const argLines = argPackets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
        out = command === 'ls-refs' ? lsRefs(repo, argLines) : fetchV2(repo, argLines);
      } else {
        out = fetchV0(repo, lines);
      }
      sendBytes(res, 200, out, 'application/x-git-upload-pack-result', requestId);
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const out = receivePack(repo, body);
      sendBytes(res, 200, out, 'application/x-git-receive-pack-result', requestId);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' }, requestId);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

function restReply(forge: Forge, req: IncomingMessage, url: URL, body: Buffer, requestId: string): RestReply {
  void requestId;
  const segments = url.pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  let parsedBody: Record<string, unknown> | null = null;
  const method = req.method ?? 'GET';
  if (body.length > 0 && method !== 'GET') {
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsedBody = value as Record<string, unknown>;
      else parsedBody = {};
    } catch {
      return { status: 400, body: { message: 'Malformed JSON' } };
    }
  }
  const host = req.headers.host ?? 'localhost';
  return handleRest(forge, {
    method,
    segments,
    query: url.searchParams,
    body: parsedBody,
    rawBody: body,
    baseUrl: `http://${host}`,
  });
}

function applyRestReply(res: ServerResponse, reply: RestReply, requestId: string): void {
  if (reply.status === 204 || reply.body === undefined) {
    res.writeHead(reply.status, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.body, requestId, reply.headers ?? {});
}
