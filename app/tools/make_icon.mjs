// Draws the app icon (orange rounded tile with a house outline and a picture frame) as PNG.
// Usage: node tools/make_icon.mjs <out.png> [size]
import fs from 'node:fs';
import { encodePng } from '../src/core/png.js';

const out = process.argv[2] || 'build/icon.png';
const S = Number(process.argv[3] || 512);
const px = new Uint8Array(S * S * 4);
const SS = 4; // supersampling for smooth edges

const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inTri = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const s = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / d;
  const t = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
};
const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

// shapes in unit coordinates (0..1)
function shade(u, v) {
  if (!roundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.2)) return null;
  // vertical orange gradient
  const t = v;
  let col = [243 - 20 * t, 154 - 50 * t, 60 - 20 * t, 255];
  const white = [255, 250, 243, 255], ink = [36, 22, 8, 255];
  const roof = inTri(u, v, [0.5, 0.16], [0.14, 0.48], [0.86, 0.48]);
  const roofHole = inTri(u, v, [0.5, 0.26], [0.27, 0.47], [0.73, 0.47]);
  const body = rect(u, v, 0.22, 0.46, 0.78, 0.82);
  const bodyHole = rect(u, v, 0.29, 0.5, 0.71, 0.76);
  if ((roof && !roofHole) || (body && !bodyHole)) col = white;
  // hanging picture on the inner wall, with the collider gap as a thin line behind it
  if (rect(u, v, 0.37, 0.54, 0.63, 0.71)) col = rect(u, v, 0.4, 0.57, 0.6, 0.68) ? [74, 168, 255, 255] : ink;
  if (rect(u, v, 0.29, 0.785, 0.71, 0.8)) col = ink;
  return col;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = shade((x + (sx + 0.5) / SS) / S, (y + (sy + 0.5) / SS) / S);
      if (!c) continue;
      r += c[0]; g += c[1]; b += c[2]; a += 255;
    }
    const n = SS * SS, i = (y * S + x) * 4;
    const cov = a / 255;
    px[i] = cov ? r / cov : 0; px[i + 1] = cov ? g / cov : 0; px[i + 2] = cov ? b / cov : 0; px[i + 3] = a / n;
  }
}
fs.mkdirSync(out.replace(/[\\/][^\\/]+$/, '') || '.', { recursive: true });
fs.writeFileSync(out, encodePng(S, S, px, { forceAlpha: true }));
console.log('wrote', out);
