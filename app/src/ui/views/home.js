import { h, clear, btn, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api, fileUrl } from '../api.js';
import { state, game } from '../state.js';
import { MODEL_FILTER, makeDropTarget, extOf } from '../files.js';
import { MODEL_EXTENSIONS } from '../../three/importers.js';
import { referenceBuildCard } from './pickers.js';

export class HomeView {
  constructor(app) { this.app = app; }

  render() {
    this.el = h('div.page');
    return this.el;
  }

  show() { this.draw(); }

  async openPicked() {
    const files = await api.openDialog({ title: 'Choose a model or .hfcontent', filters: MODEL_FILTER });
    if (files?.[0]) this.app.openInEditor({ path: files[0] });
  }

  draw() {
    const el = clear(this.el);
    const g = game();
    el.appendChild(h('div.page-head',
      h('div', h('h1', 'HF Item Studio'), h('p', 'Import 3D models as House Flipper items, check them in a real room, compare them with base-game furniture and publish them. No Unity needed.')),
      h('div.spacer')));

    const card = (ic, title, text, fn) => h('div.card.action-card', { onclick: fn }, h('div.ic', icon(ic)), h('b', title), h('span', text));
    el.appendChild(h('div.home-grid',
      card('plus', 'New item from model', 'GLB, glTF, FBX, OBJ, DAE, STL, PLY, 3DS or 3MF. Scale, pivot, colliders and thumbnail are set up for you.', () => this.openPicked()),
      card('layers', 'Batch import', 'Turn a whole folder of models into items in one go, with templates and a metadata table.', () => this.app.go('batch')),
      card('library', 'Open or remix an item', 'Browse your projects and all installed workshop items. Open any of them in the editor.', () => this.app.go('library')),
      card('heart', 'Workshop health check', 'Find the installed items that are broken and could crash the loader.', () => this.app.go('health'))));

    // first run: the base-game library is built from the user's own game files
    const setup = h('div');
    api.hasReference({ name: 'base_items.json' }).then((has) => {
      if (!has) setup.append(h('div.card.card-pad', { style: { marginBottom: '16px' } }, h('h3', 'One-time setup'), referenceBuildCard(() => this.draw())));
    });
    el.appendChild(setup);

    const drop = h('div.dropzone', h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } }, 'Drop a model or .hfcontent here'),
      h('div.small', `Supported: ${MODEL_EXTENSIONS.join(', ')}, hfcontent. Drop several to batch-import them.`));
    makeDropTarget(drop, (files) => {
      const models = files.filter((f) => [...MODEL_EXTENSIONS, 'hfcontent'].includes(extOf(f.name)));
      if (!models.length) { toast('Nothing to import', 'Drop a 3D model file or an .hfcontent item', 'warn'); return; }
      if (models.length > 1) { this.app.go('batch'); this.app.views.get('batch').instance.addEntries(files); return; }
      this.app.openInEditor({ dropped: models[0], all: files });
    });
    el.appendChild(h('div', { style: { marginBottom: '20px' } }, drop));

    const recent = (state.settings.recent || []).slice(0, 10);
    const recentList = h('div.recent-list');
    if (!recent.length) recentList.appendChild(h('div.faint', { style: { padding: '14px 4px' } }, 'Items you open or save appear here.'));
    for (const r of recent) {
      recentList.appendChild(h('div.recent', { onclick: () => this.app.openInEditor(r.kind === 'project' ? { project: r.path } : { path: r.path }) },
        r.thumb ? h('img', { src: fileUrl(r.thumb) + '?t=' + (r.opened || 0), onerror: (e) => e.target.replaceWith(h('div.thumb-ph')) }) : h('div.thumb-ph'),
        h('div.t', h('b', r.name || r.path), h('span', `${r.kind === 'project' ? 'Project' : 'File'} · ${new Date(r.opened).toLocaleString()}`))));
    }

    const env = state.env;
    const envRows = [
      ['Game', g ? g.path : 'not found'],
      ['Content Creator kit', g?.hasKit ? 'installed (used for Steam upload)' : 'not found'],
      ['Steam API', g?.steamDll || 'not found'],
      ['Workshop folders', env.workshops.join('\n') || 'none'],
      ['Game logs', env.logDir || 'not found'],
      ['Projects', state.settings.projectsDir],
      ['Python', env.python ? `${env.python.version} (${env.python.path})` : 'not found: Steam upload and reference rebuild need it'],
    ];
    el.appendChild(h('div.two-col',
      h('div.card.card-pad', h('h3', 'Recent'), recentList),
      h('div.card.card-pad', h('h3', 'Setup'),
        h('div.env-list', envRows.map(([k, v]) => [h('div.k', k), h('div.v', { style: { whiteSpace: 'pre-line' } }, v)])),
        h('div.btn-row', { style: { marginTop: '12px' } }, btn('Settings', () => this.app.go('settings'), { ic: 'settings', cls: 'sm' })))));

    el.appendChild(h('div.card.card-pad', { style: { marginTop: '14px' } },
      h('h3', 'What this does for you'),
      h('div.grid2', { style: { gap: '6px 24px' } }, [
        'Hanging items are oriented, pivoted on their back, and their colliders kept 5 mm off the wall so the game stops reporting collisions.',
        'Meshes over the game\'s hard limit (64,000 vertices or triangles) are split automatically instead of failing to load.',
        'Colliders: one box, one box per part, or a voxel "smart fit" that follows L-shapes, legs and shelves.',
        'Room view: drag the item on the floor, wall or ceiling of a furnished room with a person, door and window; colliders turn red where they hit something.',
        'Compare: line the item up against any of 10,000+ base-game items (real collider sizes) or any workshop item, with a price suggestion.',
        'Normal, metal/roughness and AO maps are converted to Unity\'s packing; textures over the limit are downscaled.',
        'Publish to the Steam Workshop directly, private first for testing, then public.',
        'Health check finds broken items in your subscriptions; the game log view shows custom-item errors.',
      ].map((t) => h('div.row', { style: { alignItems: 'flex-start' } }, h('span', { style: { color: 'var(--green)', marginTop: '1px' } }, icon('check')), h('span.muted', t))))));
  }
}
