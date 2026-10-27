// Electron entry point.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const handlers = require('./handlers');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#16191e',
    title: 'HF Item Studio',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r') win.webContents.reload();
  });
}

app.whenReady().then(() => {
  handlers.configure({
    userData: app.getPath('userData'),
    onProgress: (p) => win && !win.isDestroyed() && win.webContents.send('progress', p),
  });
  for (const [name, fn] of Object.entries(handlers)) {
    if (name === 'configure' || name === 'parseCollections') continue;
    ipcMain.handle('api:' + name, (_e, arg) => fn(arg || {}));
  }
  ipcMain.handle('dialog:open', async (_e, { title, filters, multi, folder, defaultPath } = {}) => {
    const r = await dialog.showOpenDialog(win, {
      title, defaultPath, filters,
      properties: [folder ? 'openDirectory' : 'openFile', ...(multi ? ['multiSelections'] : []), 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths;
  });
  ipcMain.handle('dialog:save', async (_e, { title, defaultPath, filters } = {}) => {
    const r = await dialog.showSaveDialog(win, { title, defaultPath, filters });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('dialog:confirm', async (_e, { message, detail, buttons = ['OK', 'Cancel'] } = {}) => {
    const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
    return r.response;
  });
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:external', (_e, url) => {
    if (/^(https:\/\/steamcommunity\.com\/|steam:\/\/)/.test(url)) return shell.openExternal(url);
    return false;
  });
  ipcMain.handle('shell:trash', (_e, p) => shell.trashItem(p));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
