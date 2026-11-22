// mend: the command-line tool SPEC.md specifies (MIT). Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A
// patches, JSON tool calls), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why
// it failed. Sections 1-10 of SPEC.md.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a line break. */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly origContent = new Map<string, string | null>();
  private readonly origExistsMap = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.origContent.has(p)) {
      let v: string | null = null;
      let ex = false;
      try {
        const st = statSync(p);
        ex = true;
        if (st.isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
        ex = false;
      }
      this.origContent.set(p, v);
      this.origExistsMap.set(p, ex);
    }
    return this.origContent.get(p)!;
  }
  origExists(p: string): boolean {
    this.original(p);
    return this.origExistsMap.get(p)!;
  }
  /** Does the path exist in the tree as the edits left it (file or directory)? */
  exists(p: string): boolean {
    return this.now.has(p) ? this.now.get(p)! !== null : this.origExists(p);
  }
  /** The file's text in the tree as the edits left it, or null when there is no such file. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- matching (section 5)

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Occurrences of O in lines at the first tier where one exists (tier 0 only when strict). */
function findOccurrences(lines: string[], old: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const o = old.map((l) => normLine(l, t));
    const occ: number[] = [];
    for (let i = 0; i + old.length <= lines.length; i++) {
      let ok = true;
      for (let k = 0; k < old.length; k++) {
        if (normLine(lines[i + k]!, t) !== o[k]!) {
          ok = false;
          break;
        }
      }
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `text`, plus the index into O when it is a context line. */
interface NItem {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines for an occurrence at `pos`: a context line is written
 * as the file's own matched line; at tier 2 every other line is re-indented from O's
 * first line's leading whitespace to the file's first matched line's.
 */
function buildNew(old: string[], nItems: NItem[], fileLines: string[], pos: number, tier: number): string[] {
  if (old.length === 0) return nItems.map((it) => it.text);
  const fLead = /^[ \t]*/.exec(fileLines[pos]!)![0];
  const pLead = /^[ \t]*/.exec(old[0]!)![0];
  return nItems.map((it) => {
    if (it.ctx !== null) return fileLines[pos + it.ctx]!;
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
    }
    return it.text;
  });
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = doc.lines.slice();
      lines.splice(line, 0, ...add);
      tree.now.set(p, writeDoc({ br: doc.br, lines, final: doc.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld: string;
  diffNew: string;
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: text after four chars, up to the first tab, trimmed, a/ or b/ removed. */
function uniPath(s: string): string {
  const t = s.slice(4).split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) return null;
  const x = rest.slice(0, idx);
  const y = rest.slice(idx + 3).trimEnd();
  if (x.length <= 2 || y === '') return null;
  return [x.slice(2), y];
}

/** Split a hunk body into its old lines, its new lines, and whether a `\` line follows its last context or `+` line. */
function splitHunk(body: string[]): { oldLines: string[]; newItems: NItem[]; noEol: boolean } {
  const oldLines: string[] = [];
  const newItems: NItem[] = [];
  for (const l of body) {
    if (l === '') {
      const oi = oldLines.length;
      oldLines.push('');
      newItems.push({ text: '', ctx: oi });
    } else if (l.startsWith('\\')) {
      continue;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      const oi = oldLines.length;
      oldLines.push(t);
      newItems.push({ text: t, ctx: oi });
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      newItems.push({ text: l.slice(1), ctx: null });
    }
  }
  let lastCtxPlus = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]![0] === ' ' || body[i]![0] === '+') lastCtxPlus = i;
  }
  const noEol = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  return { oldLines, newItems, noEol };
}

/** Apply one hunk to a document; `d` is the line offset of the hunks applied so far in this section. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, failPath: string): FileDoc {
  const { oldLines, newItems, noEol } = splitHunk(hunk.body);
  let lines = doc.lines.slice();
  let final = doc.final;
  if (oldLines.length > 0) {
    const found = findOccurrences(lines, oldLines, strict);
    if (!found) throw new Fail('no-match', failPath);
    const target = hunk.a - 1 + d;
    let pos = found.occ[0]!;
    let bestDist = Math.abs(pos - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        pos = p;
        bestDist = dist;
      }
    }
    const repl = buildNew(oldLines, newItems, lines, pos, found.tier);
    const atEnd = pos + oldLines.length === doc.lines.length;
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + oldLines.length)];
    if (atEnd) final = newItems.length === 0 ? lines.length > 0 : !noEol;
    return { br: doc.br, lines, final };
  }
  const ins = Math.min(Math.max(hunk.a + d, 0), lines.length);
  const repl = newItems.map((it) => it.text);
  const atEnd = ins === doc.lines.length;
  lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
  if (atEnd && newItems.length > 0) final = !noEol;
  return { br: doc.br, lines, final };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    const isCreate = oldPath === '/dev/null' || sec.createFlag;
    const isDelete = newPath === '/dev/null' || sec.deleteFlag;
    if (isCreate) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.exists(newPath)) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const l of h.body) if (l[0] === '+') plus.push(l.slice(1));
        let li = -1;
        for (let i = 0; i < h.body.length; i++) if (h.body[i]![0] === '+') li = i;
        if (li >= 0) noEol = h.body[li + 1] !== undefined && h.body[li + 1]!.startsWith('\\');
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const content = tree.get(oldPath);
      if (content === null) throw new Fail('missing', oldPath);
      if (tree.exists(newPath)) throw new Fail('exists', newPath);
      let doc = parseDoc(content);
      let d = 0;
      for (const h of sec.hunks) {
        const { newItems, oldLines } = splitHunk(h.body);
        doc = applyHunk(doc, h, d, strict, oldPath);
        d += newItems.length - oldLines.length;
      }
      tree.now.set(oldPath, null);
      tree.now.set(newPath, writeDoc(doc));
      tree.moves.push({ from: oldPath, to: newPath });
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const content = tree.get(oldPath);
    if (content === null) throw new Fail('missing', oldPath);
    let doc = parseDoc(content);
    let d = 0;
    for (const h of sec.hunks) {
      const { newItems, oldLines } = splitHunk(h.body);
      doc = applyHunk(doc, h, d, strict, oldPath);
      d += newItems.length - oldLines.length;
    }
    tree.now.set(oldPath, writeDoc(doc));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let curHasPair = false;
  const startSection = (s: UniSection): void => {
    sections.push(s);
    cur = s;
    curHasPair = false;
  };
  const blankSection = (): UniSection => ({ diffOld: '', diffNew: '', createFlag: false, deleteFlag: false, hunks: [] });
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = parseDiffGit(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[0];
      s.diffNew = m[1];
      startSection(s);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = uniPath(line);
      const newP = uniPath(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && !curHasPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        curHasPair = true;
      } else {
        const s = blankSection();
        s.diffOld = oldP;
        s.diffNew = newP;
        s.pairOld = oldP;
        s.pairNew = newP;
        startSection(s);
        curHasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push(l);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(hm[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.deleteFlag = true;
      else if (line.startsWith('+++ ')) {
        cur.pairNew = uniPath(line);
        curHasPair = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const doc = parseDoc(content);
    const found = findOccurrences(doc.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const repl = buildNew(oldLines, newLines.map((t) => ({ text: t, ctx: null })), doc.lines, pos, found.tier);
    tree.now.set(path, writeDoc({ br: doc.br, lines: [...doc.lines.slice(0, pos), ...repl, ...doc.lines.slice(pos + oldLines.length)], final: doc.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let sep = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newItems: NItem[];
}

interface V4aRawSection {
  kind: string;
  path: string;
  headerLine: number;
  raw: string[];
  rawLineNos: number[];
}

/** First line at or after `from` equal to the anchor at the first tier where one is (single line). */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return -1;
}

/** First occurrence of O at or after `from` at the first tier with one; an end-of-file chunk only takes one ending at the last line. */
function findChunkOcc(lines: string[], old: string[], from: number, strict: boolean, eof: boolean): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const o = old.map((l) => normLine(l, t));
    for (let i = from; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < old.length; k++) {
        if (normLine(lines[i + k]!, t) !== o[k]!) {
          ok = false;
          break;
        }
      }
      if (ok) return { pos: i, tier: t };
    }
  }
  return null;
}

function v4aUpdateEdit(s: V4aRawSection, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  const raw = s.raw;
  const nos = s.rawLineNos;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let chunk: V4aChunk | null = null;
  let chunkStarted = false;
  const closeChunk = (): void => {
    if (chunk) {
      chunks.push(chunk);
      chunk = null;
    }
  };
  while (idx < raw.length) {
    const l = raw[idx]!;
    const ln = nos[idx]!;
    if (l.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: l.slice(2).trim(), eof: false, oldLines: [], newItems: [] };
      chunkStarted = true;
      idx += 1;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${ln}`);
      chunk.eof = true;
      closeChunk();
      idx += 1;
      continue;
    }
    if (l.startsWith('*** ')) throw new Exit2(`error: parse ${ln}`);
    if (l === '' || blank(l) || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (chunk === null) {
        if (chunkStarted) throw new Exit2(`error: parse ${ln}`);
        chunk = { anchor: null, eof: false, oldLines: [], newItems: [] };
        chunkStarted = true;
      }
      if (blank(l)) {
        const oi = chunk.oldLines.length;
        chunk.oldLines.push('');
        chunk.newItems.push({ text: '', ctx: oi });
      } else if (l.startsWith(' ')) {
        const t = l.slice(1);
        const oi = chunk.oldLines.length;
        chunk.oldLines.push(t);
        chunk.newItems.push({ text: t, ctx: oi });
      } else if (l.startsWith('-')) {
        chunk.oldLines.push(l.slice(1));
      } else {
        chunk.newItems.push({ text: l.slice(1), ctx: null });
      }
      idx += 1;
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.headerLine}`);
  const path = s.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    let doc = parseDoc(content);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findAnchor(doc.lines, ch.anchor, cursor, strict);
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.oldLines.length === 0) {
        const ins = ch.eof ? doc.lines.length : cursor;
        const repl = ch.newItems.map((it) => it.text);
        doc = { br: doc.br, lines: [...doc.lines.slice(0, ins), ...repl, ...doc.lines.slice(ins)], final: doc.final };
        cursor = ins + repl.length;
      } else {
        const found = findChunkOcc(doc.lines, ch.oldLines, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const repl = buildNew(ch.oldLines, ch.newItems, doc.lines, found.pos, found.tier);
        doc = { br: doc.br, lines: [...doc.lines.slice(0, found.pos), ...repl, ...doc.lines.slice(found.pos + ch.oldLines.length)], final: doc.final };
        cursor = found.pos + repl.length;
      }
    }
    const text = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aRawSection[] = [];
  let cur: V4aRawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    let kind: string | null = null;
    let p = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      p = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      p = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      p = l.slice('*** Update File: '.length).trim();
    }
    if (kind !== null) {
      cur = { kind, path: p, headerLine: i + 1, raw: [], rawLineNos: [] };
      sections.push(cur);
      continue;
    }
    if (blank(l)) {
      if (cur) {
        cur.raw.push(l);
        cur.rawLineNos.push(i + 1);
      }
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    cur.raw.push(l);
    cur.rawLineNos.push(i + 1);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!)) {
      s.raw.pop();
      s.rawLineNos.pop();
    }
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < s.raw.length; k++) {
        const l = s.raw[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (blank(l)) fileLines.push('');
        else throw new Exit2(`error: parse ${s.rawLineNos[k]}`);
      }
      const path = s.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.exists(path)) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (s.kind === 'delete') {
      if (s.raw.length > 0) throw new Exit2(`error: parse ${s.rawLineNos[0]}`);
      const path = s.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(s, strict));
    }
  }
  return edits;
}

// ---------------------------------------------------------------- invocation, output, exit codes (sections 1, 2, 10)

function byteSort(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Output rows: a move that succeeded replaces its D/A pair with one R line, sorted by <new>.
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  const seenMove = new Set<string>();
  for (const m of tree.moves) {
    let to = m.to;
    let guard = 0;
    while (guard++ < 100) {
      const nxt = tree.moves.find((x) => x.from === to);
      if (!nxt) break;
      to = nxt.to;
    }
    const key = `${m.from}\0${to}`;
    if (seenMove.has(key)) continue;
    seenMove.add(key);
    if (tree.original(m.from) !== null && tree.original(to) === null && tree.get(m.from) === null && tree.get(to) !== null) {
      rows.push({ key: to, line: `R ${m.from} -> ${to}` });
      covered.add(m.from);
      covered.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteSort)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteSort(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        try {
          if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
          else rmSync(p, { force: true });
        } catch {
          rmSync(p, { force: true });
        }
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
