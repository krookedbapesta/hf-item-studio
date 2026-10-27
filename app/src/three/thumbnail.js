// Render the 256x256 shop thumbnail (and larger Steam preview) for an item.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { modelBounds } from './hfscene.js';
import { encodePng } from '../core/png.js';

let shared = null;

function getRenderer(size) {
  if (!shared) {
    const canvas = document.createElement('canvas');
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    const pm = new THREE.PMREMGenerator(r);
    shared = { r, env: pm.fromScene(new RoomEnvironment(), 0.04).texture };
  }
  shared.r.setPixelRatio(1);
  shared.r.setSize(size, size, false);
  return shared;
}

export const THUMB_ANGLES = {
  'three-quarter': [-0.75, 0.5, 1],
  front: [0, 0.08, 1],
  side: [-1, 0.15, 0.2],
  top: [-0.3, 1.4, 0.6],
  low: [-0.6, 0.12, 1],
};

/**
 * @param {THREE.Object3D} model item-space model
 * @param {object} o { size=256, angle, background: 'transparent'|'#rrggbb'|'gradient', margin=0.7, camera?: {position, target} }
 * @returns {Uint8Array} PNG bytes
 */
export function renderThumbnail(model, o = {}) {
  const size = o.size || 256;
  const { r, env } = getRenderer(size);
  const scene = new THREE.Scene();
  scene.environment = env;
  const holder = new THREE.Group();
  holder.scale.set(-1, 1, 1);
  const clone = model.clone(true);
  holder.add(clone);
  scene.add(holder);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(2, 4, 3);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
  fill.position.set(-3, 1, 2);
  scene.add(key, fill, new THREE.HemisphereLight(0xffffff, 0x666055, 0.5));

  const bg = o.background ?? 'transparent';
  if (bg === 'gradient') {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 256;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, o.gradientTop || '#f4f1ec'); gr.addColorStop(1, o.gradientBottom || '#cfc8bd');
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    scene.background = t;
  } else if (bg !== 'transparent') scene.background = new THREE.Color(bg);

  const box = modelBounds(model);
  // bounds in display space
  const b = new THREE.Box3(new THREE.Vector3(-box.max.x, box.min.y, box.min.z), new THREE.Vector3(-box.min.x, box.max.y, box.max.z));
  const center = b.getCenter(new THREE.Vector3());
  const sphere = b.getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.001, 1000);
  if (o.camera) {
    cam.position.copy(o.camera.position);
    cam.lookAt(o.camera.target);
  } else {
    const dir = new THREE.Vector3(...(THUMB_ANGLES[o.angle] || THUMB_ANGLES['three-quarter'])).normalize();
    const margin = o.margin ?? 0.7;
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) / (margin + 0.3);
    cam.position.copy(center).addScaledVector(dir, dist);
    cam.near = dist / 100; cam.far = dist * 10;
    cam.lookAt(center);
  }
  cam.updateProjectionMatrix();
  r.setClearColor(0x000000, 0);
  r.render(scene, cam);
  const gl = r.getContext();
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // WebGL rows are bottom-up; alpha comes back premultiplied
  const out = new Uint8Array(px.length);
  const row = size * 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < row; x += 4) {
      const s = (size - 1 - y) * row + x, d = y * row + x;
      const a = px[s + 3];
      if (a > 0 && a < 255) {
        out[d] = Math.min(255, Math.round((px[s] * 255) / a));
        out[d + 1] = Math.min(255, Math.round((px[s + 1] * 255) / a));
        out[d + 2] = Math.min(255, Math.round((px[s + 2] * 255) / a));
      } else { out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; }
      out[d + 3] = a;
    }
  }
  return encodePng(size, size, out);
}

/** Load a user-chosen image as a square 256x256 PNG (centre crop). */
export async function imageToThumbnail(bytes, size = 256) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const s = Math.min(bmp.width, bmp.height);
  g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size);
  return encodePng(size, size, new Uint8Array(d.data.buffer));
}

export function pngToDataUrl(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(s);
}
