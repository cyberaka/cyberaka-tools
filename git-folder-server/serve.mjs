#!/usr/bin/env node
// Serves a folder from a GitHub repo as a website, pulling the latest commit whenever a page is
// loaded, so refreshing the browser always shows what is on the branch now.
// No dependencies; needs Node 18+ and git 2.27+.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';

const USAGE = `Usage: node serve.mjs <github location> [options]

<github location> is one of:
  https://github.com/OWNER/REPO/tree/BRANCH/path/to/folder   (copy it from the browser)
  https://github.com/OWNER/REPO                              (whole repo, default branch)
  git@github.com:OWNER/REPO.git
  OWNER/REPO

Options:
  --branch NAME    branch or tag to serve (default: the location's, else the repo default)
  --folder PATH    folder inside the repo to serve (default: the location's, else the repo root)
  --port N         port to listen on (default 8080; 0 picks a free one)
  --host ADDR      address to listen on (default 127.0.0.1, this computer only;
                   0.0.0.0 lets other devices on your network open the pages)
  --cache DIR      where to keep the checkout (default: a folder under your temp directory)
  --check-every S  while a page is open, check GitHub for new commits every S seconds (default 30)
  --no-notify      don't add the "newer version available" notice to pages

Private repos: uses GITHUB_TOKEN or GH_TOKEN, else your GitHub CLI login (gh auth login),
else whatever git credentials or SSH keys you already use for github.com.`;

// ---- Arguments ----

function parseArgs(argv) {
  const opts = { port: 8080, host: '127.0.0.1', checkEvery: 30, notify: true };
  const rest = [];
  const value = (i, name) => {
    if (argv[i] === undefined) fail(`${name} needs a value.`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--branch' || arg === '-b') opts.branch = value(++i, arg);
    else if (arg === '--folder' || arg === '-f') opts.folder = value(++i, arg);
    else if (arg === '--port' || arg === '-p') opts.port = Number(value(++i, arg));
    else if (arg === '--host') opts.host = value(++i, arg);
    else if (arg === '--cache') opts.cache = value(++i, arg);
    else if (arg === '--check-every') opts.checkEvery = Number(value(++i, arg));
    else if (arg === '--no-notify') opts.notify = false;
    else if (arg.startsWith('-')) fail(`Unknown option ${arg}.`);
    else rest.push(arg);
  }
  opts.location = rest[0];
  return opts;
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

// Turns a GitHub location into { url, owner, repo, branch, folder }.
function parseLocation(location) {
  const loc = location.trim().replace(/\/+$/, '');
  let m = /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/.exec(loc);
  if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], repo: m[2], branch: m[3], folder: m[4] };
  m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(loc);
  if (m) return { url: `git@github.com:${m[1]}/${m[2]}.git`, owner: m[1], repo: m[2] };
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(loc);
  if (m) return { url: `https://github.com/${m[1]}/${m[2]}.git`, owner: m[1], repo: m[2] };
  return null;
}

// ---- Git ----

function findToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN.trim(), from: 'GITHUB_TOKEN' };
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN.trim(), from: 'GH_TOKEN' };
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (token) return { token, from: 'your GitHub CLI login' };
  } catch { /* gh not installed or not logged in */ }
  return { token: null, from: null };
}

// The token reaches git through environment config, so it never appears in a command line,
// a URL, the checkout's .git/config, or the logs. It is only used for https://github.com/.
function gitEnv(token, httpsUrl) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (token && httpsUrl) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

let env;
const scrub = (text, token) => (token ? String(text).split(token).join('***') : String(text));

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

function explainGitError(message, httpsUrl, tokenFrom) {
  if (/Remote branch .* not found|couldn't find remote ref/i.test(message)) return `The branch ${branch} does not exist on GitHub.`;
  if (/Authentication failed|could not read Username|terminal prompts disabled|Repository not found|not found/i.test(message)) {
    return httpsUrl && !tokenFrom
      ? 'GitHub did not find the repo. For a private repo, set GITHUB_TOKEN or run gh auth login.'
      : 'GitHub did not find the repo, or your credentials cannot read it. Check the owner and repo name.';
  }
  if (/Permission denied \(publickey\)/.test(message)) return 'Your SSH key was refused. Use the https:// location, or add your key to GitHub.';
  if (/Could not resolve host|unable to access|Could not read from remote repository/i.test(message)) {
    return 'Could not reach the repo on GitHub. Check your network connection and access.';
  }
  return '';
}

const firstFatal = (message) => (/^fatal: (.*)$/m.exec(message) || [, message.split('\n')[0]])[1];

// ---- Static files ----

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0' };

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function messagePage(title, lines) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1f2328}
h1{font-size:20px}a{color:#0969da}code{background:#f6f8fa;padding:2px 6px;border-radius:4px}ul{padding-left:20px}li{margin:2px 0}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}a{color:#4493f8}code{background:#161b22}}</style></head>
<body><h1>${escapeHtml(title)}</h1>${lines.join('\n')}</body></html>`;
}

// A small banner added to HTML pages when the latest pull failed, so stale content is not mistaken for new.
function staleBanner(error, commit) {
  return `<div style="position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:8px 14px;background:#fff8c5;color:#4d2d00;border-bottom:1px solid #d4a72c;font:13px/1.4 -apple-system,system-ui,sans-serif">`
    + `<b>git-folder-server:</b> could not pull the latest changes, so this is commit ${escapeHtml(commit)}. ${escapeHtml(error)} Refresh to try again.</div>`;
}

// Added to HTML pages: checks every so often whether GitHub has a newer commit than the one this page
// came from, and if so shows a card with a Refresh button and marks the tab title with ↻. It lives in a
// shadow root so the page's CSS can't affect it, and it checks again when you come back to the tab.
function updateNotice(pageCommit, everyMs) {
  const config = JSON.stringify({ commit: pageCommit, every: everyMs, url: STATUS_PATH }).replace(/</g, '\\u003c');
  return `<script>(function () {
  var cfg = ${config};
  var host = null, shown = null, dismissed = null, MARK = '\u21bb ';
  function show(latest) {
    if (latest === dismissed || latest === shown) return;
    if (!host) {
      host = document.createElement('git-folder-server-notice');
      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{all:initial}.card{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:12px 12px 12px 16px;border-radius:10px;background:#1f2328;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;animation:in .25s ease-out}'
        + '@keyframes in{from{transform:translateY(12px);opacity:0}}.dot{width:10px;height:10px;flex:none;border-radius:50%;background:#3fb950;box-shadow:0 0 0 4px rgba(63,185,80,.25)}'
        + '.sub{display:block;color:#b7bdc8;font-size:12px}button{font:inherit;cursor:pointer;border-radius:6px}.go{padding:6px 14px;border:0;background:#fff;color:#1f2328;font-weight:600}.x{padding:2px 8px;border:0;background:none;color:#b7bdc8;font-size:18px;line-height:1}.x:hover{color:#fff}</style>'
        + '<div class="card" role="status"><span class="dot"></span><span><b>A newer version is on GitHub</b><span class="sub"></span></span>'
        + '<button class="go">Refresh</button><button class="x" title="Dismiss until the next change" aria-label="Dismiss">\u00d7</button></div>';
      root.querySelector('.go').onclick = function () { location.reload(); };
      root.querySelector('.x').onclick = function () { dismissed = shown; shown = null; hide(); };
      document.documentElement.appendChild(host);
    }
    host.shadowRoot.querySelector('.sub').textContent = 'Commit ' + latest.slice(0, 7) + ' was pushed after this page loaded.';
    host.style.display = '';
    shown = latest;
    if (document.title.indexOf(MARK) !== 0) document.title = MARK + document.title;
  }
  function hide() {
    if (host) host.style.display = 'none';
    if (document.title.indexOf(MARK) === 0) document.title = document.title.slice(MARK.length);
  }
  function check() {
    fetch(cfg.url, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      if (s.latest && s.latest !== cfg.commit) show(s.latest);
    }).catch(function () { /* server stopped or offline: try again later */ });
  }
  setInterval(function () { if (!document.hidden) check(); }, cfg.every);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
})();</script>`;
}

function addToPage(html, extra) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${extra}</body>`) : html + extra;
}

// ---- Main ----

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opts.location) fail('Give a GitHub location.');
if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) fail('--port must be a number from 0 to 65535.');
if (!(opts.checkEvery >= 5)) fail('--check-every must be at least 5 seconds.');

const loc = parseLocation(opts.location);
if (!loc) fail(`Not a GitHub location: ${opts.location}`);
const branch = opts.branch || loc.branch || null;
const folder = (opts.folder ?? loc.folder ?? '').replace(/^\/+|\/+$/g, '');
const httpsUrl = loc.url.startsWith('https://');
const { token, from: tokenFrom } = httpsUrl ? findToken() : { token: null, from: null };
env = gitEnv(token, httpsUrl);

const cacheKey = crypto.createHash('sha256').update(`${loc.url}#${branch || ''}#${folder}`).digest('hex').slice(0, 10);
const checkout = path.resolve(opts.cache || path.join(os.tmpdir(), 'git-folder-server', `${loc.owner}-${loc.repo}-${cacheKey}`));
const root = path.join(checkout, folder);
const describe = `${loc.owner}/${loc.repo}${branch ? `@${branch}` : ' (default branch)'}${folder ? ` folder ${folder}/` : ''}`;

async function cloneFresh() {
  fs.rmSync(checkout, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  // A shallow, blobless clone that checks out only the served folder keeps big repos quick.
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout'];
  if (branch) args.push('--branch', branch);
  await git([...args, loc.url, checkout]);
  if (folder) {
    await git(['sparse-checkout', 'set', '--cone', folder], checkout);
  }
  await git(['checkout'], checkout);
}

async function prepare() {
  const reuse = fs.existsSync(path.join(checkout, '.git'))
    && await git(['remote', 'get-url', 'origin'], checkout).then((u) => u === loc.url, () => false);
  if (reuse) await pull();
  else await cloneFresh();
}

let commit = '';
let commitFull = '';
let pulling = null;
let pullError = '';

// Fetches the branch tip and moves the checkout to it. Calls made while a pull is running share it.
function pull() {
  if (pulling) return pulling;
  pulling = (async () => {
    try {
      await git(['fetch', '--depth', '1', 'origin', branch || 'HEAD'], checkout);
      await git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], checkout);
      await git(['clean', '-fdq'], checkout);
      pullError = '';
    } catch (e) {
      pullError = scrub(explainGitError(e.message, httpsUrl, tokenFrom) || firstFatal(e.message), token);
      console.error(`${new Date().toISOString()} pull failed: ${scrub(e.message, token)}`);
    } finally {
      const now = await git(['rev-parse', 'HEAD'], checkout).catch(() => commitFull);
      if (commitFull && now !== commitFull) console.log(`${new Date().toISOString()} updated ${commit} -> ${now.slice(0, 7)}`);
      commitFull = now;
      commit = now.slice(0, 7);
      pulling = null;
    }
  })();
  return pulling;
}

// ---- Checking GitHub for newer commits ----

const STATUS_PATH = '/.git-folder-server/status';
let remote = { latest: null, checkedAt: 0, error: '' };
let remoteCheck = null;
let announced = '';

// Asks GitHub for the branch's newest commit with ls-remote, which downloads nothing. Results are
// reused for half the check interval, so any number of open tabs cost one request per interval.
function latestRemote() {
  if (Date.now() - remote.checkedAt < (opts.checkEvery * 1000) / 2) return Promise.resolve(remote);
  if (remoteCheck) return remoteCheck;
  const wanted = branch ? [`refs/heads/${branch}`, `refs/tags/${branch}^{}`, `refs/tags/${branch}`] : ['HEAD'];
  remoteCheck = git(['ls-remote', 'origin', ...wanted], checkout)
    .then((out) => {
      const refs = new Map(out.split('\n').filter(Boolean).map((line) => line.split('\t').reverse()));
      const latest = wanted.map((r) => refs.get(r)).find(Boolean) || null;
      remote = { latest, checkedAt: Date.now(), error: '' };
      if (latest && latest !== commitFull && latest !== announced) {
        announced = latest;
        console.log(`${new Date().toISOString()} GitHub has a newer commit ${latest.slice(0, 7)}; open pages will offer to refresh`);
      }
      return remote;
    })
    .catch((e) => {
      remote = { ...remote, checkedAt: Date.now(), error: scrub(firstFatal(e.message), token) };
      return remote;
    })
    .finally(() => { remoteCheck = null; });
  return remoteCheck;
}

// Only page loads pull, so a page and its CSS, JS and images come from the same commit.
function isPageLoad(req, pathname) {
  const dest = req.headers['sec-fetch-dest'];
  if (dest) return dest === 'document' || dest === 'iframe';
  return pathname.endsWith('/') || /\.html?$/i.test(pathname) || (req.headers.accept || '').includes('text/html');
}

function listingPage(dir, urlPath) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const items = entries.map((e) => {
    const name = e.name + (e.isDirectory() ? '/' : '');
    return `<li><a href="${escapeHtml(encodeURIComponent(e.name) + (e.isDirectory() ? '/' : ''))}">${escapeHtml(name)}</a></li>`;
  });
  return messagePage(`${describe}: ${urlPath}`, [
    `<p>No <code>index.html</code> here. Commit <code>${escapeHtml(commit)}</code>.</p>`,
    urlPath !== '/' ? '<p><a href="../">↑ Up</a></p>' : '',
    items.length ? `<ul>${items.join('')}</ul>` : '<p>This folder is empty.</p>',
  ]);
}

function send(res, req, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Git-Commit': commit, ...NO_STORE, ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handle(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, req, 400, 'text/plain; charset=utf-8', 'Bad request\n');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, req, 405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET, HEAD' });

  if (pathname === STATUS_PATH) {
    const r = await latestRemote();
    return send(res, req, 200, 'application/json; charset=utf-8', JSON.stringify({ served: commitFull, latest: r.latest, error: r.error || undefined }));
  }

  if (isPageLoad(req, pathname)) await pull();

  // Never serve .git or other dot-files, and never leave the served folder.
  if (pathname.split('/').some((seg) => seg.startsWith('.'))) return send(res, req, 404, 'text/plain; charset=utf-8', 'Not found\n');
  const file = path.join(root, pathname);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, req, 404, 'text/plain; charset=utf-8', 'Not found\n');

  let target = file;
  let stat = fs.statSync(target, { throwIfNoEntry: false });
  if (stat && stat.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: encodeURI(pathname) + '/', ...NO_STORE });
      return res.end();
    }
    const index = path.join(target, 'index.html');
    if (fs.existsSync(index)) {
      target = index;
      stat = fs.statSync(index);
    } else {
      return send(res, req, 200, 'text/html; charset=utf-8', listingPage(target, pathname));
    }
  }
  if (!stat || !stat.isFile()) {
    return send(res, req, 404, 'text/html; charset=utf-8', messagePage('Not found', [
      `<p><code>${escapeHtml(pathname)}</code> is not in ${escapeHtml(describe)} at commit <code>${escapeHtml(commit)}</code>.</p>`,
      '<p><a href="/">Go to the start page</a></p>',
    ]));
  }

  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  let body = fs.readFileSync(target);
  if (type.startsWith('text/html') && (pullError || opts.notify)) {
    const extra = (pullError ? staleBanner(pullError, commit) : '') + (opts.notify ? updateNotice(commitFull, opts.checkEvery * 1000) : '');
    body = addToPage(body.toString('utf8'), extra);
  }
  return send(res, req, 200, type, body);
}

console.log(`Getting ${describe} from ${loc.url}`);
if (tokenFrom) console.log(`GitHub token: from ${tokenFrom}`);
try {
  await prepare();
} catch (e) {
  const hint = explainGitError(e.message, httpsUrl, tokenFrom);
  console.error(`\nCould not get the repo.${hint ? ' ' + hint : ''}\n\ngit said: ${scrub(e.message, token)}`);
  process.exit(1);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`\nThe folder "${folder}" is not in ${loc.owner}/${loc.repo}${branch ? `@${branch}` : ''}.`);
  process.exit(1);
}
commitFull = await git(['rev-parse', 'HEAD'], checkout);
commit = commitFull.slice(0, 7);

const server = http.createServer((req, res) => {
  const started = Date.now();
  handle(req, res)
    .catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, req, 500, 'text/plain; charset=utf-8', 'Internal error\n');
    })
    .finally(() => {
      if (!req.url.startsWith(STATUS_PATH)) console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started} ms)`);
    });
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${opts.port} is already in use. Pick another with --port.` : e.message);
  process.exit(1);
});

// The addresses other devices on the network can use to reach this computer. VPN tunnels and
// self-assigned (169.254.x.x) addresses are left out, since classmates can't reach those.
function networkAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|tun|tap|ppp|ipsec|wg|gif|stf|awdl|llw|bridge|docker|veth|vboxnet|vmnet)/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push(a.address);
    }
  }
  return found;
}

server.listen(opts.port, opts.host, () => {
  const { port } = server.address();
  console.log(`Commit ${commit}, checked out in ${checkout}`);
  if (opts.host === '0.0.0.0' || opts.host === '::') {
    const addresses = networkAddresses();
    console.log(`Open http://127.0.0.1:${port}/ on this computer.`);
    if (addresses.length) {
      console.log('Other devices on the same network can open:');
      for (const a of addresses) console.log(`  http://${a}:${port}/`);
    } else {
      console.log('This computer has no network address right now, so other devices cannot reach it.');
    }
    console.log('Anyone on this network can read these pages, without a login.');
  } else {
    const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
    console.log(`Open http://${host}:${port}/  (refresh the browser to pull the latest changes)`);
  }
  if (opts.notify) console.log(`Open pages check GitHub every ${opts.checkEvery} s and show a notice when a newer commit is pushed.`);
});
