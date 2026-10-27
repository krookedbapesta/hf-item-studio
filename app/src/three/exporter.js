// Turn an edited item (item-space meshes + colliders + metadata) into a .hfcontent.
import * as THREE from 'three';
import {
  newContentInfo, makeMaterialInfo, makeTextureInfo, boxColliderJson, sphereColliderJson,
  capsuleColliderJson, transformJson, addMesh, meshComponentJson, writeHfContent,
} from '../core/hfcontent.js';
import { encodePng, resizeRgba, decodePng, isPng } from '../core/png.js';
import { md5Hex } from '../core/md5.js';
import { MAX_MESH_VERTICES, MAX_MESH_TRIANGLES } from '../core/meshcodec.js';
import { eachMesh } from './hfscene.js';
import { PLACEMENT, BLEND_MODE, RENDER_QUEUE, SPECIAL_TAGS, toPLN } from '../core/constants.js';

const clean = (s) => (s || 'item').replace(/[^A-Za-z0-9_\-. ]+/g, '_').trim().slice(0, 60) || 'item';
const pow2Floor = (n) => 2 ** Math.floor(Math.log2(Math.max(1, n)));

// ---------- pixels ----------

/** RGBA pixels of a three texture, rows top-first in the orientation Unity will sample. */
export function texturePixels(tex) {
  const img = tex.image;
  if (!img) return null;
  let w, h, data;
  if (img.data && img.width && img.height) {
    w = img.width; h = img.height;
    const src = img.data;
    if (src.length === w * h * 4) data = new Uint8Array(src.buffer, src.byteOffset, src.length).slice();
    else if (src.length === w * h * 3) {
      data = new Uint8Array(w * h * 4);
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) { data[j] = src[i]; data[j + 1] = src[i + 1]; data[j + 2] = src[i + 2]; data[j + 3] = 255; }
    } else return null;
  } else {
    w = img.naturalWidth || img.videoWidth || img.width;
    h = img.naturalHeight || img.videoHeight || img.height;
    if (!w || !h) return null;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    data = new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
  }
  // flipY=false textures (glTF, DataTexture) have row 0 at v = 0; Unity wants row 0 at v = 1
  if (!tex.flipY) {
    const row = w * 4, out = new Uint8Array(data.length);
    for (let y = 0; y < h; y++) out.set(data.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    data = out;
  }
  return { width: w, height: h, data };
}

function fitSize(w, h, max, forcePow2) {
  let tw = w, th = h;
  const s = Math.min(1, max / Math.max(w, h));
  tw = Math.max(1, Math.round(w * s)); th = Math.max(1, Math.round(h * s));
  if (forcePow2) { tw = Math.min(pow2Floor(tw * 1.4), max); th = Math.min(pow2Floor(th * 1.4), max); }
  return [tw, th];
}

// ---------- materials ----------

class MaterialWriter {
  constructor(files, opts, report) {
    this.files = files;
    this.opts = opts;
    this.report = report;
    this.byMaterial = new Map();
    this.byTextureKey = new Map();
    this.rendererIndex = 0;
  }

  /** Reuse an untouched material read from an .hfcontent, including its texture bytes. */
  passthrough(mat) {
    const src = mat.userData.hf, srcFiles = mat.userData.hfFiles;
    const textures = {};
    for (const [prop, t] of Object.entries(src.Textures || {})) {
      if (!t || !srcFiles?.[t.filename]) continue;
      let name = t.filename;
      if (this.files[name] && this.files[name] !== srcFiles[t.filename]) name = `${this.rendererIndex}.${name}`;
      this.files[name] = srcFiles[t.filename];
      textures[prop] = this.byTextureKey.get(name) || makeTextureInfo(name, t.fileMd5 || md5Hex(srcFiles[t.filename]), [t.offset?.x ?? 0, t.offset?.y ?? 0], [t.scale?.x ?? 1, t.scale?.y ?? 1]);
      this.byTextureKey.set(name, textures[prop]);
    }
    return { ...src, Floats: { ...src.Floats }, Colors: { ...src.Colors }, Textures: textures, Vectors: { ...(src.Vectors || {}) }, ShaderKeywords: [...(src.ShaderKeywords || [])] };
  }

  writeTexture(tex, prop, slot, transform) {
    const key = `${tex.uuid}|${prop}`;
    if (this.byTextureKey.has(key)) return this.byTextureKey.get(key);
    let px = tex.userData.hfOriginal && isPng(tex.userData.hfOriginal) && !transform ? decodePng(tex.userData.hfOriginal) : texturePixels(tex);
    if (!px) { this.report.warnings.push(`Could not read texture for ${prop}; it was skipped`); return null; }
    const max = this.opts.maxTextureSize || 2048;
    const [tw, th] = fitSize(px.width, px.height, max, this.opts.powerOfTwo);
    let data = px.data;
    if (tw !== px.width || th !== px.height) {
      data = resizeRgba(data, px.width, px.height, tw, th);
      this.report.notes.push(`${prop}: ${px.width}x${px.height} -> ${tw}x${th}`);
    }
    if (transform) data = transform(data);
    const bytes = encodePng(tw, th, data, { forceAlpha: prop === '_BumpMap' });
    const name = `${this.rendererIndex}.${slot}${prop}.png`;
    this.files[name] = bytes;
    const info = makeTextureInfo(name, md5Hex(bytes), [tex.offset?.x ?? 0, tex.offset?.y ?? 0], [tex.repeat?.x ?? 1, tex.repeat?.y ?? 1]);
    this.byTextureKey.set(key, info);
    return info;
  }

  write(mat, slot, hasUv) {
    if (this.byMaterial.has(mat)) return this.byMaterial.get(mat);
    this.rendererIndex++;
    let mi;
    if (mat.userData.hf && !mat.userData.dirty) mi = this.passthrough(mat);
    else mi = this.convert(mat, slot, hasUv);
    this.byMaterial.set(mat, mi);
    return mi;
  }

  convert(mat, slot, hasUv) {
    const floats = {}, colors = {}, textures = {}, keywords = [];
    const c = mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1);
    const srgb = {}; c.getRGB(srgb, THREE.SRGBColorSpace);
    let alpha = mat.opacity ?? 1;
    if (mat.userData.averageColor) Object.assign(srgb, mat.userData.averageColor);
    colors._Color = [srgb.r, srgb.g, srgb.b, alpha];
    floats._Metallic = mat.metalness ?? 0;
    floats._Glossiness = 1 - (mat.roughness ?? 0.8);
    let renderQueue = RENDER_QUEUE.Opaque;
    if (mat.transparent && alpha < 0.999 || (mat.transparent && mat.map && mat.userData.hasAlpha)) {
      floats._Mode = BLEND_MODE.Fade; floats._SrcBlend = 5; floats._DstBlend = 10; floats._ZWrite = 0;
      keywords.push('_ALPHABLEND_ON'); renderQueue = RENDER_QUEUE.Fade;
    } else if (mat.alphaTest > 0) {
      floats._Mode = BLEND_MODE.Cutout; floats._Cutoff = mat.alphaTest;
      keywords.push('_ALPHATEST_ON'); renderQueue = RENDER_QUEUE.Cutout;
    }
    if (hasUv) {
      if (mat.map) {
        const t = this.writeTexture(mat.map, '_MainTex', slot);
        if (t) textures._MainTex = t;
      }
      if (mat.normalMap) {
        // Unity packs normal maps as (1, Y, 1, X)
        const t = this.writeTexture(mat.normalMap, '_BumpMap', slot, (d) => {
          const o = new Uint8Array(d.length);
          for (let i = 0; i < d.length; i += 4) { o[i] = 255; o[i + 1] = d[i + 1]; o[i + 2] = 255; o[i + 3] = d[i]; }
          return o;
        });
        if (t) { textures._BumpMap = t; keywords.push('_NORMALMAP'); floats._BumpScale = mat.normalScale?.x ?? 1; }
      }
      const mr = mat.metalnessMap || mat.roughnessMap;
      if (mr) {
        const metal = mat.metalness ?? 1, rough = mat.roughness ?? 1;
        const useMetalMap = !!mat.metalnessMap, useRoughMap = !!mat.roughnessMap;
        const t = this.writeTexture(mr, '_MetallicGlossMap', slot, (d) => {
          const o = new Uint8Array(d.length);
          for (let i = 0; i < d.length; i += 4) {
            o[i] = Math.round((useMetalMap ? d[i + 2] : 255) * metal);
            o[i + 1] = o[i]; o[i + 2] = o[i];
            o[i + 3] = 255 - Math.round((useRoughMap ? d[i + 1] : 255) * rough);
          }
          return o;
        });
        if (t) { textures._MetallicGlossMap = t; keywords.push('_METALLICGLOSSMAP'); floats._GlossMapScale = 1; }
      }
      if (mat.aoMap) {
        const t = this.writeTexture(mat.aoMap, '_OcclusionMap', slot, (d) => {
          const o = new Uint8Array(d.length);
          for (let i = 0; i < d.length; i += 4) { o[i] = o[i + 1] = o[i + 2] = d[i]; o[i + 3] = 255; }
          return o;
        });
        if (t) { textures._OcclusionMap = t; floats._OcclusionStrength = mat.aoMapIntensity ?? 1; }
      }
      if (mat.emissiveMap) {
        const t = this.writeTexture(mat.emissiveMap, '_EmissionMap', slot);
        if (t) textures._EmissionMap = t;
      }
    } else if (mat.map || mat.normalMap) {
      this.report.warnings.push(`Material "${mat.name || slot}" has textures but the mesh has no UVs; textures were dropped`);
    }
    const em = mat.emissive ? mat.emissive.clone().multiplyScalar(mat.emissiveIntensity ?? 1) : new THREE.Color(0, 0, 0);
    if (em.r + em.g + em.b > 0.001 || textures._EmissionMap) {
      const e = {}; em.getRGB(e, THREE.SRGBColorSpace);
      colors._EmissionColor = [e.r, e.g, e.b, 1];
      keywords.push('_EMISSION');
    } else colors._EmissionColor = [0, 0, 0, 1];
    if (mat.vertexColors) this.report.warnings.push(`Material "${mat.name || slot}" uses vertex colours, which the game ignores; its average colour was used`);
    return makeMaterialInfo({ renderQueue, floats, colors, textures, keywords });
  }
}

// ---------- geometry ----------

function prepareGeometry(src) {
  let g = src.clone();
  if (!g.getIndex()) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (g.getAttribute('uv') && !g.getAttribute('tangent')) {
    try { g.computeTangents(); } catch { /* degenerate UVs */ }
  }
  if (!g.groups.length) g.addGroup(0, g.getIndex().count, 0);
  return g;
}

/**
 * Split geometry into chunks that respect the per-mesh vertex and triangle limits.
 * Each chunk keeps its submesh groups (with their material index).
 */
export function splitForGame(g, maxV = MAX_MESH_VERTICES, maxT = MAX_MESH_TRIANGLES) {
  const idx = g.getIndex().array;
  const attrs = ['position', 'normal', 'tangent', 'uv', 'uv1'].filter((n) => g.getAttribute(n));
  const total = g.getAttribute('position').count;
  if (total <= maxV && idx.length / 3 <= maxT) {
    return [{
      positions: g.getAttribute('position').array, normals: g.getAttribute('normal')?.array,
      tangents: g.getAttribute('tangent')?.array, uv: g.getAttribute('uv')?.array, uv2: g.getAttribute('uv1')?.array,
      groups: [...g.groups].sort((a, b) => a.start - b.start), indices: idx,
    }];
  }
  const chunks = [];
  let cur = null;
  const newChunk = () => {
    cur = { map: new Map(), verts: [], groups: [], indices: [] };
    chunks.push(cur);
  };
  newChunk();
  const groups = [...g.groups].sort((a, b) => a.start - b.start);
  for (const grp of groups) {
    let gstart = cur.indices.length;
    let gcount = 0;
    const close = () => { if (gcount) cur.groups.push({ start: gstart, count: gcount, materialIndex: grp.materialIndex }); };
    for (let i = grp.start; i < grp.start + grp.count; i += 3) {
      const tri = [idx[i], idx[i + 1], idx[i + 2]];
      const fresh = tri.filter((v) => !cur.map.has(v)).length;
      if (cur.verts.length + fresh > maxV || (cur.indices.length / 3) + 1 > maxT) {
        close();
        newChunk();
        gstart = 0; gcount = 0;
      }
      for (const v of tri) {
        let n = cur.map.get(v);
        if (n === undefined) { n = cur.verts.length; cur.map.set(v, n); cur.verts.push(v); }
        cur.indices.push(n);
      }
      gcount += 3;
    }
    close();
  }
  return chunks.map((c) => {
    const pick = (name, size) => {
      const at = g.getAttribute(name);
      if (!at) return undefined;
      const out = new Float32Array(c.verts.length * size);
      c.verts.forEach((v, i) => { for (let k = 0; k < size; k++) out[i * size + k] = at.array[v * size + k]; });
      return out;
    };
    return {
      positions: pick('position', 3), normals: pick('normal', 3), tangents: pick('tangent', 4),
      uv: pick('uv', 2), uv2: pick('uv1', 2), groups: c.groups, indices: Uint32Array.from(c.indices),
    };
  });
}

// ---------- colliders ----------

function colliderJson(c) {
  if (c.type === 'box') return boxColliderJson(c.center, c.size.map(Math.abs), c.canPutOnTop);
  if (c.type === 'sphere') return sphereColliderJson(c.center, c.radius);
  return capsuleColliderJson(c.center, c.radius, c.height, c.direction);
}

// ---------- main ----------

/**
 * @param {object} item  { meta, model, colliders, thumbnail?: Uint8Array }
 *   meta: { name, description, price, currency, placement, categoryGuid, tagGuids[], canBePlacedOn, guid }
 * @param {object} collections  { tagByName: Map } for the special placement tags
 * @param {object} opts { maxTextureSize, powerOfTwo }
 * @returns {{ info, files, bytes, report }}
 */
export function exportItem(item, collections, opts = {}) {
  const { meta, model, colliders } = item;
  const report = { warnings: [], notes: [], meshes: 0, split: 0 };
  const info = newContentInfo();
  const files = {};
  const d = info.ItemData;
  d.PlacementOption = meta.placement ?? PLACEMENT.Floor;
  d.SelectedCurrency = meta.currency ?? 0;
  d.GUID = meta.guid || '';
  d.ItemName = { Default: meta.name || 'Untitled item' };
  d.PriceInPLN = Math.round(toPLN(meta.price || 0, d.SelectedCurrency) * 1000) / 1000;
  d.ItemDescription = meta.description || '';
  info.ItemCategory = meta.categoryGuid || '';

  // tags: the kit adds the placement limit tags itself; do the same so nothing gets missed
  const tags = new Set(meta.tagGuids || []);
  const special = (name) => collections?.tagByName?.get(name)?.guid;
  const hanging = special(SPECIAL_TAGS.hanging), ceiling = special(SPECIAL_TAGS.ceiling), placeOn = special(SPECIAL_TAGS.placeOn);
  if (hanging) (d.PlacementOption === PLACEMENT.Wall ? tags.add(hanging) : tags.delete(hanging));
  if (ceiling) (d.PlacementOption === PLACEMENT.Ceiling ? tags.add(ceiling) : tags.delete(ceiling));
  if (placeOn) (meta.canBePlacedOn ? tags.add(placeOn) : tags.delete(placeOn));
  info.ItemTags = [...tags];

  const root = transformJson(meta.name || 'Item');
  const mw = new MaterialWriter(files, opts, report);
  let meshIndex = 0;
  eachMesh(model, (o, itemM) => {
    if (o.visible === false) return;
    const g = prepareGeometry(o.geometry);
    // item space, not world: the viewport mirrors and moves the model for display
    if (!itemM.equals(new THREE.Matrix4())) g.applyMatrix4(itemM);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const chunks = splitForGame(g);
    if (chunks.length > 1) {
      report.split++;
      report.notes.push(`"${o.name}" was split into ${chunks.length} meshes to stay under the game's 64,000 vertex/triangle limit`);
    }
    chunks.forEach((ch, ci) => {
      meshIndex++;
      const hasUv = !!ch.uv;
      const usedGroups = ch.groups.filter((gr) => gr.count > 0);
      // reorder indices so submeshes are contiguous in group order
      const indices = new Uint32Array(usedGroups.reduce((a, gr) => a + gr.count, 0));
      const starts = [];
      let p = 0;
      for (const gr of usedGroups) { starts.push(p); indices.set(ch.indices.subarray(gr.start, gr.start + gr.count), p); p += gr.count; }
      const nodeName = chunks.length > 1 ? `${o.name || 'Mesh'}_${ci + 1}` : (o.name || `Mesh${meshIndex}`);
      const filename = `${clean(nodeName)}.${meshIndex}${String(o.id).padStart(4, '0')}.bin`;
      const desc = addMesh(info, files, filename, {
        positions: ch.positions, normals: ch.normals, tangents: ch.tangents, uv: ch.uv, uv2: ch.uv2,
        indices, submeshStarts: starts,
      });
      const matInfos = usedGroups.map((gr, si) => mw.write(mats[gr.materialIndex ?? 0] || mats[0], si, hasUv));
      for (const m of matInfos) if (!info.Materials.includes(m)) info.Materials.push(m);
      const node = transformJson(nodeName);
      node.Components.push(meshComponentJson(desc, matInfos));
      root.Children.push(node);
      report.meshes++;
    });
  });
  if (!colliders.length) report.warnings.push('Item has no colliders; the game will not let you place it');
  const plain = colliders.filter((c) => !c.matrix);
  if (plain.length) {
    const cn = transformJson('Colliders');
    cn.Components.push(...plain.map(colliderJson));
    root.Children.push(cn);
  }
  colliders.filter((c) => c.matrix).forEach((c, i) => {
    const m = new THREE.Matrix4().fromArray(c.matrix);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(pos, q, s);
    const n = transformJson(`Collider_${i + 1}`, pos.toArray(), [q.x, q.y, q.z, q.w], s.toArray());
    n.Components.push(colliderJson(c));
    root.Children.push(n);
  });
  info.ObjectHierarchy.push(root);
  const thumbName = `${clean(meta.name)}.png`;
  if (item.thumbnail) {
    files[thumbName] = item.thumbnail;
    d.Thumbnail = thumbName;
  } else {
    d.Thumbnail = '';
    report.warnings.push('No thumbnail; generate one before publishing');
  }
  const bytes = writeHfContent(info, files);
  return { info, files, bytes, report };
}
