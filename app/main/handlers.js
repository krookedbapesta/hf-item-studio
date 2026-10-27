// Back-end operations shared by the Electron main process and the browser dev server.
// Every export takes one plain-object argument and returns JSON-serialisable data or bytes.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { unzipSync, strFromU8 } = require('fflate');

const APP_DIR = path.join(__dirname, '..');
let dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'HF Item Studio');
let progressSink = () => {};

function configure({ userData, onProgress }) {
  if (userData) dataDir = userData;
  if (onProgress) progressSink = onProgress;
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// ---------- settings ----------

const settingsPath = () => path.join(dataDir, 'settings.json');

async function getSettings() {
  try { return JSON.parse(await fsp.readFile(settingsPath(), 'utf8')); } catch { return {}; }
}

async function setSettings({ settings }) {
  await fsp.mkdir(dataDir, { recursive: true });
  const cur = await getSettings();
  const next = { ...cur, ...settings };
  await fsp.writeFile(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

// ---------- environment detection ----------

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`));
      resolve(m ? m[1].trim() : null);
    });
  });
}

function parseLibraryFolders(text) {
  const out = [];
  for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

async function findPython() {
  const s = await getSettings();
  const candidates = [s.pythonPath, 'python', 'py'];
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
  if (exists(local)) for (const d of fs.readdirSync(local)) candidates.push(path.join(local, d, 'python.exe'));
  for (const c of candidates.filter(Boolean)) {
    const ok = await new Promise((resolve) => execFile(c, ['--version'], { windowsHide: true }, (e, out, err) => resolve(!e ? (out || err).trim() : null)));
    if (ok) return { path: c, version: ok };
  }
  return null;
}

async function detectEnvironment() {
  const steamPath = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'))?.replace(/\//g, '\\')
    || ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'].find(exists) || null;
  // the registry and libraryfolders.vdf disagree on letter case; key on the lower-cased path
  const libMap = new Map();
  const addLib = (l) => { const k = path.resolve(l).toLowerCase(); if (!libMap.has(k)) libMap.set(k, path.resolve(l)); };
  if (steamPath) {
    const vdf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    if (exists(vdf)) parseLibraryFolders(await fsp.readFile(vdf, 'utf8')).forEach(addLib);
    addLib(steamPath);
  }
  const libraries = new Set(libMap.values());
  const games = [], workshops = [];
  for (const lib of libraries) {
    const g = path.join(lib, 'steamapps', 'common', 'House Flipper');
    if (exists(path.join(g, 'HouseFlipper.exe'))) {
      games.push({
        path: g,
        hasKit: exists(path.join(g, 'Assets', 'Plugins', 'Windows_x64', 'HFContentCreatorLib.dll')),
        steamDll: [path.join(g, 'Assets', 'Plugins', 'Windows_x64', 'steam_api64.dll'), path.join(g, 'HouseFlipper_Data', 'Plugins', 'x86_64', 'steam_api64.dll')].find(exists) || null,
      });
    }
    const w = path.join(lib, 'steamapps', 'workshop', 'content', '613100');
    if (exists(w)) workshops.push(w);
  }
  const logDir = path.join(os.homedir(), 'AppData', 'LocalLow', 'Empyrean', 'House Flipper Game');
  const docs = path.join(os.homedir(), 'Documents', 'HF Item Studio');
  const python = await findPython();
  return {
    steamPath, libraries: [...libraries], games, workshops,
    logDir: exists(logDir) ? logDir : null,
    defaultProjectsDir: docs,
    python,
    dataDir,
    appDir: APP_DIR,
  };
}

// ---------- files ----------

async function readFile({ path: p }) {
  return new Uint8Array(await fsp.readFile(p));
}

async function readText({ path: p }) {
  return fsp.readFile(p, 'utf8');
}

async function writeFile({ path: p, bytes, text }) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // write to a temp file first so a crash never leaves a half-written item
  const tmp = p + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, text !== undefined ? text : Buffer.from(bytes));
  await fsp.rename(tmp, p);
  return { path: p, size: (await fsp.stat(p)).size };
}

async function copyFile({ from, to }) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  return { path: to };
}

async function listDir({ path: p, exts, recursive = false }) {
  const out = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < 6) await walk(full, depth + 1);
        else if (!recursive) out.push({ name: e.name, path: full, dir: true });
      } else {
        const ext = e.name.split('.').pop().toLowerCase();
        if (exts && !exts.includes(ext)) continue;
        const st = await fsp.stat(full);
        out.push({ name: e.name, path: full, dir: false, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  await walk(p, 0);
  return out;
}

async function statPath({ path: p }) {
  try {
    const s = await fsp.stat(p);
    return { exists: true, size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() };
  } catch { return { exists: false }; }
}

async function makeDir({ path: p }) {
  await fsp.mkdir(p, { recursive: true });
  return { path: p };
}

/** Load a model and every file in its folder that it might reference. */
async function readModelBundle({ path: p }) {
  const dir = path.dirname(p);
  const main = { name: path.basename(p), bytes: new Uint8Array(await fsp.readFile(p)) };
  const extras = [];
  const want = ['png', 'jpg', 'jpeg', 'tga', 'bmp', 'webp', 'gif', 'dds', 'mtl', 'bin', 'tif', 'tiff'];
  const scan = async (d, depth) => {
    let list;
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) await scan(full, depth + 1); continue; }
      const ext = e.name.split('.').pop().toLowerCase();
      if (!want.includes(ext) || full === p) continue;
      const st = await fsp.stat(full);
      if (st.size > 64 * 1024 * 1024) continue;
      extras.push({ name: path.relative(dir, full).replace(/\\/g, '/'), bytes: new Uint8Array(await fsp.readFile(full)) });
      if (extras.length > 200) return;
    }
  };
  await scan(dir, 0);
  return { main, extras };
}

// ---------- workshop index ----------

const indexPath = () => path.join(dataDir, 'workshop-index.json');
const thumbDir = () => path.join(dataDir, 'thumbs');

function readContentInfoFromZip(bytes) {
  const files = unzipSync(bytes, { filter: (f) => f.name.endsWith('contentInfo.json') });
  const key = Object.keys(files)[0];
  if (!key) throw new Error('contentInfo.json missing');
  let t = strFromU8(files[key]);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return JSON.parse(t);
}

function extractThumb(bytes, name) {
  const files = unzipSync(bytes, { filter: (f) => f.name === name || f.name.endsWith('/' + name) });
  return Object.values(files)[0] || null;
}

function summarize(info) {
  const meshes = (info.Meshes || []).filter(Boolean);
  // world-space-free collider extent: good enough for listing and sorting
  let colliders = 0;
  const walk = (n) => { for (const c of n.Components || []) if (c && c.componentType !== 3) colliders++; (n.Children || []).forEach(walk); };
  (info.ObjectHierarchy || []).forEach(walk);
  return {
    name: info.ItemData?.ItemName?.Default || '',
    price: info.ItemData?.PriceInPLN ?? 0,
    placement: info.ItemData?.PlacementOption ?? 0,
    category: info.ItemCategory || '',
    tags: info.ItemTags || [],
    vertices: meshes.reduce((a, m) => a + (m.verticesCount || 0), 0),
    triangles: meshes.reduce((a, m) => a + (m.trianglesCount || 0), 0),
    meshes: meshes.length,
    materials: (info.Materials || []).length,
    colliders,
    thumbName: info.ItemData?.Thumbnail || '',
    description: (info.ItemData?.ItemDescription || '').slice(0, 300),
  };
}

async function scanWorkshop({ roots, force = false }) {
  await fsp.mkdir(thumbDir(), { recursive: true });
  let old = {};
  if (!force) { try { old = JSON.parse(await fsp.readFile(indexPath(), 'utf8')).items || {}; } catch { /* first run */ } }
  const items = {};
  const dirs = [];
  for (const r of roots || []) {
    let list = [];
    try { list = await fsp.readdir(r); } catch { continue; }
    for (const d of list) if (/^\d+$/.test(d) && !items[d]) { items[d] = null; dirs.push([d, path.join(r, d)]); }
  }
  let done = 0;
  const out = {};
  for (const [id, dir] of dirs) {
    done++;
    if (done % 50 === 0) progressSink({ kind: 'workshop-scan', done, total: dirs.length });
    let files;
    try { files = await fsp.readdir(dir); } catch { continue; }
    const f = files.find((x) => x.toLowerCase().endsWith('.hfcontent'));
    if (!f) { out[id] = { id, dir, error: 'No .hfcontent file in folder', broken: true }; continue; }
    const full = path.join(dir, f);
    const st = await fsp.stat(full);
    const prev = old[id];
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.file === full) { out[id] = prev; continue; }
    try {
      const bytes = new Uint8Array(await fsp.readFile(full));
      const info = readContentInfoFromZip(bytes);
      const s = summarize(info);
      let thumb = null;
      if (s.thumbName) {
        const tb = extractThumb(bytes, s.thumbName);
        if (tb) { thumb = path.join(thumbDir(), id + '.png'); await fsp.writeFile(thumb, Buffer.from(tb)); }
      }
      out[id] = { id, dir, file: full, size: st.size, mtime: st.mtimeMs, thumb, ...s };
    } catch (e) {
      out[id] = { id, dir, file: full, size: st.size, mtime: st.mtimeMs, error: e.message, broken: true };
    }
  }
  progressSink({ kind: 'workshop-scan', done: dirs.length, total: dirs.length });
  await fsp.writeFile(indexPath(), JSON.stringify({ scanned: Date.now(), items: out }));
  return { scanned: Date.now(), items: Object.values(out) };
}

async function getWorkshopIndex() {
  try {
    const j = JSON.parse(await fsp.readFile(indexPath(), 'utf8'));
    return { scanned: j.scanned, items: Object.values(j.items) };
  } catch { return { scanned: 0, items: [] }; }
}

// ---------- deep health scan ----------

const healthPath = () => path.join(dataDir, 'workshop-health.json');
let healthCancel = false;

/** Decode every mesh of every installed item with the same checks the app uses. */
async function deepScanWorkshop({ roots, force = false }) {
  const { pathToFileURL } = require('url');
  const core = await import(pathToFileURL(path.join(APP_DIR, 'src', 'core', 'hfcontent.js')).href);
  let cache = {};
  if (!force) { try { cache = JSON.parse(await fsp.readFile(healthPath(), 'utf8')).items || {}; } catch { /* first run */ } }
  const jobs = [];
  const seen = new Set();
  for (const r of roots || []) {
    let list = [];
    try { list = await fsp.readdir(r); } catch { continue; }
    for (const d of list) if (/^\d+$/.test(d) && !seen.has(d)) { seen.add(d); jobs.push([d, path.join(r, d)]); }
  }
  healthCancel = false;
  const out = {};
  let done = 0;
  for (const [id, dir] of jobs) {
    if (healthCancel) break;
    done++;
    if (done % 20 === 0) progressSink({ kind: 'health', done, total: jobs.length });
    let files;
    try { files = await fsp.readdir(dir); } catch { continue; }
    const f = files.find((x) => x.toLowerCase().endsWith('.hfcontent'));
    if (!f) { out[id] = { id, dir, name: '', errors: ['No .hfcontent file in the folder (download incomplete?)'], warnings: [] }; continue; }
    const full = path.join(dir, f);
    const st = await fsp.stat(full);
    const c = cache[id];
    if (c && c.size === st.size && c.mtime === st.mtimeMs) { out[id] = c; continue; }
    try {
      const bytes = new Uint8Array(await fsp.readFile(full));
      const { info, files: fl } = core.readHfContent(bytes);
      const res = core.checkHfContent(info, fl, { archiveBytes: bytes.length });
      out[id] = { id, dir, file: full, size: st.size, mtime: st.mtimeMs, name: info.ItemData?.ItemName?.Default || '', errors: res.errors, warnings: res.warnings, stats: res.stats };
    } catch (e) {
      out[id] = { id, dir, file: full, size: st.size, mtime: st.mtimeMs, name: '', errors: [e.message], warnings: [] };
    }
    // let other IPC calls through
    if (done % 10 === 0) await new Promise((r) => setImmediate(r));
  }
  progressSink({ kind: 'health', done: jobs.length, total: jobs.length });
  const result = { scanned: Date.now(), complete: !healthCancel, items: out };
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(healthPath(), JSON.stringify(result));
  return { scanned: result.scanned, complete: result.complete, items: Object.values(out) };
}

async function cancelDeepScan() { healthCancel = true; return true; }

async function getHealth() {
  try { const j = JSON.parse(await fsp.readFile(healthPath(), 'utf8')); return { scanned: j.scanned, complete: j.complete, items: Object.values(j.items) }; } catch { return null; }
}

// ---------- reference data ----------

// Game data is never shipped with the app: it is read from the user's own install and cached.
const KIT_COLLECTIONS = path.join('Assets', 'Resources', 'Exporter', 'HFCollections.asset');

/** Tag and category list from the Content Creator kit's HFCollections.asset (Unity YAML). */
function parseCollections(yaml) {
  const [tagsPart, catsPart = ''] = yaml.split(/^\s*categories:/m);
  const grab = (part, key) => [...part.matchAll(new RegExp(`- ${key}: (.*)\\r?\\n\\s+assetGuid: (\\w+)`, 'g'))]
    .map((m) => ({ name: m[1].trim().replace(/^['"]|['"]$/g, ''), guid: m[2] }));
  return { tags: grab(tagsPart, 'tagName'), categories: grab(catsPart, 'categoryName') };
}

async function buildCollections() {
  const env = await detectEnvironment();
  const g = env.games.find((x) => x.hasKit && exists(path.join(x.path, KIT_COLLECTIONS)));
  if (!g) throw new Error('House Flipper with its Content Creator files was not found, so the tag and category list could not be read.');
  const out = parseCollections(await fsp.readFile(path.join(g.path, KIT_COLLECTIONS), 'utf8'));
  if (!out.tags.length || !out.categories.length) throw new Error('Could not read tags and categories from ' + KIT_COLLECTIONS);
  await fsp.mkdir(path.join(dataDir, 'reference'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'reference', 'hf_collections.json'), JSON.stringify(out));
  return out;
}

async function getReference({ name }) {
  const safe = path.basename(name);
  const p = [path.join(dataDir, 'reference', safe), path.join(APP_DIR, 'reference', safe)].find(exists);
  if (p) return JSON.parse(await fsp.readFile(p, 'utf8'));
  if (safe === 'hf_collections.json') return buildCollections();
  const e = new Error('REFERENCE_MISSING: the base-game library has not been built yet');
  e.code = 'REFERENCE_MISSING';
  throw e;
}

async function hasReference({ name }) {
  const safe = path.basename(name);
  return [path.join(dataDir, 'reference', safe), path.join(APP_DIR, 'reference', safe)].some(exists);
}

/** Make sure UnityPy is importable, installing it for the current user if needed. */
async function ensureUnityPy() {
  const check = await runPython(['-c', 'import UnityPy; print(UnityPy.__version__)']);
  if (check.code === 0) return { installed: true, version: check.lines[0] };
  progressSink({ kind: 'reference', line: 'Installing UnityPy (python -m pip install --user UnityPy)…' });
  const res = await runPython(['-m', 'pip', 'install', '--user', 'UnityPy'], { onLine: (l) => progressSink({ kind: 'reference', line: l }) });
  if (res.code !== 0) throw new Error('Could not install UnityPy: ' + (res.stderr.trim().split('\n').pop() || 'pip failed'));
  return { installed: true, justInstalled: true };
}

function runPython(args, { onLine } = {}) {
  return new Promise(async (resolve, reject) => {
    const py = await findPython();
    if (!py) return reject(new Error('Python 3 was not found. Install it from python.org or set its path in Settings.'));
    const child = spawn(py.path, args, { windowsHide: true, cwd: path.join(APP_DIR, 'main') });
    let buf = '', errBuf = '';
    const lines = [];
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        lines.push(line);
        onLine && onLine(line);
      }
    });
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, lines, stderr: errBuf }));
  });
}

async function rebuildReference({ gameDir, installDeps = true }) {
  const out = path.join(dataDir, 'reference', 'base_items.json');
  if (installDeps) await ensureUnityPy();
  const res = await runPython(['-P', path.join(APP_DIR, 'tools', 'extract_reference.py'), gameDir, out], {
    onLine: (l) => progressSink({ kind: 'reference', line: l }),
  });
  if (res.code !== 0) {
    const hint = /No module named 'UnityPy'/.test(res.stderr) ? ' Install it with: python -m pip install UnityPy' : '';
    throw new Error((res.stderr.split('\n').filter(Boolean).pop() || 'extraction failed') + hint);
  }
  return { path: out, log: res.lines };
}

// ---------- steam ----------

async function steam({ command, args }) {
  const res = await runPython([path.join(APP_DIR, 'main', 'steam_helper.py'), command, JSON.stringify(args || {})], {
    onLine: (l) => { try { const j = JSON.parse(l); if (j.event !== 'result') progressSink({ kind: 'steam', ...j }); } catch { /* not json */ } },
  });
  let result = null, error = null;
  for (const l of res.lines) {
    try {
      const j = JSON.parse(l);
      if (j.event === 'result') result = j;
      if (j.event === 'error') error = j.message;
    } catch { /* ignore */ }
  }
  if (error) throw new Error(error);
  if (!result) throw new Error(res.stderr.trim().split('\n').pop() || 'Steam helper produced no result');
  return result;
}

/** Folder Steam uploads: holds only the .hfcontent (the preview goes separately). */
async function stageUpload({ bytes, fileName, previewBytes }) {
  const dir = path.join(dataDir, 'upload', String(Date.now()));
  const content = path.join(dir, 'content');
  await fsp.mkdir(content, { recursive: true });
  await fsp.writeFile(path.join(content, fileName), Buffer.from(bytes));
  let preview = null;
  if (previewBytes) { preview = path.join(dir, 'preview.png'); await fsp.writeFile(preview, Buffer.from(previewBytes)); }
  return { contentDir: content, preview };
}

// ---------- game log ----------

async function readGameLog({ logDir }) {
  const out = [];
  for (const f of ['Player.log', 'Player-prev.log']) {
    const p = path.join(logDir, f);
    if (!exists(p)) continue;
    const text = await fsp.readFile(p, 'utf8');
    const lines = text.split(/\r?\n/);
    const st = await fsp.stat(p);
    const events = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const custom = /CustomItem \(|HFContentInfoV1|hfcontent|workshop/i.test(l);
      const err = /(Exception|Error|Invalid|failed)/i.test(l) && !/^\s+at /.test(l);
      if (custom || (err && /mesh|texture|item|content/i.test(l))) {
        const ctx = [];
        for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 8); j++) ctx.push(lines[j]);
        events.push({ line: i + 1, text: l.trim().slice(0, 400), context: ctx.join('\n').slice(0, 3000), error: err });
        i += 2;
      }
    }
    out.push({ file: f, path: p, mtime: st.mtimeMs, events: events.slice(-400) });
  }
  return out;
}

module.exports = {
  configure,
  getSettings, setSettings, detectEnvironment,
  readFile, readText, writeFile, copyFile, listDir, statPath, makeDir, readModelBundle,
  parseCollections,
  scanWorkshop, getWorkshopIndex, getReference, hasReference, rebuildReference, deepScanWorkshop, cancelDeepScan, getHealth,
  steam, stageUpload, readGameLog,
};
