import { h, clear, btn, toast, numberInput, seg } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, saveSettings, game, loadReference } from '../state.js';
import { CURRENCIES, VISIBILITY } from '../../core/constants.js';
import { THUMB_ANGLES } from '../../three/thumbnail.js';
import { referenceBuildCard } from './pickers.js';

export class SettingsView {
  constructor(app) { this.app = app; }
  render() { this.el = h('div.page'); this.draw(); return this.el; }

  draw() {
    const el = clear(this.el);
    const s = state.settings, env = state.env;
    const set = (k) => (v) => saveSettings({ [k]: v });
    const row = (label, control, hint) => h('div', { style: { display: 'grid', gridTemplateColumns: '220px 1fr', gap: '12px', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line)' } },
      h('div', h('div', label), hint ? h('div.faint.small', hint) : null), h('div', control));
    const select = (k, opts) => h('select.input', { style: { maxWidth: '260px' }, onchange: (e) => set(k)(isNaN(+e.target.value) ? e.target.value : +e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(s[k]) }, l)));
    const check = (k, label) => h('label.check', h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => set(k)(e.target.checked) }), label);

    el.appendChild(h('div.page-head', h('div', h('h1', 'Settings'), h('p', 'Defaults for new items and where things live.'))));

    el.appendChild(h('div.card.card-pad', { style: { marginBottom: '14px' } }, h('h3', 'Locations'),
      row('Projects folder', h('div.row', h('span.mono.grow', s.projectsDir), btn('Change…', async () => { const d = await api.openDialog({ title: 'Projects folder', folder: true }); if (d?.[0]) { await saveSettings({ projectsDir: d[0] }); this.draw(); } }, { cls: 'sm' }), btn('', () => api.openPath(s.projectsDir), { cls: 'sm icon', ic: 'folder' }))),
      row('House Flipper install', env.games.length ? select('selectedGame', env.games.map((g, i) => [i, g.path + (g.hasKit ? '' : ' (no Content Creator kit)')])) : h('span.badge.red', 'not found'), 'Used for the Steam API and reference data'),
      row('Workshop folders', h('div.mono.small', { style: { whiteSpace: 'pre-line' } }, env.workshops.join('\n') || 'none found')),
      row('Python', h('div.row', h('input.input', { value: s.pythonPath || env.python?.path || '', placeholder: 'python', style: { maxWidth: '420px' }, onchange: (e) => set('pythonPath')(e.target.value.trim()) }),
        btn('Browse…', async () => { const f = await api.openDialog({ title: 'python.exe', filters: [{ name: 'Python', extensions: ['exe'] }] }); if (f?.[0]) { await saveSettings({ pythonPath: f[0] }); this.draw(); } }, { cls: 'sm' })),
        env.python ? `Found ${env.python.version}. Used for Steam upload and rebuilding reference data.` : 'Not found. Install Python 3 from python.org.'),
      row('Steam', h('div.row', btn('Test connection', async () => {
        const g = game();
        if (!g?.steamDll) { toast('No steam_api64.dll', 'The Content Creator files were not found in the game folder.', 'err'); return; }
        try { const r = await api.steam({ command: 'status', args: { dll: g.steamDll } }); toast('Steam ready', `Signed in as ${r.user} (app ${r.appId})`, 'ok'); }
        catch (e) { toast('Steam not ready', e.message, 'err', 8000); }
      }, { cls: 'sm', ic: 'steam' }), h('span.faint.small', game()?.steamDll || '')))));

    el.appendChild(h('div.card.card-pad', { style: { marginBottom: '14px' } }, h('h3', 'Defaults for new items'),
      row('Currency', select('defaultCurrency', CURRENCIES.map((c) => [c.id, c.code]))),
      row('Max texture size', select('maxTextureSize', [512, 1024, 2048, 4096].map((v) => [v, v + ' px'])), 'Bigger textures are downscaled on export'),
      row('', check('powerOfTwo', 'Round textures to powers of two')),
      row('Collider mode', select('colliderMode', [['fit', 'Smart fit (voxel)'], ['perMesh', 'One box per part'], ['single', 'One box']])),
      row('Max collider boxes', numberInput(s.maxColliderBoxes, (v) => set('maxColliderBoxes')(Math.max(1, Math.round(v))), { step: 1, digits: 0, cls: '' })),
      row('Wall / ceiling gap', h('div.row', numberInput(s.wallGapMm, (v) => set('wallGapMm')(Math.max(0, v)), { step: 1, digits: 1, cls: '' }), h('span.faint', 'mm')), 'Space between colliders and the mounting surface'),
      row('Collider side inset', h('div.row', numberInput(s.colliderInsetMm, (v) => set('colliderInsetMm')(Math.max(0, v)), { step: 1, digits: 1, cls: '' }), h('span.faint', 'mm'))),
      row('Wall items', h('div', check('autoOrientWall', 'Auto-orient (thin side against the wall)'), h('div.row', { style: { marginTop: '4px' } }, h('span.small.muted', 'Vertical anchor'), select('wallVertical', [['center', 'Centre'], ['bottom', 'Bottom']])))),
      row('Thumbnail', h('div.row', select('thumbnailAngle', Object.keys(THUMB_ANGLES).map((k) => [k, k])), select('thumbnailBackground', [['transparent', 'Transparent'], ['#ffffff', 'White'], ['gradient', 'Studio'], ['#2b2f36', 'Dark']]))),
      row('Workshop visibility', select('defaultVisibility', VISIBILITY.map((v) => [v.id, v.name])), 'Private is safest for a first upload'),
      row('Workshop language', select('steamLanguage', ['english', 'polish', 'german', 'french', 'spanish', 'italian', 'russian', 'brazilian', 'schinese', 'japanese', 'koreana', 'turkish', 'czech', 'dutch', 'swedish', 'ukrainian'].map((l) => [l, l])))));

    const refBox = h('div');
    el.appendChild(h('div.card.card-pad', h('h3', 'Base-game reference data'), refBox));
    loadReference().then((ref) => {
      if (ref.missing) { clear(refBox).append(referenceBuildCard(() => this.draw())); return; }
      clear(refBox).append(
        h('p.muted', { style: { marginTop: 0 } }, `${ref.count.toLocaleString()} base-game items (core game and DLCs) with real collider sizes, generated ${ref.generated}. Used by Compare, the room view and price suggestions.`),
        h('div.row', btn('Rebuild from my game files', () => this.rebuild(refBox), { cls: 'sm', ic: 'refresh' }), h('span.faint.small', 'Run it after a game or DLC update. Needs Python; UnityPy is installed automatically.')));
    });
  }

  async rebuild(box) {
    const g = game();
    if (!g) { toast('Game not found', '', 'err'); return; }
    const log = h('pre.mono.small', { style: { background: '#12151a', padding: '10px', borderRadius: '6px', maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap' } });
    box.appendChild(log);
    const off = api.onProgress((p) => { if (p.kind === 'reference') log.textContent += p.line + '\n'; });
    try {
      await api.rebuildReference({ gameDir: g.path });
      state.reference = null;
      toast('Reference data rebuilt', '', 'ok');
      this.draw();
    } catch (e) {
      log.textContent += '\n' + e.message;
      toast('Rebuild failed', e.message, 'err', 9000);
    } finally { off(); }
  }
}

export { icon, seg };
