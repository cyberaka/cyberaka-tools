'use strict';

/* ---------------------------------------------------------------------------------------------
 * Elements, storage keys and small helpers
 * ------------------------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const source = $('source');
const preview = $('preview');
const statusEl = $('status');
const main = $('main');
const split = $('split');
const tabList = $('tab-list');
const outline = $('outline');
const syncBox = $('sync-scroll');
const watchBox = $('watch');
const fileInput = $('file-input');
const exportMenu = $('export-menu');

const STORE = {
  notes: 'markdown-viewer:notes', // ordered list of scratch note ids
  notePrefix: 'markdown-viewer:note:', // + id: the text of one scratch note
  lastActive: 'markdown-viewer:last-active', // tab to show when a new window opens
  active: 'markdown-viewer:active', // (sessionStorage) the tab this window is showing
  oldDocs: 'markdown-viewer:docs', // earlier format: all notes in one value
  oldDraft: 'markdown-viewer:draft', // earliest format: a single draft
  layout: 'markdown-viewer:layout',
  theme: 'markdown-viewer:theme',
  prefs: 'markdown-viewer:prefs',
};

// The File System Access API (Chromium browsers) keeps handles to files, so they can be re-read,
// watched and saved. Elsewhere files are opened as one-time copies and "Save" downloads instead.
const hasFsAccess = 'showOpenFilePicker' in window;
const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'], 'text/plain': ['.txt'] } }];
const MD_FILE_RE = /\.(md|markdown|mdown|mkd)$/i;

const SAMPLE = `# Markdown Viewer

Type on the left and the preview updates as you go. **Bold**, *italic*, \`code\`, and [links](https://commonmark.org) all work.

- [x] GitHub-flavored task lists
- [ ] Tables, fenced code, strikethrough

| Feature | Supported |
| ------- | --------- |
| Tables  | Yes       |

\`\`\`js
// Code blocks are syntax highlighted
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

Inline math like $e^{i\\pi} + 1 = 0$, or a block:

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

\`\`\`mermaid
flowchart LR
  Write --> Preview --> Share
\`\`\`

> Use **Open file…** or drop a \`.md\` file here to load it. **+** opens a new scratch tab.
>
> New here? Click **Help** at the top right for a full tour.
`;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.title = text;
  statusEl.classList.toggle('warn', warn);
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error(`Could not load ${src}`)); };
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}
function loadStyle(href) {
  if (!loaded.has(href)) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.append(l);
    loaded.set(href, Promise.resolve());
  }
  return loaded.get(href);
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------------------------------------
 * Rendering: Markdown -> sanitized HTML, then math and diagrams
 * ------------------------------------------------------------------------------------------- */

// $$ ... $$ blocks (starting on their own line) and $...$ inline math, rendered later by KaTeX.
// The placeholder shows the raw TeX, so the text is still readable if KaTeX can't load.
const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start(src) { return /^\$\$/m.exec(src)?.index; },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
  },
  renderer(token) {
    return `<div class="math-block" data-tex="${escapeHtml(token.text)}">${escapeHtml(`$$${token.text}$$`)}</div>\n`;
  },
};
const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    // No space just inside the dollars and no digit right after, so "$5 and $10" stays text.
    const m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
  },
  renderer(token) {
    return `<span class="math-inline" data-tex="${escapeHtml(token.text)}">${escapeHtml(`$${token.text}$`)}</span>`;
  },
};

marked.use({
  gfm: true,
  extensions: [mathBlock, mathInline],
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      if (language === 'mermaid') return `<pre class="mermaid-src">${escapeHtml(text)}</pre>\n`;
      if (language && hljs.getLanguage(language)) {
        const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        return `<pre><code class="hljs language-${escapeHtml(language)}">${html}</code></pre>\n`;
      }
      return `<pre><code class="hljs">${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

let renderGen = 0;
let lastPostProcess = Promise.resolve();

// Each top-level block is wrapped in <div data-line="N">, recording the source line it starts on.
// Scroll sync and the outline use those line numbers to line the two panes up.
function render() {
  const gen = ++renderGen;
  const tokens = marked.lexer(source.value);
  let line = 0;
  let html = '';
  for (const token of tokens) {
    if (token.type !== 'space' && token.type !== 'def') {
      const part = marked.parser(Object.assign([token], { links: tokens.links }));
      html += `<div data-line="${line}">${part}</div>`;
    }
    line += (token.raw.match(/\n/g) || []).length;
  }
  // Markdown may contain raw HTML, so sanitize before inserting it into the page.
  preview.innerHTML = DOMPurify.sanitize(html);
  for (const a of preview.querySelectorAll('a[href]')) {
    if (!a.getAttribute('href').startsWith('#')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
  updateCounts();
  buildOutline();
  invalidateScrollMap();
  if (activeScroller === source) syncFrom(source);
  lastPostProcess = postProcess(gen);
  return lastPostProcess;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

async function postProcess(gen) {
  const maths = preview.querySelectorAll('[data-tex]');
  const diagrams = preview.querySelectorAll('pre.mermaid-src');
  if (maths.length) {
    try {
      loadStyle('vendor/katex/katex.min.css');
      await loadScript('vendor/katex/katex.min.js');
      if (gen !== renderGen) return;
      for (const el of maths) {
        katex.render(el.dataset.tex, el, { displayMode: el.classList.contains('math-block'), throwOnError: false });
      }
    } catch (err) {
      setStatus(`Math could not be rendered: ${err.message}`, true);
    }
  }
  if (diagrams.length) await renderDiagrams(diagrams, gen);
  if (gen === renderGen && (maths.length || diagrams.length)) {
    invalidateScrollMap();
    buildOutline();
    if (activeScroller === source) syncFrom(source);
  }
}

// Mermaid is large, so it is only loaded when a document contains a diagram. Rendered SVGs are
// cached by theme + source, so re-rendering on every keystroke doesn't redraw unchanged diagrams.
const diagramCache = new Map();
let mermaidTheme = null;
let diagramSeq = 0;

async function renderDiagrams(pres, gen) {
  try {
    await loadScript('vendor/mermaid/mermaid.min.js');
  } catch (err) {
    setStatus(`Diagrams could not be rendered: ${err.message}`, true);
    return;
  }
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
    mermaidTheme = theme;
  }
  for (const pre of pres) {
    if (gen !== renderGen) return;
    const code = pre.textContent;
    const key = `${theme}\n${code}`;
    let result = diagramCache.get(key);
    if (!result) {
      const id = `mermaid-${++diagramSeq}`;
      try {
        result = { svg: (await mermaid.render(id, code)).svg };
      } catch (err) {
        result = { error: String((err && err.message) || err) };
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
      if (diagramCache.size > 100) diagramCache.clear();
      diagramCache.set(key, result);
    }
    const div = document.createElement('div');
    if (result.svg) {
      div.className = 'mermaid-diagram';
      div.innerHTML = result.svg;
    } else {
      div.className = 'render-error';
      div.textContent = `Diagram error: ${result.error}`;
    }
    if (pre.isConnected) pre.replaceWith(div);
  }
}

function updateCounts() {
  const words = (preview.textContent.match(/\S+/g) || []).length;
  const minutes = Math.max(1, Math.round(words / 230));
  $('counts').textContent = words ? `· ${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${minutes} min read` : '';
}

/* ---------------------------------------------------------------------------------------------
 * Outline
 * ------------------------------------------------------------------------------------------- */

let outlineLinks = [];

function buildOutline() {
  if (outline.hidden) return;
  outlineLinks = [];
  const title = document.createElement('div');
  title.className = 'outline-title';
  title.textContent = 'Outline';
  outline.replaceChildren(title);
  const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
  if (!headings.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No headings yet';
    outline.append(empty);
    return;
  }
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = h.textContent;
    a.title = h.textContent;
    a.style.paddingLeft = `${14 + (Number(h.tagName[1]) - 1) * 12}px`;
    a.addEventListener('click', (e) => { e.preventDefault(); jumpToHeading(h); });
    outline.append(a);
    outlineLinks.push({ a, h });
  }
  highlightOutline();
}

function highlightOutline() {
  if (outline.hidden || !outlineLinks.length) return;
  const y = preview.scrollTop + 24;
  let current = outlineLinks[0];
  for (const o of outlineLinks) {
    if (o.h.offsetTop <= y) current = o;
    else break;
  }
  for (const o of outlineLinks) o.a.classList.toggle('active', o === current);
}

function jumpToHeading(h) {
  activeScroller = null; // move both panes ourselves rather than letting sync fight it
  preview.scrollTop = h.offsetTop - 8;
  const line = Number(h.closest('[data-line]')?.dataset.line);
  if (!Number.isNaN(line)) {
    const entry = getScrollMap().find((m) => m.line === line);
    if (entry) source.scrollTop = entry.src - 8;
    const pos = source.value.split('\n').slice(0, line).reduce((n, l) => n + l.length + 1, 0);
    source.setSelectionRange(pos, pos);
  }
  highlightOutline();
}

$('outline-toggle').addEventListener('click', () => {
  outline.hidden = !outline.hidden;
  $('outline-toggle').setAttribute('aria-pressed', String(!outline.hidden));
  savePrefs();
  buildOutline();
  invalidateScrollMap();
});

/* ---------------------------------------------------------------------------------------------
 * Scroll sync
 * ------------------------------------------------------------------------------------------- */

// Pairs of (source y, preview y) for the start of every block, plus top and bottom anchors.
// Scrolling one pane interpolates between the surrounding pair to position the other.
let scrollMap = null;
let activeScroller = source; // the pane the user is driving; only its scroll events are synced

const mirror = document.createElement('div');
mirror.id = 'mirror';
mirror.setAttribute('aria-hidden', 'true');
document.body.append(mirror);

function invalidateScrollMap() { scrollMap = null; }

// Lay the text out in a hidden copy of the textarea (same width and font) to find the y position
// of each wanted line, accounting for soft-wrapped lines.
function measureSourceLines(lines) {
  const cs = getComputedStyle(source);
  Object.assign(mirror.style, {
    width: `${source.clientWidth}px`,
    font: cs.font,
    lineHeight: cs.lineHeight,
    padding: cs.padding,
    letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize,
    boxSizing: 'border-box',
  });
  const wanted = new Set(lines);
  const markers = new Map();
  const frag = document.createDocumentFragment();
  let buffer = '';
  source.value.split('\n').forEach((text, i) => {
    if (wanted.has(i)) {
      if (buffer) frag.append(buffer);
      buffer = '';
      const marker = document.createElement('span');
      markers.set(i, marker);
      frag.append(marker);
    }
    buffer += `${text}\n`;
  });
  if (buffer) frag.append(buffer);
  mirror.replaceChildren(frag);
  return lines.map((l) => markers.get(l)?.offsetTop ?? 0);
}

function getScrollMap() {
  if (scrollMap) return scrollMap;
  const blocks = [...preview.querySelectorAll(':scope > [data-line]')];
  const lines = blocks.map((b) => Number(b.dataset.line));
  const srcY = measureSourceLines(lines);
  const entries = [{ src: 0, prev: 0 }];
  blocks.forEach((b, i) => entries.push({ line: lines[i], src: srcY[i], prev: b.offsetTop }));
  entries.push({ src: source.scrollHeight, prev: preview.scrollHeight });
  // Keep the map monotonic so interpolation never runs backwards.
  scrollMap = entries.filter((e, i) => i === 0 || (e.src >= entries[i - 1].src && e.prev >= entries[i - 1].prev));
  return scrollMap;
}

function syncFrom(from) {
  if (!syncBox.checked || from !== activeScroller) return;
  if (split.classList.contains('left-collapsed') || split.classList.contains('right-collapsed')) return;
  const to = from === source ? preview : source;
  const [a, b] = from === source ? ['src', 'prev'] : ['prev', 'src'];
  if (from.scrollTop >= from.scrollHeight - from.clientHeight - 1) {
    to.scrollTop = to.scrollHeight;
    return;
  }
  const map = getScrollMap();
  const y = from.scrollTop;
  let i = 0;
  while (i < map.length - 1 && map[i + 1][a] <= y) i++;
  const lo = map[i];
  const hi = map[i + 1] || lo;
  const t = hi[a] > lo[a] ? (y - lo[a]) / (hi[a] - lo[a]) : 0;
  to.scrollTop = lo[b] + t * (hi[b] - lo[b]);
}

for (const el of [source, preview]) {
  for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart', 'focus']) {
    el.addEventListener(type, () => { activeScroller = el; }, { passive: true });
  }
}
source.addEventListener('scroll', () => syncFrom(source));
preview.addEventListener('scroll', () => { syncFrom(preview); highlightOutline(); });
syncBox.addEventListener('change', () => {
  savePrefs();
  if (syncBox.checked) { activeScroller = source; syncFrom(source); }
});
new ResizeObserver(invalidateScrollMap).observe(source);
new ResizeObserver(invalidateScrollMap).observe(preview);

/* ---------------------------------------------------------------------------------------------
 * Documents and tabs
 * ------------------------------------------------------------------------------------------- */

// A document is either a scratch note (kept in localStorage) or an opened file. File documents
// with a handle can be saved, reloaded and watched; ones without (non-Chromium browsers, or
// dropped files) are copies, and saving them asks for a location or downloads.
let docs = [];
let activeId = null;
let idCounter = 0;

function makeDoc({ id, kind, text = '', name = '', handle = null }) {
  return {
    id: id || `d${Date.now().toString(36)}${idCounter++}`,
    kind,
    text,
    name,
    handle,
    savedText: text,
    lastModified: 0,
    watch: false,
    diskChanged: false,
    view: { src: 0, prev: 0, sel: [0, 0] },
  };
}

const activeDoc = () => docs.find((d) => d.id === activeId);
const isDirty = (d) => d.kind === 'file' && d.text !== d.savedText;

function docTitle(d) {
  if (d.kind === 'file') return d.name;
  const first = (d.text.split('\n').find((l) => l.trim()) || '').trim();
  const title = first.replace(/^(#{1,6}\s+|[-*+>]\s+|\d+\.\s+)/, '').replace(/[*_`~[\]]/g, '').trim();
  return title.length > 40 ? `${title.slice(0, 40)}…` : title || 'Untitled';
}

function fileBase(d) {
  if (d.kind === 'file') return d.name.replace(/\.[^.]+$/, '') || 'document';
  return docTitle(d).replace(/…$/, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'untitled';
}

// Scratch notes are stored one per key, plus an ordered list of ids. Each window writes only the
// note being edited, so two windows can never overwrite each other's notes, and the 'storage'
// event keeps every open window in sync (see syncFromOtherWindow below).
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    setStatus(`Could not keep this note in the browser (${err.name}). Save it as a file to keep it safe.`, true);
    return false;
  }
}
function readNoteIds() {
  const ids = readJson(STORE.notes);
  return Array.isArray(ids) ? ids : [];
}
function saveNote(d) { storageSet(STORE.notePrefix + d.id, d.text); }
function addNote(d, afterId) {
  saveNote(d);
  const ids = readNoteIds().filter((id) => id !== d.id);
  const at = afterId ? ids.indexOf(afterId) : -1;
  ids.splice(at < 0 ? ids.length : at + 1, 0, d.id);
  storageSet(STORE.notes, JSON.stringify(ids));
}
function removeNote(id) {
  localStorage.removeItem(STORE.notePrefix + id);
  storageSet(STORE.notes, JSON.stringify(readNoteIds().filter((x) => x !== id)));
}
function rememberActive() {
  sessionStorage.setItem(STORE.active, activeId);
  if (activeDoc()?.kind === 'scratch') storageSet(STORE.lastActive, activeId);
}

// Convert notes saved by earlier versions of the viewer to one-key-per-note.
function migrateStorage() {
  if (localStorage.getItem(STORE.notes) !== null) return;
  const old = readJson(STORE.oldDocs);
  const draft = localStorage.getItem(STORE.oldDraft);
  const notes = old && Array.isArray(old.docs) ? old.docs : draft !== null ? [{ id: 'd-draft', text: draft }] : [];
  if (!notes.length) return;
  for (const n of notes) storageSet(STORE.notePrefix + n.id, n.text);
  if (storageSet(STORE.notes, JSON.stringify(notes.map((n) => n.id)))) {
    if (old?.active) storageSet(STORE.lastActive, old.active);
    localStorage.removeItem(STORE.oldDocs);
    localStorage.removeItem(STORE.oldDraft);
  }
}

function loadDocs() {
  migrateStorage();
  docs = readNoteIds()
    .map((id) => ({ id, text: localStorage.getItem(STORE.notePrefix + id) }))
    .filter((n) => n.text !== null)
    .map((n) => makeDoc({ id: n.id, kind: 'scratch', text: n.text }));
  if (!docs.length) {
    docs = [makeDoc({ kind: 'scratch', text: SAMPLE })];
    addNote(docs[0]);
  }
  const wanted = sessionStorage.getItem(STORE.active) || localStorage.getItem(STORE.lastActive);
  activeId = docs.some((d) => d.id === wanted) ? wanted : docs[0].id;
}

// Another window changed a note, or added / closed one: apply it here.
function syncFromOtherWindow(e) {
  if (e.storageArea !== localStorage) return;
  if (e.key === STORE.notes) {
    const ids = readNoteIds();
    let changed = false;
    for (const id of ids) {
      const text = localStorage.getItem(STORE.notePrefix + id);
      if (text !== null && !docs.some((d) => d.id === id)) {
        docs.push(makeDoc({ id, kind: 'scratch', text }));
        changed = true;
      }
    }
    const gone = docs.filter((d) => d.kind === 'scratch' && !ids.includes(d.id));
    if (gone.length) {
      const index = docs.findIndex((d) => d.id === activeId);
      const activeGone = gone.some((d) => d.id === activeId);
      docs = docs.filter((d) => !gone.includes(d));
      if (!docs.length) {
        docs.push(makeDoc({ kind: 'scratch' }));
        addNote(docs[0]);
      }
      if (activeGone) {
        activeId = null;
        switchTo(docs[Math.min(index, docs.length - 1)].id);
        setStatus('That note was closed in another window.');
        return;
      }
      changed = true;
    }
    if (changed) renderTabs();
  } else if (e.key && e.key.startsWith(STORE.notePrefix) && e.newValue !== null) {
    const d = docs.find((x) => x.kind === 'scratch' && x.id === e.key.slice(STORE.notePrefix.length));
    if (!d || d.text === e.newValue) return;
    d.text = e.newValue;
    if (d.id === activeId) {
      const [start, end, top] = [source.selectionStart, source.selectionEnd, source.scrollTop];
      source.value = d.text;
      source.setSelectionRange(Math.min(start, d.text.length), Math.min(end, d.text.length));
      source.scrollTop = top;
      scheduleRender();
    }
    const tab = tabList.querySelector(`[data-id="${d.id}"]`);
    if (tab) updateTab(tab, d);
  } else if (e.key === STORE.theme) {
    themePref = e.newValue || 'auto';
    applyTheme();
  }
}
window.addEventListener('storage', syncFromOtherWindow);

function renderTabs() {
  tabList.replaceChildren(...docs.map((d) => {
    const tab = document.createElement('div');
    tab.className = `tab ${d.kind}`;
    tab.dataset.id = d.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(d.id === activeId));
    const title = document.createElement('span');
    title.className = 'tab-title';
    const dirty = document.createElement('span');
    dirty.className = 'tab-dirty';
    dirty.textContent = '●';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(d.id); });
    tab.append(title, dirty, close);
    tab.addEventListener('click', () => { if (d.id !== activeId) switchTo(d.id); });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeDoc(d.id); });
    updateTab(tab, d);
    return tab;
  }));
  tabList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateTab(tab, d) {
  tab.querySelector('.tab-title').textContent = docTitle(d);
  tab.querySelector('.tab-dirty').hidden = !isDirty(d);
  tab.title = d.kind === 'scratch'
    ? 'Scratch document, kept in this browser'
    : `${d.name}${d.handle ? '' : ' (a copy: Save asks where to save)'}${isDirty(d) ? ' · unsaved changes' : ''}`;
}

function updateActiveTab() {
  const tab = tabList.querySelector(`[data-id="${activeId}"]`);
  if (tab) updateTab(tab, activeDoc());
}

function updateDocStatus(d = activeDoc()) {
  if (d.kind === 'scratch') {
    setStatus('Scratch document · kept in this browser');
  } else if (d.diskChanged && isDirty(d)) {
    setStatus(`${d.name} changed on disk. Reload to take that version (discarding your edits), or Save to overwrite it.`, true);
  } else if (isDirty(d)) {
    setStatus(`${d.name} · unsaved changes${d.handle ? ' (⌘S / Ctrl+S to save)' : ''}`);
  } else {
    setStatus(`${d.name}${d.handle ? '' : ' · a copy: edits are saved only with Save as / download'}`);
  }
}

function updateFileTools() {
  const d = activeDoc();
  $('file-tools').hidden = !(d.kind === 'file' && d.handle);
  watchBox.checked = d.watch;
}

function switchTo(id) {
  const current = activeDoc();
  if (current) current.view = { src: source.scrollTop, prev: preview.scrollTop, sel: [source.selectionStart, source.selectionEnd] };
  activeId = id;
  const d = activeDoc();
  source.value = d.text;
  activeScroller = null;
  render();
  source.setSelectionRange(...d.view.sel);
  source.scrollTop = d.view.src;
  preview.scrollTop = d.view.prev;
  renderTabs();
  updateFileTools();
  updateDocStatus(d);
  highlightFileTree();
  rememberActive();
}

// New documents go after the current tab; an untouched empty scratch tab is replaced instead.
function addDoc(d) {
  const current = activeDoc();
  const index = docs.indexOf(current);
  if (current && current.kind === 'scratch' && !current.text.trim()) {
    docs.splice(index, 1, d);
    removeNote(current.id);
    activeId = null;
  } else {
    docs.splice(index + 1, 0, d);
  }
  switchTo(d.id);
}

function newScratch(text = '') {
  const d = makeDoc({ kind: 'scratch', text });
  const index = docs.indexOf(activeDoc());
  docs.splice(index + 1, 0, d);
  addNote(d, activeId);
  switchTo(d.id);
  source.focus();
  return d;
}

function closeDoc(id) {
  const d = docs.find((x) => x.id === id);
  if (!d) return;
  if (isDirty(d) && !confirm(`"${d.name}" has unsaved changes. Close it and discard them?`)) return;
  if (d.kind === 'scratch' && d.text.trim() && !confirm(`Delete the scratch document "${docTitle(d)}"? This can't be undone.`)) return;
  const index = docs.indexOf(d);
  docs.splice(index, 1);
  if (d.kind === 'scratch') removeNote(d.id);
  if (!docs.length) {
    docs.push(makeDoc({ kind: 'scratch' }));
    addNote(docs[0]);
  }
  if (id === activeId) {
    activeId = null;
    switchTo(docs[Math.min(index, docs.length - 1)].id);
  } else {
    renderTabs();
  }
}

$('new-tab').addEventListener('click', () => newScratch());

source.addEventListener('input', () => {
  const d = activeDoc();
  const wasDirty = isDirty(d);
  d.text = source.value;
  if (d.kind === 'scratch') saveNote(d);
  updateActiveTab();
  if (isDirty(d) !== wasDirty) updateDocStatus(d);
  scheduleRender();
});

// Let Tab insert indentation instead of moving focus.
source.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  document.execCommand('insertText', false, '    ');
});

window.addEventListener('beforeunload', (e) => {
  if (docs.some(isDirty)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ---------------------------------------------------------------------------------------------
 * Opening, saving, reloading and watching files
 * ------------------------------------------------------------------------------------------- */

async function sameEntry(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.isSameEntry ? a.isSameEntry(b) : false;
}

async function openHandle(handle) {
  for (const d of docs) {
    if (await sameEntry(d.handle, handle)) {
      switchTo(d.id);
      if (!isDirty(d)) await reloadDoc(d, { force: true });
      return d;
    }
  }
  const file = await handle.getFile();
  const d = makeDoc({ kind: 'file', name: file.name, handle, text: await file.text() });
  d.lastModified = file.lastModified;
  addDoc(d);
  return d;
}

async function openCopy(file) {
  const d = makeDoc({ kind: 'file', name: file.name, text: await file.text() });
  addDoc(d);
  return d;
}

async function openFromPicker() {
  if (!hasFsAccess) { fileInput.click(); return; }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ types: MD_TYPES, multiple: true });
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not open file: ${err.message}`, true);
    return;
  }
  for (const h of handles) await openHandle(h).catch((err) => setStatus(`Could not open ${h.name}: ${err.message}`, true));
}

$('open').addEventListener('click', openFromPicker);
fileInput.addEventListener('change', async () => {
  for (const f of fileInput.files) await openCopy(f);
  fileInput.value = '';
});

async function reloadDoc(d = activeDoc(), { force = false } = {}) {
  if (!d.handle) return;
  if (isDirty(d) && !force && !confirm(`Discard your unsaved changes to "${d.name}" and reload it from disk?`)) return;
  try {
    const file = await d.handle.getFile();
    const text = await file.text();
    Object.assign(d, { text, savedText: text, lastModified: file.lastModified, diskChanged: false });
    if (d.id === activeId) {
      // Keep the reader's place when a watched file changes underneath them.
      const sel = [source.selectionStart, source.selectionEnd];
      const scroll = [source.scrollTop, preview.scrollTop];
      source.value = text;
      render();
      source.setSelectionRange(...sel);
      [source.scrollTop, preview.scrollTop] = scroll;
      updateActiveTab();
      setStatus(`${d.name} · loaded ${new Date().toLocaleTimeString()}`);
    } else {
      renderTabs();
    }
  } catch (err) {
    setStatus(`Could not reload ${d.name}: ${err.message}`, true);
  }
}

$('reload').addEventListener('click', () => reloadDoc());

// One timer checks every watched file. A change on disk reloads the document, unless it has
// unsaved edits: then the user is warned instead of losing them.
let watchTimer = null;
function updateWatchTimer() {
  const any = docs.some((d) => d.watch && d.handle);
  if (any && !watchTimer) watchTimer = setInterval(checkWatched, 1000);
  if (!any && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

async function checkWatched() {
  for (const d of docs) {
    if (!d.watch || !d.handle) continue;
    try {
      const file = await d.handle.getFile();
      if (file.lastModified === d.lastModified) continue;
      if (!isDirty(d)) {
        await reloadDoc(d, { force: true });
      } else if (!d.diskChanged) {
        d.diskChanged = true;
        if (d.id === activeId) updateDocStatus(d);
      }
    } catch (err) {
      d.watch = false;
      if (d.id === activeId) watchBox.checked = false;
      setStatus(`Stopped watching ${d.name}: ${err.message}`, true);
    }
  }
  updateWatchTimer();
}

watchBox.addEventListener('change', () => {
  const d = activeDoc();
  d.watch = watchBox.checked;
  updateWatchTimer();
  if (d.watch) checkWatched();
});

async function writeDoc(d, handle) {
  const text = d.text;
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    const file = await handle.getFile();
    const wasScratch = d.kind === 'scratch';
    Object.assign(d, { kind: 'file', handle, name: file.name, savedText: text, lastModified: file.lastModified, diskChanged: false });
    if (wasScratch) removeNote(d.id); // it is a file now, so drop it from the scratch notes
    renderTabs();
    updateFileTools();
    highlightFileTree();
    setStatus(`Saved ${file.name} at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not save: ${err.message}`, true);
  }
}

async function saveDoc(d = activeDoc()) {
  if (d.kind === 'file' && d.handle) return writeDoc(d, d.handle);
  return saveDocAs(d);
}

async function saveDocAs(d = activeDoc()) {
  const name = d.kind === 'file' ? d.name : `${fileBase(d)}.md`;
  if (!('showSaveFilePicker' in window)) {
    downloadText(name, d.text, 'text/markdown');
    if (d.kind === 'file') { d.savedText = d.text; updateActiveTab(); }
    setStatus(`Downloaded ${name}. To save straight to a file, use Chrome or Edge.`);
    return;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: name, types: MD_TYPES });
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not save: ${err.message}`, true);
    return;
  }
  await writeDoc(d, handle);
}

$('save').addEventListener('click', () => saveDoc());
$('save-as').addEventListener('click', () => saveDocAs());

/* ---------------------------------------------------------------------------------------------
 * Folder sidebar (Chromium only)
 * ------------------------------------------------------------------------------------------- */

let folderHandle = null;
const MAX_FOLDER_FILES = 2000;
$('open-folder').hidden = !('showDirectoryPicker' in window);

async function walkFolder(dir, depth, count) {
  const node = { name: dir.name, dirs: [], files: [] };
  if (depth > 8) return node;
  for await (const [name, handle] of dir.entries()) {
    if (count.n >= MAX_FOLDER_FILES) break;
    if (handle.kind === 'directory') {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const sub = await walkFolder(handle, depth + 1, count);
      if (sub.dirs.length || sub.files.length) node.dirs.push(sub);
    } else if (MD_FILE_RE.test(name)) {
      count.n++;
      node.files.push({ name, handle });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  node.dirs.sort(byName);
  node.files.sort(byName);
  return node;
}

function buildTree(node) {
  const ul = document.createElement('ul');
  for (const sub of node.dirs) {
    const li = document.createElement('li');
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = sub.name;
    details.append(summary, buildTree(sub));
    li.append(details);
    ul.append(li);
  }
  for (const f of node.files) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = f.name;
    button.title = f.name;
    button.fileHandle = f.handle;
    button.addEventListener('click', () => openHandle(f.handle).catch((err) => setStatus(`Could not open ${f.name}: ${err.message}`, true)));
    li.append(button);
    ul.append(li);
  }
  return ul;
}

async function scanFolder() {
  const tree = $('file-tree');
  $('files').hidden = false;
  $('folder-name').textContent = folderHandle.name;
  $('folder-name').title = folderHandle.name;
  tree.innerHTML = '<div class="empty">Scanning…</div>';
  const count = { n: 0 };
  try {
    const root = await walkFolder(folderHandle, 0, count);
    if (root.dirs.length || root.files.length) {
      tree.replaceChildren(buildTree(root));
    } else {
      tree.innerHTML = '<div class="empty">No Markdown files in this folder</div>';
    }
    if (count.n >= MAX_FOLDER_FILES) setStatus(`Showing the first ${MAX_FOLDER_FILES} Markdown files in ${folderHandle.name}`, true);
    highlightFileTree();
  } catch (err) {
    tree.innerHTML = '';
    setStatus(`Could not read the folder: ${err.message}`, true);
  }
}

async function highlightFileTree() {
  if (!folderHandle) return;
  const d = activeDoc();
  for (const button of $('file-tree').querySelectorAll('button')) {
    button.classList.toggle('active', await sameEntry(d.handle, button.fileHandle));
  }
}

$('open-folder').addEventListener('click', async () => {
  try {
    folderHandle = await window.showDirectoryPicker();
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(`Could not open folder: ${err.message}`, true);
    return;
  }
  await scanFolder();
});
$('refresh-folder').addEventListener('click', () => { if (folderHandle) scanFolder(); });
$('close-folder').addEventListener('click', () => {
  folderHandle = null;
  $('files').hidden = true;
  $('file-tree').replaceChildren();
});

/* ---------------------------------------------------------------------------------------------
 * Copy / paste / clear
 * ------------------------------------------------------------------------------------------- */

// The button label briefly confirms the result.
function flash(button, text) {
  clearTimeout(button.flashTimer);
  button.dataset.label ??= button.textContent;
  button.textContent = text;
  button.flashTimer = setTimeout(() => { button.textContent = button.dataset.label; }, 1500);
}

$('copy-source').addEventListener('click', async (e) => {
  const button = e.currentTarget; // currentTarget is cleared once the handler awaits
  try {
    await navigator.clipboard.writeText(source.value);
    flash(button, 'Copied');
  } catch (err) {
    flash(button, 'Failed');
    setStatus(`Could not copy: ${err.message}`, true);
  }
});

$('paste-source').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  try {
    const text = await navigator.clipboard.readText();
    source.focus();
    // insertText keeps the browser's undo history and fires 'input', which re-renders.
    document.execCommand('insertText', false, text);
    flash(button, 'Pasted');
  } catch {
    flash(button, 'Blocked');
    setStatus('The browser blocked clipboard access. Click in the left pane and press ⌘V / Ctrl+V instead.', true);
  }
});

// Copy the preview as rich text (HTML) so formatting survives a paste into email or a document,
// with a plain-text version for apps that only accept text.
$('copy-preview').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([preview.innerHTML], { type: 'text/html' }),
      'text/plain': new Blob([preview.innerText], { type: 'text/plain' }),
    })]);
    flash(button, 'Copied');
  } catch (err) {
    flash(button, 'Failed');
    setStatus(`Could not copy: ${err.message}`, true);
  }
});

// On a scratch document Clear empties it (undoable). On a file it never touches the file: it
// switches to an empty scratch tab, ready for free-form text.
$('clear-source').addEventListener('click', () => {
  if (activeDoc().kind === 'file') {
    const empty = docs.find((d) => d.kind === 'scratch' && !d.text);
    if (empty) switchTo(empty.id);
    else newScratch();
    source.focus();
    setStatus('New scratch document: type or paste Markdown.');
    return;
  }
  source.focus();
  source.select();
  document.execCommand('delete');
  setStatus('Cleared. ⌘Z / Ctrl+Z to undo.');
});

/* ---------------------------------------------------------------------------------------------
 * Formatting toolbar and shortcuts
 * ------------------------------------------------------------------------------------------- */

// All edits go through execCommand('insertText') so they land in the browser's undo history.
function replaceRange(start, end, text, selStart, selEnd) {
  source.focus();
  source.setSelectionRange(start, end);
  if (text) document.execCommand('insertText', false, text);
  else if (start !== end) document.execCommand('delete');
  source.setSelectionRange(selStart, selEnd);
}

function toggleWrap(before, after, placeholder) {
  const { selectionStart: s, selectionEnd: e, value: v } = source;
  const sel = v.slice(s, e);
  if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    replaceRange(s - before.length, e + after.length, sel, s - before.length, e - before.length);
  } else if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    replaceRange(s, e, inner, s, s + inner.length);
  } else {
    const inner = sel || placeholder;
    replaceRange(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
  }
}

function selectedLines() {
  const { selectionStart: s, selectionEnd: e, value: v } = source;
  const start = v.lastIndexOf('\n', s - 1) + 1;
  const endFrom = e > s && v[e - 1] === '\n' ? e - 1 : e;
  let end = v.indexOf('\n', endFrom);
  if (end < 0) end = v.length;
  return { start, end, lines: v.slice(start, end).split('\n'), collapsed: s === e };
}

function transformLines(fn) {
  const { start, end, lines, collapsed } = selectedLines();
  const out = fn(lines).join('\n');
  if (collapsed && lines.length === 1) replaceRange(start, end, out, start + out.length, start + out.length);
  else replaceRange(start, end, out, start, start + out.length);
}

const LIST_MARKER = /^(\s*)(?:[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s)/;
function toggleLinePrefix(test, add) {
  transformLines((lines) => {
    const content = lines.filter((l) => l.trim());
    const all = content.length > 0 && content.every((l) => test.test(l));
    let n = 0;
    return lines.map((l) => {
      if (all) return l.replace(test, '$1');
      if (!l.trim() && lines.length > 1) return l;
      return add(l, ++n);
    });
  });
}

// Insert a block (table, rule) on its own line with a blank line before it: on the current line if
// it is empty, otherwise after it.
function insertBlock(text, selectFrom, selectLength) {
  const { end } = selectedLines();
  const v = source.value;
  const lineStart = v.lastIndexOf('\n', end - 1) + 1;
  let at = end;
  let before = '\n\n';
  if (!v.slice(lineStart, end).trim()) {
    at = lineStart;
    before = at <= 1 || v[at - 2] === '\n' ? '' : '\n';
  }
  const start = at + before.length + selectFrom;
  replaceRange(at, end, `${before}${text}\n`, start, start + selectLength);
}

const FORMATS = {
  bold: () => toggleWrap('**', '**', 'bold text'),
  italic: () => toggleWrap('_', '_', 'italic text'),
  strike: () => toggleWrap('~~', '~~', 'struck text'),
  code: () => toggleWrap('`', '`', 'code'),
  link: () => {
    const { selectionStart: s, selectionEnd: e, value: v } = source;
    const sel = v.slice(s, e);
    if (/^https?:\/\/\S+$/.test(sel)) {
      replaceRange(s, e, `[link text](${sel})`, s + 1, s + 10);
    } else {
      const label = sel || 'link text';
      const text = `[${label}](https://)`;
      if (sel) replaceRange(s, e, text, s + label.length + 3, s + text.length - 1);
      else replaceRange(s, e, text, s + 1, s + 1 + label.length);
    }
  },
  heading: () => transformLines((lines) => {
    const level = (lines[0].match(/^(#{1,6})\s/) || ['', ''])[1].length;
    const next = level >= 3 ? 0 : level + 1;
    return lines.map((l) => (next ? '#'.repeat(next) + ' ' : '') + l.replace(/^#{1,6}\s+/, ''));
  }),
  ul: () => toggleLinePrefix(/^(\s*)[-*+]\s(?!\[[ xX]\]\s)/, (l) => l.replace(LIST_MARKER, '$1').replace(/^(\s*)/, '$1- ')),
  ol: () => toggleLinePrefix(/^(\s*)\d+\.\s/, (l, n) => l.replace(LIST_MARKER, '$1').replace(/^(\s*)/, `$1${n}. `)),
  task: () => toggleLinePrefix(/^(\s*)[-*+]\s\[[ xX]\]\s/, (l) => l.replace(LIST_MARKER, '$1').replace(/^(\s*)/, '$1- [ ] ')),
  quote: () => toggleLinePrefix(/^()>\s?/, (l) => `> ${l}`),
  codeblock: () => {
    const { start, end, lines, collapsed } = selectedLines();
    const body = lines.join('\n');
    if (collapsed && !body.trim()) {
      replaceRange(start, end, '```\n\n```', start + 4, start + 4);
    } else {
      const out = `\`\`\`\n${body}\n\`\`\``;
      replaceRange(start, end, out, start + 4, start + 4 + body.length);
    }
  },
  table: () => insertBlock('| Column 1 | Column 2 |\n| -------- | -------- |\n| Cell     | Cell     |', 2, 8),
  hr: () => insertBlock('---', 3, 0),
};

for (const button of document.querySelectorAll('#format-bar [data-fmt]')) {
  button.addEventListener('mousedown', (e) => e.preventDefault()); // keep the textarea selection
  button.addEventListener('click', () => FORMATS[button.dataset.fmt]());
}

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 's') { e.preventDefault(); if (e.shiftKey) saveDocAs(); else saveDoc(); return; }
  if (key === 'o' && !e.shiftKey) { e.preventDefault(); openFromPicker(); return; }
  if (document.activeElement !== source) return;
  const action = e.shiftKey ? { x: 'strike', h: 'heading' }[key] : { b: 'bold', i: 'italic', k: 'link', e: 'code' }[key];
  if (action) { e.preventDefault(); FORMATS[action](); }
});

/* ---------------------------------------------------------------------------------------------
 * Resizable split and collapsible panes (remembered between visits)
 * ------------------------------------------------------------------------------------------- */

const MIN_PANE_PX = 160;
const divider = $('divider');
const panes = {
  left: { el: $('left-pane'), toggle: $('toggle-left'), name: 'Markdown', collapseIcon: '«', expandIcon: '»' },
  right: { el: $('right-pane'), toggle: $('toggle-right'), name: 'Preview', collapseIcon: '»', expandIcon: '«' },
};
const layout = { split: 50, collapsed: null, ...readJson(STORE.layout) };

function applyLayout() {
  split.style.setProperty('--split', `${layout.split}%`);
  split.classList.toggle('left-collapsed', layout.collapsed === 'left');
  split.classList.toggle('right-collapsed', layout.collapsed === 'right');
  for (const [side, p] of Object.entries(panes)) {
    const collapsed = layout.collapsed === side;
    p.el.classList.toggle('collapsed', collapsed);
    p.toggle.textContent = collapsed ? p.expandIcon : p.collapseIcon;
    p.toggle.title = `${collapsed ? 'Expand' : 'Collapse'} the ${p.name} pane`;
    p.toggle.setAttribute('aria-expanded', String(!collapsed));
  }
  divider.setAttribute('aria-valuenow', String(Math.round(layout.split)));
  localStorage.setItem(STORE.layout, JSON.stringify(layout));
  invalidateScrollMap();
}

// Collapsing one pane while the other is collapsed swaps them, so one pane is always visible.
function toggleSide(side) {
  layout.collapsed = layout.collapsed === side ? null : side;
  applyLayout();
}
for (const [side, p] of Object.entries(panes)) {
  p.toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSide(side); });
  // When collapsed, the whole strip is a click target to expand.
  p.el.querySelector('.pane-bar').addEventListener('click', () => {
    if (layout.collapsed === side) toggleSide(side);
  });
}

function setSplitFromX(clientX) {
  const rect = split.getBoundingClientRect();
  const min = Math.min(MIN_PANE_PX, rect.width / 2);
  const x = Math.max(min, Math.min(rect.width - min, clientX - rect.left));
  layout.split = (x / rect.width) * 100;
  applyLayout();
}

divider.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  split.classList.add('resizing');
});
divider.addEventListener('pointermove', (e) => {
  if (divider.hasPointerCapture(e.pointerId)) setSplitFromX(e.clientX);
});
const endResize = (e) => {
  if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId);
  split.classList.remove('resizing');
};
divider.addEventListener('pointerup', endResize);
divider.addEventListener('pointercancel', endResize);
divider.addEventListener('dblclick', () => { layout.split = 50; applyLayout(); });
divider.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') layout.split = Math.max(10, layout.split - step);
  else if (e.key === 'ArrowRight') layout.split = Math.min(90, layout.split + step);
  else return;
  e.preventDefault();
  applyLayout();
});

/* ---------------------------------------------------------------------------------------------
 * Theme
 * ------------------------------------------------------------------------------------------- */

const THEME_LABELS = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let themePref = localStorage.getItem(STORE.theme) || 'auto';

function applyTheme() {
  const dark = themePref === 'dark' || (themePref === 'auto' && darkQuery.matches);
  const theme = dark ? 'dark' : 'light';
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = THEME_LABELS[themePref];
  $('theme').title = `Theme: ${themePref}. Click to switch between auto (follow the system), light and dark.`;
  if (changed && preview.querySelector('.mermaid-diagram, pre.mermaid-src')) render(); // diagrams are drawn per theme
}

// Help opens in one named tab that is reused, so the viewer itself is never opened twice.
$('help').addEventListener('click', (e) => {
  e.preventDefault();
  window.open('help.html', 'markdown-viewer-help');
});

$('theme').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  themePref = order[(order.indexOf(themePref) + 1) % order.length];
  localStorage.setItem(STORE.theme, themePref);
  applyTheme();
});
darkQuery.addEventListener('change', applyTheme);

/* ---------------------------------------------------------------------------------------------
 * Export: standalone HTML, print / PDF, Markdown download
 * ------------------------------------------------------------------------------------------- */

function exportHtml() {
  const d = activeDoc();
  const katexCss = preview.querySelector('.katex') && window.katex
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/katex.min.css">\n`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${document.documentElement.dataset.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle(d))}</title>
${katexCss}<style>${$('doc-style').textContent}
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .markdown { max-width: 860px; margin: 0 auto; padding: 32px 24px; }
</style>
</head>
<body>
<article class="markdown">
${preview.innerHTML}
</article>
</body>
</html>
`;
  downloadText(`${fileBase(d)}.html`, html, 'text/html');
  setStatus(`Downloaded ${fileBase(d)}.html`);
}

// Print in the light theme. The Print button re-draws diagrams in light colours first; for the
// browser's own ⌘P only the CSS colours can be switched (synchronously, in 'beforeprint').
let themeBeforePrint = null;
window.addEventListener('beforeprint', () => {
  if (document.documentElement.dataset.theme === 'dark') {
    themeBeforePrint = 'dark';
    document.documentElement.dataset.theme = 'light';
  }
});
window.addEventListener('afterprint', () => {
  if (themeBeforePrint) {
    document.documentElement.dataset.theme = themeBeforePrint;
    themeBeforePrint = null;
  }
});

async function printDoc() {
  const savedPref = themePref;
  if (document.documentElement.dataset.theme === 'dark') {
    themePref = 'light';
    applyTheme();
    await lastPostProcess;
  }
  window.print();
  if (themePref !== savedPref) {
    themePref = savedPref;
    applyTheme();
  }
}

$('export-html').addEventListener('click', () => { exportMenu.open = false; exportHtml(); });
$('print').addEventListener('click', () => { exportMenu.open = false; printDoc(); });
$('download-md').addEventListener('click', () => {
  exportMenu.open = false;
  const d = activeDoc();
  const name = d.kind === 'file' ? d.name : `${fileBase(d)}.md`;
  downloadText(name, d.text, 'text/markdown');
  setStatus(`Downloaded ${name}`);
});
document.addEventListener('click', (e) => {
  if (exportMenu.open && !exportMenu.contains(e.target)) exportMenu.open = false;
});

/* ---------------------------------------------------------------------------------------------
 * Drag and drop files (or, in Chromium, a folder)
 * ------------------------------------------------------------------------------------------- */

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

main.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return; // let dragged text drop into the textarea normally
  e.preventDefault();
  main.classList.add('dragging');
});
main.addEventListener('dragleave', (e) => {
  if (!main.contains(e.relatedTarget)) main.classList.remove('dragging');
});
main.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  main.classList.remove('dragging');
  // DataTransfer items are only readable during the event, so request every handle up front.
  const files = [...e.dataTransfer.files];
  const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
  const handles = await Promise.all(items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null)));
  for (let i = 0; i < Math.max(files.length, handles.length); i++) {
    const h = handles[i];
    try {
      if (h && h.kind === 'file') await openHandle(h);
      else if (h && h.kind === 'directory') { folderHandle = h; await scanFolder(); }
      else if (files[i]) await openCopy(files[i]);
    } catch (err) {
      setStatus(`Could not open ${files[i]?.name || 'file'}: ${err.message}`, true);
    }
  }
});

/* ---------------------------------------------------------------------------------------------
 * Start up
 * ------------------------------------------------------------------------------------------- */

function savePrefs() {
  localStorage.setItem(STORE.prefs, JSON.stringify({ sync: syncBox.checked, outline: !outline.hidden }));
}

const prefs = { sync: true, outline: false, ...readJson(STORE.prefs) };
syncBox.checked = prefs.sync;
outline.hidden = !prefs.outline;
$('outline-toggle').setAttribute('aria-pressed', String(prefs.outline));

applyTheme();
applyLayout();
loadDocs();
switchTo(activeId);
activeScroller = source;
