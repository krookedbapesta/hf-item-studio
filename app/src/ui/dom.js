// Tiny DOM helpers used by every view.
import { icon } from './icons.js';

/**
 * h('div.card.pad', { onclick, style: {...}, dataset }, children...)
 * Strings become text nodes; arrays are flattened; null/false are skipped.
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function btn(label, onclick, { cls = '', ic, title, disabled } = {}) {
  return h('button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''), { onclick, title, disabled }, ic ? icon(ic) : null, label || null);
}

export function toast(title, msg = '', kind = 'info', ms = 4200) {
  const el = h('div.toast.' + kind, h('b', title), msg ? h('div.muted', msg) : null);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.transition = '0.25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, ms);
  return el;
}

export function modal({ title, body, foot, wide = false, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => { back.remove(); onClose && onClose(); };
  const back = h('div.modal-back', { onmousedown: (e) => { if (e.target === back) close(); } },
    h('div.modal' + (wide ? '.wide' : ''),
      h('div.modal-head', h('h2', title), h('button.btn.ghost.icon', { onclick: close, title: 'Close' }, icon('x'))),
      h('div.modal-body', body),
      foot ? h('div.modal-foot', typeof foot === 'function' ? foot(close) : foot) : null));
  root.appendChild(back);
  return { close, el: back };
}

/** Promise-based prompt with arbitrary fields. Resolves to values or null. */
export function ask(title, fields, { okLabel = 'OK', description } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const body = h('div',
      description ? h('p.muted', { style: { marginTop: 0 } }, description) : null,
      fields.map((f) => {
        let inp;
        if (f.type === 'select') inp = h('select.input', f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
        else if (f.type === 'textarea') inp = h('textarea.input', { value: f.value || '' });
        else inp = h('input.input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '' });
        inputs[f.name] = inp;
        return h('label.field', h('span', f.label), inp, f.hint ? h('div.field-hint', f.hint) : null);
      }));
    let done = false;
    const m = modal({
      title, body,
      foot: (close) => [
        btn('Cancel', () => close()),
        btn(okLabel, () => {
          done = true;
          const out = {};
          for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'number' ? Number(el.value) : el.value;
          close();
          resolve(out);
        }, { cls: 'primary' }),
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
    m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') m.el.querySelector('.btn.primary').click(); });
  });
}

export function switchInput(checked, onchange) {
  const inp = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) });
  return h('label.switch', inp, h('i'));
}

export function seg(options, value, onchange, cls = '') {
  const el = h('div.seg' + (cls ? '.' + cls : ''));
  const render = (v) => {
    clear(el);
    for (const o of options) {
      el.appendChild(h('button' + (o.value === v ? '.on' : ''), { title: o.title, onclick: () => { render(o.value); onchange(o.value); } }, o.icon ? icon(o.icon) : null, o.label));
    }
  };
  render(value);
  el.set = render;
  return el;
}

export function numberInput(value, onchange, { step = 0.01, min, max, cls = 'sm', digits = 3, suffix } = {}) {
  const el = h('input.input.num.' + cls, { type: 'number', step, min, max, value: Number.isFinite(value) ? +value.toFixed(digits) : '' });
  el.addEventListener('change', () => { const v = parseFloat(el.value); if (Number.isFinite(v)) onchange(v); });
  el.addEventListener('wheel', (e) => {
    if (document.activeElement !== el) return;
    e.preventDefault();
    const v = (parseFloat(el.value) || 0) + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 10 : 1);
    el.value = +v.toFixed(digits);
    onchange(v);
  }, { passive: false });
  if (suffix) el.title = suffix;
  return el;
}

export const fmtSize = (m) => (Math.abs(m) >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(1)} cm`);
export const fmtBytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`);
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Yield to the browser so long loops keep the UI responsive. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
