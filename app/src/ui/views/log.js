// Game log viewer focused on custom-item problems.
import { h, clear, btn } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state } from '../state.js';

const EXPLAIN = [
  [/negative scaling/i, 'A custom item uses a negative scale on a node with a collider. Harmless for most items, but collisions can misbehave. Re-export it through HF Item Studio to bake the scale away.'],
  [/Invalid vertex count|Invalid triangle count/i, 'A mesh is above the 64,000 vertex/triangle limit. HF Item Studio splits these automatically.'],
  [/out of bounds|out of range/i, 'A mesh has triangle indices that point past its vertices. Use Workshop health → Repair copy.'],
  [/Steam workshop item path is null/i, 'Steam reported a subscribed item that has not finished downloading.'],
  [/NullReference/i, 'The game hit missing data while loading an item.'],
];

export class LogView {
  constructor(app) { this.app = app; this.onlyErrors = true; }

  render() {
    this.el = h('div.page');
    this.load();
    return this.el;
  }

  async load() {
    const el = clear(this.el);
    el.appendChild(h('div.page-head',
      h('div', h('h1', 'Game log'), h('p', 'Messages about custom and workshop items from House Flipper\'s Player.log, with an explanation where we know what they mean.')),
      h('div.spacer'),
      h('label.check', h('input', { type: 'checkbox', checked: this.onlyErrors, onchange: (e) => { this.onlyErrors = e.target.checked; this.load(); } }), 'Errors only'),
      btn('Reload', () => this.load(), { ic: 'refresh' }),
      state.env.logDir ? btn('Open folder', () => api.openPath(state.env.logDir), { ic: 'folder' }) : null));
    if (!state.env.logDir) { el.appendChild(h('div.empty', icon('log'), h('p', 'No House Flipper log folder found. Start the game once and it will appear.'))); return; }
    const logs = await api.readGameLog({ logDir: state.env.logDir });
    for (const lg of logs) {
      const events = lg.events.filter((e) => !this.onlyErrors || e.error);
      el.appendChild(h('h3', { style: { margin: '18px 0 8px' } }, `${lg.file} `, h('span.faint.small', `${new Date(lg.mtime).toLocaleString()} · ${events.length} event(s)`)));
      if (!events.length) { el.appendChild(h('div.faint', 'Nothing relevant.')); continue; }
      // group identical messages
      const groups = new Map();
      for (const e of events) {
        const key = e.text.replace(/\d+/g, '#').replace(/"[^"]*"/g, '"…"');
        if (!groups.has(key)) groups.set(key, { first: e, count: 0 });
        groups.get(key).count++;
      }
      for (const { first, count } of groups.values()) {
        const ex = EXPLAIN.find(([re]) => re.test(first.context))?.[1];
        el.appendChild(h('details.log-event',
          h('summary', first.error ? h('span', { style: { color: 'var(--red)' } }, icon('error')) : h('span.faint', icon('info')),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, first.text),
            count > 1 ? h('span.badge', `×${count}`) : null, h('span.faint.small', `line ${first.line}`)),
          ex ? h('div.small', { style: { padding: '8px 12px', color: 'var(--accent-2)', borderTop: '1px solid var(--line)' } }, ex) : null,
          h('pre', first.context)));
      }
    }
  }
}
