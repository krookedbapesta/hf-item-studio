// Colour variants: clone the item, recolour one material, save each as its own project.
import * as THREE from 'three';
import { h, clear, btn, toast, modal } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { ItemProject } from '../item.js';

export const COLOR_PRESETS = [
  ['Black', '#2a2a2c'], ['White', '#f2f2ee'], ['Gray', '#8c8f94'], ['Brown', '#7a5236'], ['Red', '#b8322f'], ['Orange', '#e07a2c'],
  ['Yellow', '#e3c03a'], ['Green', '#4f8a47'], ['Blue', '#3567b5'], ['Violet', '#7b4fb0'], ['Pink', '#e08aa8'],
];

function cloneItem(src) {
  const p = new ItemProject();
  p.meta = structuredClone(src.meta);
  p.settings = structuredClone(src.settings);
  p.colliders = src.colliders.map((c) => ({ ...c, center: [...c.center], size: c.size ? [...c.size] : undefined }));
  const matMap = new Map();
  p.model = src.model.clone(true);
  p.model.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry = o.geometry.clone();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const cl = mats.map((m) => {
      if (!matMap.has(m)) {
        // Material.clone JSON-copies userData, which holds the original texture bytes
        const ud = m.userData;
        m.userData = {};
        const c = m.clone();
        m.userData = ud;
        c.userData = { ...ud };
        matMap.set(m, c);
      }
      return matMap.get(m);
    });
    o.material = Array.isArray(o.material) ? cl : cl[0];
  });
  p.source = src.source;
  return { item: p, matMap };
}

export function createVariants(item, { onDone } = {}) {
  const mats = [];
  item.model.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!mats.includes(m)) mats.push(m); });
  const matSel = h('select.input', mats.map((m, i) => h('option', { value: i }, `${m.name || 'Material ' + (i + 1)}${m.map ? ' (textured)' : ''}`)));
  const chosen = new Set(['Black', 'White', 'Gray']);
  const custom = [];
  const grid = h('div.chips');
  const drawGrid = () => {
    clear(grid);
    for (const [name, hex] of [...COLOR_PRESETS, ...custom]) {
      grid.appendChild(h('button.tag-toggle' + (chosen.has(name) ? '.on' : ''), { onclick: () => { chosen.has(name) ? chosen.delete(name) : chosen.add(name); drawGrid(); } },
        h('span.swatch', { style: { background: hex, marginRight: '6px' } }), name));
    }
  };
  drawGrid();
  const customName = h('input.input.sm', { placeholder: 'Name, e.g. Sage' });
  const customColor = h('input', { type: 'color', value: '#9aa88f' });
  const mode = h('select.input', h('option', { value: 'tint' }, 'Tint (keeps the texture, multiplies its colour)'), h('option', { value: 'replace' }, 'Solid colour (removes the colour texture)'));
  const tagColors = h('input', { type: 'checkbox', checked: true });
  const progress = h('div.small.muted');
  modal({
    title: 'Create colour variants',
    body: h('div',
      h('label.field', h('span', 'Material to recolour'), matSel),
      h('label.field', h('span', 'How'), mode),
      h('div.field-label', { style: { marginBottom: '6px' } }, 'Colours'), grid,
      h('div.row', { style: { marginTop: '8px' } }, customName, customColor, btn('Add', () => { const n = customName.value.trim(); if (!n) return; custom.push([n, customColor.value]); chosen.add(n); customName.value = ''; drawGrid(); }, { cls: 'sm', ic: 'plus' })),
      h('label.check', { style: { marginTop: '10px' } }, tagColors, 'Add the matching Colors/… tag'),
      h('p.small.faint', `Each variant is saved to ${state.settings.projectsDir}\\<name> - <colour>.`),
      progress),
    foot: (close) => [btn('Cancel', close), btn('Create', async () => {
      const target = mats[+matSel.value];
      const list = [...COLOR_PRESETS, ...custom].filter(([n]) => chosen.has(n));
      if (!list.length) return;
      let n = 0;
      for (const [name, hex] of list) {
        progress.textContent = `Creating ${name}… (${++n}/${list.length})`;
        const { item: v, matMap } = cloneItem(item);
        const m = matMap.get(target);
        m.color.setStyle(hex, THREE.SRGBColorSpace);
        if (mode.value === 'replace') m.map = null;
        m.userData.dirty = true;
        v.meta.name = `${item.meta.name} - ${name}`;
        v.meta.guid = '';
        if (tagColors.checked) {
          const tag = state.collections.tagByName.get('Colors/' + name);
          const colorTags = new Set(state.collections.tags.filter((t) => t.group === 'Colors').map((t) => t.guid));
          v.meta.tagGuids = v.meta.tagGuids.filter((g) => !colorTags.has(g));
          if (tag) v.meta.tagGuids.push(tag.guid);
        }
        v.renderThumb();
        v.projectDir = null;
        await v.save();
      }
      close();
      toast('Variants created', `${list.length} items saved to your projects folder`, 'ok', 6000);
      onDone?.();
    }, { cls: 'primary', ic: 'palette' })],
  });
  void icon;
}
