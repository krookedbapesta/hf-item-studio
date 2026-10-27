// ItemProject: the editable item and every pipeline step that touches it.
import * as THREE from 'three';
import { api } from './api.js';
import { state, game } from './state.js';
import { readHfContent, checkHfContent } from '../core/hfcontent.js';
import { itemFromContent, modelBounds, modelStats } from '../three/hfscene.js';
import { loadModelFile, bakeToItemSpace, suggestUnitScale } from '../three/importers.js';
import { exportItem } from '../three/exporter.js';
import {
  applyPivot, autoOrientForWall, generateColliders, fitCollidersToSurface, pivotReport,
  colliderReport, guessPlacement, scaleItem, thickenColliders,
} from '../three/tools.js';
import { renderThumbnail } from '../three/thumbnail.js';
import { LIMITS, PLACEMENT, fromPLN } from '../core/constants.js';

export const slug = (s) => (s || 'item').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'item';
const basename = (p) => p.replace(/\\/g, '/').split('/').pop();
const stem = (p) => basename(p).replace(/\.[^.]+$/, '');
export const prettyName = (file) => stem(file).replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

function cloneModel(model) {
  const m = model.clone(true);
  m.traverse((o) => { if (o.isMesh) o.geometry = o.geometry.clone(); });
  return m;
}
const cloneCols = (c) => c.map((x) => ({ ...x, center: [...x.center], size: x.size ? [...x.size] : undefined, matrix: x.matrix ? [...x.matrix] : null }));

export class ItemProject {
  constructor() {
    const s = state.settings;
    this.meta = {
      name: '', description: '', price: 100, currency: s.defaultCurrency ?? 0, placement: PLACEMENT.Floor,
      categoryGuid: '', tagGuids: [], canBePlacedOn: false, guid: '', visibility: s.defaultVisibility ?? 2, changeNote: '',
    };
    this.settings = {
      wallGapMm: s.wallGapMm, insetMm: s.colliderInsetMm, maxTextureSize: s.maxTextureSize, powerOfTwo: s.powerOfTwo,
      colliderMode: s.colliderMode, maxBoxes: s.maxColliderBoxes, wallVertical: s.wallVertical,
      thumbAngle: s.thumbnailAngle, thumbBackground: s.thumbnailBackground, thumbAuto: true,
    };
    this.model = new THREE.Group();
    this.colliders = [];
    this.thumbnail = null;
    this.source = null;
    this.projectDir = null;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.notes = [];
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(what = 'all', { dirty = true } = {}) {
    if (dirty) this.dirty = true;
    this.listeners.forEach((l) => l(what));
  }

  // ---------- history ----------

  snapshot(withModel) {
    return { meta: structuredClone(this.meta), colliders: cloneCols(this.colliders), model: withModel ? cloneModel(this.model) : null, thumbnail: this.thumbnail };
  }

  /** Call before a change. Pass withModel=true when geometry is about to change. */
  checkpoint(label, withModel = false) {
    this.undoStack.push({ label, ...this.snapshot(withModel) });
    if (this.undoStack.length > 40) this.undoStack.shift();
    // keep at most 12 geometry copies in memory
    let n = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) if (this.undoStack[i].model && ++n > 12) this.undoStack[i].model = null;
    this.redoStack = [];
  }

  restore(snap) {
    this.meta = snap.meta;
    this.colliders = snap.colliders;
    if (snap.model) this.model = snap.model;
    this.thumbnail = snap.thumbnail;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push({ label: s.label, ...this.snapshot(!!s.model) });
    this.restore(s);
    this.changed('all');
    return s.label;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push({ label: s.label, ...this.snapshot(!!s.model) });
    this.restore(s);
    this.changed('all');
    return s.label;
  }

  // ---------- creation ----------

  static async fromModelPath(path, opts = {}) {
    const bundle = await api.readModelBundle({ path });
    return ItemProject.fromModelBundle(bundle, { ...opts, path });
  }

  static async fromModelBundle({ main, extras }, opts = {}) {
    const p = new ItemProject();
    const { scene, warnings } = await loadModelFile(main, extras);
    p.notes.push(...warnings);
    p.model = bakeToItemSpace(scene, { mergeByMaterial: opts.mergeByMaterial ?? true });
    p.source = { kind: 'model', path: opts.path || main.name, name: main.name };
    p.meta.name = opts.name || prettyName(main.name);
    if (opts.template) p.applyTemplate(opts.template, { silent: true });
    if (opts.meta) Object.assign(p.meta, opts.meta);
    if (opts.settings) Object.assign(p.settings, opts.settings);
    await p.prepareImported(opts);
    p.dirty = true;
    return p;
  }

  /** Units, orientation, pivot, colliders and thumbnail for a freshly imported model. */
  async prepareImported(opts = {}) {
    const box = modelBounds(this.model);
    const unit = opts.autoUnits === false ? null : suggestUnitScale(box);
    if (unit) {
      this.colliders = scaleItem(this.model, this.colliders, unit.factor);
      this.notes.push(`Scaled by ${unit.factor} (${unit.reason})`);
    }
    if (opts.placement === undefined || opts.placement === 'auto') {
      if (!opts.template?.placement && opts.template?.placement !== 0) this.meta.placement = guessPlacement(this.model);
    } else this.meta.placement = opts.placement;
    if (this.meta.placement === PLACEMENT.Wall && (opts.autoOrient ?? state.settings.autoOrientWall)) {
      const r = autoOrientForWall(this.model, this.colliders);
      this.colliders = r.colliders;
      if (r.steps.length) this.notes.push('Wall orientation: ' + r.steps.join(', '));
    }
    this.colliders = applyPivot(this.model, this.colliders, this.meta.placement, { wallVertical: this.settings.wallVertical });
    this.regenerateColliders({ silent: true });
    if (opts.thumbnail !== false) this.renderThumb();
  }

  static async fromHfContent(bytes, path, { asCopy = false } = {}) {
    const { info, files } = readHfContent(bytes);
    const p = new ItemProject();
    const { model, colliders, problems } = await itemFromContent(info, files);
    p.model = model;
    p.colliders = colliders;
    p.notes.push(...problems);
    const d = info.ItemData || {};
    p.meta.name = d.ItemName?.Default || stem(path);
    p.meta.description = d.ItemDescription || '';
    p.meta.currency = d.SelectedCurrency ?? 0;
    p.meta.price = Math.round(fromPLN(d.PriceInPLN || 0, p.meta.currency) * 100) / 100;
    p.meta.placement = d.PlacementOption ?? 0;
    p.meta.guid = asCopy ? '' : d.GUID || '';
    p.meta.categoryGuid = info.ItemCategory || '';
    const special = new Set(['Limits/Hanging', 'Limits/Ceiling', 'Limits/Can Be Placed On'].map((n) => state.collections.tagByName.get(n)?.guid));
    const placeOn = state.collections.tagByName.get('Limits/Can Be Placed On')?.guid;
    p.meta.canBePlacedOn = (info.ItemTags || []).includes(placeOn);
    p.meta.tagGuids = (info.ItemTags || []).filter((g) => !special.has(g));
    if (d.Thumbnail && files[d.Thumbnail]) { p.thumbnail = files[d.Thumbnail]; p.settings.thumbAuto = false; }
    p.source = { kind: 'hfcontent', path, name: basename(path) };
    p.health = checkHfContent(info, files, { archiveBytes: bytes.length });
    if (asCopy) p.meta.name += ' (copy)';
    p.dirty = asCopy;
    return p;
  }

  static async openProject(dir) {
    const meta = JSON.parse(await api.readText({ path: dir + '\\project.json' }));
    const bytes = await api.readFile({ path: dir + '\\' + meta.file });
    const p = await ItemProject.fromHfContent(bytes, dir + '\\' + meta.file);
    Object.assign(p.meta, meta.meta || {});
    Object.assign(p.settings, meta.settings || {});
    p.source = meta.source || p.source;
    p.projectDir = dir;
    p.published = meta.published || null;
    p.dirty = false;
    return p;
  }

  // ---------- operations ----------

  regenerateColliders({ mode, maxBoxes, silent = false } = {}) {
    if (!silent) this.checkpoint('Generate colliders');
    if (mode) this.settings.colliderMode = mode;
    if (maxBoxes) this.settings.maxBoxes = maxBoxes;
    this.colliders = generateColliders(this.model, {
      mode: this.settings.colliderMode, maxBoxes: this.settings.maxBoxes,
      canPutOnTop: this.colliders.some((c) => c.canPutOnTop) || this.defaultCanPutOnTop(),
    });
    this.fitToSurface({ silent: true });
    if (!silent) this.changed('colliders');
  }

  defaultCanPutOnTop() {
    const tag = (n) => state.collections.tagByName.get(n)?.guid;
    const surfaces = ['Furniture types/Table', 'Furniture types/Table Round', 'Furniture types/Desk', 'Furniture types/Desk Cornered', 'Furniture types/Shelf', 'Furniture types/Cupboard', 'Furniture types/Bedside Table', 'Furniture types/Bookcase', 'Furniture types/Coffee'].map(tag);
    return this.meta.tagGuids.some((g) => surfaces.includes(g));
  }

  fitToSurface({ silent = false } = {}) {
    if (!silent) this.checkpoint('Fit colliders to surface');
    this.colliders = fitCollidersToSurface(this.colliders, this.meta.placement, {
      gap: (this.settings.wallGapMm ?? 5) / 1000, inset: (this.settings.insetMm ?? 0) / 1000,
    });
    if (!silent) this.changed('colliders');
  }

  setPlacement(p, { reorient = true } = {}) {
    if (p === this.meta.placement) return;
    this.checkpoint('Change placement', true);
    this.meta.placement = p;
    if (p === PLACEMENT.Wall && reorient && state.settings.autoOrientWall) {
      const r = autoOrientForWall(this.model, this.colliders);
      this.colliders = r.colliders;
    }
    this.colliders = applyPivot(this.model, this.colliders, p, { wallVertical: this.settings.wallVertical });
    this.fitToSurface({ silent: true });
    if (this.settings.thumbAuto) this.renderThumb();
    this.changed('placement');
  }

  /** Run an operation that changes geometry (and colliders); keeps pivot rules afterwards. */
  geometryOp(label, fn, { repivot = true, refit = true } = {}) {
    this.checkpoint(label, true);
    const res = fn(this.model, this.colliders);
    if (Array.isArray(res)) this.colliders = res;
    else if (res?.colliders) this.colliders = res.colliders;
    if (repivot) this.colliders = applyPivot(this.model, this.colliders, this.meta.placement, { wallVertical: this.settings.wallVertical });
    if (refit) this.fitToSurface({ silent: true });
    if (this.settings.thumbAuto) this.renderThumb();
    this.changed('model');
  }

  renderThumb(opts = {}) {
    if (!this.model.children.length) return null;
    try {
      this.thumbnail = renderThumbnail(this.model, { angle: this.settings.thumbAngle, background: this.settings.thumbBackground, ...opts });
    } catch (e) {
      this.notes.push('Thumbnail failed: ' + e.message);
    }
    this.changed('thumbnail', { dirty: true });
    return this.thumbnail;
  }

  applyTemplate(t, { silent = false } = {}) {
    if (!silent) this.checkpoint('Apply template');
    if (t.categoryGuid) this.meta.categoryGuid = t.categoryGuid;
    if (t.tagGuids) this.meta.tagGuids = [...new Set([...(t.merge ? this.meta.tagGuids : []), ...t.tagGuids])];
    if (t.price !== undefined && t.price !== '' && t.price !== null) this.meta.price = Number(t.price);
    if (t.currency !== undefined) this.meta.currency = t.currency;
    if (t.placement !== undefined && t.placement !== null && t.placement !== '') this.meta.placement = Number(t.placement);
    if (t.canBePlacedOn !== undefined) this.meta.canBePlacedOn = t.canBePlacedOn;
    if (t.description) this.meta.description = t.description.replace(/\{name\}/g, this.meta.name);
    if (t.visibility !== undefined) this.meta.visibility = t.visibility;
    for (const k of ['colliderMode', 'maxBoxes', 'wallGapMm', 'insetMm', 'maxTextureSize', 'thumbBackground', 'thumbAngle']) if (t[k] !== undefined) this.settings[k] = t[k];
    if (!silent) this.changed('meta');
  }

  // ---------- analysis ----------

  stats() {
    const s = modelStats(this.model);
    const b = modelBounds(this.model);
    const size = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3());
    const perMeshOver = [];
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const v = o.geometry.getAttribute('position').count;
      const t = (o.geometry.getIndex()?.count ?? v) / 3;
      if (v > LIMITS.maxMeshVertices || t > LIMITS.maxMeshTriangles) perMeshOver.push({ name: o.name, v, t });
    });
    const maxTex = s.textures.reduce((m, t) => Math.max(m, t.image?.width || 0, t.image?.height || 0), 0);
    return { ...s, size, bounds: b, perMeshOver, maxTex };
  }

  checks() {
    const out = [];
    const m = this.meta;
    const add = (level, text, fix, fixLabel) => out.push({ level, text, fix, fixLabel });
    if (!m.name.trim()) add('error', 'Give the item a name');
    if (m.name.length > LIMITS.maxNameLength) add('error', `Name is ${m.name.length} characters; the game allows ${LIMITS.maxNameLength}`);
    if (!(m.price > 0)) add('error', 'Price must be more than zero');
    if (!m.categoryGuid) add('error', 'Pick a shop category', 'category', 'Choose');
    if (m.description.length > LIMITS.maxLongText) add('error', 'Description is longer than 8,000 characters');
    const st = this.stats();
    if (!st.meshes) { add('error', 'The item has no visible meshes'); return out; }
    for (const pm of st.perMeshOver) add('info', `"${pm.name}" has ${pm.v.toLocaleString()} vertices / ${Math.round(pm.t).toLocaleString()} triangles. It will be split automatically on export (the game rejects more than 64,000 per mesh).`);
    if (st.vertices >= LIMITS.maxVerticesTotalWarn) add('warn', `Heavy model: ${st.vertices.toLocaleString()} vertices in total. Expect slowdowns with many copies in a house.`);
    const vol = st.size.x * st.size.y * st.size.z;
    if (vol > 0.0001 && st.triangles / vol >= LIMITS.triangleDensityWarn && st.triangles > 20000) add('warn', `Very dense mesh: ${Math.round(st.triangles).toLocaleString()} triangles in ${vol.toFixed(3)} m³`);
    const big = Math.max(st.size.x, st.size.y, st.size.z);
    if (big > LIMITS.sizeWarn) add('warn', `Item is ${big.toFixed(2)} m on its longest side. Check the scale.`, 'scaleDown', '÷ 100');
    if (big > 0 && big < 0.02) add('warn', `Item is only ${(big * 1000).toFixed(1)} mm on its longest side. Check the scale.`, 'scaleUp', '× 100');
    if (m.placement === PLACEMENT.Ceiling && st.size.y > 2.0) add('warn', `Hangs ${st.size.y.toFixed(2)} m down from the ceiling`);
    for (const t of pivotReport(this.model, m.placement)) add('warn', t, 'pivot', 'Fix pivot');
    for (const c of colliderReport(this.model, this.colliders, m.placement)) {
      const fix = c.fix === 'wallfit' ? 'wallfit' : c.fix === 'thicken' ? 'thicken' : c.fix === 'pivot' ? 'pivot' : null;
      add(c.level, c.text, fix, fix === 'wallfit' ? (m.placement === PLACEMENT.Wall ? 'Wall fit' : 'Fit') : fix === 'thicken' ? 'Thicken' : fix ? 'Fix' : undefined);
    }
    if (!this.colliders.length) add('error', 'No colliders', 'colliders', 'Generate');
    if (st.maxTex > (this.settings.maxTextureSize || 2048)) add('info', `Textures up to ${st.maxTex}px will be downscaled to ${this.settings.maxTextureSize}px on export`);
    let noUv = false, vcol = false;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (!o.geometry.getAttribute('uv') && mats.some((x) => x.map || x.normalMap)) noUv = true;
      if (mats.some((x) => x.vertexColors)) vcol = true;
    });
    if (noUv) add('warn', 'Some meshes use textures but have no UV coordinates; their textures will be dropped');
    if (vcol) add('warn', 'Vertex colours are not supported in game; the material colour is used instead');
    if (!this.thumbnail) add('warn', 'No thumbnail yet', 'thumb', 'Render');
    if (m.placement === PLACEMENT.Floor && guessPlacement(this.model) === PLACEMENT.Wall) add('info', 'This looks like something that hangs on a wall', 'toWall', 'Make wall item');
    if (!m.tagGuids.length) add('info', 'No tags: tags help the game pick items for buyers and the shop filters', 'tags', 'Add tags');
    if (!out.some((c) => c.level === 'error' || c.level === 'warn')) add('ok', 'Ready to export');
    return out;
  }

  // ---------- output ----------

  build() {
    return exportItem({ meta: this.meta, model: this.model, colliders: this.colliders, thumbnail: this.thumbnail }, state.collections, {
      maxTextureSize: this.settings.maxTextureSize, powerOfTwo: this.settings.powerOfTwo,
    });
  }

  fileName() { return slug(this.meta.name) + '.hfcontent'; }

  async save({ dir } = {}) {
    const out = this.build();
    const target = dir || this.projectDir || `${state.settings.projectsDir}\\${slug(this.meta.name)}`;
    await api.makeDir({ path: target });
    const file = this.fileName();
    await api.writeFile({ path: `${target}\\${file}`, bytes: out.bytes });
    if (this.thumbnail) await api.writeFile({ path: `${target}\\thumbnail.png`, bytes: this.thumbnail });
    const project = {
      app: 'HF Item Studio', version: 1, file, saved: Date.now(),
      meta: this.meta, settings: this.settings, source: this.source, published: this.published || null,
    };
    await api.writeFile({ path: `${target}\\project.json`, text: JSON.stringify(project, null, 2) });
    this.projectDir = target;
    this.dirty = false;
    this.changed('saved', { dirty: false });
    return { dir: target, file: `${target}\\${file}`, report: out.report, bytes: out.bytes };
  }

  async exportTo(path) {
    const out = this.build();
    await api.writeFile({ path, bytes: out.bytes });
    return out;
  }

  thickenColliders() {
    this.checkpoint('Thicken colliders');
    this.colliders = thickenColliders(this.colliders);
    this.changed('colliders');
  }
}

/** Where Steam keeps an installed copy of a workshop item, if any. */
export function workshopFolderFor(id) {
  for (const w of state.env?.workshops || []) {
    const p = `${w}\\${id}`;
    const it = state.workshop?.items?.find((x) => x.id === String(id));
    if (it?.dir) return it.dir;
    void p;
  }
  return state.env?.workshops?.[0] ? `${state.env.workshops[0]}\\${id}` : null;
}

export { game };
