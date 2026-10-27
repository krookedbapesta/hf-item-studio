const { contextBridge, ipcRenderer, webUtils } = require('electron');

const names = [
  'getSettings', 'setSettings', 'detectEnvironment',
  'readFile', 'readText', 'writeFile', 'copyFile', 'listDir', 'statPath', 'makeDir', 'readModelBundle',
  'scanWorkshop', 'getWorkshopIndex', 'getReference', 'hasReference', 'rebuildReference', 'deepScanWorkshop', 'cancelDeepScan', 'getHealth',
  'steam', 'stageUpload', 'readGameLog',
];

const api = {};
for (const n of names) api[n] = (arg) => ipcRenderer.invoke('api:' + n, arg);
api.openDialog = (o) => ipcRenderer.invoke('dialog:open', o);
api.saveDialog = (o) => ipcRenderer.invoke('dialog:save', o);
api.confirm = (o) => ipcRenderer.invoke('dialog:confirm', o);
api.openPath = (p) => ipcRenderer.invoke('shell:open', p);
api.showInFolder = (p) => ipcRenderer.invoke('shell:show', p);
api.openExternal = (u) => ipcRenderer.invoke('shell:external', u);
api.trash = (p) => ipcRenderer.invoke('shell:trash', p);
api.onProgress = (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on('progress', h);
  return () => ipcRenderer.removeListener('progress', h);
};
api.pathForFile = (file) => webUtils.getPathForFile(file);
api.isElectron = true;

contextBridge.exposeInMainWorld('hf', api);
