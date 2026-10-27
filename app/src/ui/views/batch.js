// Batch import: many models -> many items with shared settings and per-row overrides.
import { h, clear, btn, toast, modal, seg, numberInput, tick } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { ItemProject, prettyName } from '../item.js';
import { MODEL_EXTENSIONS } from '../../three/importers.js';
import { makeDropTarget, extOf, bundleFromDropped, MODEL_FILTER } from '../files.js';
import { categoryPicker, categoryLabel, tagPicker } from './pickers.js';
import { CURRENCIES, PLACEMENT_NAMES } from '../../core/constants.js';

const csvEscape = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export class BatchView {
  constructor(app) {
    this.app = app;
    this.rows = [];
    this.running = false;
    const s = state.settings;
    this.opts = {
      template: '', placement: 'auto', categoryGuid: '', tagGuids: [], price: 100, currency: s.defaultCurrency,
      colliderMode: s.colliderMode, maxBoxes: s.maxColliderBoxes, autoOrient: s.autoOrientWall, autoUnits: true,
      wallGapMm: s.wallGapMm, maxTextureSize: s.maxTextureSize, thumbBackground: s.thumbnailBackground, mergeByMaterial: true,
      exportDir: '',
    };
  }

  render() {
    this.el = h('div.page');
    this.draw();
    return this.el;
  }

  addEntries(entries) {
    for (const e of entries) {
      if (!MODEL_EXTENSIONS.includes(extOf(e.name))) continue;
      if (this.rows.some((r) => (r.path && r.path === e.path) || (!r.path && r.name === e.name && r.entry === e))) continue;
      this.rows.push({ path: e.path || null, entry: e.path ? null : e, file: e.name, name: prettyName(e.name), placement: '', price: '', categoryGuid: '', description: '', status: 'queued', message: '' });
    }
    this.draw();
  }

  async addFiles() {
    const files = await api.openDialog({ title: 'Choose models', filters: MODEL_FILTER, multi: true });
    if (files) this.addEntries(files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
  }

  async addFolder() {
    const d = await api.openDialog({ title: 'Choose a folder of models', folder: true });
    if (!d?.[0]) return;
    const list = await api.listDir({ path: d[0], exts: MODEL_EXTENSIONS, recursive: true });
    // one model per folder for formats that come with sidecar files
    this.addEntries(list.map((f) => ({ path: f.path, name: f.name })));
    toast('Folder scanned', `${list.length} model file(s) found`, 'info');
  }

  draw() {
    const el = clear(this.el);
    const o = this.opts;
    const templates = state.settings.templates || [];
    el.appendChild(h('div.page-head',
      h('div', h('h1', 'Batch import'), h('p', 'Every model becomes its own item project with scale, pivot, colliders, wall fit and thumbnail done for you.')),
      h('div.spacer'),
      btn('Add files…', () => this.addFiles(), { ic: 'plus' }),
      btn('Add folder…', () => this.addFolder(), { ic: 'folder' }),
      btn('Import CSV…', () => this.importCsv(), { ic: 'upload' }),
      btn('Export CSV…', () => this.exportCsv(), { ic: 'download', disabled: !this.rows.length }),
      btn(this.running ? 'Working…' : `Process ${this.rows.filter((r) => r.status !== 'done').length} item(s)`, () => this.run(), { cls: 'primary', ic: 'play', disabled: this.running || !this.rows.length })));

    const optField = (label, control, hint) => h('label.field', h('span', label), control, hint ? h('div.field-hint', hint) : null);
    const tplSel = h('select.input', { onchange: (e) => { o.template = e.target.value; } }, h('option', { value: '' }, 'None'), templates.map((t, i) => h('option', { value: i, selected: String(i) === o.template }, t.name)));
    const placementSel = h('select.input', { onchange: (e) => { o.placement = e.target.value; } },
      h('option', { value: 'auto', selected: o.placement === 'auto' }, 'Detect from shape'), PLACEMENT_NAMES.map((n, i) => h('option', { value: i, selected: String(o.placement) === String(i) }, n)));
    const catBtn = btn(o.categoryGuid ? categoryLabel(o.categoryGuid) : 'Choose…', () => this.pickCategory((g) => { o.categoryGuid = g; this.draw(); }), { cls: 'sm' });
    const tagBtn = btn(o.tagGuids.length ? `${o.tagGuids.length} tag(s)` : 'Choose…', () => this.pickTags(), { cls: 'sm' });
    const exportBtn = btn(o.exportDir || 'Off', async () => { const d = await api.openDialog({ title: 'Also copy .hfcontent files to…', folder: true }); o.exportDir = d?.[0] || ''; this.draw(); }, { cls: 'sm' });
    el.appendChild(h('div.card.card-pad', { style: { marginBottom: '14px' } },
      h('h3', 'Shared settings'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px 16px' } },
        optField('Template', tplSel, 'Applied first; rows can override.'),
        optField('Placement', placementSel),
        optField('Category', catBtn),
        optField('Tags', tagBtn),
        optField('Price', h('div.row', numberInput(o.price, (v) => { o.price = v; }, { step: 1, digits: 2, cls: '' }),
          h('select.input', { style: { width: '80px' }, onchange: (e) => { o.currency = +e.target.value; } }, CURRENCIES.map((c) => h('option', { value: c.id, selected: c.id === o.currency }, c.code))))),
        optField('Colliders', seg([{ value: 'fit', label: 'Smart' }, { value: 'perMesh', label: 'Parts' }, { value: 'single', label: 'Box' }], o.colliderMode, (v) => { o.colliderMode = v; }, 'sm')),
        optField('Max boxes', numberInput(o.maxBoxes, (v) => { o.maxBoxes = Math.max(1, Math.round(v)); }, { step: 1, digits: 0, cls: '' })),
        optField('Wall gap (mm)', numberInput(o.wallGapMm, (v) => { o.wallGapMm = Math.max(0, v); }, { step: 1, digits: 1, cls: '' })),
        optField('Max texture', h('select.input', { onchange: (e) => { o.maxTextureSize = +e.target.value; } }, [512, 1024, 2048, 4096].map((v) => h('option', { value: v, selected: v === o.maxTextureSize }, v + ' px')))),
        optField('Thumbnail background', h('select.input', { onchange: (e) => { o.thumbBackground = e.target.value; } },
          [['transparent', 'Transparent'], ['#ffffff', 'White'], ['gradient', 'Studio'], ['#2b2f36', 'Dark']].map(([v, l]) => h('option', { value: v, selected: v === o.thumbBackground }, l)))),
        optField('Also export to', exportBtn),
        h('div', { style: { paddingTop: '18px' } },
          h('label.check', h('input', { type: 'checkbox', checked: o.autoUnits, onchange: (e) => { o.autoUnits = e.target.checked; } }), 'Fix cm/mm units'),
          h('label.check', h('input', { type: 'checkbox', checked: o.autoOrient, onchange: (e) => { o.autoOrient = e.target.checked; } }), 'Auto-orient wall items'),
          h('label.check', h('input', { type: 'checkbox', checked: o.mergeByMaterial, onchange: (e) => { o.mergeByMaterial = e.target.checked; } }), 'Merge parts per material')))));

    const drop = h('div.dropzone', { style: { marginBottom: '14px', padding: '16px' } }, 'Drop model files or a folder\'s contents here');
    makeDropTarget(drop, (files) => this.addEntries(files));
    el.appendChild(drop);

    if (!this.rows.length) { el.appendChild(h('div.empty', icon('layers'), h('p', 'No models queued yet.'))); return; }
    const statusBadge = (r) => ({ queued: h('span.badge', 'queued'), working: h('span.badge.blue', h('span.spinner', { style: { width: '10px', height: '10px', borderWidth: '2px' } }), 'working'), done: h('span.badge.green', 'done'), warn: h('span.badge.yellow', 'done, check'), error: h('span.badge.red', 'failed') }[r.status]);
    const table = h('table.tbl',
      h('tr', h('th', 'File'), h('th', 'Item name'), h('th', 'Placement'), h('th', 'Category'), h('th', 'Price'), h('th', 'Status'), h('th', '')),
      this.rows.map((r, i) => h('tr',
        h('td.small', { title: r.path || r.file, style: { maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.file),
        h('td', h('input.input.sm', { value: r.name, oninput: (e) => { r.name = e.target.value; } })),
        h('td', h('select.input.sm', { onchange: (e) => { r.placement = e.target.value; } }, h('option', { value: '' }, 'Shared'), h('option', { value: 'auto', selected: r.placement === 'auto' }, 'Detect'),
          PLACEMENT_NAMES.map((n, k) => h('option', { value: k, selected: String(r.placement) === String(k) }, n)))),
        h('td', btn(r.categoryGuid ? categoryLabel(r.categoryGuid).split(' › ').pop() : 'Shared', () => this.pickCategory((g) => { r.categoryGuid = g; this.draw(); }), { cls: 'xs' })),
        h('td', { style: { width: '90px' } }, h('input.input.sm.num', { value: r.price, placeholder: String(o.price), oninput: (e) => { r.price = e.target.value; } })),
        h('td', { title: r.message }, statusBadge(r), r.message ? h('div.small.faint', { style: { maxWidth: '260px', whiteSpace: 'normal' } }, r.message) : null),
        h('td', h('div.btn-row',
          r.projectDir ? btn('Open', () => this.app.openInEditor({ project: r.projectDir }), { cls: 'xs', ic: 'cube' }) : null,
          btn('', () => { this.rows.splice(i, 1); this.draw(); }, { cls: 'xs ghost', ic: 'x', title: 'Remove' }))))));
    el.appendChild(h('div.card', { style: { overflow: 'auto' } }, table));
    el.appendChild(h('div.btn-row', { style: { marginTop: '10px' } },
      btn('Clear finished', () => { this.rows = this.rows.filter((r) => r.status !== 'done' && r.status !== 'warn'); this.draw(); }, { cls: 'sm' }),
      btn('Clear all', () => { this.rows = []; this.draw(); }, { cls: 'sm ghost' })));
  }

  pickCategory(onPick) {
    const m = modal({ title: 'Category', body: categoryPicker('', (g) => { onPick(g); m.close(); }) });
  }

  pickTags() {
    let tags = [...this.opts.tagGuids];
    modal({ title: 'Tags for every item', body: tagPicker(tags, (t) => { tags = t; }), foot: (close) => [btn('Done', () => { this.opts.tagGuids = tags; close(); this.draw(); }, { cls: 'primary' })] });
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.draw();
    const o = this.opts;
    const template = o.template !== '' ? state.settings.templates[+o.template] : null;
    let ok = 0, failed = 0;
    for (const r of this.rows) {
      if (r.status === 'done' || r.status === 'warn') continue;
      r.status = 'working'; r.message = '';
      this.draw();
      await tick();
      try {
        const placement = r.placement === '' ? o.placement : r.placement;
        const meta = {};
        if (o.categoryGuid) meta.categoryGuid = o.categoryGuid;
        if (r.categoryGuid) meta.categoryGuid = r.categoryGuid;
        if (o.tagGuids.length) meta.tagGuids = [...new Set([...(template?.tagGuids || []), ...o.tagGuids])];
        meta.price = r.price !== '' ? Number(r.price) : (template?.price ?? o.price);
        meta.currency = o.currency;
        if (r.description) meta.description = r.description;
        const opts = {
          name: r.name, template, meta, placement: placement === 'auto' ? 'auto' : Number(placement),
          autoOrient: o.autoOrient, autoUnits: o.autoUnits, mergeByMaterial: o.mergeByMaterial,
          settings: { colliderMode: o.colliderMode, maxBoxes: o.maxBoxes, wallGapMm: o.wallGapMm, maxTextureSize: o.maxTextureSize, thumbBackground: o.thumbBackground },
        };
        const item = r.path
          ? await ItemProject.fromModelPath(r.path, opts)
          : await ItemProject.fromModelBundle(await bundleFromDropped(r.entry, []), { ...opts, path: r.file });
        const saved = await item.save();
        if (o.exportDir) await api.writeFile({ path: `${o.exportDir}\\${item.fileName()}`, bytes: saved.bytes });
        r.projectDir = saved.dir;
        const problems = item.checks().filter((c) => c.level === 'error' || c.level === 'warn');
        r.status = problems.length ? 'warn' : 'done';
        r.message = problems.map((c) => c.text).slice(0, 3).join(' · ');
        ok++;
      } catch (e) {
        console.error(e);
        r.status = 'error';
        r.message = e.message;
        failed++;
      }
      this.draw();
    }
    this.running = false;
    this.draw();
    toast('Batch finished', `${ok} item(s) created${failed ? `, ${failed} failed` : ''}. They are in your projects folder.`, failed ? 'warn' : 'ok', 7000);
  }

  async exportCsv() {
    const p = await api.saveDialog({ title: 'Save metadata CSV', defaultPath: 'batch.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    const lines = [['file', 'name', 'placement', 'category', 'price', 'description'].join(',')];
    for (const r of this.rows) lines.push([r.path || r.file, r.name, r.placement === '' ? '' : (r.placement === 'auto' ? 'auto' : PLACEMENT_NAMES[r.placement]), r.categoryGuid ? state.collections.catByGuid.get(r.categoryGuid)?.name : '', r.price, r.description].map(csvEscape).join(','));
    await api.writeFile({ path: p, text: lines.join('\r\n') });
    toast('CSV saved', p, 'ok');
  }

  async importCsv() {
    const f = await api.openDialog({ title: 'Metadata CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!f?.[0]) return;
    const rows = parseCsv(await api.readText({ path: f[0] }));
    const head = rows.shift().map((x) => x.trim().toLowerCase());
    const col = (n) => head.indexOf(n);
    const catByName = new Map(state.collections.categories.map((c) => [c.name.toLowerCase(), c.guid]));
    let n = 0;
    for (const line of rows) {
      const file = line[col('file')]?.trim();
      if (!file) continue;
      let r = this.rows.find((x) => x.path === file || x.file === file || x.file === file.split(/[\\/]/).pop());
      if (!r && /[\\/]/.test(file)) { this.addEntries([{ path: file, name: file.split(/[\\/]/).pop() }]); r = this.rows[this.rows.length - 1]; }
      if (!r) continue;
      if (col('name') >= 0 && line[col('name')]) r.name = line[col('name')];
      if (col('price') >= 0) r.price = line[col('price')];
      if (col('description') >= 0) r.description = line[col('description')];
      if (col('placement') >= 0) { const p = line[col('placement')].trim().toLowerCase(); const i = PLACEMENT_NAMES.findIndex((x) => x.toLowerCase() === p); r.placement = i >= 0 ? i : p === 'auto' ? 'auto' : ''; }
      if (col('category') >= 0) { const c = line[col('category')].trim().toLowerCase(); r.categoryGuid = catByName.get(c) || catByName.get('workshop/' + c) || r.categoryGuid; }
      n++;
    }
    this.draw();
    toast('CSV imported', `${n} row(s) matched`, 'ok');
  }
}
