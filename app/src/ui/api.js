// Back-end bridge: Electron preload when available, otherwise the HTTP dev server.
const encode = (v) => {
  if (v instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode.apply(null, v.subarray(i, i + 0x8000));
    return { __b64: btoa(s) };
  }
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = encode(v[k]); return o; }
  return v;
};
const decode = (v) => {
  if (v && typeof v === 'object' && v.__b64 !== undefined) {
    const s = atob(v.__b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = decode(v[k]); return o; }
  return v;
};

function httpApi() {
  const call = async (name, arg) => {
    const r = await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(encode(arg || {})) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return decode(j.value);
  };
  const names = ['getSettings', 'setSettings', 'detectEnvironment', 'readFile', 'readText', 'writeFile', 'copyFile', 'listDir',
    'statPath', 'makeDir', 'readModelBundle', 'scanWorkshop', 'getWorkshopIndex', 'getReference', 'hasReference', 'rebuildReference', 'steam', 'stageUpload', 'readGameLog',
    'deepScanWorkshop', 'cancelDeepScan', 'getHealth'];
  const api = {};
  for (const n of names) api[n] = (a) => call(n, a);
  // dialogs are not available in the browser; ask for a path instead
  api.openDialog = async ({ title, folder, multi } = {}) => {
    const p = window.prompt(`${title || (folder ? 'Folder' : 'File')} path${multi ? ' (separate several with |)' : ''}:`);
    return p ? p.split('|').map((s) => s.trim()).filter(Boolean) : null;
  };
  api.saveDialog = async ({ title, defaultPath } = {}) => window.prompt(`${title || 'Save to'}:`, defaultPath || '') || null;
  api.confirm = async ({ message, buttons = ['OK', 'Cancel'] } = {}) => (window.confirm(message) ? 0 : buttons.length - 1);
  api.openPath = async () => {};
  api.showInFolder = async () => {};
  api.openExternal = async (u) => window.open(u, '_blank');
  api.trash = async () => {};
  const listeners = new Set();
  setInterval(async () => {
    if (!listeners.size) return;
    try {
      const r = await fetch('/api/events', { method: 'POST', body: '{}' });
      for (const e of await r.json()) listeners.forEach((l) => l(e));
    } catch { /* server gone */ }
  }, 400);
  api.onProgress = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  api.isElectron = false;
  return api;
}

export const api = window.hf || httpApi();

/** URL an <img> can use for a local file. */
export function fileUrl(p) {
  if (!p) return '';
  if (api.isElectron) return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  return '/file/' + encodeURIComponent(p);
}
