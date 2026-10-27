// App shell: navigation and view switching.
import { h, clear, toast } from './dom.js';
import { icon } from './icons.js';
import { state, initState, onState, game } from './state.js';
import { HomeView } from './views/home.js';
import { EditorView } from './views/editor.js';
import { BatchView } from './views/batch.js';
import { LibraryView } from './views/library.js';
import { HealthView } from './views/health.js';
import { LogView } from './views/log.js';
import { SettingsView } from './views/settings.js';
import { TemplatesView } from './views/templates.js';

const NAV = [
  { id: 'home', label: 'Home', icon: 'home', view: HomeView },
  { id: 'editor', label: 'Item editor', icon: 'cube', view: EditorView, keep: true },
  { id: 'batch', label: 'Batch import', icon: 'layers', view: BatchView, keep: true },
  { sep: 'Library' },
  { id: 'library', label: 'My items & workshop', icon: 'library', view: LibraryView, keep: true },
  { id: 'health', label: 'Workshop health', icon: 'heart', view: HealthView, keep: true },
  { id: 'log', label: 'Game log', icon: 'log', view: LogView },
  { sep: 'Setup' },
  { id: 'templates', label: 'Templates', icon: 'template', view: TemplatesView },
  { id: 'settings', label: 'Settings', icon: 'settings', view: SettingsView },
];

const app = {
  current: null,
  views: new Map(),
  go(id, arg) {
    const entry = NAV.find((n) => n.id === id);
    if (!entry) return;
    const root = document.getElementById('view');
    if (this.current && this.current.entry.keep) this.current.el.classList.add('hidden');
    else if (this.current) { this.current.instance.destroy?.(); this.current.el.remove(); this.views.delete(this.current.entry.id); }
    let v = this.views.get(id);
    if (!v) {
      const instance = new entry.view(this);
      const el = instance.render();
      el.classList.add('view-root');
      el.style.flex = '1';
      el.style.minHeight = '0';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      root.appendChild(el);
      v = { entry, instance, el };
      if (entry.keep) this.views.set(id, v);
    }
    v.el.classList.remove('hidden');
    this.current = v;
    v.instance.show?.(arg);
    for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.id === id);
  },
  /** Open an item in the editor, asking about unsaved work first. */
  async openInEditor(loader) {
    this.go('editor');
    const ed = this.views.get('editor').instance;
    return ed.load(loader);
  },
  editor() {
    if (!this.views.get('editor')) { this.go('editor'); }
    return this.views.get('editor').instance;
  },
};
window.hfApp = app;

function renderNav() {
  const nav = clear(document.getElementById('nav'));
  for (const n of NAV) {
    if (n.sep) { nav.appendChild(h('div.nav-sep', n.sep)); continue; }
    nav.appendChild(h('button.nav-item', { dataset: { id: n.id }, onclick: () => app.go(n.id) }, icon(n.icon), n.label));
  }
}

function renderFoot() {
  const f = clear(document.getElementById('nav-foot'));
  const g = game();
  const ok = (v) => h('span.dot', { style: { background: v ? 'var(--green)' : 'var(--red)' } });
  f.appendChild(h('div', ok(!!g), g ? 'House Flipper found' : 'Game not found'));
  f.appendChild(h('div', ok(!!state.env?.workshops?.length), `${state.env?.workshops?.length || 0} workshop folder(s)`));
  f.appendChild(h('div', ok(!!state.env?.python), state.env?.python ? state.env.python.version : 'Python not found'));
}

async function boot() {
  renderNav();
  const view = document.getElementById('view');
  view.appendChild(h('div.page', h('div.empty', h('div.spinner'), h('p', 'Looking for House Flipper and your workshop folders…'))));
  try {
    await initState();
  } catch (e) {
    clear(view).appendChild(h('div.page', h('div.empty', icon('alert'), h('p', 'Could not start: ' + e.message))));
    return;
  }
  clear(view);
  renderFoot();
  onState((w) => { if (w === 'settings') renderFoot(); });
  app.go('home');
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's' && app.current?.entry.id === 'editor') { e.preventDefault(); app.current.instance.save(); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  window.addEventListener('unhandledrejection', (e) => toast('Something went wrong', e.reason?.message || String(e.reason), 'err', 8000));
}

boot();
