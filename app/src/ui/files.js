// File picking and drag-and-drop that work both in Electron and in the browser dev server.
import { api } from './api.js';
import { MODEL_EXTENSIONS } from '../three/importers.js';

export const MODEL_FILTER = [{ name: '3D models', extensions: MODEL_EXTENSIONS }, { name: 'House Flipper items', extensions: ['hfcontent'] }, { name: 'All files', extensions: ['*'] }];
export const ITEM_FILTER = [{ name: 'House Flipper items', extensions: ['hfcontent'] }];
export const IMAGE_FILTER = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }];

export const extOf = (n) => (n || '').toLowerCase().split('.').pop();

/**
 * Normalise dropped files: [{ name, path?, file }]. `path` exists in Electron, where sibling
 * textures can be read from disk; in the browser only the dropped bytes are available.
 */
export function droppedFiles(e) {
  const list = [...(e.dataTransfer?.files || [])];
  return list.map((file) => ({ name: file.name, file, path: api.pathForFile ? api.pathForFile(file) : null }));
}

/** Bundle for loadModelFile from a dropped entry. Uses the disk when a path is known. */
export async function bundleFromDropped(entry, all = []) {
  if (entry.path) return api.readModelBundle({ path: entry.path });
  const main = { name: entry.name, bytes: new Uint8Array(await entry.file.arrayBuffer()) };
  const extras = [];
  for (const o of all) if (o !== entry) extras.push({ name: o.name, bytes: new Uint8Array(await o.file.arrayBuffer()) });
  return { main, extras };
}

export async function bytesFromDropped(entry) {
  if (entry.path) return api.readFile({ path: entry.path });
  return new Uint8Array(await entry.file.arrayBuffer());
}

export function makeDropTarget(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; el.classList.add('over'); });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('over'); });
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    el.classList.remove('over');
    const files = droppedFiles(e);
    if (files.length) onFiles(files);
  });
}
