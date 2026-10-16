import type { Ref, ViewBlock, ViewModel } from '../core/project';
import { highlight } from './highlight';
import { K, layout, ownRows, type Box, type Layout, type Metrics, type Row } from './layout';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

type Mode = 'names' | 'code';
type View = 'map' | 'outline';
type Links = ViewModel['links'][string];

interface Notice {
  kind: 'disabled' | 'unsupported';
  file: string;
  languageId: string;
  language: string;
}

/** One stop in the navigation history: a block, possibly in another file. */
interface Stop {
  rel: string;
  uri?: string;
  id?: string;
  line: number;
  label: string;
}

interface FileView {
  x: number;
  y: number;
  k: number;
  collapsed: string[];
  selected?: string;
}

// ------------------------------------------------------------------ state

const persisted = (vscode.getState() ?? {}) as { uri?: string; files?: Record<string, FileView>; details?: boolean; view?: View };
const S = {
  model: null as ViewModel | null,
  uri: '',
  lines: [] as string[],
  hl: null as string[] | null,
  mode: 'names' as Mode,
  view: (persisted.view ?? 'map') as View,
  maxCardLines: 24,
  selected: undefined as string | undefined,
  collapsed: new Set<string>(),
  x: 0,
  y: 0,
  k: 1,
  details: persisted.details ?? true,
  files: persisted.files ?? ({} as Record<string, FileView>),
  lay: null as Layout | null,
  byId: new Map<string, ViewBlock>(),
  parentOf: new Map<string, ViewBlock | undefined>(),
  language: { id: '', name: '', builtIn: true } as Language,
  outline: undefined as 'ok' | 'waiting' | 'none' | undefined,
  indexWorkspace: true,
  notice: null as Notice | null,
  /** Language-server call lookups for symbol-based files, by block id. */
  lsp: new Map<string, 'loading' | 'ok' | 'unavailable'>(),
  lspLinks: new Map<string, Links>(),
  /** Details panel opened on a narrow view, where it floats over the map. */
  narrowOpen: false,
};

const H = { stops: [] as Stop[], i: -1 };
/** Block to select once the map switches to another file. */
let pendingStop: Stop | undefined;

function save() {
  if (S.uri) S.files[S.uri] = { x: S.x, y: S.y, k: S.k, collapsed: [...S.collapsed], selected: S.selected };
  // Keep the persisted state small.
  const keys = Object.keys(S.files);
  if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete S.files[k];
  vscode.setState({ uri: S.uri, files: S.files, details: S.details, view: S.view });
}

// ------------------------------------------------------------------ palette

const isLight = () => document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
// Pastel hues; each has a soft tone (branches, fills) and an ink tone (text on light backgrounds).
const PASTELS: [string, string][] = [
  ['#b8a9f0', '#6a55c4'], // lavender
  ['#9fe0c4', '#2f8f6a'], // mint
  ['#ffc3a0', '#c0672e'], // peach
  ['#f5afcf', '#b8457c'], // rose
  ['#a3d3ff', '#3277b8'], // sky
  ['#f2dc8f', '#9a7a12'], // butter
  ['#9ee0e0', '#22858a'], // aqua
  ['#d6b3f2', '#8a4fc0'], // lilac
  ['#c3e3a0', '#5a8a2a'], // sage
  ['#ffb1a8', '#c24e45'], // coral
];
const hueVars = (h: number) => {
  const [soft, ink] = PASTELS[h % PASTELS.length];
  return `--c:${soft};--ci:${isLight() ? ink : soft}`;
};

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const el = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fileName = (rel: string) => rel.split('/').pop() ?? rel;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function chip(b: ViewBlock): string {
  if (b.tag) return b.tag;
  const lang = S.model?.lang;
  switch (b.kind) {
    case 'function':
      return lang === 'python' ? 'def' : 'fn';
    case 'method':
      return lang === 'python' ? 'def' : lang === 'java' ? 'method' : 'method';
    case 'ctor':
      return lang === 'python' ? 'init' : lang === 'java' ? 'new' : 'ctor';
    default:
      return b.kind;
  }
}

const isGroup = (b: ViewBlock) => ['imports', 'globals', 'fields', 'script', 'doc', 'main'].includes(b.kind);
const label = (b: ViewBlock) => (isGroup(b) ? b.detail || b.kind : b.name);
const links = (id: string): Links | undefined => S.model?.links[id];
/** Callers plus blocks that pass this one around as a value. */
const inCount = (l: Links | undefined) => (l ? l.in.length + (l.refs?.length ?? 0) : 0);
function badges(b: ViewBlock): string[] {
  const l = links(b.id);
  const out: string[] = [];
  if (inCount(l)) out.push(`←${inCount(l)}`);
  if (l?.out.length) out.push(`→${uniq(l.out).length}`);
  return out;
}
/** De-duplicate refs that point at the same block (several call sites). */
function uniq(refs: Ref[]): (Ref & { n: number })[] {
  const m = new Map<string, Ref & { n: number }>();
  for (const r of refs) {
    const e = m.get(r.id);
    if (e) e.n++;
    else m.set(r.id, { ...r, n: 1 });
  }
  return [...m.values()];
}

// ------------------------------------------------------------------ metrics

const canvas = document.createElement('canvas').getContext('2d')!;
const fontCache = new Map<string, number>();
let fonts: Record<string, string> = {};
function initFonts() {
  // Read fonts from real elements so measurement matches whatever the theme resolves to.
  const probe = el('div', 'node pill');
  probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px';
  probe.innerHTML = '<span class="chip">x</span><span class="label">x</span><span class="label dim">x</span><span class="range">x</span><span class="badge in">x</span><div class="root-name">x</div><div class="root-sum">x</div><div class="code">x</div>';
  document.body.appendChild(probe);
  const f = (sel: string) => {
    const cs = getComputedStyle(probe.querySelector(sel)!);
    return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  };
  fonts = {
    chip: f('.chip'),
    name: f('.label:not(.dim)'),
    detail: f('.label.dim'),
    meta: f('.range'),
    badge: f('.badge'),
    title: f('.root-name'),
    summary: f('.root-sum'),
    code: f('.code'),
  };
  probe.remove();
  fontCache.clear();
}
const M: Metrics = {
  text(s, font) {
    const key = font + '\0' + s;
    let w = fontCache.get(key);
    if (w === undefined) {
      canvas.font = fonts[font];
      w = canvas.measureText(s).width;
      if (fontCache.size > 20000) fontCache.clear();
      fontCache.set(key, w);
    }
    return w;
  },
  ch: 7.2,
  lineH: 18,
};

// ------------------------------------------------------------------ DOM skeleton

const app = $('#app');
app.innerHTML = `
<header class="top">
  <div class="brand"><span class="logo"></span><span class="brand-name">Codebloom</span></div>
  <div class="nav">
    <button class="icon-btn back" title="Back (Alt+←)" aria-label="Back" disabled><svg viewBox="0 0 16 16" class="ico"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button class="icon-btn fwd" title="Forward (Alt+→)" aria-label="Forward" disabled><svg viewBox="0 0 16 16" class="ico"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
  <div class="crumbs"><span class="dir"></span><span class="file"></span><span class="lang"></span></div>
  <div class="stats"></div>
  <div class="search">
    <svg viewBox="0 0 16 16" class="ico"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    <input type="text" placeholder="Search blocks in this file" spellcheck="false" aria-label="Search blocks">
    <kbd>/</kbd>
    <div class="results" hidden></div>
  </div>
  <button class="icon-btn maximize" title="Full-width map" aria-label="Full-width map"><svg viewBox="0 0 16 16" class="ico"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  <button class="icon-btn toggle-details" title="Toggle details panel (D)"><svg viewBox="0 0 16 16" class="ico"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10 3v10" stroke="currentColor" stroke-width="1.3"/></svg></button>
</header>
<main>
  <section class="stage" tabindex="0" aria-label="Mind map">
    <div class="world">
      <svg class="branches"></svg>
      <svg class="arrows"><defs>
        <marker id="ah-out" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" class="ah-out"/></marker>
        <marker id="ah-in" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" class="ah-in"/></marker>
      </defs><g></g></svg>
      <div class="nodes"></div>
    </div>
    <div class="empty" hidden></div>
    <div class="trail" hidden></div>
    <div class="banner" hidden></div>
    <div class="legend"><span class="lg-out">calls</span><span class="lg-in">called by</span><span class="lg-ref" hidden>passed as a value</span></div>
  </section>
  <section class="outline" hidden></section>
  <aside class="details"></aside>
</main>
<nav class="dock">
  <div class="seg mode"><button data-mode="names">Names</button><button data-mode="code">Code</button></div>
  <span class="sep"></span>
  <button class="zoom-out" title="Zoom out (-)">−</button><button class="zoom-pct" title="Reset zoom">100%</button><button class="zoom-in" title="Zoom in (+)">+</button>
  <button class="fit" title="Fit map (F)"><svg viewBox="0 0 16 16" class="ico"><path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
  <span class="sep"></span>
  <button class="expand-all">Expand all</button><button class="collapse-all">Collapse all</button>
  <span class="sep"></span>
  <div class="seg view"><button data-view="map">Map</button><button data-view="outline">Outline</button></div>
</nav>
<div class="help" hidden></div>`;

const stage = $('.stage');
const world = $('.world');
const nodesEl = $('.nodes');
const branchSvg = $('.branches') as unknown as SVGSVGElement;
const arrowG = $('.arrows g') as unknown as SVGGElement;
const arrowSvg = $('.arrows') as unknown as SVGSVGElement;
const details = $('.details');
const outlineEl = $('.outline');
const searchInput = $<HTMLInputElement>('.search input');
const results = $('.results');

// ------------------------------------------------------------------ model handling

function indexBlocks(blocks: ViewBlock[], parent?: ViewBlock) {
  for (const b of blocks) {
    S.byId.set(b.id, b);
    S.parentOf.set(b.id, parent);
    indexBlocks(b.children, b);
  }
}

function blockAtLine(line: number): ViewBlock | undefined {
  let list = S.model?.blocks ?? [];
  let found: ViewBlock | undefined;
  for (;;) {
    const hit = list.find((b) => b.start <= line && line <= b.end);
    if (!hit) return found;
    found = hit;
    list = hit.children;
  }
}

/**
 * The file's language. `provider` names who answers questions about the code
 * when it isn't one of Codebloom's own parsers ("IntelliJ"); by default that's
 * the language's VS Code extension.
 */
interface Language {
  id: string;
  name: string;
  builtIn: boolean;
  provider?: string;
}

/** "the TypeScript extension", or the host's own name. */
const provider = () => S.language.provider ?? `the ${S.language.name} extension`;
const Provider = () => provider().charAt(0).toUpperCase() + provider().slice(1);

interface ModelMsg {
  model: ViewModel;
  uri: string;
  text?: string;
  cursor?: number;
  language?: Language;
  outline?: 'ok' | 'waiting' | 'none';
  config: { mode: Mode; maxCardLines: number; indexWorkspace: boolean };
}

function onModel(msg: ModelMsg) {
  const switching = msg.uri !== S.uri;
  if (switching || msg.text !== undefined) {
    // Language-server links are for one version of one file.
    S.lsp.clear();
    S.lspLinks.clear();
  }
  if (switching) {
    S.notice = null;
    save();
    S.uri = msg.uri;
    const fv = S.files[msg.uri];
    S.collapsed = new Set(fv?.collapsed ?? []);
    S.selected = fv?.selected;
    if (fv) {
      S.x = fv.x;
      S.y = fv.y;
      S.k = fv.k;
    }
  }
  const prevSel = S.selected ? S.byId.get(S.selected) : undefined;
  S.model = msg.model;
  if (msg.text !== undefined) {
    S.lines = msg.text.split(/\r?\n/);
    S.hl = null;
  }
  S.mode = msg.config.mode;
  S.maxCardLines = msg.config.maxCardLines;
  S.indexWorkspace = msg.config.indexWorkspace ?? true;
  S.language = msg.language ?? { id: msg.model.lang, name: msg.model.lang, builtIn: true };
  S.outline = msg.outline;
  for (const [id, l] of S.lspLinks) S.model.links[id] = l;
  S.byId.clear();
  S.parentOf.clear();
  indexBlocks(S.model.blocks);
  // Keep the selection across edits: same id, or the block now at its line.
  if (S.selected && !S.byId.has(S.selected)) S.selected = prevSel ? blockAtLine(prevSel.defLine)?.id : undefined;
  if (switching && !S.files[msg.uri] && msg.cursor && msg.cursor > 1) S.selected = blockAtLine(msg.cursor)?.id;
  // Arrived here by following a call into this file: select its target.
  let arrived = false;
  if (switching && pendingStop && pendingStop.rel === S.model.rel) {
    const target = (pendingStop.id && S.byId.get(pendingStop.id)) || blockAtLine(pendingStop.line);
    if (target) {
      S.selected = target.id;
      arrived = true;
    }
    pendingStop = undefined;
  }
  renderChrome();
  relayout(switching && (!S.files[msg.uri] || arrived) ? 'fit' : 'keep');
  if (arrived && S.selected) ensureVisible(S.selected);
  if (S.selected) requestCalls(S.selected);
  if (switching) save();
}

// ------------------------------------------------------------------ language-server calls

const usesLsp = () => S.model?.engine === 'symbols';

/** Ask the extension for a symbol-based block's calls; they arrive as a 'calls' message. */
function requestCalls(id: string) {
  if (!usesLsp() || S.lsp.has(id)) return;
  const b = S.byId.get(id);
  if (!b || isGroup(b)) return;
  S.lsp.set(id, 'loading');
  vscode.postMessage({ type: 'calls', id });
}

function onCalls(msg: { id: string; status: 'ok' | 'unavailable'; out: Ref[]; in: Ref[]; refs?: Ref[] }) {
  if (!S.model || !S.byId.has(msg.id)) return;
  S.lsp.set(msg.id, msg.status);
  const l: Links = { out: msg.out, in: msg.in, ext: [], refs: msg.refs ?? [] };
  S.lspLinks.set(msg.id, l);
  S.model.links[msg.id] = l;
  if (msg.id !== S.selected) return;
  // Badges change the pill width, so lay out again around the selection.
  const box = S.lay?.boxes.get(msg.id);
  if (S.view === 'map' && box) relayout(anchorOf(box));
  else {
    renderDetails();
    if (S.view === 'outline') renderOutline();
  }
}

// ------------------------------------------------------------------ history

const sameStop = (a: Stop | undefined, b: Stop) => !!a && a.rel === b.rel && (a.id ?? a.line) === (b.id ?? b.line);

function stopOf(b: ViewBlock): Stop {
  return { rel: S.model!.rel, uri: S.uri, id: b.id, line: b.defLine, label: b.qual.replace(/#\d+$/, '') };
}

function pushStop(stop: Stop) {
  if (sameStop(H.stops[H.i], stop)) return;
  H.stops = H.stops.slice(0, H.i + 1);
  H.stops.push(stop);
  if (H.stops.length > 60) H.stops.shift();
  H.i = H.stops.length - 1;
  renderTrail();
}

/** Go to a stop: select it here, or open its file and select it there. */
function goStop(stop: Stop) {
  if (stop.rel === S.model?.rel) {
    const b = (stop.id && S.byId.get(stop.id)) || blockAtLine(stop.line);
    if (b) select(b.id, { reveal: true, center: true });
  } else {
    pendingStop = stop;
    reveal(stop.rel, stop.line, undefined, false, stop.uri);
  }
  renderTrail();
}

function step(delta: number) {
  const j = H.i + delta;
  if (j < 0 || j >= H.stops.length) return;
  H.i = j;
  goStop(H.stops[j]);
}

function renderTrail() {
  ($('.nav .back') as HTMLButtonElement).disabled = H.i <= 0;
  ($('.nav .fwd') as HTMLButtonElement).disabled = H.i >= H.stops.length - 1;
  const trail = $('.trail');
  const from = Math.max(0, H.i - 3);
  const shown = H.stops.slice(from, H.i + 1);
  trail.hidden = shown.length < 2;
  if (trail.hidden) return;
  trail.innerHTML =
    (from > 0 ? '<span class="t-more">…</span>' : '') +
    shown
      .map((st, k) => {
        const idx = from + k;
        const prev = idx > 0 ? H.stops[idx - 1] : undefined;
        const file = !prev || prev.rel !== st.rel ? `<span class="t-file">${esc(fileName(st.rel))}</span>` : '';
        return `${k ? '<span class="t-sep">›</span>' : ''}<button class="t-stop ${idx === H.i ? 'on' : ''}" data-i="${idx}" title="${esc(st.rel)}:${st.line}">${file}${esc(st.label)}</button>`;
      })
      .join('');
}

function hl(): string[] {
  if (!S.hl) S.hl = highlight(S.lines, S.model?.lang ?? 'javascript');
  return S.hl;
}

// ------------------------------------------------------------------ chrome

function renderChrome() {
  const m = S.model!;
  const parts = m.rel.split('/');
  $('.crumbs .dir').textContent = parts.length > 1 ? parts.slice(0, -1).join(' / ') + ' / ' : '';
  $('.crumbs .file').textContent = parts[parts.length - 1];
  $('.crumbs .lang').textContent = S.language.name || m.lang;
  const st = m.stats;
  if (m.engine === 'symbols') {
    const from = S.language.provider ? `${S.language.provider} code model` : `outline from ${S.language.name} extension`;
    $('.stats').innerHTML = `<span title="Blocks come from ${esc(provider())}. Callers are looked up when you select a block.">${esc(from)}</span>`;
  } else {
    let s = `${plural(st.files, 'file')} · ${plural(st.lines, 'line')} · ${plural(st.links, 'call link')}`;
    if (st.indexing) s += ' <span class="pulse">indexing…</span>';
    if (st.truncated) s += ` <button class="warn" data-setting="codebloom.maxFiles" title="The workspace has more files than codebloom.maxFiles, so calls into the rest are not linked. Click to raise the limit.">first ${st.truncated.toLocaleString()} files only</button>`;
    if (!S.indexWorkspace) s += ' <button class="warn" data-setting="codebloom.indexWorkspace" title="Only open files are linked. Click to turn workspace indexing back on.">workspace index off</button>';
    $('.stats').innerHTML = s;
  }
  renderBanner();
  for (const b of document.querySelectorAll<HTMLElement>('.mode button')) b.classList.toggle('on', b.dataset.mode === S.mode);
  for (const b of document.querySelectorAll<HTMLElement>('.view button')) b.classList.toggle('on', b.dataset.view === S.view);
  document.body.classList.toggle('no-details', !S.details);
  document.body.classList.toggle('narrow-open', S.narrowOpen);
  stage.hidden = S.view !== 'map';
  outlineEl.hidden = S.view !== 'outline';
  for (const b of document.querySelectorAll<HTMLElement>('.dock .zoom-out, .dock .zoom-in, .dock .zoom-pct, .dock .fit')) b.toggleAttribute('disabled', S.view !== 'map');
  const empty = $('.empty');
  empty.hidden = m.blocks.length > 0;
  empty.textContent = 'Nothing to map in this file yet.';
}

/** One line above the map explaining anything the user would otherwise have to guess. */
function renderBanner() {
  const b = $('.banner');
  const n = S.notice;
  const here = S.model ? fileName(S.model.rel) : '';
  let html = '';
  if (n?.kind === 'disabled') {
    html = `<span>Still showing <b>${esc(here)}</b>. Codebloom isn't mapping ${esc(n.language)} files.</span>
      <button class="b-act" data-act="enable" data-lang="${esc(n.languageId)}">Map ${esc(n.language)} files</button><button class="b-x" data-act="dismiss" aria-label="Dismiss">×</button>`;
  } else if (n) {
    html = `<span>Still showing <b>${esc(here)}</b>. ${esc(n.file)} (${esc(n.language)}) has no map.</span><button class="b-x" data-act="dismiss" aria-label="Dismiss">×</button>`;
  } else if (S.model?.engine === 'symbols' && S.outline === 'waiting') {
    html = `<span class="pulse">Waiting for ${esc(provider())} to ${S.language.provider ? 'finish indexing' : "report this file's outline"}…</span>`;
  } else if (S.model?.engine === 'symbols' && S.outline === 'none') {
    html = S.language.builtIn
      ? `<span>No outline was found for this file, so it is shown as one block.</span>`
      : `<span>No ${esc(S.language.name)} extension reported an outline, so this file is shown as one block.</span>
        <button class="b-act" data-act="find" data-lang="${esc(S.language.id)}">Find a ${esc(S.language.name)} extension</button>`;
  }
  b.hidden = !html;
  b.innerHTML = html;
}

// ------------------------------------------------------------------ layout + render

let rendered = new Map<string, HTMLElement>();

type Anchor = { anchor: string; sx: number; sy: number };
/** Screen position of a box's inner edge, so re-layout can keep it still. */
function anchorOf(box: Box): Anchor {
  const x = box.side < 0 ? box.x + box.w : box.x;
  return { anchor: box.id, sx: S.x + x * S.k, sy: S.y + box.y * S.k };
}

function relayout(how: 'fit' | 'keep' | Anchor) {
  if (!S.model) return;
  initFontsOnce();
  const cards = (b: ViewBlock) => S.mode === 'code' || b.id === S.selected;
  S.lay = layout(
    {
      rel: S.model.rel,
      lineCount: S.model.lineCount,
      summary: S.model.summary,
      blocks: S.model.blocks,
      lines: S.lines,
      collapsed: S.collapsed,
      cards,
      chip,
      label,
      badges,
      maxCardLines: S.maxCardLines,
      foot: (b) => b.id === S.selected,
      m: M,
    },
    PASTELS.length,
  );
  const lay = S.lay;
  // Branches
  const pad = 400;
  const w = lay.maxX - lay.minX + 2 * pad;
  const h = lay.maxY - lay.minY + 2 * pad;
  for (const svg of [branchSvg, arrowSvg]) {
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `${lay.minX - pad} ${lay.minY - pad} ${w} ${h}`);
    svg.style.left = `${lay.minX - pad}px`;
    svg.style.top = `${lay.minY - pad}px`;
  }
  let paths = '';
  for (const br of lay.branches) {
    const [soft] = PASTELS[br.hue % PASTELS.length];
    paths += br.line
      ? `<path d="${br.d}" fill="none" stroke="${soft}" stroke-width="${br.depth <= 1 ? 2.2 : 1.6}" stroke-linecap="round" class="br"/>`
      : `<path d="${br.d}" fill="${soft}" class="br"/>`;
  }
  branchSvg.innerHTML = paths;
  // Nodes are created lazily; drop everything so sizes/positions refresh.
  nodesEl.textContent = '';
  rendered = new Map();

  if (how === 'fit') initialView();
  else if (typeof how === 'object') {
    const box = lay.boxes.get(how.anchor);
    if (box) {
      // Keep the anchor where it was on screen.
      S.x = how.sx - (box.side < 0 ? box.x + box.w : box.x) * S.k;
      S.y = how.sy - box.y * S.k;
    }
  }
  applyTransform();
  drawArrows();
  renderDetails();
  if (S.view === 'outline') renderOutline();
}

let fontsReady = false;
function initFontsOnce() {
  if (fontsReady) return;
  fontsReady = true;
  initFonts();
  canvas.font = fonts.code;
  M.ch = canvas.measureText('MMMMMMMMMM').width / 10;
}

function nodeHtml(box: Box): string {
  if (!box.b) {
    const m = S.model!;
    return `<div class="root-title"><span class="root-name">${esc(fileName(m.rel))}</span><span class="root-meta">${m.lineCount.toLocaleString()} lines</span></div>${m.summary ? `<div class="root-sum">${esc(m.summary.slice(0, 64))}</div>` : ''}`;
  }
  const b = box.b;
  const l = links(b.id);
  let head = `<span class="chip k-${b.kind}">${esc(chip(b))}</span>`;
  head += isGroup(b) ? `<span class="label dim">${esc(label(b))}</span>` : `<span class="label">${esc(b.name)}</span>`;
  head += `<span class="range">${b.start}–${b.end}</span>`;
  if (inCount(l)) head += `<span class="badge in" title="${inTitle(l!)}">←${inCount(l)}</span>`;
  if (l?.out.length) head += `<span class="badge out" title="Calls ${uniq(l.out).length}">→${uniq(l.out).length}</span>`;
  let html = `<div class="head">${head}</div>`;
  if (box.card && box.rows) html += codeHtml(box) + (box.foot ? `<div class="more">${footText(box)}</div>` : '');
  if (box.kidCount) {
    html += `<button class="knob" title="${box.collapsed ? 'Expand' : 'Collapse'} (${box.kidCount})" aria-label="Toggle children">${box.collapsed ? `+${box.kidCount}` : '−'}</button>`;
  }
  return html;
}

function inTitle(l: Links) {
  const parts = [];
  if (l.in.length) parts.push(`called by ${uniq(l.in).length}`);
  if (l.refs?.length) parts.push(`passed as a value by ${uniq(l.refs).length}`);
  const t = parts.join(' · ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function codeHtml(box: Box) {
  const h = hl();
  const gw = String(box.b!.end).length;
  const scroll = box.rows!.length > box.view!;
  let s = `<div class="code${scroll ? ' scroll' : ''}" style="--gw:${gw}ch;height:${box.view! * M.lineH + K.cardPad}px">`;
  for (const r of box.rows!) {
    if (typeof r === 'number') s += `<div class="ln" data-line="${r}"><i>${r}</i><span>${h[r - 1] ?? ''}</span></div>`;
    else s += `<div class="ln gap"><i>⋯</i><span>${r.gap} lines in child blocks</span></div>`;
  }
  if (box.cut) s += `<div class="ln gap"><i>⋯</i><span>${box.cut} more lines · open in editor</span></div>`;
  return s + '</div>';
}

// ------------------------------------------------------------------ reading through cards
//
// The selected card scrolls through its code. Scrolling on past its end (or
// start) moves the selection to the next (or previous) block in file order,
// so a file can be read top to bottom while its arrows follow along.

/** Blocks in the order they appear in the file. */
function readingOrder(): ViewBlock[] {
  const out: ViewBlock[] = [];
  const walk = (bs: ViewBlock[]) => {
    for (const b of [...bs].sort((a, c) => a.start - c.start)) {
      out.push(b);
      walk(b.children);
    }
  };
  walk(S.model?.blocks ?? []);
  return out;
}

function neighbour(id: string, dir: 1 | -1): ViewBlock | undefined {
  const order = readingOrder();
  const i = order.findIndex((b) => b.id === id);
  return i < 0 ? undefined : order[i + dir];
}

/** Distance to keep scrolling past an edge before moving on: about two mouse-wheel notches. */
const OVERSCROLL = 180;
/** Gap between wheel events that starts a new gesture; trackpad momentum stays within one. */
const GESTURE_GAP = 220;
/** Pause after which a half-finished overscroll is forgotten. */
const OVERSCROLL_RESET = 1200;
const RS = {
  last: 0,
  gesture: 0,
  /** The card scrolled during this gesture, so what's left of it is momentum. */
  scrolled: false,
  /** Gesture already moved to another block. */
  used: -1,
  acc: 0,
  dir: 0 as 0 | 1 | -1,
};
/** Scroll position of each card, so re-rendering doesn't lose your place. */
const scrollTops = new Map<string, number>();

function atEdge(code: HTMLElement, dir: 1 | -1) {
  return dir > 0 ? code.scrollTop + code.clientHeight >= code.scrollHeight - 1 : code.scrollTop <= 0;
}

function footText(box: Box, progress?: { dir: 1 | -1; f: number }): string {
  const b = box.b!;
  const code = rendered.get(box.id)?.querySelector<HTMLElement>('.code');
  const selected = box.id === S.selected;
  if (selected && progress) {
    const n = neighbour(b.id, progress.dir);
    if (n) {
      return `<span class="next" style="--f:${progress.f}">${progress.dir > 0 ? '↓' : '↑'} Keep scrolling for <b>${esc(label(n))}</b></span>`;
    }
  }
  const below = code ? Math.round((code.scrollHeight - code.scrollTop - code.clientHeight) / M.lineH) : (box.more ?? 0);
  if (below > 0) return selected ? `↓ ${plural(below, 'more line')} · scroll` : `+${plural(below, 'more line')} · select to scroll`;
  if (selected) {
    const n = neighbour(b.id, 1);
    return n ? `↓ Scroll on for <b>${esc(label(n))}</b>` : 'End of file';
  }
  return '';
}

function paintFoot(id: string, progress?: { dir: 1 | -1; f: number }) {
  const box = S.lay?.boxes.get(id);
  const foot = rendered.get(id)?.querySelector<HTMLElement>('.more');
  if (box && foot) foot.innerHTML = footText(box, progress);
}

/** Handles a wheel event over the selected card. Returns true if the card took it. */
function cardWheel(e: WheelEvent): boolean {
  if (e.ctrlKey || e.metaKey || !S.selected || S.view !== 'map') return false;
  const node = (e.target as HTMLElement).closest<HTMLElement>('.node.card');
  if (!node || node.dataset.id !== S.selected) return false;
  const code = node.querySelector<HTMLElement>('.code');
  if (!code) return false;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * code.clientHeight : e.deltaY;
  // Mostly sideways: leave it to the map.
  if (Math.abs(e.deltaX) > Math.abs(dy)) return false;
  e.preventDefault();
  e.stopPropagation();
  const now = performance.now();
  const dir: 1 | -1 = dy > 0 ? 1 : -1;
  if (dir !== RS.dir || now - RS.last > OVERSCROLL_RESET) RS.acc = 0;
  if (dir !== RS.dir || now - RS.last > GESTURE_GAP) {
    RS.gesture++;
    RS.scrolled = false;
  }
  RS.dir = dir;
  RS.last = now;
  if (RS.used === RS.gesture || dy === 0) return true;
  if (!atEdge(code, dir)) {
    code.scrollTop += dy;
    RS.scrolled = true;
    RS.acc = 0;
    return true;
  }
  // At the edge. Momentum from scrolling the card itself doesn't count.
  const next = neighbour(S.selected, dir);
  if (RS.scrolled || !next) return true;
  RS.acc += Math.abs(dy);
  if (RS.acc < OVERSCROLL) {
    paintFoot(S.selected, { dir, f: RS.acc / OVERSCROLL });
    clearTimeout(footTimer);
    footTimer = window.setTimeout(() => S.selected && paintFoot(S.selected), OVERSCROLL_RESET);
    return true;
  }
  RS.acc = 0;
  RS.used = RS.gesture;
  readOn(next, dir);
  return true;
}
let footTimer = 0;

/** Move the selection to `next`, keeping its card where the old one was so reading carries on in place. */
function readOn(next: ViewBlock, dir: 1 | -1) {
  const old = S.selected ? S.lay?.boxes.get(S.selected) : undefined;
  const sx = old ? S.x + old.x * S.k : undefined;
  const sy = old ? S.y + old.y * S.k : undefined;
  // Going up starts the previous block at its end.
  scrollTops.set(next.id, dir > 0 ? 0 : Number.MAX_SAFE_INTEGER);
  select(next.id, { reveal: true, keepView: true });
  const box = S.lay?.boxes.get(next.id);
  if (!box || sx === undefined || sy === undefined) return;
  const r = stage.getBoundingClientRect();
  const m = 24;
  const tx = Math.min(Math.max(sx, m), Math.max(m, r.width - m - box.w * S.k));
  const ty = Math.min(Math.max(sy, m), Math.max(m, r.height - m - box.h * S.k));
  animateTo(tx - box.x * S.k, ty - box.y * S.k, S.k, 320);
}

function makeNode(box: Box): HTMLElement {
  const e = el('div', `node ${box.b ? (box.card ? 'card' : 'pill') : 'root'} side-${box.side > 0 ? 'r' : 'l'}`);
  e.dataset.id = box.id;
  e.style.cssText = `${hueVars(box.hue)};left:${box.x}px;top:${box.y}px;width:${box.w}px;${box.card ? `height:${box.h}px;` : ''}${box.b ? '' : `height:${box.h}px;`}`;
  e.innerHTML = nodeHtml(box);
  const top = scrollTops.get(box.id);
  const code = top ? e.querySelector<HTMLElement>('.code.scroll') : null;
  if (code) requestAnimationFrame(() => {
    code.scrollTop = top!;
    paintFoot(box.id);
  });
  return e;
}

/** Create DOM for boxes inside (or near) the viewport; remove the rest. */
let visQueued = false;
function updateVisible() {
  visQueued = false;
  const lay = S.lay;
  if (!lay || S.view !== 'map') return;
  const r = stage.getBoundingClientRect();
  const margin = 300 / S.k;
  const x0 = -S.x / S.k - margin;
  const y0 = -S.y / S.k - margin;
  const x1 = (r.width - S.x) / S.k + margin;
  const y1 = (r.height - S.y) / S.k + margin;
  const keep = new Set<string>();
  const frag = document.createDocumentFragment();
  for (const box of lay.list) {
    if (box.x + box.w + K.knob < x0 || box.x - K.knob > x1 || box.y + box.h < y0 || box.y > y1) continue;
    keep.add(box.id);
    if (!rendered.has(box.id)) {
      const n = makeNode(box);
      rendered.set(box.id, n);
      frag.appendChild(n);
    }
  }
  for (const [id, n] of rendered) {
    if (!keep.has(id)) {
      n.remove();
      rendered.delete(id);
    }
  }
  nodesEl.appendChild(frag);
  paintState();
}
function queueVisible() {
  if (!visQueued) {
    visQueued = true;
    requestAnimationFrame(updateVisible);
  }
}

/** Selection, related and cursor classes on rendered nodes. */
let cursorId: string | undefined;
function paintState() {
  const l = S.selected ? links(S.selected) : undefined;
  const related = new Set<string>();
  if (l) {
    for (const r of l.out) related.add(r.id);
    for (const r of l.in) related.add(r.id);
    for (const r of l.refs ?? []) related.add(r.id);
  }
  const focus = !!S.selected;
  stage.classList.toggle('focus', focus);
  for (const [id, n] of rendered) {
    n.classList.toggle('selected', id === S.selected);
    n.classList.toggle('related', related.has(id));
    n.classList.toggle('dim', focus && id !== S.selected && !related.has(id) && id !== '#root');
    n.classList.toggle('cursor', id === cursorId && id !== S.selected);
  }
}

function applyTransform() {
  world.style.transform = `translate(${S.x}px, ${S.y}px) scale(${S.k})`;
  $('.zoom-pct').textContent = `${Math.round(S.k * 100)}%`;
  stage.style.setProperty('--grid', `${24 * S.k}px`);
  stage.style.backgroundPosition = `${S.x}px ${S.y}px`;
  queueVisible();
}

// ------------------------------------------------------------------ arrows

function arrowPath(a: Box, b: Box): string {
  const ya = a.y + (a.card ? K.cardHead / 2 : a.h / 2);
  const yb = b.y + (b.card ? K.cardHead / 2 : b.h / 2);
  if (a.b && b.b && a.side === b.side) {
    // Same side of the map: leave and enter on the outer edges and bow outward,
    // away from the branches.
    const out = a.side;
    const xa = out > 0 ? a.x + a.w : a.x;
    const xb = out > 0 ? b.x + b.w : b.x;
    const bow = out * Math.min(220, 50 + Math.abs(yb - ya) * 0.35);
    const edge = out > 0 ? Math.max(xa, xb) : Math.min(xa, xb);
    return `M${xa} ${ya}C${edge + bow} ${ya} ${edge + bow} ${yb} ${xb + out * 3} ${yb}`;
  }
  // Across the root: inner edge to inner edge.
  const right = b.x + b.w / 2 > a.x + a.w / 2;
  const xa = right ? a.x + a.w : a.x;
  const xb = right ? b.x : b.x + b.w;
  const dx = Math.max(60, Math.abs(xb - xa) * 0.4) * (right ? 1 : -1);
  return `M${xa} ${ya}C${xa + dx} ${ya} ${xb - dx} ${yb} ${xb + (right ? -3 : 3)} ${yb}`;
}

function drawArrows() {
  arrowG.innerHTML = '';
  $('.lg-ref').hidden = !(S.selected && links(S.selected)?.refs?.length);
  const lay = S.lay;
  if (!lay || !S.selected) return;
  const me = lay.boxes.get(S.selected);
  const l = links(S.selected);
  if (!me || !l) return;
  // A collapsed target is drawn to its nearest visible ancestor.
  const visible = (id: string): Box | undefined => {
    for (let b: ViewBlock | undefined = S.byId.get(id); b; b = S.parentOf.get(b.id)) {
      const box = lay.boxes.get(b.id);
      if (box) return box;
    }
  };
  let s = '';
  const drawn = new Set<string>();
  for (const r of uniq(l.out)) {
    const t = r.rel === S.model!.rel ? visible(r.id) : undefined;
    if (!t || t === me || drawn.has('o' + t.id)) continue;
    drawn.add('o' + t.id);
    s += `<path d="${arrowPath(me, t)}" class="arrow out" marker-end="url(#ah-out)"/>`;
  }
  for (const r of uniq(l.in)) {
    const t = r.rel === S.model!.rel ? visible(r.id) : undefined;
    if (!t || t === me || drawn.has('i' + t.id)) continue;
    drawn.add('i' + t.id);
    s += `<path d="${arrowPath(t, me)}" class="arrow in" marker-end="url(#ah-in)"/>`;
  }
  for (const r of uniq(l.refs ?? [])) {
    const t = r.rel === S.model!.rel ? visible(r.id) : undefined;
    if (!t || t === me || drawn.has('i' + t.id)) continue;
    drawn.add('i' + t.id);
    s += `<path d="${arrowPath(t, me)}" class="arrow ref" marker-end="url(#ah-in)"/>`;
  }
  arrowG.innerHTML = s;
}

// ------------------------------------------------------------------ selection

function reveal(rel: string, line: number, endLine?: number, focus = false, uri?: string) {
  vscode.postMessage({ type: 'reveal', rel, uri, line, endLine, focus });
}

/** `history` marks a deliberate jump (click, search, following a call) that Back should return to. */
/** `keepView` leaves the camera to the caller. */
function select(id: string | undefined, opts: { reveal?: boolean; center?: boolean; fromCursor?: boolean; history?: boolean; keepView?: boolean } = {}) {
  const prev = S.selected;
  S.selected = id;
  const b = id ? S.byId.get(id) : undefined;
  if (b && opts.history) {
    // The first jump also records where it started from.
    if (H.i < 0 && prev && prev !== id && S.byId.get(prev)) pushStop(stopOf(S.byId.get(prev)!));
    pushStop(stopOf(b));
  }
  if (id) requestCalls(id);
  // Make sure the block is visible: expand collapsed ancestors.
  let expanded = false;
  for (let p = b ? S.parentOf.get(b.id) : undefined; p; p = S.parentOf.get(p.id)) {
    if (S.collapsed.delete(p.id)) expanded = true;
  }
  if (b && opts.reveal) reveal(S.model!.rel, b.defLine, b.end);
  if (S.view === 'outline') {
    renderDetails();
    renderOutline();
    save();
    return;
  }
  // The selected block gets its own card (names mode) or card footer (code mode), so a new selection re-lays out.
  if (prev !== id) {
    const box = id ? S.lay?.boxes.get(id) : prev ? S.lay?.boxes.get(prev) : undefined;
    if (box && !expanded) relayout(anchorOf(box));
    else relayout('keep');
  } else {
    drawArrows();
    paintState();
    renderDetails();
  }
  if (id && !opts.keepView) ensureVisible(id);
  save();
}

function ensureVisible(id: string) {
  const box = S.lay?.boxes.get(id);
  if (!box) return;
  const r = stage.getBoundingClientRect();
  const sx = S.x + box.x * S.k;
  const sy = S.y + box.y * S.k;
  const sw = box.w * S.k;
  const sh = Math.min(box.h * S.k, r.height * 0.8);
  const m = 40;
  if (sx >= m && sy >= m && sx + sw <= r.width - m && sy + sh <= r.height - m) return;
  const tx = sw > r.width - 2 * m ? m - box.x * S.k : r.width / 2 - (box.x + box.w / 2) * S.k;
  const ty = sh > r.height - 2 * m ? m - box.y * S.k : r.height / 2 - (box.y + box.h / 2) * S.k;
  animateTo(tx, ty, S.k);
}

let anim = 0;
function animateTo(x: number, y: number, k: number, ms = 240) {
  const from = { x: S.x, y: S.y, k: S.k };
  const t0 = performance.now();
  const id = ++anim;
  const step = (t: number) => {
    if (id !== anim) return;
    const p = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    S.x = from.x + (x - from.x) * e;
    S.y = from.y + (y - from.y) * e;
    S.k = from.k + (k - from.k) * e;
    applyTransform();
    if (p < 1) requestAnimationFrame(step);
    else save();
  };
  requestAnimationFrame(step);
}

/** First view of a file: fit it, but never so small that names are unreadable. */
function initialView() {
  fit(false);
  const lay = S.lay;
  if (!lay || S.k >= 0.72) return;
  const r = stage.getBoundingClientRect();
  S.k = 0.8;
  const target = S.selected ? lay.boxes.get(S.selected) : lay.root;
  const box = target ?? lay.root;
  S.x = r.width / 2 - (box.x + box.w / 2) * S.k;
  S.y = (r.height - 40) / 2 - (box.y + box.h / 2) * S.k;
}

function fit(animate = true) {
  const lay = S.lay;
  if (!lay) return;
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const w = lay.maxX - lay.minX;
  const h = lay.maxY - lay.minY;
  const k = Math.max(0.12, Math.min(1.1, Math.min((r.width - 80) / w, (r.height - 110) / h)));
  const x = r.width / 2 - (lay.minX + w / 2) * k;
  const y = (r.height - 40) / 2 - (lay.minY + h / 2) * k;
  if (animate) animateTo(x, y, k);
  else {
    S.x = x;
    S.y = y;
    S.k = k;
  }
}

function zoomAt(factor: number, cx?: number, cy?: number) {
  const r = stage.getBoundingClientRect();
  const px = cx ?? r.width / 2;
  const py = cy ?? r.height / 2;
  const k = Math.max(0.08, Math.min(3, S.k * factor));
  S.x = px - ((px - S.x) * k) / S.k;
  S.y = py - ((py - S.y) * k) / S.k;
  S.k = k;
  applyTransform();
  saveSoon();
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 300);
}

function toggleCollapse(id: string) {
  const box = S.lay?.boxes.get(id);
  if (S.collapsed.has(id)) S.collapsed.delete(id);
  else S.collapsed.add(id);
  if (box) relayout(anchorOf(box));
  else relayout('keep');
  save();
}

function setAllCollapsed(collapse: boolean) {
  S.collapsed.clear();
  if (collapse) for (const b of S.byId.values()) if (b.children.length) S.collapsed.add(b.id);
  relayout('fit');
  if (S.view === 'outline') renderOutline();
  save();
}

// ------------------------------------------------------------------ details panel

function refItem(r: Ref & { n: number }, dir: 'out' | 'in' | 'val') {
  const here = r.rel === S.model!.rel;
  const where = here ? `L${r.line}` : `${esc(fileName(r.rel))}:${r.line}`;
  return `<li><button class="ref ${dir}" data-id="${esc(r.id)}" data-rel="${esc(r.rel)}" data-line="${r.line}" data-label="${esc(r.label)}"${r.uri ? ` data-uri="${esc(r.uri)}"` : ''} title="${esc(r.rel)}:${r.line}">
    <span class="ref-name">${esc(r.label)}</span>${r.n > 1 ? `<span class="ref-n">×${r.n}</span>` : ''}<span class="ref-where ${here ? '' : 'ext'}">${where}</span></button></li>`;
}

const isCallableBlock = (b: ViewBlock) => b.kind === 'function' || b.kind === 'method' || b.kind === 'ctor';
const fileChip = (rel: string) => (/\.([\w]+)$/.exec(rel)?.[1] ?? 'file').toLowerCase().slice(0, 5);

/** Why a block may have no direct callers, so nobody takes "0" to mean dead code. */
function noCallersHint(b: ViewBlock, l: Links): string {
  if (!isCallableBlock(b) || l.in.length) return '';
  if (l.refs?.length) {
    const first = uniq(l.refs)[0];
    return `It is passed as a value by <b>${esc(first.label)}</b>${l.refs.length > 1 ? ' and others' : ''}, so it is probably called from there: a callback, handler or registered node.`;
  }
  if (b.decorators?.length) return `It has <code>${esc(b.decorators[0])}</code>, so a framework probably calls it.`;
  if (usesLsp()) return `${esc(Provider())} found no callers. Dynamic calls are not counted.`;
  return 'No call to it was found in the indexed files. It may still be called dynamically, through a base class, or by code outside the workspace.';
}

function renderDetails() {
  if (!S.model) return;
  const m = S.model;
  const b = S.selected ? S.byId.get(S.selected) : undefined;
  if (!b) {
    // File overview: shape of the file and its most-called blocks.
    let classes = 0;
    let fns = 0;
    const hot: { b: ViewBlock; n: number }[] = [];
    for (const x of S.byId.values()) {
      if (x.kind === 'class' || x.kind === 'interface' || x.kind === 'enum') classes++;
      if (isCallableBlock(x)) fns++;
      const n = links(x.id)?.in.length ?? 0;
      if (n) hot.push({ b: x, n });
    }
    hot.sort((a, c) => c.n - a.n);
    details.innerHTML = `
      <div class="d-head"><span class="chip k-file">${esc(fileChip(m.rel))}</span><span class="d-title">${esc(fileName(m.rel))}</span></div>
      <div class="d-sub">${esc(m.rel)}</div>
      ${m.summary ? `<p class="d-doc">${esc(m.summary)}</p>` : ''}
      <div class="tiles">
        <div class="tile"><b>${m.lineCount.toLocaleString()}</b><span>lines</span></div>
        <div class="tile"><b>${classes}</b><span>${classes === 1 ? 'class' : 'classes'}</span></div>
        <div class="tile"><b>${fns}</b><span>${fns === 1 ? 'function' : 'functions'}</span></div>
      </div>
      ${hot.length ? `<h4>Most called</h4><ul class="refs">${hot.slice(0, 8).map((h) => `<li><button class="ref sel" data-id="${esc(h.b.id)}"><span class="ref-name">${esc(h.b.qual.replace(/#\d+$/, ''))}</span><span class="ref-where">←${h.n}</span></button></li>`).join('')}</ul>` : ''}
      ${usesLsp() ? `<p class="d-note">Select a block to ask ${esc(provider())} what calls it.</p>` : ''}
      <div class="tips">
        <h4>Tips</h4>
        <ul>
          <li><kbd>Click</kbd> a block to open it and jump the editor there</li>
          <li><kbd>Double-click</kbd> to put the cursor in the code</li>
          <li><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> walk the map, <kbd>Enter</kbd> edit</li>
          <li><kbd>Alt</kbd>+<kbd>←</kbd> back after following a call</li>
          <li><kbd>/</kbd> search · <kbd>F</kbd> fit · <kbd>C</kbd> code/names · <kbd>O</kbd> outline</li>
        </ul>
      </div>`;
    return;
  }
  const l: Links = links(b.id) ?? { out: [], in: [], ext: [], refs: [] };
  const out = uniq(l.out);
  const inn = uniq(l.in);
  const refs = uniq(l.refs ?? []);
  const lines = b.end - b.start + 1;
  // The map already shows the selected block as a code card, so only the outline needs a preview.
  let code = '';
  if (S.view === 'outline') {
    const h = hl();
    const maxPreview = 400;
    for (let ln = b.start; ln <= Math.min(b.end, b.start + maxPreview - 1); ln++) {
      code += `<div class="ln" data-line="${ln}"><i>${ln}</i><span>${h[ln - 1] ?? ''}</span></div>`;
    }
    if (lines > maxPreview) code += `<div class="more">+${lines - maxPreview} more lines</div>`;
  }
  let callsHtml: string;
  const status = usesLsp() ? S.lsp.get(b.id) : 'ok';
  if (isGroup(b)) callsHtml = '';
  else if (status === 'loading' && !links(b.id)) callsHtml = `<p class="none pulse calls-note">Asking ${esc(provider())} for calls…</p>`;
  else if (status === 'unavailable') {
    callsHtml = `<p class="none calls-note">Call information isn't available for this block. ${esc(Provider())} doesn't report a call hierarchy here${S.language.builtIn ? '' : ', or no extension is installed'}.</p>`;
  } else {
    const hint = noCallersHint(b, l);
    callsHtml = `
    <div class="cols">
      <div><h4 class="h-out">Calls · ${out.length}</h4>${out.length ? `<ul class="refs">${out.map((r) => refItem(r, 'out')).join('')}</ul>` : '<p class="none">none found</p>'}</div>
      <div><h4 class="h-in">Called by · ${inn.length}</h4>${inn.length ? `<ul class="refs">${inn.map((r) => refItem(r, 'in')).join('')}</ul>` : '<p class="none">No direct callers found</p>'}
      ${refs.length ? `<h4 class="h-ref">Passed as a value · ${refs.length}</h4><ul class="refs">${refs.map((r) => refItem(r, 'val')).join('')}</ul>` : ''}</div>
    </div>
    ${hint ? `<p class="d-hint">${hint}</p>` : ''}
    ${l.ext.length ? `<details class="ext"><summary>Unlinked calls · ${l.ext.length}</summary><p class="ext-why">Codebloom couldn't tell where these go. Usually that's library code, or a target only known at runtime (an untyped parameter, <code>getattr</code>, a dict of functions).</p><div class="ext-list">${l.ext.map((e) => `<code>${esc(e)}</code>`).join('')}</div></details>` : ''}`;
  }
  details.innerHTML = `
    <div class="d-head"><span class="chip k-${b.kind}">${esc(chip(b))}</span><span class="d-title" title="${esc(b.qual)}">${esc(isGroup(b) ? b.kind : b.qual.replace(/#\d+$/, ''))}</span></div>
    <div class="d-sub">L${b.start}–${b.end} · ${plural(lines, 'line')}</div>
    <div class="d-actions">
      <button class="btn primary go">Go to code</button>
      <button class="btn copy" title="Copy this block's code with what it calls and what calls it">Copy as context</button>
    </div>
    ${b.signature ? `<div class="sig">${esc(b.signature)}</div>` : ''}
    ${b.decorators?.length ? `<div class="decos">${b.decorators.map((d) => `<code>${esc(d)}</code>`).join('')}</div>` : ''}
    ${b.detail && !isGroup(b) ? `<p class="d-doc">${esc(b.detail)}</p>` : ''}
    ${callsHtml}
    ${code ? `<div class="d-code code" style="--gw:${String(b.end).length}ch">${code}</div>` : ''}`;
}

details.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const ref = t.closest<HTMLElement>('.ref');
  if (ref) {
    const id = ref.dataset.id!;
    const rel = ref.dataset.rel;
    if (!rel || rel === S.model?.rel) select(id, { reveal: true, center: true, history: true });
    else {
      // Following a call into another file: remember where we were, then go.
      const cur = S.selected ? S.byId.get(S.selected) : undefined;
      if (cur && H.i < 0) pushStop(stopOf(cur));
      const stop: Stop = { rel, uri: ref.dataset.uri, id, line: Number(ref.dataset.line), label: ref.dataset.label ?? id };
      pushStop(stop);
      goStop(stop);
    }
    return;
  }
  const b = S.selected ? S.byId.get(S.selected) : undefined;
  if (t.closest('.go') && b) reveal(S.model!.rel, b.defLine, b.end, true);
  else if (t.closest('.copy')) {
    vscode.postMessage({ type: 'copyContext', id: S.selected });
    const btn = t.closest('.copy')!;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy as context'), 1400);
  } else {
    const ln = t.closest<HTMLElement>('.ln[data-line]');
    if (ln) reveal(S.model!.rel, Number(ln.dataset.line), undefined, false);
  }
});

// ------------------------------------------------------------------ outline

function renderOutline() {
  if (!S.model) return;
  const row = (b: ViewBlock, depth: number, hue: number): string => {
    const l = links(b.id);
    const kids = b.children.length;
    const collapsed = S.collapsed.has(b.id);
    let s = `<div class="o-row ${b.id === S.selected ? 'selected' : ''}" data-id="${esc(b.id)}" style="--d:${depth};${hueVars(hue)}">
      ${kids ? `<button class="o-tw" aria-label="Toggle">${collapsed ? '▸' : '▾'}</button>` : '<span class="o-tw"></span>'}
      <span class="chip k-${b.kind}">${esc(chip(b))}</span>
      <span class="label ${isGroup(b) ? 'dim' : ''}">${esc(label(b))}</span>
      ${b.signature && !isGroup(b) ? `<span class="o-sig">${esc(b.signature)}</span>` : ''}
      <span class="range">${b.start}–${b.end}</span>
      ${inCount(l) ? `<span class="badge in" title="${inTitle(l!)}">←${inCount(l)}</span>` : ''}${l?.out.length ? `<span class="badge out">→${uniq(l.out).length}</span>` : ''}
    </div>`;
    if (kids && !collapsed) s += b.children.map((c) => row(c, depth + 1, hue)).join('');
    return s;
  };
  outlineEl.innerHTML = `<div class="o-file">${esc(S.model.rel)}</div>` + S.model.blocks.map((b, i) => row(b, 0, i)).join('');
}

outlineEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const r = t.closest<HTMLElement>('.o-row');
  if (!r) return;
  if (t.closest('.o-tw') && S.byId.get(r.dataset.id!)?.children.length) {
    const id = r.dataset.id!;
    if (S.collapsed.has(id)) S.collapsed.delete(id);
    else S.collapsed.add(id);
    renderOutline();
    return;
  }
  select(r.dataset.id, { reveal: true, history: true });
});
outlineEl.addEventListener('dblclick', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.o-row');
  const b = r && S.byId.get(r.dataset.id!);
  if (b) reveal(S.model!.rel, b.defLine, b.end, true);
});

// ------------------------------------------------------------------ search

let hits: ViewBlock[] = [];
let hitIndex = 0;
function score(q: string, s: string): number {
  const a = s.toLowerCase();
  if (a === q) return 100;
  if (a.startsWith(q)) return 80 - a.length / 100;
  const i = a.indexOf(q);
  if (i >= 0) return 60 - i;
  // Subsequence match.
  let j = 0;
  for (const ch of a) if (ch === q[j]) j++;
  return j === q.length ? 20 - a.length / 50 : -1;
}
function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q || !S.model) {
    results.hidden = true;
    return;
  }
  hits = [...S.byId.values()]
    .filter((b) => !isGroup(b))
    .map((b) => ({ b, s: Math.max(score(q, b.name), score(q, b.qual) - 5) }))
    .filter((x) => x.s >= 0)
    .sort((a, c) => c.s - a.s)
    .slice(0, 30)
    .map((x) => x.b);
  hitIndex = 0;
  paintResults();
}
function paintResults() {
  results.hidden = false;
  results.innerHTML = hits.length
    ? hits.map((b, i) => `<button class="hit ${i === hitIndex ? 'on' : ''}" data-id="${esc(b.id)}"><span class="chip k-${b.kind}">${esc(chip(b))}</span><span class="hit-name">${esc(b.qual.replace(/#\d+$/, ''))}</span><span class="range">L${b.defLine}</span></button>`).join('')
    : '<div class="no-hit">No matching blocks</div>';
  results.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function pickHit(b: ViewBlock | undefined) {
  if (!b) return;
  results.hidden = true;
  searchInput.value = '';
  searchInput.blur();
  select(b.id, { reveal: true, center: true, history: true });
  stage.focus();
}
searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('focus', runSearch);
searchInput.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    hitIndex = (hitIndex + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(1, hits.length);
    paintResults();
  } else if (e.key === 'Enter') {
    pickHit(hits[hitIndex]);
  } else if (e.key === 'Escape') {
    searchInput.value = '';
    searchInput.blur();
    results.hidden = true;
  }
});
results.addEventListener('mousedown', (e) => {
  const h = (e.target as HTMLElement).closest<HTMLElement>('.hit');
  if (h) {
    e.preventDefault();
    pickHit(S.byId.get(h.dataset.id!));
  }
});

// ------------------------------------------------------------------ map interaction

let drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest('.node')) return;
  drag = { x: e.clientX, y: e.clientY, sx: S.x, sy: S.y, moved: false };
  stage.setPointerCapture(e.pointerId);
  anim++;
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  stage.classList.add('panning');
  S.x = drag.sx + dx;
  S.y = drag.sy + dy;
  applyTransform();
});
stage.addEventListener('pointerup', () => {
  if (drag && !drag.moved) select(undefined);
  drag = null;
  stage.classList.remove('panning');
  saveSoon();
});

stage.addEventListener(
  'wheel',
  (e) => {
    if (cardWheel(e)) return;
    e.preventDefault();
    anim++;
    const r = stage.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    // Pinch and ctrl+wheel zoom; a mouse wheel zooms; a trackpad's two-finger scroll pans.
    const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0018)), px, py);
    } else {
      S.x -= e.deltaX;
      S.y -= e.deltaY;
      applyTransform();
      saveSoon();
    }
  },
  { passive: false },
);

nodesEl.addEventListener(
  'scroll',
  (e) => {
    const code = e.target as HTMLElement;
    const id = code.closest<HTMLElement>('.node')?.dataset.id;
    if (!id || !code.classList?.contains('code')) return;
    scrollTops.set(id, code.scrollTop);
    paintFoot(id);
  },
  true,
);

nodesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const n = t.closest<HTMLElement>('.node');
  if (!n) return;
  const id = n.dataset.id!;
  if (t.closest('.knob')) {
    toggleCollapse(id);
    return;
  }
  if (id === '#root') {
    select(undefined);
    return;
  }
  const ln = t.closest<HTMLElement>('.ln[data-line]');
  if (ln && id === S.selected) {
    reveal(S.model!.rel, Number(ln.dataset.line), undefined, false);
    return;
  }
  if (t.closest('.more') && id === S.selected) {
    const code = n.querySelector<HTMLElement>('.code');
    const next = neighbour(id, 1);
    if (next && (!code || atEdge(code, 1))) readOn(next, 1);
    else {
      const b = S.byId.get(id);
      if (b) reveal(S.model!.rel, b.defLine, b.end, true);
    }
    return;
  }
  select(id, { reveal: true, history: true });
});
nodesEl.addEventListener('dblclick', (e) => {
  const n = (e.target as HTMLElement).closest<HTMLElement>('.node');
  if (!n || (e.target as HTMLElement).closest('.knob')) return;
  const ln = (e.target as HTMLElement).closest<HTMLElement>('.ln[data-line]');
  const b = S.byId.get(n.dataset.id!);
  if (b) reveal(S.model!.rel, ln ? Number(ln.dataset.line) : b.defLine, b.end, true);
});

// Keyboard navigation over the tree.
function siblings(b: ViewBlock): ViewBlock[] {
  const p = S.parentOf.get(b.id);
  return p ? p.children : S.model!.blocks;
}
function navigate(key: string) {
  if (!S.model) return;
  const b = S.selected ? S.byId.get(S.selected) : undefined;
  if (!b) {
    const first = S.model.blocks.find((x) => !isGroup(x)) ?? S.model.blocks[0];
    if (first) select(first.id, { reveal: true, center: true });
    return;
  }
  const side = S.lay?.boxes.get(b.id)?.side ?? 1;
  const sib = siblings(b);
  const i = sib.indexOf(b);
  let next: ViewBlock | undefined;
  const outward = side > 0 ? 'ArrowRight' : 'ArrowLeft';
  const inward = side > 0 ? 'ArrowLeft' : 'ArrowRight';
  if (key === 'ArrowDown') next = sib[i + 1];
  else if (key === 'ArrowUp') next = sib[i - 1];
  else if (key === outward) {
    if (b.children.length) {
      S.collapsed.delete(b.id);
      next = b.children[0];
    }
  } else if (key === inward) next = S.parentOf.get(b.id);
  if (next) select(next.id, { reveal: true, center: true });
}

window.addEventListener('keydown', (e) => {
  const inInput = (e.target as HTMLElement).closest('input, textarea');
  if (inInput) return;
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f')) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case 'Escape':
      if (!$('.help').hidden) $('.help').hidden = true;
      else select(undefined);
      break;
    case 'f':
    case 'F':
      fit();
      break;
    case 'c':
    case 'C':
      setMode(S.mode === 'names' ? 'code' : 'names');
      break;
    case 'o':
    case 'O':
      setView(S.view === 'map' ? 'outline' : 'map');
      break;
    case 'd':
    case 'D':
      toggleDetails();
      break;
    case '+':
    case '=':
      zoomAt(1.2);
      break;
    case '-':
    case '_':
      zoomAt(1 / 1.2);
      break;
    case '0':
      zoomAt(1 / S.k);
      break;
    case '?':
      toggleHelp();
      break;
    case '[':
      step(-1);
      break;
    case ']':
      step(1);
      break;
    case 'Enter': {
      const b = S.selected ? S.byId.get(S.selected) : undefined;
      if (b) reveal(S.model!.rel, b.defLine, b.end, true);
      break;
    }
    case ' ': {
      if (S.selected && S.byId.get(S.selected)?.children.length) toggleCollapse(S.selected);
      break;
    }
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      e.preventDefault();
      navigate(e.key);
      break;
    default:
      return;
  }
});

function toggleHelp() {
  const h = $('.help');
  h.hidden = !h.hidden;
  h.innerHTML = `<div class="help-card"><h3>Keyboard</h3><dl>
    <dt>/</dt><dd>Search blocks</dd><dt>↑ ↓</dt><dd>Previous / next sibling</dd><dt>← →</dt><dd>Parent / first child</dd>
    <dt>Enter</dt><dd>Edit the selected block</dd><dt>Space</dt><dd>Fold / unfold</dd><dt>C</dt><dd>Names ↔ Code</dd><dt>O</dt><dd>Map ↔ Outline</dd>
    <dt>Alt ← →</dt><dd>Back / forward (also [ and ])</dd>
    <dt>F</dt><dd>Fit map</dd><dt>+ − 0</dt><dd>Zoom in / out / reset</dd><dt>D</dt><dd>Details panel</dd><dt>Esc</dt><dd>Deselect</dd></dl>
    <p>Drag to pan · scroll or pinch to zoom</p></div>`;
}
$('.help').addEventListener('click', () => ($('.help').hidden = true));

function setMode(mode: Mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  vscode.postMessage({ type: 'mode', mode });
  renderChrome();
  const id = S.selected;
  const box = id ? S.lay?.boxes.get(id) : undefined;
  if (box) relayout(anchorOf(box));
  else relayout('fit');
}
function setView(view: View) {
  S.view = view;
  renderChrome();
  if (view === 'outline') {
    renderOutline();
    renderDetails();
  } else {
    relayout('keep');
  }
  save();
}
/** Below this width the details panel floats over the map instead of taking a column. */
const NARROW = 760;
const isNarrow = () => window.innerWidth <= NARROW;
function toggleDetails() {
  if (isNarrow()) S.narrowOpen = !S.narrowOpen;
  else S.details = !S.details;
  renderChrome();
  save();
  queueVisible();
}

document.querySelector('.dock')!.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!t) return;
  if (t.dataset.mode) setMode(t.dataset.mode as Mode);
  else if (t.dataset.view) setView(t.dataset.view as View);
  else if (t.classList.contains('zoom-in')) zoomAt(1.2);
  else if (t.classList.contains('zoom-out')) zoomAt(1 / 1.2);
  else if (t.classList.contains('zoom-pct')) zoomAt(1 / S.k);
  else if (t.classList.contains('fit')) fit();
  else if (t.classList.contains('expand-all')) setAllCollapsed(false);
  else if (t.classList.contains('collapse-all')) setAllCollapsed(true);
});
$('.toggle-details').addEventListener('click', toggleDetails);
$('.maximize').addEventListener('click', () => vscode.postMessage({ type: 'maximize' }));
$('.nav .back').addEventListener('click', () => step(-1));
$('.nav .fwd').addEventListener('click', () => step(1));
// Mouse back/forward buttons.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
    step(e.button === 3 ? -1 : 1);
  }
});
$('.trail').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('.t-stop');
  if (!t) return;
  H.i = Number(t.dataset.i);
  goStop(H.stops[H.i]);
});
$('.stats').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-setting]');
  if (t) vscode.postMessage({ type: 'openSetting', key: t.dataset.setting });
});
$('.banner').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!t) return;
  if (t.dataset.act === 'enable') vscode.postMessage({ type: 'enableLanguage', languageId: t.dataset.lang });
  else if (t.dataset.act === 'find') vscode.postMessage({ type: 'findExtension', languageId: t.dataset.lang });
  S.notice = null;
  renderBanner();
});

new ResizeObserver(() => queueVisible()).observe(stage);
window.addEventListener('resize', () => {
  // Leaving the narrow layout closes the floating panel.
  if (!isNarrow() && S.narrowOpen) {
    S.narrowOpen = false;
    renderChrome();
  }
});

// Theme changes swap body classes; recolor text tones.
new MutationObserver(() => {
  fontsReady = false;
  if (S.model) relayout('keep');
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ------------------------------------------------------------------ messages

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'model') onModel(msg);
  else if (msg.type === 'calls') onCalls(msg);
  else if (msg.type === 'notice') {
    S.notice = msg.notice;
    if (S.model) renderBanner();
  } else if (msg.type === 'cursor') {
    const b = blockAtLine(msg.line);
    cursorId = b?.id;
    if (b && b.id !== S.selected) select(b.id, { fromCursor: true });
    else paintState();
  }
});

vscode.postMessage({ type: 'ready' });

// Exposed for the browser harness used in development.
(window as any).__codebloom = { S, relayout, ownRows, select, setView };
