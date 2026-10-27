// Headless stand-in for src/three/thumbnail.js: renders a flat grey PNG instead of using WebGL.
import { encodePng } from '../../src/core/png.js';

export const THUMB_ANGLES = { 'three-quarter': [-0.75, 0.5, 1], front: [0, 0.08, 1], side: [-1, 0.15, 0.2], top: [-0.3, 1.4, 0.6], low: [-0.6, 0.12, 1] };

export function renderThumbnail(model, o = {}) {
  const s = o.size || 256;
  const px = new Uint8Array(s * s * 4).fill(160);
  return encodePng(s, s, px);
}

export async function imageToThumbnail() { return renderThumbnail(null); }

export function pngToDataUrl(bytes) {
  return 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
}
