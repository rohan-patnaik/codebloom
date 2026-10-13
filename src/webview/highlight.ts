// A small single-pass syntax highlighter. It only needs to look right on
// cards, so it trades completeness for speed: one regex scan per line, with
// carried state for strings and comments that span lines.

interface LangSpec {
  line: string[];
  block?: [string, string];
  /** Delimiters that may span lines (triple quotes, template strings). */
  multi: string[];
  quotes: string[];
  keywords: Set<string>;
  literals: Set<string>;
  decorator: boolean;
  /** Words that introduce a definition name. */
  defs: Set<string>;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const SPECS: Record<string, LangSpec> = {
  python: {
    line: ['#'],
    multi: ['"""', "'''"],
    quotes: ['"', "'"],
    keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type'),
    literals: words('True False None self cls'),
    decorator: true,
    defs: words('def class'),
  },
  java: {
    line: ['//'],
    block: ['/*', '*/'],
    multi: [],
    quotes: ['"', "'"],
    keywords: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield non-sealed'),
    literals: words('true false null'),
    decorator: true,
    defs: words('class interface enum record'),
  },
  javascript: {
    line: ['//'],
    block: ['/*', '*/'],
    multi: ['`'],
    quotes: ['"', "'"],
    keywords: words('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'),
    literals: words('true false null undefined NaN Infinity'),
    decorator: false,
    defs: words('function class'),
  },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => `<span class="t-${cls}">${esc(s)}</span>`;

/** Returns highlighted HTML for each line. */
export function highlight(lines: string[], lang: string): string[] {
  const spec = SPECS[lang] ?? SPECS.javascript;
  const out: string[] = new Array(lines.length);
  // Carried state: inside a block comment, or inside a multi-line string with this delimiter.
  let inBlock = false;
  let inMulti: string | null = null;
  const ident = /[A-Za-z_$][\w$]*/y;
  const num = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[lLfFdDnj]?/y;

  for (let li = 0; li < lines.length; li++) {
    const s = lines[li];
    let html = '';
    let i = 0;
    let prevWord = '';
    let plain = '';
    const flush = () => {
      if (plain) html += esc(plain);
      plain = '';
    };
    while (i < s.length) {
      if (inBlock) {
        const end = s.indexOf(spec.block![1], i);
        const stop = end === -1 ? s.length : end + spec.block![1].length;
        flush();
        html += span('c', s.slice(i, stop));
        i = stop;
        if (end !== -1) inBlock = false;
        continue;
      }
      if (inMulti) {
        let j = i;
        let end = -1;
        while (j < s.length) {
          if (s[j] === '\\') {
            j += 2;
            continue;
          }
          if (s.startsWith(inMulti, j)) {
            end = j;
            break;
          }
          j++;
        }
        const stop = end === -1 ? s.length : end + inMulti.length;
        flush();
        html += span('s', s.slice(i, stop));
        i = stop;
        if (end !== -1) inMulti = null;
        continue;
      }
      const ch = s[i];
      if (ch === ' ' || ch === '\t') {
        plain += ch;
        i++;
        continue;
      }
      if (spec.line.some((p) => s.startsWith(p, i))) {
        flush();
        html += span('c', s.slice(i));
        i = s.length;
        break;
      }
      if (spec.block && s.startsWith(spec.block[0], i)) {
        inBlock = true;
        flush();
        continue;
      }
      // Python string prefixes like f"", rb''.
      let pre = 0;
      if (lang === 'python') {
        const m = /^[rRbBuUfF]{1,2}(?=["'])/.exec(s.slice(i, i + 3));
        if (m && !/[\w$]/.test(s[i - 1] ?? '')) pre = m[0].length;
      }
      const multi = spec.multi.find((d) => s.startsWith(d, i + pre));
      if (multi) {
        flush();
        html += span('s', s.slice(i, i + pre + multi.length));
        i += pre + multi.length;
        inMulti = multi;
        continue;
      }
      const q = s[i + pre];
      if (spec.quotes.includes(q)) {
        let j = i + pre + 1;
        while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
        flush();
        html += span('s', s.slice(i, j + 1));
        i = j + 1;
        prevWord = '';
        continue;
      }
      if (spec.decorator && ch === '@') {
        const m = /@[\w.$]+/y;
        m.lastIndex = i;
        const r = m.exec(s);
        if (r) {
          flush();
          html += span('d', r[0]);
          i += r[0].length;
          continue;
        }
      }
      if (/\d/.test(ch) && !/[\w$]/.test(s[i - 1] ?? '')) {
        num.lastIndex = i;
        const r = num.exec(s);
        if (r) {
          flush();
          html += span('n', r[0]);
          i += r[0].length;
          continue;
        }
      }
      ident.lastIndex = i;
      const r = /[A-Za-z_$]/.test(ch) ? ident.exec(s) : null;
      if (r) {
        const w = r[0];
        flush();
        let k = i + w.length;
        while (s[k] === ' ') k++;
        if (spec.defs.has(prevWord)) html += span('f', w);
        else if (spec.keywords.has(w)) html += span('k', w);
        else if (spec.literals.has(w)) html += span('l', w);
        else if (s[k] === '(') html += span('f', w);
        else if (/^[A-Z][a-z0-9]/.test(w)) html += span('t', w);
        else html += esc(w);
        prevWord = w;
        i += w.length;
        continue;
      }
      if (/[+\-*/%=<>!&|^~?:]/.test(ch)) {
        flush();
        let j = i + 1;
        while (j < s.length && /[+\-*/%=<>!&|^~?:]/.test(s[j]) && j - i < 3) j++;
        html += span('o', s.slice(i, j));
        i = j;
        continue;
      }
      plain += ch;
      prevWord = '';
      i++;
    }
    flush();
    out[li] = html;
  }
  return out;
}
