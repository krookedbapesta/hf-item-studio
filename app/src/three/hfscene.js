// .hfcontent <-> three.js objects.
//
// Everything in this module lives in "item space", which is Unity's coordinate system:
// X right, Y up, Z forward, left-handed. Viewports display it through a root group scaled
// (-1, 1, 1) so models look the same as in the tool they were made with.
import * as THREE from 'three';
import { decodeMesh } from '../core/meshcodec.js';
import { decodePng, isPng } from '../core/png.js';
import { COMPONENT } from '../core/constants.js';

// ---------- textures ----------

function flipRows(data, w, h) {
  const out = new Uint8Array(data.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(data.subarray(y * row, y * row + row), (h - 1 - y) * row);
  return out;
}

async function decodeAnyImage(bytes) {
  if (isPng(bytes)) {
    const d = decodePng(bytes);
    if (d) return d;
  }
  // JPEG, interlaced or 16-bit PNG: let the browser decode it
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const id = g.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, data: new Uint8Array(id.data.buffer) };
}

/** Detect the (1, Y, 1, X) packing the kit writes for normal maps. */
export function isPackedNormal(rgba) {
  let packed = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * 97) {
    n++;
    if (rgba[i] > 250 && rgba[i + 2] > 250) packed++;
  }
  return n > 0 && packed / n > 0.9;
}

export function unpackNormal(rgba) {
  const out = new Uint8Array(rgba.length);
  const packed = isPackedNormal(rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    const xr = packed ? rgba[i + 3] : rgba[i];
    const yg = rgba[i + 1];
    const x = xr / 127.5 - 1, y = yg / 127.5 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    out[i] = xr; out[i + 1] = yg; out[i + 2] = Math.round((z * 0.5 + 0.5) * 255); out[i + 3] = 255;
  }
  return out;
}

function dataTexture(w, h, rgba, srgb) {
  const t = new THREE.DataTexture(flipRows(rgba, w, h), w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// ---------- materials ----------

/**
 * Build a MeshStandardMaterial that approximates a Unity Standard material.
 * The original MaterialInfo and its texture bytes are kept on userData so an unedited
 * material is written back byte-for-byte.
 */
export async function materialFromInfo(mi, files, cache = new Map()) {
  const F = mi.Floats || {}, C = mi.Colors || {}, T = mi.Textures || {};
  const kw = new Set(mi.ShaderKeywords || []);
  const mat = new THREE.MeshStandardMaterial({ name: mi._name || 'Material' });
  const col = C._Color || [1, 1, 1, 1];
  mat.color.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace);
  mat.opacity = col[3] ?? 1;
  mat.metalness = F._Metallic ?? 0;
  mat.roughness = 1 - (F._Glossiness ?? 0.5);
  const specular = mi.ShaderName === 'Standard (Specular setup)';
  if (specular) mat.metalness = 0;

  const load = async (prop, kind) => {
    const t = T[prop];
    if (!t || !files[t.filename]) return null;
    const key = t.filename + '|' + kind;
    if (cache.has(key)) return cache.get(key);
    let img;
    try { img = await decodeAnyImage(files[t.filename]); } catch { return null; }
    let px = img.data;
    if (kind === 'normal') px = unpackNormal(px);
    else if (kind === 'metal') {
      // Unity: R = metallic, A = smoothness. three: B = metalness, G = roughness.
      const o = new Uint8Array(px.length);
      const gs = F._GlossMapScale ?? 1;
      for (let i = 0; i < px.length; i += 4) {
        o[i] = 0; o[i + 1] = 255 - Math.round(px[i + 3] * gs); o[i + 2] = px[i]; o[i + 3] = 255;
      }
      px = o;
    } else if (kind === 'ao') {
      const o = new Uint8Array(px.length);
      for (let i = 0; i < px.length; i += 4) { o[i] = o[i + 1] = o[i + 2] = px[i + 1]; o[i + 3] = 255; }
      px = o;
    }
    const tex = dataTexture(img.width, img.height, px, kind === 'color');
    const sc = t.scale || { x: 1, y: 1 }, of = t.offset || { x: 0, y: 0 };
    tex.repeat.set(sc.x ?? 1, sc.y ?? 1);
    tex.offset.set(of.x ?? 0, of.y ?? 0);
    tex.userData.size = [img.width, img.height];
    cache.set(key, tex);
    return tex;
  };

  mat.map = await load('_MainTex', 'color');
  if (kw.has('_NORMALMAP') || T._BumpMap) {
    mat.normalMap = await load('_BumpMap', 'normal');
    const bs = F._BumpScale ?? 1;
    mat.normalScale.set(bs, bs);
  }
  if (!specular && (kw.has('_METALLICGLOSSMAP') || T._MetallicGlossMap)) {
    const m = await load('_MetallicGlossMap', 'metal');
    if (m) { mat.metalnessMap = m; mat.roughnessMap = m; mat.metalness = 1; mat.roughness = 1; }
  }
  if (T._OcclusionMap) {
    mat.aoMap = await load('_OcclusionMap', 'ao');
    mat.aoMapIntensity = F._OcclusionStrength ?? 1;
  }
  if (kw.has('_EMISSION')) {
    const e = C._EmissionColor || [0, 0, 0, 1];
    mat.emissive.setRGB(e[0], e[1], e[2], THREE.SRGBColorSpace);
    mat.emissiveMap = await load('_EmissionMap', 'color');
  }
  const mode = F._Mode ?? 0;
  if (mode === 1 || kw.has('_ALPHATEST_ON')) mat.alphaTest = F._Cutoff ?? 0.5;
  else if (mode >= 2 || kw.has('_ALPHABLEND_ON') || kw.has('_ALPHAPREMULTIPLY_ON')) {
    mat.transparent = true;
    mat.depthWrite = false;
  }
  mat.userData.hf = mi;
  mat.userData.hfFiles = files;
  return mat;
}

// ---------- geometry ----------

export function geometryFromDecoded(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  if (m.normals && m.normals.length === m.positions.length) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  if (m.uv2) g.setAttribute('uv1', new THREE.BufferAttribute(m.uv2, 2));
  if (m.tangents && m.tangents.length / 4 === m.positions.length / 3) g.setAttribute('tangent', new THREE.BufferAttribute(m.tangents, 4));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  m.submeshes.forEach((s, i) => g.addGroup(s.start, s.count, i));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function nodeMatrix(node) {
  const p = node.LocalPosition || [0, 0, 0];
  const r = node.LocalRotation || [0, 0, 0, 1];
  const s = node.LocalScale || [1, 1, 1];
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion(...r), new THREE.Vector3(...s));
}

// ---------- colliders ----------

/** Collider record used across the app. `matrix` places the shape in item space. */
export function colliderFromComponent(c, matrix) {
  const center = c.ColliderCenter || [0, 0, 0];
  const base = { canPutOnTop: !!c.CanPutOnTop, matrix: matrix.elements.slice() };
  if (c.componentType === COMPONENT.BoxCollider) return { type: 'box', center: [...center], size: [...(c.ColliderSize || [0, 0, 0])], ...base };
  if (c.componentType === COMPONENT.SphereCollider) return { type: 'sphere', center: [...center], radius: c.ColliderRadius || 0, ...base };
  if (c.componentType === COMPONENT.CapsuleCollider) return { type: 'capsule', center: [...center], radius: c.ColliderRadius || 0, height: c.ColliderHeight || 0, direction: c.ColliderDirection ?? 1, ...base };
  return null;
}

/**
 * Turn a collider into an item-space axis-aligned box when its transform has no rotation,
 * so it can be edited with plain numbers. Returns the collider unchanged otherwise.
 */
export function normalizeCollider(col) {
  if (!col.matrix) return col;
  const m = new THREE.Matrix4().fromArray(col.matrix);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(pos, q, s);
  const axisAligned = Math.abs(Math.abs(q.w) - 1) < 1e-5;
  if (!axisAligned) return col;
  const c = new THREE.Vector3(...col.center).multiply(s).add(pos);
  const out = { ...col, center: c.toArray(), matrix: null };
  if (col.type === 'box') out.size = col.size.map((v, i) => Math.abs(v * s.getComponent(i)));
  else if (col.type === 'sphere') out.radius = col.radius * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
  else if (col.type === 'capsule') {
    const ax = col.direction;
    out.height = col.height * Math.abs(s.getComponent(ax));
    const others = [0, 1, 2].filter((i) => i !== ax).map((i) => Math.abs(s.getComponent(i)));
    out.radius = col.radius * Math.max(...others);
  }
  return out;
}

/** Item-space AABB of a collider. */
export function colliderBounds(col) {
  const box = new THREE.Box3();
  const c = new THREE.Vector3(...col.center);
  if (col.type === 'box') box.setFromCenterAndSize(c, new THREE.Vector3(...col.size).set(Math.abs(col.size[0]), Math.abs(col.size[1]), Math.abs(col.size[2])));
  else if (col.type === 'sphere') box.setFromCenterAndSize(c, new THREE.Vector3().setScalar(col.radius * 2));
  else {
    const s = new THREE.Vector3().setScalar(col.radius * 2);
    s.setComponent(col.direction, Math.max(col.height, col.radius * 2));
    box.setFromCenterAndSize(c, s);
  }
  if (col.matrix) box.applyMatrix4(new THREE.Matrix4().fromArray(col.matrix));
  return box;
}

const COLLIDER_COLORS = { normal: 0x35d07f, top: 0x4aa8ff, selected: 0xffc23d, bad: 0xff4d5e };

/** Wireframe + translucent shell for one collider. */
export function colliderMesh(col, state = 'normal') {
  let geo;
  if (col.type === 'box') geo = new THREE.BoxGeometry(...col.size.map((v) => Math.max(Math.abs(v), 1e-4)));
  else if (col.type === 'sphere') geo = new THREE.SphereGeometry(col.radius, 20, 14);
  else {
    const len = Math.max(0, col.height - col.radius * 2);
    geo = new THREE.CapsuleGeometry(col.radius, len, 6, 16);
    if (col.direction === 0) geo.rotateZ(Math.PI / 2);
    else if (col.direction === 2) geo.rotateX(Math.PI / 2);
  }
  const colr = COLLIDER_COLORS[state] ?? (col.canPutOnTop ? COLLIDER_COLORS.top : COLLIDER_COLORS.normal);
  const g = new THREE.Group();
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colr, transparent: true, opacity: 0.12, depthWrite: false }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: colr, transparent: true, opacity: 0.95 }));
  fill.renderOrder = 10; edges.renderOrder = 11;
  g.add(fill, edges);
  g.position.set(...col.center);
  if (col.matrix) {
    const wrap = new THREE.Group();
    wrap.matrixAutoUpdate = false;
    wrap.matrix.fromArray(col.matrix);
    wrap.add(g);
    wrap.userData.collider = col;
    return wrap;
  }
  g.userData.collider = col;
  return g;
}

export function colliderColorFor(col, selected, colliding) {
  if (colliding) return 'bad';
  if (selected) return 'selected';
  return col.canPutOnTop ? 'top' : 'normal';
}

// ---------- full item ----------

/**
 * Build an editable item from a parsed .hfcontent.
 * Geometry is baked into item space so the editor works with one flat list of meshes.
 * @returns {{ model: THREE.Group, colliders: object[], problems: string[] }}
 */
export async function itemFromContent(info, files) {
  const problems = [];
  const model = new THREE.Group();
  model.name = info.ItemData?.ItemName?.Default || 'Item';
  const colliders = [];
  const texCache = new Map();
  const matCache = new Map();
  const geoCache = new Map();
  const getMat = async (mi) => {
    if (!mi) return new THREE.MeshStandardMaterial({ color: 0xff00ff });
    if (!matCache.has(mi)) matCache.set(mi, await materialFromInfo(mi, files, texCache));
    return matCache.get(mi);
  };
  const visit = async (node, parentMatrix) => {
    const m = parentMatrix.clone().multiply(nodeMatrix(node));
    for (const c of node.Components || []) {
      if (!c) continue;
      if (c.componentType === COMPONENT.Mesh) {
        const d = c.meshDescriptor;
        if (!d) { problems.push(`"${node.Name}": mesh component without data`); continue; }
        let base = geoCache.get(d);
        if (!base) {
          try {
            const dm = decodeMesh(d, files[d.filename], { lenient: true });
            if (dm.droppedTriangles) problems.push(`"${node.Name}": dropped ${dm.droppedTriangles} broken triangle(s) that pointed past the vertex list`);
            base = geometryFromDecoded(dm);
          } catch (e) {
            problems.push(`"${node.Name}": ${e.message}`);
            continue;
          }
          geoCache.set(d, base);
        }
        const geo = base.clone();
        geo.applyMatrix4(m);
        if (m.determinant() < 0) flipWinding(geo);
        const mats = [];
        for (const mi of c.Materials || []) mats.push(await getMat(mi));
        const mesh = new THREE.Mesh(geo, mats.length > 1 ? mats : mats[0] || new THREE.MeshStandardMaterial());
        mesh.name = node.Name;
        mesh.userData.sourceMesh = d.filename;
        model.add(mesh);
      } else {
        const col = colliderFromComponent(c, m);
        if (col) colliders.push(normalizeCollider(col));
      }
    }
    for (const ch of node.Children || []) await visit(ch, m);
  };
  for (const n of info.ObjectHierarchy || []) await visit(n, new THREE.Matrix4());
  return { model, colliders, problems };
}

/** Reverse triangle winding after a mirroring transform (negative determinant). */
export function flipWinding(geo) {
  // mirrored tangents have the wrong handedness; the exporter recomputes missing ones
  if (geo.getAttribute('tangent')) geo.deleteAttribute('tangent');
  const idx = geo.getIndex();
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
  } else {
    for (const name of Object.keys(geo.attributes)) {
      const at = geo.attributes[name];
      const n = at.itemSize;
      for (let i = 0; i < at.count; i += 3) {
        for (let k = 0; k < n; k++) {
          const t = at.array[(i + 1) * n + k];
          at.array[(i + 1) * n + k] = at.array[(i + 2) * n + k];
          at.array[(i + 2) * n + k] = t;
        }
      }
      at.needsUpdate = true;
    }
  }
}

/**
 * Transform of `o` in item space: composed up to and including `root`, ignoring whatever the
 * root is attached to (the viewport mirrors and moves it for display).
 */
export function itemMatrix(o, root) {
  const m = new THREE.Matrix4();
  let cur = o;
  while (cur) {
    cur.updateMatrix();
    m.premultiply(cur.matrix);
    if (cur === root) break;
    cur = cur.parent;
  }
  return m;
}

/** Visit every mesh with its item-space matrix. */
export function eachMesh(root, fn) {
  root.traverse((o) => { if (o.isMesh) fn(o, itemMatrix(o, root)); });
}

export function modelBounds(model) {
  const box = new THREE.Box3();
  eachMesh(model, (o, m) => {
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(m));
  });
  return box;
}

export function modelStats(model) {
  let vertices = 0, triangles = 0, meshes = 0;
  const materials = new Set(), textures = new Set();
  model.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    vertices += o.geometry.getAttribute('position').count;
    triangles += (o.geometry.getIndex()?.count ?? o.geometry.getAttribute('position').count) / 3;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      materials.add(m);
      for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) if (m[k]) textures.add(m[k]);
    }
  });
  return { vertices, triangles, meshes, materials: materials.size, textures: [...textures] };
}

export { srgbToLinear, decodeAnyImage };
