// Library: saved projects, installed workshop items, and the user's own Steam uploads.
import { h, clear, btn, toast, seg, debounce, fmtBytes, fmtNum } from '../dom.js';
import { icon } from '../icons.js';
import { api, fileUrl } from '../api.js';
import { state, loadWorkshopIndex, game } from '../state.js';
import { categoryLabel } from './pickers.js';
import { PLACEMENT_NAMES, VISIBILITY } from '../../core/constants.js';

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.tab = 'projects';
    this.query = '';
    this.sort = 'name';
    this.filter = 'all';
    this.limit = 240;
    this.selected = null;
  }

  render() {
    this.el = h('div.page');
    return this.el;
  }

  show() { this.draw(); }

  async draw() {
    const el = clear(this.el);
    el.appendChild(h('div.page-head',
      h('div', h('h1', 'Library'), h('p', 'Your projects, everything installed from the Workshop, and what you have published.')),
      h('div.spacer'),
      seg([{ value: 'projects', label: 'My projects', icon: 'folder' }, { value: 'workshop', label: 'Installed workshop', icon: 'grid' }, { value: 'uploads', label: 'My uploads', icon: 'steam' }],
        this.tab, (v) => { this.tab = v; this.selected = null; this.draw(); })));
    this.body = h('div');
    el.appendChild(this.body);
    if (this.tab === 'projects') await this.drawProjects();
    else if (this.tab === 'workshop') await this.drawWorkshop();
    else this.drawUploads();
  }

  // ---------- projects ----------

  async loadProjects() {
    const dir = state.settings.projectsDir;
    const st = await api.statPath({ path: dir });
    if (!st.exists) return [];
    const dirs = (await api.listDir({ path: dir })).filter((d) => d.dir);
    const out = [];
    await Promise.all(dirs.map(async (d) => {
      try {
        const p = JSON.parse(await api.readText({ path: d.path + '\\project.json' }));
        out.push({ dir: d.path, name: p.meta?.name || d.name, saved: p.saved, published: p.published, meta: p.meta, file: p.file, thumb: d.path + '\\thumbnail.png' });
      } catch { /* not a project folder */ }
    }));
    return out.sort((a, b) => (b.saved || 0) - (a.saved || 0));
  }

  async drawProjects() {
    const body = this.body;
    body.appendChild(h('div.row.faint', h('span.spinner'), 'Reading projects…'));
    const list = await this.loadProjects();
    clear(body);
    const q = this.query.toLowerCase();
    const search = h('input.input', { placeholder: 'Search projects…', value: this.query, style: { maxWidth: '320px' }, oninput: debounce((e) => { this.query = e.target.value; this.draw(); }, 200) });
    body.appendChild(h('div.lib-toolbar', search, h('div.grow'),
      h('span.faint.small', state.settings.projectsDir),
      btn('Open folder', () => api.openPath(state.settings.projectsDir), { cls: 'sm', ic: 'folder' })));
    const shown = list.filter((p) => !q || p.name.toLowerCase().includes(q));
    if (!shown.length) { body.appendChild(h('div.empty', icon('folder'), h('p', list.length ? 'No projects match.' : 'No saved projects yet. Items you save from the editor or batch import show up here.'))); return; }
    const grid = h('div.lib-grid');
    const detail = h('div.card.card-pad.detail-panel');
    for (const p of shown) {
      const card = h('div.lib-card', {
        onclick: () => { this.selected = p.dir; grid.querySelectorAll('.lib-card').forEach((c) => c.classList.remove('sel')); card.classList.add('sel'); this.projectDetail(detail, p); },
        ondblclick: () => this.app.openInEditor({ project: p.dir }),
      },
      h('div.img', h('img', { src: fileUrl(p.thumb) + '?t=' + (p.saved || 0), loading: 'lazy', onerror: (e) => { e.target.style.display = 'none'; } }),
        p.published ? h('span.badge.blue', 'published') : null),
      h('div.meta', h('b', p.name), h('span', p.saved ? new Date(p.saved).toLocaleDateString() : '')));
      grid.appendChild(card);
    }
    const sel = shown.find((p) => p.dir === this.selected) || shown[0];
    this.selected = sel.dir;
    grid.querySelectorAll('.lib-card')[shown.indexOf(sel)]?.classList.add('sel');
    this.projectDetail(detail, sel);
    body.appendChild(h('div.lib-layout', grid, detail));
  }

  projectDetail(el, p) {
    clear(el).append(
      h('div.img', h('img', { src: fileUrl(p.thumb) + '?t=' + (p.saved || 0), onerror: (e) => { e.target.style.display = 'none'; } })),
      h('h3', p.name),
      h('div.kv',
        h('div.k', 'Placement'), h('div', PLACEMENT_NAMES[p.meta?.placement ?? 0]),
        h('div.k', 'Category'), h('div', categoryLabel(p.meta?.categoryGuid) || '—'),
        h('div.k', 'Price'), h('div', String(p.meta?.price ?? '')),
        h('div.k', 'Workshop'), h('div', p.meta?.guid ? '#' + p.meta.guid : 'not published'),
        h('div.k', 'Saved'), h('div', p.saved ? new Date(p.saved).toLocaleString() : '—')),
      h('div.btn-row',
        btn('Open in editor', () => this.app.openInEditor({ project: p.dir }), { cls: 'primary sm', ic: 'cube' }),
        btn('Show folder', () => api.openPath(p.dir), { cls: 'sm', ic: 'folder' }),
        p.meta?.guid ? btn('Steam page', () => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${p.meta.guid}`), { cls: 'sm', ic: 'external' }) : null,
        btn('Move to bin', async () => {
          const r = await api.confirm({ message: `Move "${p.name}" to the Recycle Bin?`, detail: p.dir, buttons: ['Move to bin', 'Cancel'] });
          if (r === 0) { await api.trash(p.dir); toast('Moved to the Recycle Bin', p.name, 'ok'); this.draw(); }
        }, { cls: 'sm ghost danger', ic: 'trash' })));
  }

  // ---------- workshop ----------

  async drawWorkshop() {
    const body = this.body;
    if (!state.workshop) {
      body.appendChild(h('div.card.card-pad.row', h('span.spinner'), h('span', 'Indexing installed workshop items (the first time takes about a minute)…'), this.progressEl = h('span.faint')));
      const off = api.onProgress((p) => { if (p.kind === 'workshop-scan' && this.progressEl) this.progressEl.textContent = `${p.done} / ${p.total}`; });
      try { await loadWorkshopIndex(); } finally { off(); }
      clear(body);
    }
    const all = state.workshop.items;
    const search = h('input.input', { placeholder: `Search ${fmtNum(all.length)} installed items…`, value: this.query, style: { maxWidth: '320px' } });
    search.addEventListener('input', debounce(() => { this.query = search.value; this.limit = 240; this.drawWorkshopGrid(); }, 200));
    const sortSel = h('select.input', { style: { width: '160px' }, onchange: (e) => { this.sort = e.target.value; this.drawWorkshopGrid(); } },
      [['name', 'Name'], ['new', 'Recently updated'], ['tris', 'Most triangles'], ['size', 'Largest file'], ['price', 'Price']].map(([v, l]) => h('option', { value: v, selected: v === this.sort }, l)));
    const filterSel = h('select.input', { style: { width: '150px' }, onchange: (e) => { this.filter = e.target.value; this.drawWorkshopGrid(); } },
      [['all', 'All items'], ['0', 'Floor'], ['2', 'Wall'], ['1', 'Ceiling'], ['broken', 'Broken']].map(([v, l]) => h('option', { value: v, selected: v === this.filter }, l)));
    body.appendChild(h('div.lib-toolbar', search, sortSel, filterSel, h('div.grow'),
      h('span.faint.small', `Indexed ${new Date(state.workshop.scanned).toLocaleString()}`),
      btn('Rescan', async () => { state.workshop = null; await api.scanWorkshop({ roots: state.env.workshops, force: false }); this.draw(); }, { cls: 'sm', ic: 'refresh' })));
    this.wsGrid = h('div.lib-grid');
    this.wsDetail = h('div.card.card-pad.detail-panel', h('div.faint', 'Select an item'));
    body.appendChild(h('div.lib-layout', h('div', this.wsGrid, this.moreEl = h('div', { style: { textAlign: 'center', marginTop: '12px' } })), this.wsDetail));
    this.drawWorkshopGrid();
  }

  drawWorkshopGrid() {
    const q = this.query.toLowerCase().trim();
    let list = state.workshop.items.filter((w) => {
      if (this.filter === 'broken') return w.broken;
      if (this.filter !== 'all' && String(w.placement) !== this.filter) return false;
      return !q || (w.name || '').toLowerCase().includes(q) || w.id.includes(q);
    });
    const by = { name: (a, b) => (a.name || '').localeCompare(b.name || ''), new: (a, b) => (b.mtime || 0) - (a.mtime || 0), tris: (a, b) => (b.triangles || 0) - (a.triangles || 0), size: (a, b) => (b.size || 0) - (a.size || 0), price: (a, b) => (b.price || 0) - (a.price || 0) }[this.sort];
    list = list.sort(by);
    const grid = clear(this.wsGrid);
    for (const w of list.slice(0, this.limit)) {
      const card = h('div.lib-card', {
        onclick: () => { grid.querySelectorAll('.sel').forEach((c) => c.classList.remove('sel')); card.classList.add('sel'); this.workshopDetail(w); },
        ondblclick: () => this.app.openInEditor({ workshop: w, asCopy: true }),
      },
      h('div.img', w.thumb ? h('img', { src: fileUrl(w.thumb), loading: 'lazy' }) : null, w.broken ? h('span.badge.red', 'broken') : w.placement === 2 ? h('span.badge', 'wall') : w.placement === 1 ? h('span.badge', 'ceiling') : null),
      h('div.meta', h('b', { title: w.name }, w.name || '#' + w.id), h('span', `${fmtNum(w.triangles || 0)} tris · ${fmtBytes(w.size || 0)}`)));
      grid.appendChild(card);
    }
    clear(this.moreEl);
    if (list.length > this.limit) this.moreEl.appendChild(btn(`Show more (${fmtNum(list.length - this.limit)} left)`, () => { this.limit += 480; this.drawWorkshopGrid(); }, { cls: 'sm' }));
    if (!list.length) grid.appendChild(h('div.empty', { style: { gridColumn: '1 / -1' } }, 'Nothing matches.'));
  }

  workshopDetail(w) {
    const el = clear(this.wsDetail);
    const cat = categoryLabel(w.category);
    const tags = (w.tags || []).map((g) => state.collections.tagByGuid.get(g)?.short).filter(Boolean);
    el.append(
      h('div.img', w.thumb ? h('img', { src: fileUrl(w.thumb) }) : null),
      h('h3', w.name || '#' + w.id),
      w.broken ? h('div.check-item.error', { style: { marginBottom: '10px' } }, icon('error', 'ico'), h('div', w.error || 'This item could not be read')) : null,
      h('div.kv',
        h('div.k', 'Workshop id'), h('div.mono', w.id),
        h('div.k', 'Placement'), h('div', PLACEMENT_NAMES[w.placement ?? 0]),
        h('div.k', 'Category'), h('div', cat || '—'),
        h('div.k', 'Price'), h('div', w.price ? '$' + (Math.round(w.price * 100) / 100) : '—'),
        h('div.k', 'Geometry'), h('div', `${fmtNum(w.vertices || 0)} verts · ${fmtNum(w.triangles || 0)} tris · ${w.meshes || 0} meshes`),
        h('div.k', 'Colliders'), h('div', String(w.colliders ?? '—')),
        h('div.k', 'File'), h('div', fmtBytes(w.size || 0)),
        h('div.k', 'Tags'), h('div.small', tags.join(', ') || '—')),
      w.description ? h('p.small.muted', w.description) : null,
      h('div.btn-row',
        !w.broken ? btn('Remix as my item', () => this.app.openInEditor({ workshop: w, asCopy: true }), { cls: 'primary sm', ic: 'copy', title: 'Open a copy with no workshop id, to edit and publish as your own' }) : null,
        !w.broken ? btn('Open (keep id)', () => this.app.openInEditor({ workshop: w, asCopy: false }), { cls: 'sm', ic: 'cube', title: 'For your own published items: edit and upload an update' }) : null,
        btn('Folder', () => api.openPath(w.dir), { cls: 'sm', ic: 'folder' }),
        btn('Steam page', () => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${w.id}`), { cls: 'sm', ic: 'external' })),
      h('p.small.faint', { style: { marginTop: '10px' } }, 'Respect the original creator: only republish items you made or have permission to use.'));
  }

  // ---------- uploads ----------

  async drawUploads() {
    const body = this.body;
    const g = game();
    if (!g?.steamDll || !state.env.python) {
      body.appendChild(h('div.empty', icon('steam'), h('p', 'Listing your uploads needs the Steam API from the House Flipper folder and Python.')));
      return;
    }
    body.appendChild(h('div.row.faint', h('span.spinner'), 'Asking Steam for your published items…'));
    let res;
    try { res = await api.steam({ command: 'myitems', args: { dll: g.steamDll } }); } catch (e) {
      clear(body).appendChild(h('div.check-item.error', icon('error', 'ico'), h('div', 'Steam: ' + e.message)));
      return;
    }
    const projects = await this.loadProjects();
    const byGuid = new Map(projects.filter((p) => p.meta?.guid).map((p) => [p.meta.guid, p]));
    clear(body);
    if (!res.items.length) { body.appendChild(h('div.empty', icon('upload'), h('p', 'You have not published any House Flipper items yet.'))); return; }
    body.appendChild(h('div.card', { style: { overflow: 'auto' } }, h('table.tbl',
      h('tr', h('th', 'Title'), h('th', 'Id'), h('th', 'Visibility'), h('th', 'Updated'), h('th', 'Project'), h('th', '')),
      res.items.map((it) => {
        const proj = byGuid.get(it.fileId);
        const installed = state.workshop?.items?.find((w) => w.id === it.fileId);
        return h('tr', h('td', it.title), h('td.mono', it.fileId), h('td', VISIBILITY[it.visibility]?.name || it.visibility),
          h('td', it.updated ? new Date(it.updated * 1000).toLocaleString() : ''),
          h('td', proj ? h('span.badge.green', 'linked') : h('span.badge', 'none')),
          h('td', h('div.btn-row',
            proj ? btn('Open project', () => this.app.openInEditor({ project: proj.dir }), { cls: 'xs', ic: 'cube' })
              : installed ? btn('Open installed copy', () => this.app.openInEditor({ workshop: installed, asCopy: false }), { cls: 'xs', ic: 'cube' }) : null,
            btn('Steam', () => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${it.fileId}`), { cls: 'xs', ic: 'external' }))));
      }))));
  }
}
