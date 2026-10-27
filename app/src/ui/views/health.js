// Workshop health: find installed items that are broken or risky.
import { h, clear, btn, toast, seg, fmtNum, fmtBytes } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadWorkshopIndex } from '../state.js';

const RULES = [
  [/out of range|truncated|Invalid (vertex|triangle)|missing|Not a valid|could not|No \.hfcontent/i, 'Fails to load or renders garbage in game'],
  [/no colliders/i, 'Cannot be placed'],
  [/no visible meshes/i, 'Invisible in game'],
];

export class HealthView {
  constructor(app) { this.app = app; this.filter = 'errors'; this.result = null; }

  render() {
    this.el = h('div.page');
    api.getHealth().then((r) => { if (r) { this.result = r; this.draw(); } });
    this.draw();
    return this.el;
  }

  async scan(force) {
    if (this.running) return;
    this.running = true;
    this.draw();
    const off = api.onProgress((p) => {
      if (p.kind !== 'health') return;
      this.progress = p;
      if (this.barEl) { this.barEl.style.width = (p.done / Math.max(1, p.total)) * 100 + '%'; this.progEl.textContent = `${fmtNum(p.done)} / ${fmtNum(p.total)}`; }
    });
    try {
      this.result = await api.deepScanWorkshop({ roots: state.env.workshops, force });
      const bad = this.result.items.filter((i) => i.errors.length).length;
      toast('Health check done', `${fmtNum(this.result.items.length)} items checked, ${bad} with errors`, bad ? 'warn' : 'ok', 6000);
    } catch (e) { toast('Scan failed', e.message, 'err'); } finally { off(); this.running = false; this.draw(); }
  }

  draw() {
    const el = clear(this.el);
    el.appendChild(h('div.page-head',
      h('div', h('h1', 'Workshop health'), h('p', 'Decodes every mesh of every item you are subscribed to, exactly the way the game\'s loader does, and lists the ones that will break.')),
      h('div.spacer'),
      this.running ? btn('Stop', () => api.cancelDeepScan(), { ic: 'x' }) : null,
      btn(this.running ? 'Scanning…' : this.result ? 'Scan again' : 'Run health check', () => this.scan(false), { cls: 'primary', ic: 'pulse', disabled: this.running }),
      this.result && !this.running ? btn('Full rescan', () => this.scan(true), { ic: 'refresh', title: 'Ignore the cache and re-read every file' }) : null));
    if (this.running) {
      this.barEl = h('i');
      this.progEl = h('span.faint.small', 'starting…');
      el.appendChild(h('div.card.card-pad', { style: { marginBottom: '14px' } }, h('div.row', { style: { marginBottom: '8px' } }, h('span.spinner'), h('b', 'Checking items'), h('div.grow'), this.progEl), h('div.progress', this.barEl)));
    }
    if (!this.result) {
      el.appendChild(h('div.empty', icon('heart'), h('p', `${state.env.workshops.length} workshop folder(s) found. The first check takes a few minutes; later checks only look at items that changed.`)));
      return;
    }
    const items = this.result.items;
    const errs = items.filter((i) => i.errors.length);
    const warns = items.filter((i) => !i.errors.length && i.warnings.length);
    const heavy = items.filter((i) => (i.stats?.triangles || 0) > 100000);
    const totalSize = items.reduce((a, i) => a + (i.size || 0), 0);
    const stat = (v, label, cls) => h('div.card.card-pad', h('div', { style: { fontSize: '24px', fontWeight: 700, color: cls } }, v), h('div.faint.small', label));
    el.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '10px', marginBottom: '14px' } },
      stat(fmtNum(items.length), 'items checked'), stat(fmtNum(errs.length), 'with errors', errs.length ? 'var(--red)' : 'var(--green)'),
      stat(fmtNum(warns.length), 'with warnings only', 'var(--yellow)'), stat(fmtNum(heavy.length), 'over 100k triangles'), stat(fmtBytes(totalSize), 'on disk')));
    el.appendChild(h('div.lib-toolbar', seg([{ value: 'errors', label: `Errors (${errs.length})` }, { value: 'warnings', label: `Warnings (${warns.length})` }, { value: 'heavy', label: `Heavy (${heavy.length})` }], this.filter, (v) => { this.filter = v; this.draw(); }),
      h('div.grow'), h('span.faint.small', `Checked ${new Date(this.result.scanned).toLocaleString()}${this.result.complete ? '' : ' (stopped early)'}`)));
    const list = { errors: errs, warnings: warns, heavy: heavy.sort((a, b) => b.stats.triangles - a.stats.triangles) }[this.filter];
    if (!list.length) { el.appendChild(h('div.empty', icon('check'), h('p', 'Nothing here.'))); return; }
    const ws = state.workshop;
    el.appendChild(h('div.card', { style: { overflow: 'auto' } }, h('table.tbl',
      h('tr', h('th', 'Item'), h('th', 'Problem'), h('th', 'Effect'), h('th', 'Size'), h('th', '')),
      list.slice(0, 500).map((i) => {
        const msgs = this.filter === 'errors' ? i.errors : this.filter === 'warnings' ? i.warnings : [`${fmtNum(i.stats.triangles)} triangles, ${fmtNum(i.stats.vertices)} vertices`];
        const effect = this.filter === 'errors' ? (RULES.find(([re]) => msgs.some((m) => re.test(m)))?.[1] || 'May not work') : this.filter === 'heavy' ? 'Slows the game down with many copies' : 'Probably fine';
        const wsItem = ws?.items?.find((w) => w.id === i.id);
        return h('tr',
          h('td', h('b', i.name || '(unreadable)'), h('div.mono.faint', '#' + i.id)),
          h('td.small', { style: { maxWidth: '420px' } }, msgs.slice(0, 3).map((m) => h('div', m)), msgs.length > 3 ? h('div.faint', `+${msgs.length - 3} more`) : null),
          h('td.small', effect),
          h('td.num', fmtBytes(i.size || 0)),
          h('td', h('div.btn-row',
            i.file && this.filter === 'errors' ? btn('Repair copy', async () => {
              const w = wsItem || { id: i.id, file: i.file, name: i.name };
              this.app.openInEditor({ workshop: w, asCopy: true });
            }, { cls: 'xs', ic: 'wand', title: 'Open a copy with broken triangles dropped, to fix and re-export' }) : null,
            btn('', () => api.openPath(i.dir), { cls: 'xs', ic: 'folder', title: 'Open folder' }),
            btn('', () => api.openExternal(`https://steamcommunity.com/sharedfiles/filedetails/?id=${i.id}`), { cls: 'xs', ic: 'external', title: 'Steam page (unsubscribe there)' }))));
      }))));
    if (!ws) loadWorkshopIndex().catch(() => {});
  }
}
