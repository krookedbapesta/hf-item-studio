// Reusable presets: category, tags, price, placement and collider settings.
import { h, clear, btn, toast, modal, numberInput } from '../dom.js';
import { icon } from '../icons.js';
import { state, saveSettings } from '../state.js';
import { categoryPicker, categoryLabel, tagPicker, tagChips } from './pickers.js';
import { CURRENCIES, PLACEMENT_NAMES, VISIBILITY } from '../../core/constants.js';

const STARTERS = [
  { name: 'Wall painting', placement: 2, cat: 'Workshop/InteriorDesign/Decorations/PhotosAndPaintings/Paintings', tags: ['Item types/Painting'], price: 120, colliderMode: 'single' },
  { name: 'Wall shelf', placement: 2, cat: 'Workshop/InteriorDesign/Furniture/Livingroom/Surfaces', tags: ['Furniture types/Shelf'], price: 80, colliderMode: 'fit', canPutOnTop: true },
  { name: 'Ceiling lamp', placement: 1, cat: 'Workshop/InteriorDesign/Lights/CeilingLamps', tags: ['Item types/Light'], price: 150, colliderMode: 'perMesh' },
  { name: 'Small decoration', placement: 0, cat: 'Workshop/InteriorDesign/Decorations/Standing decorations', tags: [], price: 40, canBePlacedOn: true, colliderMode: 'single' },
  { name: 'Sofa', placement: 0, cat: 'Workshop/InteriorDesign/Furniture/Livingroom/Seats', tags: ['Furniture types/Sofa'], price: 900, colliderMode: 'fit', maxBoxes: 4 },
  { name: 'Table', placement: 0, cat: 'Workshop/InteriorDesign/Furniture/Dinningroom', tags: ['Furniture types/Table'], price: 400, colliderMode: 'fit', maxBoxes: 5, canPutOnTop: true },
];

export class TemplatesView {
  constructor(app) { this.app = app; }
  render() { this.el = h('div.page'); this.draw(); return this.el; }

  draw() {
    const el = clear(this.el);
    const list = state.settings.templates || [];
    el.appendChild(h('div.page-head',
      h('div', h('h1', 'Templates'), h('p', 'Presets you can apply in the editor or use for a whole batch. Use {name} in the description to insert the item name.')),
      h('div.spacer'),
      !list.length ? btn('Add starter templates', () => this.addStarters(), { ic: 'sparkle' }) : null,
      btn('New template', () => this.edit(null), { cls: 'primary', ic: 'plus' })));
    if (!list.length) { el.appendChild(h('div.empty', icon('template'), h('p', 'No templates yet.'))); return; }
    el.appendChild(h('div.card', h('table.tbl',
      h('tr', h('th', 'Name'), h('th', 'Placement'), h('th', 'Category'), h('th', 'Tags'), h('th', 'Price'), h('th', 'Colliders'), h('th', '')),
      list.map((t, i) => h('tr',
        h('td', h('b', t.name)),
        h('td', t.placement === '' || t.placement === undefined ? h('span.faint', 'any') : PLACEMENT_NAMES[t.placement]),
        h('td.small', categoryLabel(t.categoryGuid) || h('span.faint', '—')),
        h('td', tagChips(t.tagGuids || [])),
        h('td.num', t.price !== undefined && t.price !== '' ? `${t.price} ${CURRENCIES[t.currency ?? 0].code}` : '—'),
        h('td.small', `${t.colliderMode || 'default'}${t.maxBoxes ? ` ≤${t.maxBoxes}` : ''}`),
        h('td', h('div.btn-row',
          btn('Edit', () => this.edit(i), { cls: 'xs' }),
          btn('', () => { const l = [...list]; l.splice(i + 1, 0, { ...structuredClone(t), name: t.name + ' copy' }); saveSettings({ templates: l }).then(() => this.draw()); }, { cls: 'xs ghost', ic: 'copy', title: 'Duplicate' }),
          btn('', () => { const l = list.filter((_, k) => k !== i); saveSettings({ templates: l }).then(() => this.draw()); }, { cls: 'xs ghost', ic: 'trash', title: 'Delete' }))))))));
  }

  async addStarters() {
    const byName = new Map(state.collections.categories.map((c) => [c.name, c.guid]));
    const tag = (n) => state.collections.tagByName.get(n)?.guid;
    const out = STARTERS.map((s) => ({
      name: s.name, placement: s.placement, categoryGuid: byName.get(s.cat) || '', tagGuids: s.tags.map(tag).filter(Boolean),
      price: s.price, currency: state.settings.defaultCurrency ?? 0, colliderMode: s.colliderMode, maxBoxes: s.maxBoxes, canBePlacedOn: !!s.canBePlacedOn,
    }));
    await saveSettings({ templates: out });
    toast('Starter templates added', `${out.length} templates`, 'ok');
    this.draw();
  }

  edit(index) {
    const list = state.settings.templates || [];
    const t = index === null ? { name: '', placement: '', categoryGuid: '', tagGuids: [], price: '', currency: state.settings.defaultCurrency ?? 0, canBePlacedOn: false, description: '', colliderMode: '', maxBoxes: '' } : structuredClone(list[index]);
    const catLabel = h('div.small.muted', categoryLabel(t.categoryGuid) || 'None');
    const body = h('div',
      h('label.field', h('span', 'Template name'), h('input.input', { value: t.name, oninput: (e) => { t.name = e.target.value; } })),
      h('div.grid2',
        h('label.field', h('span', 'Placement'), h('select.input', { onchange: (e) => { t.placement = e.target.value === '' ? '' : +e.target.value; } },
          h('option', { value: '' }, 'Leave as is'), PLACEMENT_NAMES.map((n, i) => h('option', { value: i, selected: t.placement === i }, n)))),
        h('label.field', h('span', 'Price'), h('div.row', h('input.input.num', { value: t.price, placeholder: 'leave as is', oninput: (e) => { t.price = e.target.value === '' ? '' : +e.target.value; } }),
          h('select.input', { style: { width: '80px' }, onchange: (e) => { t.currency = +e.target.value; } }, CURRENCIES.map((c) => h('option', { value: c.id, selected: c.id === t.currency }, c.code)))))),
      h('div.field-label', 'Category'), catLabel,
      categoryPicker(t.categoryGuid, (g) => { t.categoryGuid = g; catLabel.textContent = categoryLabel(g); }),
      h('div.field-label', { style: { marginTop: '10px' } }, 'Tags'),
      tagPicker(t.tagGuids || [], (g) => { t.tagGuids = g; }),
      h('label.check', { style: { marginTop: '8px' } }, h('input', { type: 'checkbox', checked: t.canBePlacedOn, onchange: (e) => { t.canBePlacedOn = e.target.checked; } }), 'Can be placed on other items'),
      h('div.grid2', { style: { marginTop: '8px' } },
        h('label.field', h('span', 'Collider mode'), h('select.input', { onchange: (e) => { t.colliderMode = e.target.value || undefined; } },
          [['', 'Default'], ['fit', 'Smart fit'], ['perMesh', 'Per part'], ['single', 'One box']].map(([v, l]) => h('option', { value: v, selected: (t.colliderMode || '') === v }, l)))),
        h('label.field', h('span', 'Max boxes'), numberInput(t.maxBoxes || 6, (v) => { t.maxBoxes = Math.max(1, Math.round(v)); }, { step: 1, digits: 0, cls: '' }))),
      h('label.field', h('span', 'Workshop visibility'), h('select.input', { onchange: (e) => { t.visibility = e.target.value === '' ? undefined : +e.target.value; } },
        h('option', { value: '' }, 'Default'), VISIBILITY.map((v) => h('option', { value: v.id, selected: t.visibility === v.id }, v.name)))),
      h('label.field', h('span', 'Description'), h('textarea.input', { value: t.description || '', placeholder: 'e.g. {name}, a handmade piece for your flips.', oninput: (e) => { t.description = e.target.value; } })));
    modal({
      title: index === null ? 'New template' : 'Edit template', body, wide: true,
      foot: (close) => [btn('Cancel', close), btn('Save template', async () => {
        if (!t.name.trim()) { toast('Name the template', '', 'warn'); return; }
        const l = [...list];
        if (index === null) l.push(t); else l[index] = t;
        await saveSettings({ templates: l });
        close();
        this.draw();
      }, { cls: 'primary' })],
    });
  }
}
