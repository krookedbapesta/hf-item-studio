// The item editor: metadata, model tools, colliders, materials, thumbnail, room and compare.
import * as THREE from 'three';
import { h, clear, btn, toast, seg, switchInput, numberInput, fmtSize, fmtNum, fmtBytes, ask, modal } from '../dom.js';
import { icon } from '../icons.js';
import { api, fileUrl } from '../api.js';
import { state, addRecent, loadReference, loadWorkshopIndex, saveSettings } from '../state.js';
import { ItemProject, slug } from '../item.js';
import { Viewport } from '../../three/viewport.js';
import { CURRENCIES, PLACEMENT, PLACEMENT_NAMES, VISIBILITY } from '../../core/constants.js';
import { MODEL_FILTER, IMAGE_FILTER, ITEM_FILTER, extOf, bundleFromDropped, bytesFromDropped, makeDropTarget } from '../files.js';
import { categoryPicker, categoryLabel, tagPicker, referenceSearch, similarItems, suggestPrice, dims, referenceBuildCard } from './pickers.js';
import { autoOrientForWall, rotateItem, mirrorItem, scaleItem, resizeItem, autoTopSurfaces, applyPivot } from '../../three/tools.js';
import { modelBounds, itemFromContent } from '../../three/hfscene.js';
import { readHfContent } from '../../core/hfcontent.js';
import { pngToDataUrl, imageToThumbnail, THUMB_ANGLES } from '../../three/thumbnail.js';
import { texturePixels } from '../../three/exporter.js';
import { decodeAnyImage } from '../../three/hfscene.js';
import { openPublishDialog } from './publish.js';
import { createVariants } from './variants.js';

const LEFT_TABS = [
  ['details', 'Details'], ['model', 'Model'], ['colliders', 'Colliders'], ['materials', 'Materials'], ['thumb', 'Thumbnail'],
];
const MODES = [
  { value: 'model', label: 'Model', icon: 'cube' },
  { value: 'collision', label: 'Collision', icon: 'collision' },
  { value: 'room', label: 'In a room', icon: 'sofa' },
  { value: 'compare', label: 'Compare', icon: 'compare' },
];

export class EditorView {
  constructor(app) {
    this.app = app;
    this.item = null;
    this.leftTab = 'details';
    this.rightTab = 'checks';
    this.mode = 'model';
    this.selCollider = -1;
    this.compare = [];
    this.roomRefs = [];
  }

  render() {
    this.el = h('div.editor');
    this.top = h('div.ed-top');
    this.left = h('div.ed-left');
    this.right = h('div.ed-right');
    this.vpEl = h('div.vp');
    this.vpWrap = h('div.vp-wrap', this.vpEl);
    this.el.append(this.top, h('div.ed-body', this.left, this.vpWrap, this.right));
    this.viewport = new Viewport(this.vpEl, {
      onSelectCollider: (i) => { this.selCollider = i; if (this.leftTab !== 'colliders') this.leftTab = 'colliders'; this.drawLeft(); },
      onColliderEdited: (i, c) => this.editCollider(i, c, 'Move collider'),
      onRoomMove: (hits) => this.updateRoomStatus(hits),
    });
    this.buildOverlay();
    this.drawAll();
    makeDropTarget(this.vpWrap, (files) => {
      const f = files.find((x) => [...MODEL_FILTER[0].extensions, 'hfcontent'].includes(extOf(x.name)));
      if (f) this.load({ dropped: f, all: files });
    });
    return this.el;
  }

  show() {
    setTimeout(() => this.viewport.resize(), 0);
  }

  // ---------- loading ----------

  async confirmDiscard() {
    if (!this.item?.dirty) return true;
    const r = await api.confirm({ message: `Save changes to "${this.item.meta.name}"?`, buttons: ['Save', "Don't save", 'Cancel'] });
    if (r === 2) return false;
    if (r === 0) await this.save();
    return true;
  }

  async load(loader) {
    if (!(await this.confirmDiscard())) return;
    const busy = this.busy('Loading…');
    try {
      let item;
      if (loader.item) item = loader.item;
      else if (loader.project) item = await ItemProject.openProject(loader.project);
      else if (loader.workshop) {
        const bytes = await api.readFile({ path: loader.workshop.file });
        item = await ItemProject.fromHfContent(bytes, loader.workshop.file, { asCopy: loader.asCopy });
        if (!loader.asCopy) item.meta.guid = loader.workshop.id;
      } else if (loader.dropped) {
        if (extOf(loader.dropped.name) === 'hfcontent') item = await ItemProject.fromHfContent(await bytesFromDropped(loader.dropped), loader.dropped.path || loader.dropped.name);
        else item = await ItemProject.fromModelBundle(await bundleFromDropped(loader.dropped, loader.all || []), { path: loader.dropped.path || loader.dropped.name });
      } else if (loader.path) {
        if (extOf(loader.path) === 'hfcontent') item = await ItemProject.fromHfContent(await api.readFile({ path: loader.path }), loader.path);
        else item = await ItemProject.fromModelPath(loader.path);
      }
      if (!item) return;
      this.setItem(item);
      if (loader.project) addRecent({ kind: 'project', path: loader.project, name: item.meta.name, thumb: loader.project + '\\thumbnail.png' });
      else if (loader.path && !loader.workshop) addRecent({ kind: 'file', path: loader.path, name: item.meta.name });
      if (item.notes.length) toast('Imported', item.notes.join('\n'), 'info', 7000);
      if (item.health?.errors?.length) toast('This item has problems', item.health.errors.slice(0, 4).join('\n'), 'warn', 9000);
    } catch (e) {
      console.error(e);
      toast('Could not open', e.message, 'err', 8000);
    } finally {
      busy();
    }
  }

  setItem(item) {
    this.unsub?.();
    this.item = item;
    this.selCollider = -1;
    this.viewport.selected = -1;
    this.unsub = item.on((what) => this.onItemChanged(what));
    this.viewport.setItem(item.model, item.colliders, item.meta.placement);
    this.viewport.roomPos.set(0, 0, 1.6);
    this.viewport.frame();
    this.drawAll();
  }

  onItemChanged(what) {
    const it = this.item;
    if (what === 'model' || what === 'all') {
      this.viewport.setItem(it.model, it.colliders, it.meta.placement);
    } else if (what === 'colliders') {
      this.viewport.setColliders(it.colliders, this.selCollider);
    } else if (what === 'placement') {
      this.viewport.setItem(it.model, it.colliders, it.meta.placement);
      this.viewport.frame();
    }
    if (what === 'meta-text') { this.drawTop(); this.drawRight(); return; }
    if (what === 'thumbnail' && this.leftTab !== 'thumb') { this.drawTop(); return; }
    this.drawAll();
  }

  busy(text) {
    const ov = h('div.vp-drop', { style: { pointerEvents: 'auto', background: 'rgba(15,17,21,0.55)', zIndex: 20 } }, h('div.card.card-pad.row', h('span.spinner'), text));
    this.vpWrap.appendChild(ov);
    return () => ov.remove();
  }

  // ---------- top bar ----------

  drawAll() {
    this.drawTop();
    this.drawLeft();
    this.drawRight();
    this.drawOverlay();
  }

  drawTop() {
    const t = clear(this.top);
    const it = this.item;
    if (!it) {
      t.append(h('div.title', 'Item editor'), h('div.grow'),
        btn('Open…', () => this.openDialog(), { ic: 'open', cls: 'sm' }));
      return;
    }
    const placement = seg(PLACEMENT_NAMES.map((n, i) => ({ value: i, label: n, icon: ['floor', 'ceiling', 'wall'][i] })), it.meta.placement, (v) => it.setPlacement(v), 'accent');
    t.append(
      it.thumbnail ? h('img', { src: pngToDataUrl(it.thumbnail), style: { width: '30px', height: '30px', borderRadius: '5px', background: '#101318', objectFit: 'contain' } }) : null,
      h('div.title', { title: it.meta.name }, it.meta.name || 'Untitled item'),
      it.dirty ? h('span.dirty', { title: 'Unsaved changes' }, '•') : null,
      it.meta.guid ? h('span.badge.blue', { title: 'Workshop file id' }, '#' + it.meta.guid) : h('span.badge', 'Not published'),
      h('div.grow'),
      h('span.faint.small', 'Placement'),
      placement,
      h('div', { style: { width: '8px' } }),
      btn('', () => { const l = it.undo(); if (l) toast('Undone', l, 'info', 1500); }, { ic: 'undo', cls: 'sm icon ghost', title: 'Undo', disabled: !it.undoStack.length }),
      btn('', () => { const l = it.redo(); if (l) toast('Redone', l, 'info', 1500); }, { ic: 'redo', cls: 'sm icon ghost', title: 'Redo', disabled: !it.redoStack.length }),
      btn('Open', () => this.openDialog(), { ic: 'open', cls: 'sm' }),
      btn('Save', () => this.save(), { ic: 'save', cls: 'sm', title: 'Save project (Ctrl+S)' }),
      btn('Export .hfcontent', () => this.exportAs(), { ic: 'download', cls: 'sm' }),
      btn('Publish', () => this.publish(), { ic: 'steam', cls: 'sm primary' }),
    );
  }

  async openDialog() {
    const files = await api.openDialog({ title: 'Open a model, .hfcontent or project.json', filters: [...MODEL_FILTER, { name: 'Projects', extensions: ['json'] }] });
    if (!files?.[0]) return;
    const p = files[0];
    if (p.toLowerCase().endsWith('project.json')) this.load({ project: p.replace(/[\\/]project\.json$/i, '') });
    else this.load({ path: p });
  }

  async save() {
    if (!this.item) return;
    const busy = this.busy('Saving…');
    try {
      const r = await this.item.save();
      addRecent({ kind: 'project', path: r.dir, name: this.item.meta.name, thumb: r.dir + '\\thumbnail.png' });
      toast('Saved', `${r.file}\n${fmtBytes(r.bytes.length)}${r.report.notes.length ? '\n' + r.report.notes.join('\n') : ''}`, 'ok', 5000);
      return r;
    } catch (e) {
      toast('Save failed', e.message, 'err', 8000);
    } finally { busy(); }
  }

  async exportAs() {
    if (!this.item) return;
    const p = await api.saveDialog({ title: 'Export .hfcontent', defaultPath: `${state.settings.projectsDir}\\${this.item.fileName()}`, filters: ITEM_FILTER });
    if (!p) return;
    const busy = this.busy('Exporting…');
    try {
      const out = await this.item.exportTo(p);
      toast('Exported', `${p}\n${fmtBytes(out.bytes.length)} · ${out.report.meshes} meshes${out.report.warnings.length ? '\n' + out.report.warnings.join('\n') : ''}`, out.report.warnings.length ? 'warn' : 'ok', 7000);
    } catch (e) { toast('Export failed', e.message, 'err', 8000); } finally { busy(); }
  }

  publish() {
    if (!this.item) return;
    const errors = this.item.checks().filter((c) => c.level === 'error');
    if (errors.length) { toast('Fix these first', errors.map((e) => '• ' + e.text).join('\n'), 'err', 7000); this.rightTab = 'checks'; this.drawRight(); return; }
    openPublishDialog(this.item, { onDone: () => this.drawAll(), save: () => this.save() });
  }

  // ---------- viewport overlay ----------

  buildOverlay() {
    this.ovModes = h('div.vp-modes');
    this.ovTools = h('div.vp-tools');
    this.ovViews = h('div.vp-views');
    this.ovInfo = h('div.vp-info');
    this.ovHint = h('div.vp-hint.hidden');
    this.ovEmpty = h('div.vp-drop');
    this.vpWrap.append(this.ovModes, this.ovTools, this.ovViews, this.ovInfo, this.ovHint, this.ovEmpty);
  }

  setMode(m) {
    this.mode = m;
    if (m === 'room') { this.rightTab = 'room'; this.viewport.setRoomExtras({ refs: this.roomRefs.map((r) => r.data) }); }
    else if (m === 'compare') { this.rightTab = 'compare'; this.viewport.setCompareItems(this.compare.map((c) => c.data)); }
    else if (this.rightTab === 'room' || this.rightTab === 'compare') this.rightTab = 'checks';
    if (m === 'collision' && this.leftTab !== 'colliders') this.leftTab = 'colliders';
    this.viewport.setMode(m);
    this.drawAll();
  }

  drawOverlay() {
    const it = this.item;
    clear(this.ovModes).appendChild(seg(MODES, this.mode, (v) => this.setMode(v)));
    const vp = this.viewport;
    const tool = (ic, title, on, fn) => h('button.btn.sm.icon' + (on ? '.on' : ''), { title, onclick: fn }, icon(ic));
    clear(this.ovTools).append(
      tool('collision', 'Show colliders', vp.showColliders, () => { vp.setVisibility({ colliders: !vp.showColliders }); this.drawOverlay(); }),
      tool('ruler', 'Show dimensions', vp.showDims, () => { vp.setVisibility({ dims: !vp.showDims }); this.drawOverlay(); }),
      tool('eye', 'X-ray model', vp.xray, () => { vp.setVisibility({ xray: !vp.xray }); this.drawOverlay(); }),
      tool('target', 'Frame item', false, () => vp.frame()),
      this.mode === 'collision' ? h('div', { style: { height: '6px' } }) : null,
      this.mode === 'collision' ? tool('move', 'Move selected collider', (vp.gizmoMode || 'translate') === 'translate', () => { vp.setGizmoMode('translate'); this.drawOverlay(); }) : null,
      this.mode === 'collision' ? tool('scale', 'Resize selected collider', vp.gizmoMode === 'scale', () => { vp.setGizmoMode('scale'); this.drawOverlay(); }) : null,
    );
    clear(this.ovViews);
    if (this.mode === 'model' || this.mode === 'collision') {
      this.ovViews.appendChild(h('div.seg.sm', ['front', 'left', 'right', 'back', 'top', 'three'].map((v) => h('button', { onclick: () => vp.view(v) }, v === 'three' ? '3/4' : v[0].toUpperCase() + v.slice(1)))));
    }
    if (this.mode === 'room') {
      this.ovViews.appendChild(h('div.btn-row',
        btn('', () => { vp.rotateInRoom(-90); }, { ic: 'rotate', cls: 'sm icon', title: 'Rotate item 90°' }),
        btn('Reset view', () => vp.frame(), { cls: 'sm' })));
    }
    const hint = { collision: 'Click a collider to select it. Drag the gizmo to move or resize.', room: 'Drag the item to move it along the ' + ['floor', 'ceiling', 'wall'][it?.meta.placement ?? 0] + '. Red colliders hit something.', compare: 'Add base-game or workshop items in the panel on the right.' }[this.mode];
    this.ovHint.textContent = hint || '';
    this.ovHint.classList.toggle('hidden', !hint || !it);
    clear(this.ovEmpty);
    this.ovEmpty.classList.toggle('hidden', !!it);
    if (!it) {
      const dz = h('div.dropzone', h('div', { style: { fontSize: '15px', fontWeight: 600 } }, 'Drop a 3D model or .hfcontent'), h('div.small', { style: { margin: '6px 0 12px' } }, 'or'), btn('Choose a file…', () => this.openDialog(), { cls: 'primary', ic: 'open' }));
      this.ovEmpty.appendChild(dz);
    }
    this.drawInfo();
  }

  drawInfo() {
    const it = this.item;
    clear(this.ovInfo);
    this.ovInfo.classList.toggle('hidden', !it);
    if (!it) return;
    const s = modelBounds(it.model).getSize(new THREE.Vector3());
    this.ovInfo.append(h('div', h('b', `${fmtSize(s.x)} × ${fmtSize(s.y)} × ${fmtSize(s.z)}`), h('span.faint', '  W × H × D')),
      h('div.small', `${it.colliders.length} collider${it.colliders.length === 1 ? '' : 's'} · ${PLACEMENT_NAMES[it.meta.placement]} item`));
  }

  // ---------- left panel ----------

  drawLeft() {
    const l = clear(this.left);
    if (!this.item) { l.appendChild(h('div.tab-body', h('div.empty', icon('cube'), h('p', 'Open or drop a model to start.')))); return; }
    l.appendChild(h('div.tabs', LEFT_TABS.map(([id, label]) => h('button' + (this.leftTab === id ? '.on' : ''), { onclick: () => { this.leftTab = id; this.drawLeft(); } }, label,
      id === 'colliders' ? h('span.badge', String(this.item.colliders.length)) : null))));
    const body = h('div.tab-body');
    l.appendChild(body);
    ({ details: () => this.tabDetails(body), model: () => this.tabModel(body), colliders: () => this.tabColliders(body), materials: () => this.tabMaterials(body), thumb: () => this.tabThumb(body) })[this.leftTab]();
  }

  section(title, ...content) {
    return h('div.section', h('div.section-title', title, h('div.line')), ...content);
  }

  tabDetails(body) {
    const it = this.item, m = it.meta;
    const text = (key, el) => { el.addEventListener('input', () => { m[key] = el.value; it.dirty = true; it.changed('meta-text'); }); return el; };
    const templates = state.settings.templates || [];
    body.append(
      h('label.field', h('span', 'Item name'), text('name', h('input.input', { value: m.name, maxlength: 128 }))),
      templates.length ? h('label.field', h('span', 'Apply template'), h('select.input', {
        onchange: (e) => { const t = templates[e.target.value]; if (t) { it.applyTemplate(t); toast('Template applied', t.name, 'ok', 2000); } },
      }, h('option', { value: '' }, 'Choose a template…'), templates.map((t, i) => h('option', { value: i }, t.name)))) : null,
      h('div.grid2',
        h('label.field', h('span', 'Price'), numberInput(m.price, (v) => { it.checkpoint('Price'); m.price = Math.max(0, v); it.changed('meta-text'); }, { step: 1, digits: 2, cls: '' })),
        h('label.field', h('span', 'Currency'), h('select.input', { onchange: (e) => { m.currency = +e.target.value; it.changed('meta-text'); } },
          CURRENCIES.map((c) => h('option', { value: c.id, selected: c.id === m.currency }, c.code))))),
      h('div.field-hint', { style: { marginTop: '-6px', marginBottom: '10px' } }, 'Stored in PLN like the official kit. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.suggestPriceInline(); } }, 'Suggest a price from similar base-game items')),
      this.section('Category', h('div.small.muted', { style: { marginBottom: '6px' } }, m.categoryGuid ? categoryLabel(m.categoryGuid) : 'None selected'),
        categoryPicker(m.categoryGuid, (g) => { it.checkpoint('Category'); m.categoryGuid = g; it.changed('meta'); })),
      this.section('Placement options',
        h('label.check', h('input', { type: 'checkbox', checked: m.canBePlacedOn, onchange: (e) => { it.checkpoint('Can be placed on'); m.canBePlacedOn = e.target.checked; it.changed('meta'); } }), 'Can be placed on other items (tables, shelves)'),
        h('label.check', h('input', { type: 'checkbox', checked: it.colliders.some((c) => c.canPutOnTop), onchange: (e) => this.setCanPutOnTop(e.target.checked) }), 'Other items can be put on top of this one'),
        h('div.field-hint', 'Only exposed, flat collider tops become surfaces. Fine-tune per collider in the Colliders tab.')),
      this.section('Tags', tagPicker(m.tagGuids, (g) => { it.checkpoint('Tags'); m.tagGuids = g; it.changed('meta-text'); }, { placement: m.placement, canBePlacedOn: m.canBePlacedOn })),
      this.section('Description', text('description', h('textarea.input', { value: m.description, rows: 4, placeholder: 'Shown on the Steam Workshop page' })),
        h('div.field-hint', `${m.description.length} / 8000`)),
    );
  }

  setCanPutOnTop(on) {
    const it = this.item;
    it.checkpoint('Can put items on top');
    it.colliders = on ? autoTopSurfaces(it.colliders) : it.colliders.map((c) => ({ ...c, canPutOnTop: false }));
    if (on && !it.colliders.some((c) => c.canPutOnTop) && it.colliders.length) {
      // nothing qualified; use the highest box
      let best = 0;
      it.colliders.forEach((c, i) => { if (c.center[1] + (c.size?.[1] || 0) / 2 > it.colliders[best].center[1] + (it.colliders[best].size?.[1] || 0) / 2) best = i; });
      it.colliders[best] = { ...it.colliders[best], canPutOnTop: true };
    }
    it.changed('colliders');
  }

  async suggestPriceInline() {
    const ref = await loadReference();
    if (ref.missing) {
      modal({ title: 'Price suggestion', body: referenceBuildCard(() => { document.querySelector('.modal-back')?.remove(); this.suggestPriceInline(); }) });
      return;
    }
    const s = modelBounds(this.item.model).getSize(new THREE.Vector3());
    const sim = similarItems(ref, [s.x, s.y, s.z], { hanging: this.item.meta.placement === PLACEMENT.Wall, limit: 15 });
    const p = suggestPrice(sim);
    if (!p) { toast('No similar items found', '', 'warn'); return; }
    const rate = CURRENCIES[this.item.meta.currency].rate;
    // base-game prices are in-game dollars; the kit stores PLN and the game shows it 1:1
    const inCur = (v) => Math.round((v / rate) * 100) / 100;
    modal({
      title: 'Price suggestion',
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } }, `Based on ${sim.length} base-game items of a similar size. In-game prices are shown as the game shows them.`),
        h('div.grid3', h('div.stat', h('b', '$' + p.low), h('span', 'Low')), h('div.stat', h('b', '$' + p.median), h('span', 'Typical')), h('div.stat', h('b', '$' + p.high), h('span', 'High'))),
        h('table.tbl', { style: { marginTop: '12px' } }, h('tr', h('th', 'Item'), h('th', 'Size'), h('th', 'Price')),
          sim.map((r) => h('tr', h('td', r.name), h('td.num', dims(r.size)), h('td.num', '$' + r.price))))),
      foot: (close) => [btn('Close', close), btn(`Use $${p.median}`, () => { this.item.checkpoint('Price'); this.item.meta.price = inCur(p.median); this.item.changed('meta'); close(); }, { cls: 'primary' })],
    });
  }

  tabModel(body) {
    const it = this.item;
    const st = it.stats();
    const stat = (v, label, cls = '') => h('div.stat' + (cls ? '.' + cls : ''), h('b', v), h('span', label));
    body.append(this.section('Statistics', h('div.stat-grid',
      stat(fmtNum(st.vertices), 'Vertices', st.vertices >= 65535 ? 'warn' : ''),
      stat(fmtNum(Math.round(st.triangles)), 'Triangles', st.triangles >= 65535 ? 'warn' : ''),
      stat(st.meshes, 'Meshes'),
      stat(st.materials, 'Materials'),
      stat(st.textures.length, 'Textures'),
      stat(st.maxTex ? st.maxTex + 'px' : '—', 'Largest tex', st.maxTex > it.settings.maxTextureSize ? 'warn' : ''))));

    // size editor
    const size = st.size;
    const vals = { x: size.x * 100, y: size.y * 100, z: size.z * 100 };
    let lock = true;
    const inputs = {};
    const setAxis = (ax, v) => {
      const target = { x: vals.x, y: vals.y, z: vals.z };
      if (lock) { const f = v / (vals[ax] || 1); target.x *= f; target.y *= f; target.z *= f; } else target[ax] = v;
      it.geometryOp('Resize', (model, cols) => resizeItem(model, cols, { x: target.x / 100, y: target.y / 100, z: target.z / 100 }, { uniform: false }));
    };
    for (const ax of ['x', 'y', 'z']) inputs[ax] = numberInput(vals[ax], (v) => setAxis(ax, v), { step: 1, digits: 1 });
    const lockBtn = btn('', () => { lock = !lock; lockBtn.replaceChildren(icon(lock ? 'lock' : 'unlock')); }, { ic: 'lock', cls: 'sm icon', title: 'Keep proportions' });
    body.append(this.section('Size (cm)',
      h('div.row', h('div.grow', h('div.field-label', 'Width'), inputs.x), h('div.grow', h('div.field-label', 'Height'), inputs.y), h('div.grow', h('div.field-label', 'Depth'), inputs.z), h('div', { style: { paddingTop: '16px' } }, lockBtn)),
      h('div.btn-row', { style: { marginTop: '8px' } },
        h('span.faint.small', 'Quick scale'),
        ...[['× 0.01', 0.01], ['× 0.1', 0.1], ['× 0.5', 0.5], ['× 2', 2], ['× 10', 10], ['× 100', 100]].map(([l, f]) => btn(l, () => it.geometryOp('Scale ' + l, (m, c) => scaleItem(m, c, f)), { cls: 'xs' })))));

    const rot = (axis, deg) => btn(`${axis.toUpperCase()} ${deg > 0 ? '+' : ''}${deg}°`, () => it.geometryOp(`Rotate ${axis} ${deg}`, (m, c) => rotateItem(m, c, axis, deg)), { cls: 'xs' });
    body.append(this.section('Orientation',
      h('div.grid3', rot('x', -90), rot('x', 90), rot('x', 180), rot('y', -90), rot('y', 90), rot('y', 180), rot('z', -90), rot('z', 90), rot('z', 180)),
      h('div.btn-row', { style: { marginTop: '8px' } },
        btn('Mirror X', () => it.geometryOp('Mirror X', (m, c) => mirrorItem(m, c, 'x')), { cls: 'xs', ic: 'flip' }),
        btn('Mirror Z', () => it.geometryOp('Mirror Z', (m, c) => mirrorItem(m, c, 'z')), { cls: 'xs', ic: 'flip' }),
        btn('Turn around', () => it.geometryOp('Turn around', (m, c) => rotateItem(m, c, 'y', 180)), { cls: 'xs', ic: 'rotate', title: 'Swap front and back' })),
      it.meta.placement === PLACEMENT.Wall ? h('div', { style: { marginTop: '8px' } },
        btn('Auto-orient for wall', () => it.geometryOp('Auto-orient', (m, c) => { const r = autoOrientForWall(m, c); toast('Wall orientation', r.steps.join('\n') || 'Already oriented', 'info'); return r; }), { cls: 'sm', ic: 'wand' }),
        h('div.field-hint', { style: { marginTop: '4px' } }, 'Puts the thinnest side against the wall and the flat back facing it.')) : null));

    body.append(this.section('Pivot',
      h('div.small.muted', { style: { marginBottom: '6px' } }, {
        0: 'Floor items: pivot at the bottom centre, resting on y = 0.',
        1: 'Ceiling items: pivot at the top centre, hanging from y = 0.',
        2: 'Wall items: pivot on the back face (z = 0), centred left to right.',
      }[it.meta.placement]),
      it.meta.placement === PLACEMENT.Wall ? h('div.row', { style: { marginBottom: '6px' } }, h('span.faint.small', 'Vertical anchor'),
        seg([{ value: 'center', label: 'Centre' }, { value: 'bottom', label: 'Bottom' }], it.settings.wallVertical, (v) => { it.settings.wallVertical = v; it.geometryOp('Pivot', (m, c) => c); }, 'sm')) : null,
      btn('Apply pivot rule', () => it.geometryOp('Apply pivot', (m, c) => c), { cls: 'sm', ic: 'target' })));

    const meshes = [];
    it.model.traverse((o) => { if (o.isMesh) meshes.push(o); });
    body.append(this.section(`Parts (${meshes.length})`, h('div', meshes.map((o) => {
      const v = o.geometry.getAttribute('position').count, t = Math.round((o.geometry.getIndex()?.count ?? v) / 3);
      const over = v > 64000 || t > 64000;
      return h('div.row', { style: { padding: '4px 0', borderBottom: '1px solid var(--line)' } },
        h('label.check.grow', { title: o.name }, h('input', { type: 'checkbox', checked: o.visible, onchange: (e) => { o.visible = e.target.checked; it.changed('model'); } }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, o.name || 'Mesh')),
        h('span.mono.faint', `${fmtNum(t)} tris`), over ? h('span.badge.yellow', { title: 'Will be split on export' }, 'split') : null,
        btn('', () => { it.checkpoint('Delete part', true); o.parent.remove(o); it.changed('model'); }, { ic: 'trash', cls: 'xs ghost', title: 'Delete this part' }));
    })), h('div.field-hint', { style: { marginTop: '6px' } }, 'Hidden parts are left out of the export.')));

    if (it.notes.length) body.append(this.section('Import notes', h('div.small.muted', { style: { whiteSpace: 'pre-line' } }, it.notes.join('\n'))));
  }

  editCollider(i, c, label) {
    const it = this.item;
    it.checkpoint(label);
    it.colliders = i >= it.colliders.length ? [...it.colliders, c] : it.colliders.map((x, k) => (k === i ? c : x));
    it.changed('colliders');
  }

  tabColliders(body) {
    const it = this.item;
    const s = it.settings;
    const modeSeg = seg([{ value: 'fit', label: 'Smart fit' }, { value: 'perMesh', label: 'Per part' }, { value: 'single', label: 'One box' }], s.colliderMode, (v) => { s.colliderMode = v; }, 'sm');
    const boxesInp = numberInput(s.maxBoxes, (v) => { s.maxBoxes = Math.max(1, Math.min(32, Math.round(v))); }, { step: 1, digits: 0 });
    boxesInp.style.width = '60px';
    body.append(this.section('Generate',
      h('div.row', modeSeg),
      h('div.row', { style: { marginTop: '8px' } }, h('span.small.muted', 'Max boxes'), boxesInp, h('div.grow'),
        btn('Generate', () => { it.regenerateColliders(); this.selCollider = -1; toast('Colliders generated', `${it.colliders.length} box${it.colliders.length === 1 ? '' : 'es'}`, 'ok', 1800); }, { cls: 'sm primary', ic: 'wand' })),
      h('div.field-hint', { style: { marginTop: '6px' } }, 'Smart fit voxelises the model and merges the voxels into a few boxes, so legs, shelves and L-shapes get proper collision.')));

    const p = it.meta.placement;
    const gapInp = numberInput(s.wallGapMm, (v) => { s.wallGapMm = Math.max(0, v); }, { step: 1, digits: 1 });
    const insetInp = numberInput(s.insetMm, (v) => { s.insetMm = Math.max(0, v); }, { step: 1, digits: 1 });
    gapInp.style.width = insetInp.style.width = '70px';
    body.append(this.section(p === PLACEMENT.Wall ? 'Wall fit' : p === PLACEMENT.Ceiling ? 'Ceiling fit' : 'Floor fit',
      h('div.small.muted', { style: { marginBottom: '8px' } }, p === PLACEMENT.Wall
        ? 'The model stays flush with the wall; the colliders start a few millimetres in front of it so the game does not see the wall as a collision.'
        : p === PLACEMENT.Ceiling ? 'Colliders stop a few millimetres below the ceiling.' : 'Colliders start at the floor. Inset shrinks them so the item fits snugly between others.'),
      h('div.row', p !== PLACEMENT.Floor ? [h('span.small', 'Gap (mm)'), gapInp] : null, h('span.small', 'Side inset (mm)'), insetInp),
      h('div.btn-row', { style: { marginTop: '8px' } }, btn(p === PLACEMENT.Wall ? 'Apply wall fit' : 'Apply fit', () => { it.fitToSurface(); toast('Colliders fitted', '', 'ok', 1500); }, { cls: 'sm', ic: 'target' }),
        btn('Thicken thin boxes', () => it.thickenColliders(), { cls: 'sm' }))));

    const list = h('div.col-list');
    const hits = new Set((this.viewport.lastCollisions || []).map((x) => x.collider));
    it.colliders.forEach((c, i) => {
      const sel = i === this.selCollider;
      const row = h('div.col-row' + (sel ? '.sel' : '') + (hits.has(i) ? '.bad' : ''), {
        onclick: (e) => { if (e.target.closest('input,button,select')) return; this.selCollider = i; this.viewport.selected = i; this.viewport.rebuildColliders(); this.drawLeft(); },
      });
      row.appendChild(h('div.head',
        h('span.swatch', { style: { background: c.canPutOnTop ? 'var(--blue)' : 'var(--green)' } }),
        h('b', `${c.type === 'box' ? 'Box' : c.type === 'sphere' ? 'Sphere' : 'Capsule'} ${i + 1}`),
        c.matrix ? h('span.badge', { title: 'Rotated: edit by regenerating' }, 'rotated') : null,
        h('div.grow'),
        h('label.check.small', { title: 'Other items can stand on this collider' }, h('input', { type: 'checkbox', checked: c.canPutOnTop, onchange: (e) => this.editCollider(i, { ...c, canPutOnTop: e.target.checked }, 'Toggle surface') }), 'surface'),
        btn('', () => this.editCollider(it.colliders.length, { ...c, center: [c.center[0] + 0.05, c.center[1], c.center[2]] }, 'Duplicate collider'), { ic: 'copy', cls: 'xs ghost', title: 'Duplicate' }),
        btn('', () => { it.checkpoint('Delete collider'); it.colliders = it.colliders.filter((_, k) => k !== i); this.selCollider = -1; it.changed('colliders'); }, { ic: 'trash', cls: 'xs ghost', title: 'Delete' })));
      if (sel && !c.matrix) {
        const vecRow = (label, arr, key, step) => h('div.vec', h('span', label), arr.map((v, k) => numberInput(v * 100, (nv) => {
          const n = [...arr]; n[k] = nv / 100;
          this.editCollider(i, { ...c, [key]: n }, 'Edit collider');
        }, { step, digits: 1 })));
        row.appendChild(vecRow('Centre', c.center, 'center', 0.5));
        if (c.type === 'box') row.appendChild(vecRow('Size', c.size, 'size', 0.5));
        else {
          row.appendChild(h('div.vec', h('span', 'Radius'), numberInput(c.radius * 100, (v) => this.editCollider(i, { ...c, radius: v / 100 }, 'Edit collider'), { step: 0.5, digits: 1 })));
          if (c.type === 'capsule') row.appendChild(h('div.vec', h('span', 'Height'), numberInput(c.height * 100, (v) => this.editCollider(i, { ...c, height: v / 100 }, 'Edit collider'), { step: 0.5, digits: 1 })));
        }
        row.appendChild(h('div.field-hint', { style: { marginTop: '4px' } }, 'Values in cm. Scroll on a focused field to nudge, Shift for ×10.'));
      }
      list.appendChild(row);
    });
    body.append(this.section(`Colliders (${it.colliders.length})`, list,
      h('div.btn-row', { style: { marginTop: '8px' } },
        btn('Add box', () => {
          const b = modelBounds(it.model);
          const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3()).multiplyScalar(0.5);
          this.selCollider = it.colliders.length;
          this.editCollider(it.colliders.length, { type: 'box', center: c.toArray(), size: sz.toArray(), canPutOnTop: false, matrix: null }, 'Add collider');
        }, { ic: 'plus', cls: 'sm' }),
        this.mode !== 'collision' ? btn('Edit in 3D', () => this.setMode('collision'), { ic: 'collision', cls: 'sm' }) : null)));
  }

  tabMaterials(body) {
    const it = this.item;
    const mats = new Map();
    it.model.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!mats.has(m)) mats.set(m, []); });
    it.model.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.get(m).push(o.name); });
    const touch = (m, label) => { it.checkpoint(label); m.userData.dirty = true; m.needsUpdate = true; if (it.settings.thumbAuto) it.renderThumb(); it.changed('materials'); };
    const list = h('div');
    for (const [m] of mats) {
      const hex = '#' + m.color.getHexString(THREE.SRGBColorSpace);
      const chip = h('div.mat-chip', { style: { background: hex } });
      if (m.map) {
        try {
          const px = texturePixels(m.map);
          if (px) {
            const c = document.createElement('canvas'); c.width = px.width; c.height = px.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data.buffer.slice(0)), px.width, px.height), 0, 0);
            chip.style.backgroundImage = `url(${c.toDataURL()})`;
          }
        } catch { /* preview only */ }
      }
      const maps = ['map', 'normalMap', 'metalnessMap', 'aoMap', 'emissiveMap'].filter((k) => m[k]).map((k) => ({ map: 'Colour', normalMap: 'Normal', metalnessMap: 'Metal/Rough', aoMap: 'AO', emissiveMap: 'Emission' }[k]));
      const details = h('div', { style: { gridColumn: '1 / -1' } },
        h('div.row', { style: { marginTop: '4px' } }, h('span.small.muted', { style: { width: '72px' } }, 'Tint'),
          h('input', { type: 'color', value: hex, onchange: (e) => { m.color.setStyle(e.target.value, THREE.SRGBColorSpace); touch(m, 'Material colour'); } }),
          h('span.small.faint', m.map ? 'multiplies the texture' : 'base colour')),
        h('div.row', h('span.small.muted', { style: { width: '72px' } }, 'Roughness'), h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: m.roughness, onchange: (e) => { m.roughness = +e.target.value; touch(m, 'Roughness'); } })),
        h('div.row', h('span.small.muted', { style: { width: '72px' } }, 'Metallic'), h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: m.metalness, onchange: (e) => { m.metalness = +e.target.value; touch(m, 'Metallic'); } })),
        h('div.row', h('span.small.muted', { style: { width: '72px' } }, 'Opacity'), h('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: m.opacity, onchange: (e) => { m.opacity = +e.target.value; m.transparent = m.opacity < 0.999; m.depthWrite = !m.transparent; touch(m, 'Opacity'); } })),
        h('div.btn-row', { style: { marginTop: '4px' } },
          btn(m.map ? 'Replace texture' : 'Add texture', () => this.replaceTexture(m, 'map'), { cls: 'xs', ic: 'image' }),
          m.map ? btn('Remove', () => { m.map = null; touch(m, 'Remove texture'); }, { cls: 'xs ghost' }) : null,
          btn(m.normalMap ? 'Replace normal' : 'Add normal map', () => this.replaceTexture(m, 'normalMap'), { cls: 'xs' })));
      list.appendChild(h('div.mat-row', chip,
        h('div', { style: { minWidth: 0 } }, h('b', { style: { display: 'block', fontSize: '12.3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.name || 'Material'),
          h('span.faint.small', maps.join(' · ') || 'no textures'), m.userData.hf && !m.userData.dirty ? h('span.badge', { style: { marginLeft: '6px' } }, 'original') : null),
        h('span'), details));
    }
    body.append(this.section(`Materials (${mats.size})`, list));
    const s = it.settings;
    body.append(this.section('Texture output',
      h('div.row', h('span.small.muted', 'Max size'), h('select.input.sm', { style: { width: '100px' }, onchange: (e) => { s.maxTextureSize = +e.target.value; it.changed('meta'); } },
        [512, 1024, 2048, 4096].map((v) => h('option', { value: v, selected: v === s.maxTextureSize }, v + ' px'))),
      h('label.check.small', h('input', { type: 'checkbox', checked: s.powerOfTwo, onchange: (e) => { s.powerOfTwo = e.target.checked; } }), 'Power of two')),
      h('div.field-hint', { style: { marginTop: '4px' } }, 'Bigger textures are downscaled on export. Original materials from .hfcontent files are copied unchanged unless you edit them.')));
    body.append(this.section('Variants',
      h('div.small.muted', { style: { marginBottom: '8px' } }, 'Make colour versions of this item in one go. Each one is saved as its own project with a matching colour tag.'),
      btn('Create colour variants…', () => createVariants(this.item, { onDone: () => this.app.go('library') }), { cls: 'sm', ic: 'palette' })));
  }

  async replaceTexture(mat, slot) {
    const files = await api.openDialog({ title: 'Choose an image', filters: IMAGE_FILTER });
    if (!files?.[0]) return;
    const bytes = await api.readFile({ path: files[0] });
    const img = await decodeAnyImage(bytes);
    // decoded rows are top-first; a DataTexture samples row 0 at v = 0, so store them bottom-first
    const flipped = new Uint8Array(img.data.length);
    const row = img.width * 4;
    for (let y = 0; y < img.height; y++) flipped.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
    const tex = new THREE.DataTexture(flipped, img.width, img.height, THREE.RGBAFormat);
    tex.colorSpace = slot === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    this.item.checkpoint('Replace texture');
    mat[slot] = tex;
    mat.userData.dirty = true;
    mat.needsUpdate = true;
    if (this.item.settings.thumbAuto) this.item.renderThumb();
    this.item.changed('materials');
  }

  tabThumb(body) {
    const it = this.item, s = it.settings;
    const img = h('div.thumb-preview', it.thumbnail ? h('img', { src: pngToDataUrl(it.thumbnail) }) : h('span.faint', 'No thumbnail'));
    const rerender = () => { it.renderThumb(); this.drawLeft(); };
    body.append(
      img,
      h('div.row', { style: { margin: '8px 0 14px', gap: '10px' } },
        it.thumbnail ? h('img', { src: pngToDataUrl(it.thumbnail), style: { width: '64px', height: '64px', borderRadius: '6px', background: '#e8e4dc' } }) : null,
        h('div.small.muted', '256 × 256 PNG, used in the in-game shop and as the Steam preview.')),
      this.section('Camera',
        seg(Object.keys(THUMB_ANGLES).map((k) => ({ value: k, label: k === 'three-quarter' ? '3/4' : k[0].toUpperCase() + k.slice(1) })), s.thumbAngle, (v) => { s.thumbAngle = v; rerender(); }, 'sm'),
        h('div.btn-row', { style: { marginTop: '8px' } },
          btn('Use current 3D view', () => {
            const cam = this.viewport.camera;
            it.renderThumb({ camera: { position: cam.position.clone(), target: this.viewport.controls.target.clone() } });
            s.thumbAuto = false;
            this.drawLeft();
          }, { cls: 'sm', ic: 'camera' }))),
      this.section('Background',
        seg([{ value: 'transparent', label: 'Transparent' }, { value: '#ffffff', label: 'White' }, { value: 'gradient', label: 'Studio' }, { value: '#2b2f36', label: 'Dark' }],
          s.thumbBackground, (v) => { s.thumbBackground = v; rerender(); }, 'sm')),
      this.section('Source',
        h('label.check', h('input', { type: 'checkbox', checked: s.thumbAuto, onchange: (e) => { s.thumbAuto = e.target.checked; if (s.thumbAuto) rerender(); } }), 'Re-render automatically when the model changes'),
        h('div.btn-row', { style: { marginTop: '6px' } },
          btn('Render now', rerender, { cls: 'sm primary', ic: 'camera' }),
          btn('Use an image…', async () => {
            const f = await api.openDialog({ title: 'Thumbnail image', filters: IMAGE_FILTER });
            if (!f?.[0]) return;
            it.checkpoint('Custom thumbnail');
            it.thumbnail = await imageToThumbnail(await api.readFile({ path: f[0] }));
            s.thumbAuto = false;
            it.changed('thumbnail');
            this.drawLeft();
          }, { cls: 'sm', ic: 'image' }),
          it.thumbnail ? btn('Save PNG…', async () => {
            const p = await api.saveDialog({ title: 'Save thumbnail', defaultPath: `${slug(it.meta.name)}.png`, filters: IMAGE_FILTER });
            if (p) { await api.writeFile({ path: p, bytes: it.thumbnail }); toast('Saved', p, 'ok'); }
          }, { cls: 'sm' }) : null)),
    );
  }

  // ---------- right panel ----------

  drawRight() {
    const r = clear(this.right);
    if (!this.item) return;
    const checks = this.item.checks();
    const errs = checks.filter((c) => c.level === 'error').length, warns = checks.filter((c) => c.level === 'warn').length;
    r.appendChild(h('div.tabs',
      h('button' + (this.rightTab === 'checks' ? '.on' : ''), { onclick: () => { this.rightTab = 'checks'; this.drawRight(); } }, 'Checks',
        errs ? h('span.badge.red', String(errs)) : warns ? h('span.badge.yellow', String(warns)) : h('span.badge.green', '✓')),
      h('button' + (this.rightTab === 'room' ? '.on' : ''), { onclick: () => this.setMode('room') }, 'Room'),
      h('button' + (this.rightTab === 'compare' ? '.on' : ''), { onclick: () => this.setMode('compare') }, 'Compare')));
    const body = h('div.tab-body');
    r.appendChild(body);
    if (this.rightTab === 'checks') this.panelChecks(body, checks);
    else if (this.rightTab === 'room') this.panelRoom(body);
    else this.panelCompare(body);
  }

  panelChecks(body, checks) {
    const ico = { error: 'error', warn: 'alert', info: 'info', ok: 'check' };
    body.appendChild(h('div.checks', checks.map((c) => h('div.check-item.' + c.level, icon(ico[c.level], 'ico'),
      h('div', c.text, c.fix ? h('div.fix', btn(c.fixLabel || 'Fix', () => this.applyFix(c.fix), { cls: 'xs' })) : null)))));
    const it = this.item;
    if (it.health && (it.health.errors.length || it.health.warnings.length)) {
      body.appendChild(this.section('Original file', h('div.small.muted', { style: { whiteSpace: 'pre-line' } },
        [...it.health.errors.map((e) => '✖ ' + e), ...it.health.warnings.slice(0, 8).map((w) => '⚠ ' + w)].join('\n'))));
    }
    body.appendChild(this.section('Shortcuts', h('div.small.muted', h('div', h('span.kbd', 'Ctrl'), ' + ', h('span.kbd', 'S'), '  save project'), h('div', 'Drop a file on the viewport to open it'))));
  }

  applyFix(fix) {
    const it = this.item;
    switch (fix) {
      case 'pivot': it.geometryOp('Apply pivot', (m, c) => c); break;
      case 'wallfit': it.fitToSurface(); break;
      case 'thicken': it.thickenColliders(); break;
      case 'colliders': it.regenerateColliders(); break;
      case 'thumb': it.renderThumb(); break;
      case 'scaleDown': it.geometryOp('Scale ÷ 100', (m, c) => scaleItem(m, c, 0.01)); break;
      case 'scaleUp': it.geometryOp('Scale × 100', (m, c) => scaleItem(m, c, 100)); break;
      case 'toWall': it.setPlacement(PLACEMENT.Wall); break;
      case 'category': case 'tags': this.leftTab = 'details'; this.drawLeft(); break;
      default: break;
    }
  }

  updateRoomStatus(hits) {
    this.roomHits = hits;
    if (this.rightTab === 'room' && this.roomStatusEl) this.drawRoomStatus();
  }

  drawRoomStatus() {
    const el = clear(this.roomStatusEl);
    const hits = this.roomHits || [];
    const vp = this.viewport;
    const p = vp.roomPos;
    el.append(h('div.small.faint', { style: { marginBottom: '6px' } }, `Position x ${p.x.toFixed(2)} m · ${this.item.meta.placement === PLACEMENT.Wall ? `height ${p.y.toFixed(2)} m` : `z ${p.z.toFixed(2)} m`}`));
    if (!hits.length) el.append(h('div.check-item.ok', icon('check', 'ico'), h('div', 'No collisions here. The game should let you place it.')));
    else {
      const byWhat = new Map();
      for (const x of hits) byWhat.set(x.with, Math.max(byWhat.get(x.with) ?? -1, x.depth));
      for (const [what, depth] of byWhat) {
        const text = depth > 0 ? `Collides with ${what} by ${(depth * 1000).toFixed(1)} mm` : `Touches ${what} with no gap. The game counts this as a collision.`;
        el.append(h('div.check-item.error', icon('error', 'ico'), h('div', text,
          /wall|ceiling/i.test(what) && this.item.meta.placement !== PLACEMENT.Floor ? h('div.fix', btn('Apply ' + (this.item.meta.placement === PLACEMENT.Wall ? 'wall' : 'ceiling') + ' fit', () => this.item.fitToSurface(), { cls: 'xs' })) : null)));
      }
    }
  }

  panelRoom(body) {
    const vp = this.viewport;
    const o = vp.roomOpts;
    this.roomStatusEl = h('div.checks');
    body.append(this.section('Placement check', this.roomStatusEl));
    this.drawRoomStatus();
    const slider = (label, key, min, max, step) => {
      const val = h('span.mono.faint', { style: { width: '52px', textAlign: 'right' } }, o[key].toFixed(2) + ' m');
      return h('div.row', h('span.small.muted', { style: { width: '62px' } }, label),
        h('input', { type: 'range', min, max, step, value: o[key], oninput: (e) => { val.textContent = (+e.target.value).toFixed(2) + ' m'; }, onchange: (e) => { vp.setRoomOptions({ [key]: +e.target.value }); vp.frame(); } }), val);
    };
    body.append(this.section('Room',
      slider('Width', 'width', 2.5, 9, 0.05), slider('Depth', 'depth', 2.5, 9, 0.05), slider('Height', 'height', 2.2, 3.6, 0.01),
      h('div.row', { style: { marginTop: '6px' } }, h('span.small.muted', { style: { width: '62px' } }, 'Walls'), h('input', { type: 'color', value: o.wallColor, onchange: (e) => vp.setRoomOptions({ wallColor: e.target.value }) }),
        h('span.small.muted', 'Floor'), h('input', { type: 'color', value: o.floorColor, onchange: (e) => vp.setRoomOptions({ floorColor: e.target.value }) })),
      h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: vp.roomPerson !== false, onchange: (e) => vp.setRoomExtras({ person: e.target.checked }) }), 'Show a 1.80 m person')));
    const refsBox = h('div');
    const drawRefs = () => {
      clear(refsBox);
      for (const [i, r] of this.roomRefs.entries()) {
        refsBox.appendChild(h('div.chip', { style: { margin: '0 4px 4px 0' } }, r.data.name, h('button', { onclick: () => { this.roomRefs.splice(i, 1); vp.setRoomExtras({ refs: this.roomRefs.map((x) => x.data) }); drawRefs(); } }, icon('x'))));
      }
    };
    drawRefs();
    const searchHolder = h('div');
    body.append(this.section('Furnish the room', h('div.small.muted', { style: { marginBottom: '6px' } }, 'Add base-game items (shown as their real collision boxes) or workshop items (real models) to see how yours fits in.'), refsBox, searchHolder));
    this.attachReferenceSearch(searchHolder, async (pick) => {
      const data = await this.referenceData(pick);
      if (!data) return;
      this.roomRefs.push({ data });
      vp.setRoomExtras({ refs: this.roomRefs.map((x) => x.data) });
      drawRefs();
    });
  }

  async attachReferenceSearch(holder, onPick) {
    holder.appendChild(h('div.row.small.faint', h('span.spinner'), 'Loading reference library…'));
    const ref = await loadReference();
    let ws = null;
    try { ws = await loadWorkshopIndex(); } catch { /* optional */ }
    clear(holder);
    if (ref.missing) holder.appendChild(referenceBuildCard(() => this.drawRight(), { compact: true }));
    holder.appendChild(referenceSearch(ref, onPick, { workshop: ws, placeholder: ref.missing ? 'Search workshop items…' : undefined }));
  }

  /** Turn a search pick into something the viewport can show (base item proxy or real workshop model). */
  async referenceData(pick) {
    if (pick.ref) return pick.ref;
    if (pick.workshop) {
      const w = pick.workshop;
      try {
        const bytes = await api.readFile({ path: w.file });
        const { info, files } = readHfContent(bytes);
        const { model } = await itemFromContent(info, files);
        const b = modelBounds(model);
        return { name: w.name, object: model, min: b.min.toArray(), size: b.getSize(new THREE.Vector3()).toArray(), placement: w.placement, tags: [], price: w.price };
      } catch (e) { toast('Could not load workshop item', e.message, 'err'); return null; }
    }
    return null;
  }

  panelCompare(body) {
    const vp = this.viewport;
    const it = this.item;
    const s = modelBounds(it.model).getSize(new THREE.Vector3());
    const layout = seg([{ value: 'lineup', label: 'Side by side' }, { value: 'overlay', label: 'Overlay' }], vp.compareLayout || 'lineup', (v) => vp.setCompareLayout(v), 'sm');
    const refresh = () => { vp.setCompareItems(this.compare.map((c) => c.data)); this.drawRight(); };
    const table = h('table.tbl', h('tr', h('th', ''), h('th', 'W'), h('th', 'H'), h('th', 'D'), h('th', '$')),
      h('tr', h('td', h('b', 'Yours')), h('td.num', fmtSize(s.x)), h('td.num', fmtSize(s.y)), h('td.num', fmtSize(s.z)), h('td.num', it.meta.price)),
      this.compare.map((c, i) => {
        const d = c.data.size;
        const diff = (a, b) => { const p = Math.round(((b - a) / (a || 1)) * 100); return h('div.small.' + (p > 0 ? 'diff-up' : 'diff-down'), p === 0 ? '=' : (p > 0 ? '+' : '') + p + '%'); };
        return h('tr', h('td', { title: c.data.name, style: { maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          h('button.btn.xs.ghost', { onclick: () => { this.compare.splice(i, 1); refresh(); }, title: 'Remove' }, icon('x')), c.data.name),
          h('td.num', fmtSize(d[0]), diff(s.x, d[0])), h('td.num', fmtSize(d[1]), diff(s.y, d[1])), h('td.num', fmtSize(d[2]), diff(s.z, d[2])), h('td.num', c.data.price ?? ''));
      }));
    body.append(this.section('Layout', layout,
      h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: vp.compareWithPerson !== false, onchange: (e) => { vp.compareWithPerson = e.target.checked; vp.layoutCompare(); } }), 'Include a 1.80 m person')),
      this.section('Sizes', table, h('div.field-hint', { style: { marginTop: '6px' } }, 'Percentages show how much bigger (+) or smaller (−) each item is than yours.')));
    const sugg = h('div');
    body.append(this.section('Similar base-game items', sugg));
    loadReference().then((ref) => {
      if (ref.missing) { clear(sugg).appendChild(referenceBuildCard(() => this.drawRight())); return; }
      const sim = similarItems(ref, [s.x, s.y, s.z], { hanging: it.meta.placement === PLACEMENT.Wall, limit: 8 });
      const p = suggestPrice(sim);
      clear(sugg).append(
        p ? h('div.small.muted', { style: { marginBottom: '6px' } }, `Similar items cost $${p.low}–$${p.high} (typical $${p.median}).`) : null,
        h('div', sim.map((r) => h('div.ref-row', { onclick: () => { if (!this.compare.some((c) => c.data.id === r.id)) { this.compare.push({ data: r }); refresh(); } } },
          h('span.n', r.name), h('span.d', dims(r.size)), h('span.badge', '$' + r.price)))));
    });
    const searchHolder = h('div');
    body.append(this.section('Add any item', searchHolder));
    this.attachReferenceSearch(searchHolder, async (pick) => {
      const data = await this.referenceData(pick);
      if (!data) return;
      this.compare.push({ data });
      refresh();
    });
  }

  destroy() { this.viewport.dispose(); }
}

export { saveSettings, VISIBILITY };
