// Category tree, tag picker and reference-item search used by the editor and batch views.
import { h, clear, debounce, fmtSize, toast } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { api, fileUrl } from '../api.js';
import { SPECIAL_TAGS } from '../../core/constants.js';

export function categoryLabel(guid) {
  const c = state.collections.catByGuid.get(guid);
  return c ? c.path : '';
}

/** Searchable category tree. onPick(guid). */
export function categoryPicker(selected, onPick) {
  const wrap = h('div');
  const search = h('input.input.sm', { placeholder: 'Search categories…', style: { marginBottom: '6px' } });
  const tree = h('div.cat-tree');
  const draw = () => {
    clear(tree);
    const q = search.value.trim().toLowerCase();
    const cats = state.collections.categories.filter((c) => !q || c.name.toLowerCase().includes(q));
    let lastGroup = '';
    for (const c of cats.sort((a, b) => a.name.localeCompare(b.name))) {
      const group = c.parts.slice(0, 1).join('');
      if (group !== lastGroup) { tree.appendChild(h('div.cat-node.grp', group.replace(/([a-z])([A-Z])/g, '$1 $2'))); lastGroup = group; }
      const depth = c.parts.length - 2;
      tree.appendChild(h('div.cat-node' + (c.guid === selected ? '.sel' : ''), {
        style: { paddingLeft: 8 + Math.max(0, depth) * 12 + 'px' },
        onclick: () => { selected = c.guid; onPick(c.guid); draw(); },
        title: c.name,
      }, c.parts.slice(1).join(' › ') || c.short));
    }
    if (!cats.length) tree.appendChild(h('div.faint.small', { style: { padding: '8px' } }, 'No match'));
  };
  search.addEventListener('input', draw);
  draw();
  wrap.append(search, tree);
  setTimeout(() => tree.querySelector('.sel')?.scrollIntoView({ block: 'center' }), 0);
  return wrap;
}

/** Tag picker grouped by prefix. Placement-driven tags are shown but locked. */
export function tagPicker(selected, onChange, { placement = 0, canBePlacedOn = false } = {}) {
  const set = new Set(selected);
  const wrap = h('div');
  const search = h('input.input.sm', { placeholder: 'Search tags…', style: { marginBottom: '6px' } });
  const box = h('div.tag-pick');
  const locked = new Map([
    [SPECIAL_TAGS.hanging, placement === 2],
    [SPECIAL_TAGS.ceiling, placement === 1],
    [SPECIAL_TAGS.placeOn, canBePlacedOn],
  ]);
  const draw = () => {
    clear(box);
    const q = search.value.trim().toLowerCase();
    for (const [group, tags] of state.collections.tagGroups) {
      const list = tags.filter((t) => !q || t.name.toLowerCase().includes(q));
      if (!list.length) continue;
      box.appendChild(h('div.tag-group', h('div', group), h('div', list.map((t) => {
        const isLocked = locked.has(t.name);
        const on = isLocked ? locked.get(t.name) : set.has(t.guid);
        return h('button.tag-toggle' + (on ? '.on' : '') + (isLocked ? '.locked' : ''), {
          title: isLocked ? 'Set automatically from placement / options' : t.name,
          onclick: () => {
            if (isLocked) return;
            if (set.has(t.guid)) set.delete(t.guid); else set.add(t.guid);
            onChange([...set]);
            draw();
          },
        }, t.short);
      }))));
    }
  };
  search.addEventListener('input', draw);
  draw();
  wrap.append(search, box);
  return wrap;
}

export function tagChips(guids, onRemove) {
  return h('div.chips', guids.map((g) => {
    const t = state.collections.tagByGuid.get(g);
    return h('span.chip', t ? t.short : g.slice(0, 8), onRemove ? h('button', { onclick: () => onRemove(g), title: 'Remove' }, icon('x')) : null);
  }));
}

// ---------- reference search ----------

const dims = (s) => `${fmtSize(s[0])} × ${fmtSize(s[1])} × ${fmtSize(s[2])}`;

/** Score base items by similarity to a size (and optionally hanging-ness). */
export function similarItems(ref, size, { hanging = null, limit = 12, folderHint = '' } = {}) {
  const [w, hgt, d] = size;
  const lw = Math.log(Math.max(w, 0.01)), lh = Math.log(Math.max(hgt, 0.01)), ld = Math.log(Math.max(d, 0.01));
  const out = [];
  for (const r of ref.items) {
    if (!r.price || r.size.some((v) => v <= 0)) continue;
    if (hanging !== null && r.hanging !== hanging) continue;
    if (/molding|panels|tiles|wallpaper|paint/.test(r.lfolder)) continue;
    const s = r.size;
    // compare footprint either way round, items are often rotated
    const a = (Math.log(Math.max(s[0], 0.01)) - lw) ** 2 + (Math.log(Math.max(s[2], 0.01)) - ld) ** 2;
    const b = (Math.log(Math.max(s[2], 0.01)) - lw) ** 2 + (Math.log(Math.max(s[0], 0.01)) - ld) ** 2;
    let score = Math.min(a, b) + (Math.log(Math.max(s[1], 0.01)) - lh) ** 2 * 1.3;
    if (folderHint && r.lfolder.includes(folderHint)) score *= 0.6;
    out.push([score, r]);
  }
  out.sort((x, y) => x[0] - y[0]);
  // one per name stem so colour variants do not crowd the list
  const seen = new Set();
  const res = [];
  for (const [score, r] of out) {
    const key = r.lname.replace(/\b(dark|light|white|black|grey|gray|blue|red|green|left|right|\d+)\b/g, '').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    res.push({ ...r, score });
    if (res.length >= limit) break;
  }
  return res;
}

export function suggestPrice(similar) {
  const prices = similar.map((r) => r.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const mid = prices[Math.floor(prices.length / 2)];
  return { median: mid, low: prices[Math.floor(prices.length * 0.25)], high: prices[Math.floor(prices.length * 0.75)] };
}

/** Search box over base-game reference items and installed workshop items. */
export function referenceSearch(ref, onPick, { workshop = null, placeholder = 'Search 10,000+ base-game items…' } = {}) {
  const wrap = h('div');
  const input = h('input.input.sm', { placeholder });
  const src = h('select.input.sm', { style: { width: '110px', flex: 'none' } }, h('option', { value: 'base' }, 'Base game'), workshop ? h('option', { value: 'ws' }, 'Workshop') : null);
  const results = h('div.ref-results', { style: { marginTop: '6px' } });
  const draw = debounce(() => {
    clear(results);
    const q = input.value.trim().toLowerCase();
    if (src.value === 'ws' && workshop) {
      const list = workshop.items.filter((w) => !w.broken && (!q || (w.name || '').toLowerCase().includes(q))).slice(0, 80);
      for (const w of list) {
        results.appendChild(h('div.ref-row', { onclick: () => onPick({ workshop: w }) },
          w.thumb ? h('img', { src: fileUrl(w.thumb) }) : null,
          h('span.n', { title: w.name }, w.name || w.id), h('span.d', `${(w.triangles / 1000).toFixed(0)}k tris`)));
      }
      if (!list.length) results.appendChild(h('div.faint.small', { style: { padding: '8px' } }, 'No workshop items match'));
      return;
    }
    const words = q.split(/\s+/).filter(Boolean);
    const list = ref.items.filter((r) => words.every((w) => r.lname.includes(w) || r.lfolder.includes(w))).slice(0, 120);
    for (const r of list) {
      results.appendChild(h('div.ref-row', { onclick: () => onPick({ ref: r }), title: r.folder },
        h('span.n', r.name), h('span.d', dims(r.size)), r.price ? h('span.badge', '$' + r.price) : null));
    }
    if (!list.length) results.appendChild(h('div.faint.small', { style: { padding: '8px' } }, 'No base-game items match'));
  }, 120);
  input.addEventListener('input', draw);
  src.addEventListener('change', draw);
  wrap.append(h('div.row', input, src), results);
  draw();
  return wrap;
}

/**
 * Card shown while the base-game library has not been built. It is read from the user's
 * own game files (never shipped with the app), which needs Python; UnityPy is installed
 * automatically.
 */
export function referenceBuildCard(onBuilt, { compact = false } = {}) {
  const log = h('div.small.faint.mono', { style: { whiteSpace: 'pre-wrap', maxHeight: '90px', overflow: 'auto', marginTop: '6px' } });
  const g = gameForBuild();
  const run = async (b) => {
    b.disabled = true;
    b.textContent = 'Building…';
    const off = api.onProgress((p) => { if (p.kind === 'reference') { log.textContent = (log.textContent + '\n' + p.line).split('\n').slice(-5).join('\n').trim(); } });
    try {
      await api.rebuildReference({ gameDir: g.path });
      state.reference = null;
      toast('Base-game library ready', 'Compare, room furnishing and price suggestions now work.', 'ok', 6000);
      onBuilt?.();
    } catch (e) {
      toast('Could not build the library', e.message, 'err', 10000);
      b.disabled = false;
      b.textContent = 'Try again';
    } finally { off(); }
  };
  const button = h('button.btn.sm.primary', { onclick: (e) => run(e.currentTarget) }, 'Build it now');
  if (!g) return h('div.check-item.warn', icon('alert', 'ico'), h('div', 'The base-game library needs your House Flipper install, which was not found. Set it in Settings.'));
  if (!state.env.python) return h('div.check-item.warn', icon('alert', 'ico'), h('div', 'The base-game library is built from your game files with Python 3. Install Python from python.org, then restart the app.'));
  return h('div.check-item.info', icon('info', 'ico'), h('div',
    compact ? 'Build the base-game library (about 30 seconds) to compare with 10,000+ game items.'
      : 'Compare, room furnishing and price suggestions use the sizes and prices of every base-game item. They are read from your own House Flipper install the first time (about 30 seconds; installs the UnityPy Python package if needed).',
    h('div.fix', button), log));
}

function gameForBuild() {
  const gs = state.env?.games || [];
  return gs[state.settings.selectedGame] || gs[0] || null;
}

export { dims };
