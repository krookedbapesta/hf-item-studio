// Global application state: environment, settings, tag/category collections, reference data.
import { api } from './api.js';

const DEFAULT_SETTINGS = {
  projectsDir: '',
  defaultCurrency: 0,
  maxTextureSize: 2048,
  powerOfTwo: false,
  wallGapMm: 5,
  colliderInsetMm: 0,
  colliderMode: 'fit',
  maxColliderBoxes: 6,
  thumbnailBackground: 'transparent',
  thumbnailAngle: 'three-quarter',
  autoOrientWall: true,
  wallVertical: 'center',
  recent: [],
  templates: [],
  selectedGame: 0,
  steamLanguage: 'english',
  defaultVisibility: 2,
};

export const state = {
  env: null,
  settings: { ...DEFAULT_SETTINGS },
  collections: null,
  reference: null,
  workshop: null,
  listeners: new Set(),
};

export function onState(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
export function emit(what) { state.listeners.forEach((l) => l(what)); }

export async function initState() {
  const [env, settings, collections] = await Promise.all([
    api.detectEnvironment(),
    api.getSettings(),
    api.getReference({ name: 'hf_collections.json' }),
  ]);
  state.env = env;
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  if (!state.settings.projectsDir) state.settings.projectsDir = env.defaultProjectsDir + '\\Projects';
  state.collections = buildCollections(collections);
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await api.setSettings({ settings: patch });
  emit('settings');
}

export function game() {
  const g = state.env?.games || [];
  return g[state.settings.selectedGame] || g[0] || null;
}

function buildCollections(raw) {
  const tagByGuid = new Map(), tagByName = new Map(), catByGuid = new Map();
  for (const t of raw.tags) { tagByGuid.set(t.guid, t); tagByName.set(t.name, t); }
  for (const c of raw.categories) catByGuid.set(c.guid, c);
  const tagGroups = new Map();
  for (const t of raw.tags) {
    const [group, ...rest] = t.name.split('/');
    t.group = group;
    t.short = rest.join('/') || group;
    if (!tagGroups.has(group)) tagGroups.set(group, []);
    tagGroups.get(group).push(t);
  }
  for (const c of raw.categories) {
    const parts = c.name.replace(/^Workshop\//, '').split('/');
    c.parts = parts;
    c.short = parts[parts.length - 1];
    c.path = parts.join(' › ');
  }
  return { tags: raw.tags, categories: raw.categories, tagByGuid, tagByName, catByGuid, tagGroups };
}

/** Base-game library, or an empty one with `missing: true` until the user builds it. */
export async function loadReference() {
  if (!state.reference) {
    let ref;
    try {
      ref = await api.getReference({ name: 'base_items.json' });
    } catch (e) {
      if (/REFERENCE_MISSING/.test(e.message)) return { count: 0, items: [], missing: true };
      throw e;
    }
    for (const r of ref.items) {
      r.lname = r.name.toLowerCase();
      r.lfolder = r.folder.toLowerCase();
      r.hanging = r.tags.some((t) => /^hanging/i.test(t));
      r.group = r.folder.split('/').slice(0, 4).join('/');
    }
    state.reference = ref;
  }
  return state.reference;
}

export async function loadWorkshopIndex({ rescan = false } = {}) {
  if (rescan || !state.workshop) {
    let idx = await api.getWorkshopIndex();
    if (rescan || !idx.items.length) idx = await api.scanWorkshop({ roots: state.env.workshops, force: false });
    state.workshop = idx;
    emit('workshop');
  }
  return state.workshop;
}

export async function addRecent(entry) {
  const list = (state.settings.recent || []).filter((r) => r.path !== entry.path);
  list.unshift({ ...entry, opened: Date.now() });
  await saveSettings({ recent: list.slice(0, 30) });
}

export const DEFAULTS = DEFAULT_SETTINGS;
