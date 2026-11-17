// Git object model on Node's standard library only: hashing, loose in-memory
// storage, tree/commit codecs, packfile reading (with delta application) and
// packfile writing (full objects, no deltas: always valid, small enough here).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const TYPE_IDS: Record<string, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

export const TYPE_TO_ID: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export class ObjectStore {
  map = new Map<string, GitObj>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.map.has(oid)) this.map.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObj | undefined {
    return this.map.get(oid);
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // "100644", "100755", "120000", "40000" for a subtree
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: byte order on names, directories as if suffixed with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {mode, oid} for every blob under it. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> blob map. Returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

/** Every commit reachable from `tip` (inclusive), following parents. */
export function reachableCommits(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  return reachableCommits(store, tip).has(ancestor);
}

/**
 * The merge base of two commits: a common ancestor that is not itself an
 * ancestor of another common ancestor. Histories here are small; a simple
 * breadth walk over both ancestor sets is exact enough.
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = reachableCommits(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = store.get(oid);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** All objects (commits, trees, blobs) reachable from the given tips, minus `exclude` commits' closure. */
export function objectsToSend(store: ObjectStore, tips: string[], excludeCommits: Set<string>): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const excluded = new Set<string>();
  const markExcludedTree = (treeOid: string): void => {
    if (excluded.has(treeOid)) return;
    excluded.add(treeOid);
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') markExcludedTree(entry.oid);
      else excluded.add(entry.oid);
    }
  };
  for (const oid of excludeCommits) {
    excluded.add(oid);
    const obj = store.get(oid);
    if (obj && obj.type === 'commit') markExcludedTree(parseCommit(obj.data).tree);
  }
  const visitTree = (treeOid: string): void => {
    if (out.has(treeOid) || excluded.has(treeOid)) return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    out.set(treeOid, obj);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else if (!excluded.has(entry.oid)) {
        const blob = store.get(entry.oid);
        if (blob) out.set(entry.oid, blob);
      }
    }
  };
  // Tips may name annotated tags: include the tag object and follow it to
  // the commit it names (possibly through nested tags).
  const commitTips: string[] = [];
  for (const tip of tips) {
    let current = tip;
    for (;;) {
      const obj = store.get(current);
      if (!obj || obj.type !== 'tag') break;
      if (!excluded.has(current)) out.set(current, obj);
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match) {
        current = '';
        break;
      }
      current = match[1];
    }
    if (current !== '') commitTips.push(current);
  }
  const seenCommits = new Set<string>();
  const stack = [...commitTips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenCommits.has(oid) || excludeCommits.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seenCommits.add(oid);
    out.set(oid, obj);
    const info = parseCommit(obj.data);
    visitTree(info.tree);
    stack.push(...info.parents);
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = buf[i];
    i += 1;
    value |= (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** The number of compressed bytes a zlib stream at `start` occupies (binary search on inflate). */
export function zlibLength(buf: Buffer, start: number): number {
  let lo = 1;
  let hi = buf.length - start;
  // Grow hi until inflation succeeds or the buffer ends.
  const inflates = (len: number): boolean => {
    try {
      inflateSync(buf.subarray(start, start + len));
      return true;
    } catch {
      return false;
    }
  };
  if (!inflates(hi)) throw new Error('corrupt zlib stream in pack');
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (inflates(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readSize();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== dstSize || out.length !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

interface PendingObject {
  typeId: number;
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/** Parse a packfile into the store. Returns the oids of every object it held. */
export function receivePack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, string>();
  const pending: PendingObject[] = [];
  const rawAt = new Map<number, PendingObject>();
  for (let n = 0; n < count; n += 1) {
    const objectStart = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    // size varint (low 4 bits first, then 7-bit groups)
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      shift += 7;
    }
    void shift;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // ofs-delta: offset encoding
      let byte2 = pack[offset];
      offset += 1;
      let rel = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[offset];
        offset += 1;
        rel = ((rel + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = objectStart - rel;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const zlen = zlibLength(pack, offset);
    const data = inflateSync(pack.subarray(offset, offset + zlen));
    offset += zlen;
    const item: PendingObject = { typeId, data, baseOid, baseOffset };
    pending.push(item);
    rawAt.set(objectStart, item);
    void byOffset;
  }
  // Resolve in passes: plain objects first, then deltas whose bases are known.
  const resolved = new Map<PendingObject, string>();
  const resolveOne = (item: PendingObject): string | null => {
    if (resolved.has(item)) return resolved.get(item) as string;
    if (item.typeId >= 1 && item.typeId <= 4) {
      const type = TYPE_IDS[item.typeId];
      const oid = store.put(type, item.data);
      resolved.set(item, oid);
      return oid;
    }
    let baseObj: GitObj | undefined;
    let baseType: ObjType | undefined;
    if (item.baseOid !== undefined) {
      baseObj = store.get(item.baseOid);
      if (!baseObj) return null;
      baseType = baseObj.type;
    } else if (item.baseOffset !== undefined) {
      const baseItem = rawAt.get(item.baseOffset);
      if (!baseItem) return null;
      const baseOidResolved = resolveOne(baseItem);
      if (baseOidResolved === null) return null;
      baseObj = store.get(baseOidResolved);
      if (!baseObj) return null;
      baseType = baseObj.type;
    }
    if (!baseObj || !baseType) return null;
    const data = applyDelta(baseObj.data, item.data);
    const oid = store.put(baseType, data);
    resolved.set(item, oid);
    return oid;
  };
  let progress = true;
  while (progress) {
    progress = false;
    for (const item of pending) {
      if (!resolved.has(item) && resolveOne(item) !== null) progress = true;
    }
  }
  if (resolved.size !== pending.length) throw new Error('unresolvable delta in pack');
  return [...resolved.values()];
}

/** Serialize objects into a packfile (full objects only). */
export function buildPack(objects: { oid: string; type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeId = TYPE_TO_ID[obj.type];
    let size = obj.data.length;
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size = Math.floor(size / 128);
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
