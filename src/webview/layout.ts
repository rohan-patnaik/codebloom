// Analytical mind-map layout. Sizes come from text metrics rather than DOM
// measurement, so the whole map can be laid out without rendering it; the
// renderer then only creates DOM for boxes near the viewport.

import type { ViewBlock } from '../core/project';

export type Row = number | { gap: number };

export interface Box {
  id: string;
  b: ViewBlock | null;
  x: number;
  y: number;
  w: number;
  h: number;
  side: 1 | -1;
  depth: number;
  hue: number;
  parent?: Box;
  kids: Box[];
  /** Total children, visible or not. */
  kidCount: number;
  collapsed: boolean;
  card: boolean;
  /** Every row of the card's own code; the card shows `view` of them and scrolls the rest. */
  rows?: Row[];
  /** Rows visible at once. */
  view?: number;
  /** Lines below the visible rows, reached by scrolling. */
  more?: number;
  /** Lines past the scrollable limit, only reachable in the editor. */
  cut?: number;
  /** Card has a footer (scroll hint or "keep scrolling"). */
  foot?: boolean;
  /** Layout-only: subtree size. */
  sw?: number;
  sh?: number;
  cols?: Box[][];
}

export interface Branch {
  d: string;
  hue: number;
  depth: number;
  /** Stroke instead of fill (trunks and buses of wrapped columns). */
  line?: boolean;
}

export interface Layout {
  root: Box;
  boxes: Map<string, Box>;
  list: Box[];
  branches: Branch[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Metrics {
  /** Width of a string in one of the UI fonts. */
  text(s: string, font: 'chip' | 'name' | 'meta' | 'badge' | 'title' | 'summary' | 'detail'): number;
  ch: number;
  lineH: number;
}

export interface LayoutInput {
  rel: string;
  lineCount: number;
  summary?: string;
  blocks: ViewBlock[];
  lines: string[];
  collapsed: Set<string>;
  /** Blocks shown as code cards. */
  cards: (b: ViewBlock) => boolean;
  chip: (b: ViewBlock) => string;
  label: (b: ViewBlock) => string;
  badges: (b: ViewBlock) => string[];
  maxCardLines: number;
  /** Cards that always get a footer, even when all their code fits (the selected one). */
  foot?: (b: ViewBlock) => boolean;
  m: Metrics;
}

export const K = {
  pillH: 26,
  vgap: 7,
  hgap: 54,
  rootGap: 64,
  knob: 22,
  colGap: 40,
  wrap: 14,
  wrapH: 1500,
  busPad: 24,
  cardHead: 30,
  cardPad: 10,
  cardFoot: 22,
  maxCardW: 760,
  /** Rows a card can scroll through; longer blocks end with a link to the editor. */
  maxScrollRows: 4000,
};

const isGroup = (b: ViewBlock) => ['imports', 'globals', 'fields', 'script', 'doc', 'main'].includes(b.kind);

export function ownRows(b: ViewBlock, lines: string[]): Row[] {
  const rows: Row[] = [];
  const kids = [...b.children].sort((a, c) => a.start - c.start);
  let ln = b.start;
  for (const k of kids) {
    for (; ln < k.start && ln <= b.end; ln++) rows.push(ln);
    if (k.end >= ln) {
      const hidden = k.end - Math.max(ln, k.start) + 1;
      const last = rows[rows.length - 1];
      if (typeof last === 'object') last.gap += hidden;
      else rows.push({ gap: hidden });
      ln = k.end + 1;
    }
  }
  for (; ln <= b.end; ln++) rows.push(ln);
  // Trim trailing blank lines (common before the next block).
  while (rows.length > 1 && typeof rows[rows.length - 1] === 'number' && !lines[(rows[rows.length - 1] as number) - 1]?.trim()) rows.pop();
  return rows;
}

function pillWidth(inp: LayoutInput, b: ViewBlock) {
  const { m } = inp;
  // Mirrors the .pill flex row: 10px padding + 1px border per side, 8px gaps.
  const items = [
    m.text(inp.chip(b), 'chip') + 12,
    isGroup(b) ? Math.min(m.text(inp.label(b), 'detail'), 320) : m.text(inp.label(b), 'name'),
    m.text(`${b.start}–${b.end}`, 'meta'),
    ...inp.badges(b).map((s) => m.text(s, 'badge') + 10),
  ];
  return Math.ceil(items.reduce((a, c) => a + c, 0) + 8 * (items.length - 1) + 22 + 1);
}

function sizeBox(inp: LayoutInput, box: Box) {
  const b = box.b!;
  const pill = pillWidth(inp, b);
  if (!box.card) {
    box.w = pill;
    box.h = K.pillH;
    return;
  }
  let rows = ownRows(b, inp.lines);
  const count = (rs: Row[]) => rs.reduce<number>((n, r) => n + (typeof r === 'number' ? 1 : r.gap), 0);
  if (rows.length > K.maxScrollRows) {
    box.cut = count(rows.slice(K.maxScrollRows));
    rows = rows.slice(0, K.maxScrollRows);
  }
  box.view = Math.min(rows.length, inp.maxCardLines);
  if (rows.length > box.view) box.more = count(rows.slice(box.view));
  box.foot = !!(box.more || box.cut || inp.foot?.(b));
  box.rows = rows;
  let maxLen = 0;
  for (const r of rows) {
    if (typeof r !== 'number') continue;
    const len = (inp.lines[r - 1] ?? '').replace(/\t/g, '    ').trimEnd().length;
    if (len > maxLen) maxLen = len;
  }
  const gutter = String(b.end).length * inp.m.ch + 16;
  box.w = Math.ceil(Math.min(K.maxCardW, Math.max(pill, gutter + Math.min(maxLen, 110) * inp.m.ch + 2 * K.cardPad + 8 + (box.more ? 8 : 0))));
  box.h = K.cardHead + box.view * inp.m.lineH + K.cardPad + (box.foot ? K.cardFoot : 0) + 2;
}

/** Split many or very tall children into side-by-side columns of similar height. */
function columns(kids: Box[]): Box[][] {
  const total = kids.reduce((n, k) => n + k.sh! + K.vgap, 0);
  const n = Math.min(kids.length, Math.max(Math.ceil(kids.length / K.wrap), Math.ceil(total / K.wrapH)));
  if (n <= 1) return [kids];
  const target = total / n;
  const cols: Box[][] = [[]];
  let h = 0;
  for (const k of kids) {
    const kh = k.sh! + K.vgap;
    const col = cols[cols.length - 1];
    if (col.length && h + kh / 2 > target && cols.length < n) {
      cols.push([k]);
      h = kh;
    } else {
      col.push(k);
      h += kh;
    }
  }
  return cols;
}

function measure(box: Box) {
  if (!box.kids.length) {
    box.sw = box.w;
    box.sh = box.h;
    return;
  }
  for (const k of box.kids) measure(k);
  box.cols = columns(box.kids);
  let w = 0;
  let h = 0;
  for (const col of box.cols) {
    let ch = 0;
    let cw = 0;
    for (const k of col) {
      ch += k.sh! + K.vgap;
      cw = Math.max(cw, k.sw!);
    }
    h = Math.max(h, ch - K.vgap);
    w += cw + K.colGap;
  }
  if (box.cols.length > 1) h += K.busPad;
  box.sh = Math.max(box.h, h);
  box.sw = box.w + K.knob + K.hgap + w - K.colGap;
}

function place(box: Box, edge: number, top: number, dir: 1 | -1) {
  box.side = dir;
  box.y = top + (box.sh! - box.h) / 2;
  box.x = dir > 0 ? edge : edge - box.w;
  if (!box.kids.length) return;
  const wrapped = box.cols!.length > 1;
  let cx = dir > 0 ? edge + box.w + K.knob + K.hgap : edge - box.w - K.knob - K.hgap;
  for (const col of box.cols!) {
    const colH = col.reduce((n, k) => n + k.sh! + K.vgap, -K.vgap);
    let cy = wrapped ? top + K.busPad : top + (box.sh! - colH) / 2;
    let cw = 0;
    for (const k of col) {
      place(k, cx, cy, dir);
      cy += k.sh! + K.vgap;
      cw = Math.max(cw, k.sw!);
    }
    cx += dir * (cw + K.colGap);
  }
  if (wrapped) {
    // Keep the parent level with the bus rather than floating mid-column.
    box.y = Math.min(box.y, top + K.busPad);
  }
}

/** Tapered bezier ribbon from (x0,y0) to (x1,y1). */
function ribbon(x0: number, y0: number, x1: number, y1: number, w0: number, w1: number) {
  const mx = (x0 + x1) / 2;
  const a = w0 / 2;
  const b = w1 / 2;
  const f = (n: number) => n.toFixed(1);
  return `M${f(x0)} ${f(y0 - a)}C${f(mx)} ${f(y0 - a)} ${f(mx)} ${f(y1 - b)} ${f(x1)} ${f(y1 - b)}L${f(x1)} ${f(y1 + b)}C${f(mx)} ${f(y1 + b)} ${f(mx)} ${f(y0 + a)} ${f(x0)} ${f(y0 + a)}Z`;
}

const widthAt = (depth: number) => (depth === 0 ? 7 : depth === 1 ? 4.2 : 3);

function branchesFor(box: Box, out: Branch[]) {
  if (!box.kids.length) return;
  const dir = box.side;
  const cy = (b: Box) => b.y + (b.b && !b.card ? b.h / 2 : Math.min(b.h / 2, K.cardHead / 2 + 1));
  const inner = (b: Box) => (dir > 0 ? b.x : b.x + b.w);
  const px = box.b ? (dir > 0 ? box.x + box.w + K.knob / 2 : box.x - K.knob / 2) : dir > 0 ? box.x + box.w : box.x;
  const py = cy(box);
  const w0 = widthAt(box.depth);
  const cols = box.cols!;
  if (cols.length === 1) {
    for (const k of box.kids) out.push({ d: ribbon(px, py, inner(k), cy(k), w0, 1.6), hue: k.hue, depth: box.depth });
  } else {
    const busY = Math.min(...box.kids.map((k) => k.y)) - K.busPad / 2;
    const trunkX = (col: Box[]) => inner(col[0]) - dir * 16;
    const firstX = trunkX(cols[0]);
    const lastX = trunkX(cols[cols.length - 1]);
    out.push({ d: ribbon(px, py, firstX, busY, w0, 2.4), hue: box.kids[0].hue, depth: box.depth });
    out.push({ d: `M${firstX} ${busY}L${lastX} ${busY}`, hue: box.kids[0].hue, depth: box.depth, line: true });
    for (const col of cols) {
      const tx = trunkX(col);
      const lastY = cy(col[col.length - 1]);
      out.push({ d: `M${tx} ${busY}L${tx} ${lastY - 8}`, hue: col[0].hue, depth: box.depth, line: true });
      for (const k of col) {
        const ky = cy(k);
        const y0 = Math.max(busY + 1, ky - 14);
        out.push({ d: `M${tx} ${y0}Q${tx} ${ky} ${inner(k)} ${ky}`, hue: k.hue, depth: box.depth + 1, line: true });
      }
    }
  }
  for (const k of box.kids) branchesFor(k, out);
}

export function layout(inp: LayoutInput, hues: number): Layout {
  const boxes = new Map<string, Box>();
  const list: Box[] = [];
  const name = inp.rel.split('/').pop() ?? inp.rel;
  const root: Box = { id: '#root', b: null, x: 0, y: 0, w: 0, h: 0, side: 1, depth: 0, hue: 0, kids: [], kidCount: inp.blocks.length, collapsed: false, card: false };
  const summary = inp.summary ? inp.summary.slice(0, 64) : '';
  root.w = Math.ceil(Math.max(inp.m.text(name, 'title') + inp.m.text(`${inp.lineCount} lines`, 'meta') + 30, summary ? inp.m.text(summary, 'summary') : 0) + 40);
  root.h = summary ? 66 : 50;
  boxes.set(root.id, root);
  list.push(root);

  const build = (b: ViewBlock, parent: Box, depth: number, hue: number): Box => {
    const box: Box = {
      id: b.id,
      b,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      side: 1,
      depth,
      hue,
      parent,
      kids: [],
      kidCount: b.children.length,
      collapsed: inp.collapsed.has(b.id) && b.children.length > 0,
      card: inp.cards(b),
    };
    sizeBox(inp, box);
    boxes.set(box.id, box);
    list.push(box);
    if (!box.collapsed) box.kids = b.children.map((c) => build(c, box, depth + 1, hue));
    return box;
  };
  root.kids = inp.blocks.map((b, i) => build(b, root, 1, i % hues));
  root.kids.forEach(measure);

  // Split top-level blocks between the two sides, keeping file order: the
  // right side reads top to bottom first, then the left side.
  const hs = root.kids.map((k) => k.sh! + K.vgap);
  const total = hs.reduce((a, b) => a + b, 0);
  let k = 0;
  let acc = 0;
  let best = Infinity;
  for (let i = 0; i <= hs.length; i++) {
    const diff = Math.abs(total - 2 * acc);
    if (diff < best) {
      best = diff;
      k = i;
    }
    acc += hs[i] ?? 0;
  }
  if (root.kids.length <= 3) k = root.kids.length;
  const right = root.kids.slice(0, k);
  const left = root.kids.slice(k);
  root.x = -root.w / 2;
  root.y = -root.h / 2;
  const stack = (side: Box[], dir: 1 | -1) => {
    const h = side.reduce((n, b) => n + b.sh! + K.vgap, -K.vgap);
    let y = -h / 2;
    for (const b of side) {
      place(b, dir > 0 ? root.w / 2 + K.rootGap : -root.w / 2 - K.rootGap, y, dir);
      y += b.sh! + K.vgap;
    }
  };
  stack(right, 1);
  stack(left, -1);

  const branches: Branch[] = [];
  for (const b of root.kids) {
    const dir = b.side;
    const x0 = dir > 0 ? root.x + root.w - 4 : root.x + 4;
    const y1 = b.y + (b.card ? Math.min(b.h / 2, K.cardHead / 2 + 1) : b.h / 2);
    branches.push({ d: ribbon(x0, 0, dir > 0 ? b.x : b.x + b.w, y1, 9, 2), hue: b.hue, depth: 0 });
    branchesFor(b, branches);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    const pad = b.kidCount ? K.knob : 0;
    minX = Math.min(minX, b.x - (b.side < 0 ? pad : 0));
    maxX = Math.max(maxX, b.x + b.w + (b.side > 0 ? pad : 0));
    minY = Math.min(minY, b.y - (b.cols && b.cols.length > 1 ? K.busPad : 0));
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { root, boxes, list, branches, minX, minY, maxX, maxY };
}
