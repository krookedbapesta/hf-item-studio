// Headless UI smoke test: boots the real renderer code in jsdom (WebGL parts stubbed), drives
// every view and the editor with a real workshop item, and fails on any thrown error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WORKSHOP = 'D:/SteamLibrary/steamapps/workshop/content/613100';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfstudio-ui-'));

// swap the WebGL modules for stubs
const stubs = { 'three/viewport.js': 'test/stubs/viewport.js', 'three/thumbnail.js': 'test/stubs/thumbnail.js' };
const hookSrc = `
const map = ${JSON.stringify(Object.fromEntries(Object.entries(stubs).map(([k, v]) => [k, 'file:///' + path.join(APP, v).replace(/\\/g, '/')])))};
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  if (ctx.parentURL && !ctx.parentURL.includes('/test/')) for (const [k, v] of Object.entries(map)) if (r.url.endsWith('/src/' + k)) return { ...r, url: v };
  return r;
}`;
register('data:text/javascript,' + encodeURIComponent(hookSrc));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(40); }
  throw new Error('timed out waiting');
}

function pickSample() {
  if (!fs.existsSync(WORKSHOP)) return null;
  for (const d of fs.readdirSync(WORKSHOP).slice(0, 300)) {
    const dir = path.join(WORKSHOP, d);
    const f = fs.readdirSync(dir).find((x) => x.endsWith('.hfcontent'));
    if (f && fs.statSync(path.join(dir, f)).size < 3e6) return { id: d, dir, file: path.join(dir, f) };
  }
  return null;
}

test('every view renders and the editor workflow runs without errors', { timeout: 180000, skip: !pickSample() }, async () => {
  const errors = [];
  const onRej = (e) => errors.push('unhandled: ' + (e?.stack || e));
  process.on('unhandledRejection', onRej);
  const html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  w.Element.prototype.scrollIntoView = () => {};
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 16);
  w.console.error = (...a) => errors.push('console.error: ' + a.join(' '));

  // back end: the real handlers, with dialogs answered automatically
  const handlers = require(path.join(APP, 'main', 'handlers.js'));
  const sample = pickSample();
  handlers.configure({ userData: path.join(tmp, 'data'), onProgress: () => {} });
  const api = {};
  for (const [k, fn] of Object.entries(handlers)) if (k !== 'configure') api[k] = (a) => fn(a || {});
  const realEnv = api.detectEnvironment;
  api.detectEnvironment = async () => ({ ...(await realEnv()), workshops: [path.dirname(sample.dir)], defaultProjectsDir: tmp });
  const sampleRoot = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(sampleRoot, sample.id), { recursive: true });
  fs.copyFileSync(sample.file, path.join(sampleRoot, sample.id, path.basename(sample.file)));
  api.detectEnvironment = async () => ({ ...(await realEnv()), workshops: [sampleRoot], defaultProjectsDir: tmp });
  api.openDialog = async () => null;
  api.saveDialog = async () => path.join(tmp, 'export.hfcontent');
  api.confirm = async () => 1;
  for (const k of ['openPath', 'showInFolder', 'openExternal', 'trash']) api[k] = async () => {};
  api.onProgress = () => () => {};
  api.isElectron = true;
  api.pathForFile = () => '';
  w.hf = api;
  globalThis.hf = api;

  await import('../src/ui/app.js');
  const app = await until(() => w.hfApp?.current && w.hfApp);
  const view = w.document.getElementById('view');
  assert.ok(view.textContent.includes('HF Item Studio'), 'home rendered');
  // fresh install: no base-game library yet, so Home offers to build it
  await until(() => /One-time setup/.test(view.textContent));
  const cached = path.join(os.homedir(), 'AppData', 'Roaming', 'HF Item Studio', 'reference', 'base_items.json');
  if (fs.existsSync(cached)) {
    fs.mkdirSync(path.join(tmp, 'data', 'reference'), { recursive: true });
    fs.copyFileSync(cached, path.join(tmp, 'data', 'reference', 'base_items.json'));
  }

  for (const id of ['batch', 'library', 'health', 'log', 'templates', 'settings', 'home']) {
    app.go(id);
    await sleep(300);
    assert.ok(view.querySelector('.page'), `${id} rendered`);
  }

  // templates: add starters
  app.go('templates');
  [...view.querySelectorAll('button')].find((b) => /starter/i.test(b.textContent))?.click();
  await until(() => /Wall painting/.test(view.textContent));

  // library: installed workshop tab indexes the sample
  app.go('library');
  await sleep(200);
  [...view.querySelectorAll('.seg button')].find((b) => /Installed/.test(b.textContent)).click();
  await until(() => view.querySelector('.lib-card'));
  view.querySelector('.lib-card').click();
  await until(() => /Workshop id/.test(view.textContent));

  // editor with the real item
  await app.openInEditor({ path: sample.file });
  const ed = app.views.get('editor').instance;
  await until(() => ed.item);
  assert.ok(ed.item.model.children.length > 0, 'model loaded');
  for (const tab of ['details', 'model', 'colliders', 'materials', 'thumb']) {
    ed.leftTab = tab; ed.drawLeft();
    assert.ok(ed.left.querySelector('.tab-body').children.length > 0, `left tab ${tab}`);
  }
  for (const mode of ['collision', 'room', 'compare', 'model']) {
    ed.setMode(mode);
    await sleep(mode === 'compare' ? 1500 : 200);
  }
  ed.rightTab = 'compare'; ed.drawRight();
  await until(() => ed.right.querySelector('.ref-row'), 30000);
  ed.right.querySelector('.ref-row').click();
  await sleep(100);
  assert.ok(ed.compare.length === 1, 'compare item added');

  const it = ed.item;
  it.regenerateColliders();
  assert.ok(it.colliders.length > 0);
  it.setPlacement(2);
  assert.equal(it.meta.placement, 2);
  ed.applyFix('wallfit');
  assert.ok(it.colliders.every((c) => c.matrix || c.center[2] - c.size[2] / 2 >= 0.0049), 'wall gap applied');
  it.undo(); it.redo();
  it.meta.categoryGuid ||= (await import('./game-data.mjs')).loadCollections().categories[0].guid;
  const saved = await ed.save();
  assert.ok(saved && fs.existsSync(saved.file), 'project saved');
  await ed.exportAs();
  assert.ok(fs.existsSync(path.join(tmp, 'export.hfcontent')), 'exported');

  // reopen the saved project
  await app.openInEditor({ project: saved.dir });
  await until(() => ed.item && ed.item.projectDir === saved.dir);
  assert.equal(ed.item.meta.placement, 2);

  // import an OBJ model through the editor
  const obj = path.join(tmp, 'shelf.obj');
  fs.writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 1 0.03 0\nv 0 0.03 0\nv 0 0 0.25\nv 1 0 0.25\nv 1 0.03 0.25\nv 0 0.03 0.25\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n');
  await app.openInEditor({ path: obj });
  await until(() => ed.item?.source?.path === obj);
  assert.ok(ed.item.thumbnail, 'thumbnail rendered');

  // batch import of the same model
  app.go('batch');
  const batch = app.views.get('batch').instance;
  batch.addEntries([{ path: obj, name: 'shelf.obj' }]);
  await batch.run();
  assert.ok(['done', 'warn'].includes(batch.rows[0].status), 'batch row: ' + batch.rows[0].message);

  app.go('library');
  await sleep(500);
  process.off('unhandledRejection', onRej);
  assert.deepEqual(errors, []);
});

test('the viewport stub only uses methods that exist on the real Viewport', async () => {
  const real = await import('../src/three/viewport.js?real');
  const stub = await import('./stubs/viewport.js');
  const realNames = new Set(Object.getOwnPropertyNames(real.Viewport.prototype));
  for (const n of Object.getOwnPropertyNames(stub.Viewport.prototype)) {
    if (n === 'constructor' || n === 'log') continue;
    assert.ok(realNames.has(n), `real Viewport has ${n}()`);
  }
});
