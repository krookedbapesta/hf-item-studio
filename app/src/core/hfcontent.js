// Read and write .hfcontent archives (zip: contentInfo.json + *.bin meshes + *.png textures).
import { unzipSync, zipSync, strFromU8, strToU8 } from '../../node_modules/fflate/esm/browser.js';
import { encodeMesh, decodeMesh, expectedMeshSize } from './meshcodec.js';
import { COMPONENT, STANDARD_FLOATS, LIMITS } from './constants.js';
import { pngSize } from './png.js';

export const CONTENT_INFO = 'contentInfo.json';
export const EXTENSION = '.hfcontent';

// ---------- Newtonsoft $id / $ref handling ----------

function resolveRefs(root) {
  const ids = new Map();
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      if (v.$id !== undefined) ids.set(String(v.$id), v);
      for (const k in v) collect(v[k]);
    }
  };
  collect(root);
  const swap = (v) => {
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') {
      if (v.$ref !== undefined && Object.keys(v).length === 1) return ids.get(String(v.$ref)) ?? null;
      for (const k in v) v[k] = swap(v[k]);
    }
    return v;
  };
  return swap(root);
}

/** Serialize with $id on first sight of meshes, materials and textures, $ref afterwards. */
function serializeWithRefs(info) {
  let next = 1;
  const seen = new Map();
  const refTypes = new Set(['mesh', 'material', 'texture']);
  const kindOf = new Map();
  for (const m of info.Meshes) kindOf.set(m, 'mesh');
  for (const m of info.Materials) {
    kindOf.set(m, 'material');
    for (const t of Object.values(m.Textures || {})) kindOf.set(t, 'texture');
  }
  const conv = (v) => {
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
      const kind = kindOf.get(v);
      if (kind && refTypes.has(kind)) {
        if (seen.has(v)) return { $ref: seen.get(v) };
        const id = String(next++);
        seen.set(v, id);
        const out = { $id: id };
        for (const k in v) if (!k.startsWith('_')) out[k] = conv(v[k]);
        return out;
      }
      const out = {};
      for (const k in v) if (!k.startsWith('_')) out[k] = conv(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(conv(info), null, 2);
}

export function vec2Json(x, y) {
  const mag = Math.hypot(x, y);
  const v = { x, y, magnitude: mag, sqrMagnitude: x * x + y * y };
  if (!(x === 0 && y === 0)) v.normalized = { x: x / mag, y: y / mag, magnitude: 1, sqrMagnitude: 1 };
  return v;
}

// ---------- read ----------

/**
 * Parse an .hfcontent archive.
 * @returns {{ info: object, files: Record<string, Uint8Array>, problems: string[] }}
 */
export function readHfContent(bytes) {
  let files;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new Error(`Not a valid .hfcontent archive: ${e.message}`);
  }
  // archives built by hand sometimes nest everything under a folder
  let infoName = Object.keys(files).find((k) => k === CONTENT_INFO) || Object.keys(files).find((k) => k.endsWith('/' + CONTENT_INFO));
  if (!infoName) throw new Error('contentInfo.json is missing from the archive');
  const prefix = infoName.slice(0, -CONTENT_INFO.length);
  if (prefix) {
    const flat = {};
    for (const [k, v] of Object.entries(files)) if (k.startsWith(prefix)) flat[k.slice(prefix.length)] = v;
    files = flat;
  }
  let text = strFromU8(files[CONTENT_INFO]);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const info = resolveRefs(JSON.parse(text));
  delete files[CONTENT_INFO];
  return { info, files };
}

/** Walk the hierarchy calling fn(node, parents). */
export function walkHierarchy(info, fn) {
  const visit = (node, parents) => {
    fn(node, parents);
    for (const c of node.Children || []) visit(c, [...parents, node]);
  };
  for (const n of info.ObjectHierarchy || []) visit(n, []);
}

export function decodeAllMeshes(info, files) {
  const out = new Map();
  for (const d of info.Meshes || []) {
    if (!d) continue;
    const bytes = files[d.filename];
    if (!bytes) { out.set(d, { error: `Mesh file ${d.filename} is missing` }); continue; }
    try { out.set(d, decodeMesh(d, bytes)); } catch (e) { out.set(d, { error: e.message }); }
  }
  return out;
}

/**
 * Health check that mirrors what the game's loader does and the kit's warnings, plus
 * things that silently break items. Returns { errors: [], warnings: [], stats }.
 */
export function checkHfContent(info, files, { archiveBytes = 0 } = {}) {
  const errors = [], warnings = [];
  const stats = { meshes: 0, vertices: 0, triangles: 0, materials: 0, textures: 0, colliders: 0, textureBytes: 0, maxTexture: 0 };
  if (!info || typeof info !== 'object') return { errors: ['contentInfo.json could not be parsed'], warnings, stats };
  if (info.version !== 1) warnings.push(`Unknown content version ${info.version}`);
  const d = info.ItemData;
  if (!d) errors.push('ItemData is missing');
  else {
    const name = d.ItemName?.Default ?? '';
    if (!name) errors.push('Item has no name');
    if (name.length > LIMITS.maxNameLength) errors.push(`Name is ${name.length} characters (max ${LIMITS.maxNameLength})`);
    if (!(d.PriceInPLN > 0)) errors.push('Price must be greater than zero');
    if (![0, 1, 2].includes(d.PlacementOption)) errors.push(`Unknown placement option ${d.PlacementOption}`);
    if (!d.Thumbnail) warnings.push('No thumbnail set');
    else if (!files[d.Thumbnail]) errors.push(`Thumbnail ${d.Thumbnail} is missing from the archive`);
    else {
      const sz = pngSize(files[d.Thumbnail]);
      if (!sz) warnings.push('Thumbnail is not a PNG');
      else if (sz.width !== 256 || sz.height !== 256) warnings.push(`Thumbnail is ${sz.width}x${sz.height}; the kit expects 256x256`);
    }
    if ((d.ItemDescription || '').length > LIMITS.maxLongText) warnings.push('Description is longer than 8000 characters');
  }
  if (!info.ItemCategory) errors.push('Item has no category');
  for (const m of info.Meshes || []) {
    if (!m) { errors.push('A mesh reference is broken'); continue; }
    stats.meshes++;
    stats.vertices += m.verticesCount;
    stats.triangles += m.trianglesCount;
    if (m.verticesCount > LIMITS.maxMeshVertices) errors.push(`Mesh ${m.filename} has ${m.verticesCount} vertices; the game refuses more than ${LIMITS.maxMeshVertices}`);
    if (m.trianglesCount > LIMITS.maxMeshTriangles) errors.push(`Mesh ${m.filename} has ${m.trianglesCount} triangles; the game refuses more than ${LIMITS.maxMeshTriangles}`);
    const b = files[m.filename];
    if (!b) errors.push(`Mesh file ${m.filename} is missing`);
    else {
      const exp = expectedMeshSize(m);
      if (b.length < exp) errors.push(`Mesh file ${m.filename} is truncated (${b.length} of ${exp} bytes)`);
      else {
        try { decodeMesh(m, b); } catch (e) { errors.push(`Mesh ${m.filename}: ${e.message}`); }
      }
    }
  }
  if (stats.vertices >= LIMITS.maxVerticesTotalWarn || stats.triangles >= LIMITS.maxVerticesTotalWarn) {
    warnings.push(`Heavy model: ${stats.vertices} vertices, ${stats.triangles} triangles in total`);
  }
  const texSeen = new Set();
  for (const mat of info.Materials || []) {
    if (!mat) { errors.push('A material reference is broken'); continue; }
    stats.materials++;
    if (!['Standard', 'Standard (Specular setup)'].includes(mat.ShaderName)) warnings.push(`Material uses shader "${mat.ShaderName}", which may render differently in game`);
    for (const [prop, t] of Object.entries(mat.Textures || {})) {
      if (!t) continue;
      if (texSeen.has(t.filename)) continue;
      texSeen.add(t.filename);
      stats.textures++;
      const b = files[t.filename];
      if (!b) { errors.push(`Texture ${t.filename} (${prop}) is missing`); continue; }
      stats.textureBytes += b.length;
      const sz = pngSize(b);
      if (sz) {
        stats.maxTexture = Math.max(stats.maxTexture, sz.width, sz.height);
        if (sz.width > LIMITS.textureSizeWarn || sz.height > LIMITS.textureSizeWarn) warnings.push(`Texture ${t.filename} is ${sz.width}x${sz.height}; large textures use a lot of memory in game`);
      }
    }
  }
  let hasCollider = false, hasRenderer = false;
  walkHierarchy(info, (node) => {
    for (const c of node.Components || []) {
      if (!c) continue;
      if (c.componentType === COMPONENT.Mesh) {
        hasRenderer = true;
        if (!c.meshDescriptor) errors.push(`Node "${node.Name}" has a mesh component without mesh data`);
      } else {
        hasCollider = true;
        stats.colliders++;
        if (c.componentType === COMPONENT.BoxCollider && (!c.ColliderSize || c.ColliderSize.some((v) => !(Math.abs(v) > 1e-6)))) {
          warnings.push(`Node "${node.Name}" has a flat or empty box collider`);
        }
      }
    }
    const s = node.LocalScale || [1, 1, 1];
    if (s.some((v) => v < 0)) warnings.push(`Node "${node.Name}" has negative scale; the game logs physics warnings for its colliders`);
  });
  if (!hasRenderer) errors.push('Item has no visible meshes');
  if (!hasCollider) errors.push('Item has no colliders (Box, Sphere or Capsule); it cannot be placed');
  if (archiveBytes > LIMITS.maxPackageBytes) errors.push(`Package is ${(archiveBytes / 1048576).toFixed(1)} MB (max 100 MB)`);
  return { errors, warnings, stats };
}

// ---------- write ----------

export function newContentInfo() {
  return {
    version: 1,
    ItemData: {
      PlacementOption: 0,
      SelectedCurrency: 0,
      GUID: '',
      Thumbnail: 'thumbnail.png',
      ItemName: { Default: '' },
      PriceInPLN: 0,
      ItemDescription: '',
    },
    Meshes: [],
    Materials: [],
    ObjectHierarchy: [],
    ItemTags: [],
    ItemCategory: '',
  };
}

export function makeMaterialInfo({ shader = 'Standard', renderQueue = 2000, floats = {}, colors = {}, textures = {}, vectors = {}, keywords = [] } = {}) {
  return {
    ShaderName: shader,
    RenderQueue: renderQueue,
    Floats: { ...STANDARD_FLOATS, ...floats },
    Colors: colors,
    Textures: textures,
    Vectors: vectors,
    ShaderKeywords: keywords,
  };
}

export function makeTextureInfo(filename, md5, offset = [0, 0], scale = [1, 1]) {
  return { filename, fileMd5: md5, offset: vec2Json(offset[0], offset[1]), scale: vec2Json(scale[0], scale[1]) };
}

export function boxColliderJson(center, size, canPutOnTop = false) {
  return { componentType: COMPONENT.BoxCollider, ColliderSize: [...size], CanPutOnTop: !!canPutOnTop, ColliderCenter: [...center] };
}

export function sphereColliderJson(center, radius) {
  return { componentType: COMPONENT.SphereCollider, ColliderRadius: radius, CanPutOnTop: false, ColliderCenter: [...center] };
}

export function capsuleColliderJson(center, radius, height, direction) {
  return { componentType: COMPONENT.CapsuleCollider, ColliderRadius: radius, ColliderDirection: direction, ColliderHeight: height, CanPutOnTop: false, ColliderCenter: [...center] };
}

export function transformJson(name, pos = [0, 0, 0], rot = [0, 0, 0, 1], scale = [1, 1, 1]) {
  return { Name: name, LocalPosition: [...pos], LocalRotation: [...rot], LocalScale: [...scale], Children: [], Components: [] };
}

/** Add encoded mesh data to info/files; returns the descriptor object to reference from a MeshInfo. */
export function addMesh(info, files, filename, meshData) {
  const { bytes, descriptor } = encodeMesh(meshData);
  descriptor.filename = filename;
  files[filename] = bytes;
  info.Meshes.push(descriptor);
  return descriptor;
}

export function meshComponentJson(descriptor, materials) {
  return { meshDescriptor: descriptor, componentType: COMPONENT.Mesh, Materials: materials };
}

/** Build the zip. `files` holds every non-JSON entry. */
export function writeHfContent(info, files, { compress = true } = {}) {
  const entries = { [CONTENT_INFO]: strToU8(serializeWithRefs(info)) };
  for (const [k, v] of Object.entries(files)) entries[k] = v;
  const opts = {};
  for (const k of Object.keys(entries)) opts[k] = [entries[k], { level: compress && !k.endsWith('.png') ? 6 : 0 }];
  return zipSync(opts);
}

/** Deep clone an info object, keeping shared mesh/material/texture references shared. */
export function cloneInfo(info) {
  const map = new Map();
  const c = (v) => {
    if (Array.isArray(v)) return v.map(c);
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
      if (map.has(v)) return map.get(v);
      const o = {};
      map.set(v, o);
      for (const k in v) o[k] = c(v[k]);
      return o;
    }
    return v;
  };
  return c(info);
}
