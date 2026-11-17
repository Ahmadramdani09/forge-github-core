// Git smart HTTP, implemented from the protocol itself: v0 and v2 ref
// advertisements, v2 ls-refs and fetch (with shallow support), v0 fetch, and
// v0 receive-pack with report-status. No git binary anywhere: the object
// store in gitobj.ts does all the work.

import { Forge, Repo, ZERO_OID } from './store.ts';
import {
  buildPack,
  isAncestor,
  objectsToSend,
  parseCommit,
  parseTree,
  reachableCommits,
  receivePack as ingestPack,
} from './gitobj.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines; trailing raw bytes (a pack) are returned too. */
export function decodePkts(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break; // a flush ends the pkt-line stream; what follows is raw (the pack)
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      offset += 4;
      continue; // response-end packet: skip
    }
    if (len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_CAPS_V0 = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Peeled target of an annotated tag object, when the ref names one. */
function peeled(repo: Repo, oid: string): string | null {
  const obj = repo.store.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return match ? match[1] : null;
}

export function advertisement(forge: Forge, repo: Repo, service: string, version2: boolean): Buffer {
  void forge;
  if (service === 'git-upload-pack' && version2) {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (service === 'git-upload-pack') {
      parts.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    }
  } else {
    let first = true;
    const headOid = repo.refs.get(repo.headRef()) ?? ZERO_OID;
    parts.push(pktLine(first ? `${headOid} HEAD\0${caps}\n` : `${headOid} HEAD\n`));
    first = false;
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peel = peeled(repo, oid);
      if (peel) parts.push(pktLine(`${peel} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function lsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headTarget = repo.headRef();
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else {
      lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const target = peeled(repo, oid);
      if (target) line += ` peeled:${target}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen?: number;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface ShallowPlan {
  commits: Set<string>; // commits to include
  boundary: string[]; // commits to report as shallow after this fetch
  unshallow: string[];
}

/** BFS levels from a tip: commit -> depth (1 = the tip itself), pruned at maxDepth. */
function commitLevels(repo: Repo, tip: string, maxDepth = Number.POSITIVE_INFINITY): Map<string, number> {
  const levels = new Map<string, number>();
  const queue: [string, number][] = [[tip, 1]];
  while (queue.length > 0) {
    const [oid, depth] = queue.shift() as [string, number];
    if (levels.has(oid) && (levels.get(oid) as number) <= depth) continue;
    levels.set(oid, depth);
    if (depth >= maxDepth) continue;
    const obj = repo.store.get(oid);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, depth + 1]);
    }
  }
  return levels;
}

/**
 * The commits reachable from `seeds` without expanding the parents of
 * `stopAt` commits: what a shallow client actually holds when its boundary
 * commits are in `stopAt` (their ancestors are named on the server side but
 * were never sent).
 */
function truncatedClosure(repo: Repo, seeds: string[], stopAt: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    if (stopAt.has(oid)) continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  return seen;
}

/**
 * Shallow fetch planning. `deepen N` is the target total depth measured from
 * the wants (the protocol's meaning), and the `shallow` lines name the
 * client's current boundary. The new boundary is recomputed from what the
 * client holds after the fetch: a present commit whose parents are not all
 * present.
 */
function planShallow(repo: Repo, args: FetchArgs, wantClosure: Set<string>): ShallowPlan {
  const boundarySet = new Set(args.shallowLines);
  const held = truncatedClosure(repo, [...args.haves, ...args.shallowLines], boundarySet);
  const include = new Set<string>();
  if (args.deepen !== undefined) {
    for (const want of args.wants) {
      const levels = commitLevels(repo, want, args.deepen);
      for (const [oid, level] of levels) {
        if (level <= args.deepen) include.add(oid);
      }
    }
  } else {
    const belowBoundary = new Set<string>();
    for (const boundaryOid of boundarySet) {
      for (const oid of reachableCommits(repo.store, boundaryOid)) belowBoundary.add(oid);
    }
    for (const oid of wantClosure) {
      if (!belowBoundary.has(oid)) include.add(oid);
    }
  }
  const deliver = new Set<string>();
  for (const oid of include) if (!held.has(oid)) deliver.add(oid);
  const present = new Set<string>([...held, ...deliver]);
  const newBoundary = new Set<string>();
  for (const oid of [...deliver, ...boundarySet]) {
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => !present.has(parent))) newBoundary.add(oid);
  }
  const unshallow = args.shallowLines.filter((oid) => !newBoundary.has(oid));
  return { commits: deliver, boundary: [...newBoundary], unshallow };
}

function sidebandChunks(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const SIZE = 32768;
  for (let offset = 0; offset < data.length; offset += SIZE) {
    const slice = data.subarray(offset, offset + SIZE);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

/** The fetch computation shared by v2 and v0. */
function computeFetch(repo: Repo, args: FetchArgs): { packObjects: Map<string, { type: string; data: Buffer }> | null; shallow: ShallowPlan | null; common: string[] } {
  const store = repo.store;
  const common = args.haves.filter((have) => store.has(have));
  const shallowMode = args.deepen !== undefined || args.shallowLines.length > 0;
  if (!shallowMode) {
    const haveClosure = new Set<string>();
    for (const have of common) {
      for (const oid of reachableCommits(store, have)) haveClosure.add(oid);
    }
    const wantCommits = new Set<string>();
    for (const want of args.wants) {
      for (const oid of reachableCommits(store, want)) wantCommits.add(oid);
    }
    const fresh = [...wantCommits].filter((oid) => !haveClosure.has(oid));
    if (fresh.length === 0 && args.wants.length > 0) {
      return { packObjects: null, shallow: null, common };
    }
    const objects = objectsToSend(store, args.wants, haveClosure);
    return { packObjects: objects as Map<string, { type: string; data: Buffer }>, shallow: null, common };
  }
  const wantCommits = new Set<string>();
  if (args.deepen === undefined) {
    for (const want of args.wants) {
      for (const oid of reachableCommits(store, want)) wantCommits.add(oid);
    }
  }
  const plan = planShallow(repo, args, wantCommits);
  const include = plan.commits;
  if (include.size === 0) {
    return { packObjects: null, shallow: plan, common };
  }
  const objects = new Map<string, { type: string; data: Buffer }>();
  const visitTree = (treeOid: string): void => {
    if (objects.has(treeOid)) return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    objects.set(treeOid, obj as { type: string; data: Buffer });
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else {
        const blob = store.get(entry.oid);
        if (blob) objects.set(entry.oid, blob as { type: string; data: Buffer });
      }
    }
  };
  for (const oid of include) {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    objects.set(oid, obj as { type: string; data: Buffer });
    visitTree(parseCommit(obj.data).tree);
  }
  // Boundary handling: if a commit is a boundary, its parents are excluded
  // already by construction of plan.commits.
  return { packObjects: objects, shallow: plan, common };
}

export function fetchV2(repo: Repo, argLines: string[]): Buffer {
  const args = parseFetchArgs(argLines);
  const { packObjects, shallow, common } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (common.length > 0) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    if (packObjects === null) parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (shallow) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of shallow.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (packObjects !== null) {
    const pack = buildPack([...packObjects.entries()].map(([oid, obj]) => ({ oid, type: obj.type as never, data: obj.data })));
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandChunks(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function fetchV0(repo: Repo, lines: string[]): Buffer {
  const args = parseFetchArgs(lines);
  args.done = true;
  const { packObjects, shallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (shallow) {
    for (const oid of shallow.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of shallow.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(pktLine('NAK\n'));
  if (packObjects !== null && packObjects.size > 0) {
    const pack = buildPack([...packObjects.entries()].map(([oid, obj]) => ({ oid, type: obj.type as never, data: obj.data })));
    parts.push(...sidebandChunks(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodePkts(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const sideband = capabilities.split(' ').includes('side-band-64k');
  const reportStatus = capabilities.split(' ').includes('report-status');

  let unpackError: string | null = null;
  const hasPack = rest.length > 0 && commands.some((command) => command.newOid !== ZERO_OID);
  if (hasPack) {
    try {
      receivePackObjects(repo, rest);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  if (unpackError !== null) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: `unpacker error` });
  } else {
    for (const command of commands) {
      results.push(applyCommand(repo, command));
    }
  }

  if (!reportStatus) return PKT_FLUSH;
  const lines: string[] = [unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n'];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  const report = Buffer.concat(lines.map((line) => pktLine(line)));
  if (sideband) {
    return Buffer.concat([...sidebandChunks(report), PKT_FLUSH]);
  }
  return Buffer.concat([report, PKT_FLUSH]);
}

function receivePackObjects(repo: Repo, pack: Buffer): void {
  ingestPack(repo.store, pack);
}

function applyCommand(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (!repo.refs.has(command.ref)) return { ref: command.ref, ok: false, reason: 'reference does not exist' };
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true };
  }
  const target = repo.store.get(command.newOid);
  if (!target) return { ref: command.ref, ok: false, reason: 'unknown object' };
  if (current !== command.oldOid && current !== ZERO_OID && command.oldOid !== ZERO_OID) {
    return { ref: command.ref, ok: false, reason: 'reference is at a different commit' };
  }
  const isBranch = command.ref.startsWith('refs/heads/');
  if (isBranch && current !== ZERO_OID && target.type === 'commit') {
    if (!isAncestor(repo.store, current, command.newOid)) {
      return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true };
}
