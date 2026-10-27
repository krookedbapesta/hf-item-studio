// Load 3D model files into item space (Unity coordinates, metres).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { flipWinding } from './hfscene.js';

export const MODEL_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'dae', 'stl', 'ply', '3ds', '3mf'];
export const TEXTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'tga', 'bmp', 'webp', 'gif', 'dds'];

const ext = (name) => name.toLowerCase().split('.').pop();
const base = (name) => name.replace(/\\/g, '/').split('/').pop();

/**
 * @param {{name: string, bytes: Uint8Array}} main   the model file
 * @param {{name: string, bytes: Uint8Array}[]} extras  sibling files (textures, .mtl, .bin)
 * @returns {Promise<{ scene: THREE.Object3D, warnings: string[] }>}
 */
export async function loadModelFile(main, extras = []) {
  const warnings = [];
  const urls = new Map();
  const blobFor = (f) => {
    if (!urls.has(f.name)) urls.set(f.name, URL.createObjectURL(new Blob([f.bytes])));
    return urls.get(f.name);
  };
  const byBase = new Map();
  for (const f of extras) byBase.set(base(f.name).toLowerCase(), f);
  const manager = new THREE.LoadingManager();
  const missing = new Set();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const key = base(decodeURIComponent(url)).toLowerCase();
    const f = byBase.get(key);
    if (f) return blobFor(f);
    missing.add(base(decodeURIComponent(url)));
    return url;
  });
  // resolves once every texture the loader asked for has arrived (or right away if none)
  let started = false;
  const settled = new Promise((resolve) => {
    manager.onStart = () => { started = true; };
    manager.onLoad = resolve;
    manager.onError = () => {};
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.addHandler(/\.dds$/i, new DDSLoader(manager));
  const e = ext(main.name);
  const buf = main.bytes.buffer.slice(main.bytes.byteOffset, main.bytes.byteOffset + main.bytes.byteLength);
  const text = () => new TextDecoder().decode(main.bytes);
  let scene;
  try {
    switch (e) {
      case 'glb':
      case 'gltf': {
        const g = await new GLTFLoader(manager).parseAsync(e === 'glb' ? buf : text(), '');
        scene = g.scene;
        break;
      }
      case 'fbx':
        scene = new FBXLoader(manager).parse(buf, '');
        break;
      case 'obj': {
        const loader = new OBJLoader(manager);
        const src = text();
        const mtlName = (src.match(/^mtllib\s+(.+)$/m) || [])[1]?.trim();
        const mtl = mtlName && byBase.get(base(mtlName).toLowerCase());
        if (mtl) {
          const mats = new MTLLoader(manager).parse(new TextDecoder().decode(mtl.bytes), '');
          mats.preload();
          loader.setMaterials(mats);
        } else if (mtlName) warnings.push(`Material library ${mtlName} was not found next to the model`);
        scene = loader.parse(src);
        break;
      }
      case 'dae':
        scene = new ColladaLoader(manager).parse(text(), '').scene;
        break;
      case 'stl': {
        const geo = new STLLoader().parse(buf);
        scene = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6 }));
        warnings.push('STL files carry no materials or UVs; the item will use a plain material');
        break;
      }
      case 'ply': {
        const geo = new PLYLoader().parse(buf);
        if (!geo.getAttribute('normal')) geo.computeVertexNormals();
        scene = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: !!geo.getAttribute('color') }));
        break;
      }
      case '3ds':
        scene = new TDSLoader(manager).parse(buf, '');
        break;
      case '3mf':
        scene = new ThreeMFLoader(manager).parse(buf);
        break;
      default:
        throw new Error(`Unsupported model format .${e}`);
    }
  } finally {
    // keep blob URLs alive until textures finish decoding
    if (started) await Promise.race([settled, new Promise((r) => setTimeout(r, 20000))]);
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30000);
  }
  if (missing.size) warnings.push(`Missing files referenced by the model: ${[...missing].slice(0, 8).join(', ')}`);
  return { scene, warnings };
}

// ---------- conversion into item space ----------

function toStandard(m) {
  if (!m) return new THREE.MeshStandardMaterial({ color: 0xcccccc });
  if (m.isMeshStandardMaterial) return m;
  const s = new THREE.MeshStandardMaterial({ name: m.name });
  if (m.color) s.color.copy(m.color);
  for (const k of ['map', 'normalMap', 'aoMap', 'emissiveMap', 'alphaMap']) if (m[k]) s[k] = m[k];
  if (m.bumpMap && !m.normalMap) s.bumpMap = m.bumpMap;
  if (m.normalScale) s.normalScale.copy(m.normalScale);
  if (m.emissive) s.emissive.copy(m.emissive);
  s.opacity = m.opacity ?? 1;
  s.transparent = !!m.transparent && s.opacity < 0.999;
  s.alphaTest = m.alphaTest || 0;
  s.vertexColors = !!m.vertexColors;
  s.side = m.side;
  if (m.isMeshPhongMaterial) {
    s.roughness = Math.min(1, Math.max(0.05, 1 - Math.sqrt((m.shininess ?? 30) / 100)));
    s.metalness = 0;
  } else {
    s.roughness = 0.8; s.metalness = 0;
  }
  if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
  return s;
}

/**
 * Bake a loaded scene into flat item-space meshes: world transforms applied, handedness
 * converted (X mirrored, winding reversed), non-mesh objects dropped.
 */
export function bakeToItemSpace(scene, { mergeByMaterial = false } = {}) {
  scene.updateMatrixWorld(true);
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
  const out = new THREE.Group();
  out.name = scene.name || 'Model';
  const meshes = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.visible === false) return;
    if (o.isSkinnedMesh) {
      // bind pose is good enough for a static item
    }
    let g = o.geometry.clone();
    for (const k of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'uv1', 'uv2', 'tangent', 'color'].includes(k)) g.deleteAttribute(k);
    }
    if (g.getAttribute('uv2') && !g.getAttribute('uv1')) { g.setAttribute('uv1', g.getAttribute('uv2')); g.deleteAttribute('uv2'); }
    if (g.morphAttributes) g.morphAttributes = {};
    const m = new THREE.Matrix4().multiplyMatrices(mirror, o.matrixWorld);
    g.applyMatrix4(m);
    // mirror once (handedness) plus whatever negative scale the node had
    if (m.determinant() < 0) flipWinding(g);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(toStandard);
    const mesh = new THREE.Mesh(g, mats.length > 1 ? mats : mats[0]);
    mesh.name = o.name || 'Mesh';
    meshes.push(mesh);
  });
  if (mergeByMaterial && meshes.length > 1) {
    const groups = new Map();
    for (const m of meshes) {
      if (Array.isArray(m.material)) { out.add(m); continue; }
      const k = m.material.uuid;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    for (const list of groups.values()) {
      if (list.length === 1) { out.add(list[0]); continue; }
      const geos = list.map((m) => (m.geometry.index ? m.geometry : m.geometry.toNonIndexed()));
      const merged = BufferGeometryUtils.mergeGeometries(harmonize(geos), false);
      if (merged) {
        const mm = new THREE.Mesh(merged, list[0].material);
        mm.name = list[0].material.name || list[0].name;
        out.add(mm);
      } else list.forEach((m) => out.add(m));
    }
  } else meshes.forEach((m) => out.add(m));
  return out;
}

/** mergeGeometries needs identical attribute sets. */
function harmonize(geos) {
  const names = new Set();
  geos.forEach((g) => Object.keys(g.attributes).forEach((n) => names.add(n)));
  const common = [...names].filter((n) => geos.every((g) => g.getAttribute(n)));
  return geos.map((g) => {
    const c = g.clone();
    for (const n of Object.keys(c.attributes)) if (!common.includes(n)) c.deleteAttribute(n);
    if (!c.index) c.setIndex([...Array(c.getAttribute('position').count).keys()]);
    return c;
  });
}

/** Guess a scale correction for models authored in centimetres or millimetres. */
export function suggestUnitScale(box) {
  const size = box.getSize(new THREE.Vector3());
  const m = Math.max(size.x, size.y, size.z);
  if (m > 300) return { factor: 0.001, reason: 'looks like millimetres' };
  if (m > 12) return { factor: 0.01, reason: 'looks like centimetres' };
  if (m > 0 && m < 0.02) return { factor: 100, reason: 'model is tiny; probably exported in metres from a cm scene' };
  return null;
}
