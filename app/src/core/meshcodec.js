// Binary mesh format used inside .hfcontent archives (MeshSerializer in HFContentCreatorLib).
//
// Layout, all little-endian, sections present only when their count is non-zero:
//   positions : 6 x f32 bounds (minX,maxX,minY,maxY,minZ,maxZ) + N x 3 x u16 quantized
//   normals   : N x 3 x u8   (v * 127 + 128)
//   tangents  : N x 4 x u8   (v * 127 + 128)
//   uv        : 4 x f32 bounds (minX,maxX,minY,maxY) + N x 2 x u16
//   uv2       : same as uv
//   indices   : trianglesCount * 3 x u16
// The game rejects meshes with more than 64000 vertices or triangles.

export const MAX_MESH_VERTICES = 64000;
export const MAX_MESH_TRIANGLES = 64000;

class Writer {
  constructor(size) {
    this.buf = new ArrayBuffer(size);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.p = 0;
  }
  f32(v) { this.dv.setFloat32(this.p, v, true); this.p += 4; }
  u16(v) { this.dv.setUint16(this.p, v, true); this.p += 2; }
  u8v(v) { this.u8[this.p++] = v; }
}

class Reader {
  constructor(bytes) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.u8 = bytes;
    this.p = 0;
  }
  need(n) {
    if (this.p + n > this.u8.length) throw new Error(`Mesh data truncated (need ${n} bytes at ${this.p}, have ${this.u8.length})`);
  }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u8v() { this.need(1); return this.u8[this.p++]; }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function writeVec3Quantized(w, arr, n) {
  if (n === 0) return;
  let mnx = arr[0] - 0.0005, mny = arr[1] - 0.0005, mnz = arr[2] - 0.0005;
  let mxx = arr[0] + 0.0005, mxy = arr[1] + 0.0005, mxz = arr[2] + 0.0005;
  for (let i = 0; i < n; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  // f32 round-trip so quantisation uses exactly what the reader will see
  const f = new Float32Array([mnx, mxx, mny, mxy, mnz, mxz]);
  for (const v of f) w.f32(v);
  const [ax, bx, ay, by, az, bz] = f;
  const sx = 65535 / (bx - ax), sy = 65535 / (by - ay), sz = 65535 / (bz - az);
  for (let i = 0; i < n; i++) {
    w.u16(clamp(Math.round((arr[i * 3] - ax) * sx), 0, 65535));
    w.u16(clamp(Math.round((arr[i * 3 + 1] - ay) * sy), 0, 65535));
    w.u16(clamp(Math.round((arr[i * 3 + 2] - az) * sz), 0, 65535));
  }
}

function readVec3Quantized(r, n) {
  const out = new Float32Array(n * 3);
  if (n === 0) return out;
  const mnx = r.f32(), mxx = r.f32(), mny = r.f32(), mxy = r.f32(), mnz = r.f32(), mxz = r.f32();
  const dx = (mxx - mnx) / 65535, dy = (mxy - mny) / 65535, dz = (mxz - mnz) / 65535;
  for (let i = 0; i < n; i++) {
    out[i * 3] = mnx + r.u16() * dx;
    out[i * 3 + 1] = mny + r.u16() * dy;
    out[i * 3 + 2] = mnz + r.u16() * dz;
  }
  return out;
}

function writeVec2Quantized(w, arr, n) {
  if (n === 0) return;
  let mnx = arr[0] - 0.001, mny = arr[1] - 0.001, mxx = arr[0] + 0.001, mxy = arr[1] + 0.001;
  for (let i = 0; i < n; i++) {
    const x = arr[i * 2], y = arr[i * 2 + 1];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
  }
  const f = new Float32Array([mnx, mxx, mny, mxy]);
  for (const v of f) w.f32(v);
  const [ax, bx, ay, by] = f;
  const sx = 65535 / (bx - ax), sy = 65535 / (by - ay);
  for (let i = 0; i < n; i++) {
    w.u16(clamp(Math.round((arr[i * 2] - ax) * sx), 0, 65535));
    w.u16(clamp(Math.round((arr[i * 2 + 1] - ay) * sy), 0, 65535));
  }
}

function readVec2Quantized(r, n) {
  const out = new Float32Array(n * 2);
  if (n === 0) return out;
  const mnx = r.f32(), mxx = r.f32(), mny = r.f32(), mxy = r.f32();
  const dx = (mxx - mnx) / 65535, dy = (mxy - mny) / 65535;
  for (let i = 0; i < n; i++) {
    out[i * 2] = mnx + r.u16() * dx;
    out[i * 2 + 1] = mny + r.u16() * dy;
  }
  return out;
}

function writeBytes(w, arr, n, comps) {
  for (let i = 0; i < n * comps; i++) w.u8v(clamp(Math.round(arr[i] * 127 + 128), 0, 255));
}

function readBytes(r, n, comps) {
  const out = new Float32Array(n * comps);
  for (let i = 0; i < n * comps; i++) out[i] = (r.u8v() - 128) / 127;
  return out;
}

/**
 * Encode mesh data.
 * @param {object} m { positions: Float32Array, normals?, tangents?, uv?, uv2?, indices: Uint32Array|Uint16Array|number[], submeshStarts?: number[] }
 * @returns {{ bytes: Uint8Array, descriptor: object }}
 */
export function encodeMesh(m) {
  const n = m.positions.length / 3;
  const nn = m.normals ? m.normals.length / 3 : 0;
  const nt = m.tangents ? m.tangents.length / 4 : 0;
  const hasUv = !!(m.uv && m.uv.length);
  const hasUv2 = !!(m.uv2 && m.uv2.length);
  const idx = m.indices;
  const tris = Math.floor(idx.length / 3);
  if (n > MAX_MESH_VERTICES) throw new Error(`Mesh has ${n} vertices; the game allows at most ${MAX_MESH_VERTICES} per mesh`);
  if (tris > MAX_MESH_TRIANGLES) throw new Error(`Mesh has ${tris} triangles; the game allows at most ${MAX_MESH_TRIANGLES} per mesh`);
  const size = (n ? 24 + n * 6 : 0) + nn * 3 + nt * 4 + (hasUv ? 16 + n * 4 : 0) + (hasUv2 ? 16 + n * 4 : 0) + tris * 6;
  const w = new Writer(size);
  writeVec3Quantized(w, m.positions, n);
  writeBytes(w, m.normals, nn, 3);
  writeBytes(w, m.tangents, nt, 4);
  if (hasUv) writeVec2Quantized(w, m.uv, n);
  if (hasUv2) writeVec2Quantized(w, m.uv2, n);
  for (let i = 0; i < tris * 3; i++) w.u16(idx[i]);
  return {
    bytes: new Uint8Array(w.buf),
    descriptor: {
      verticesCount: n,
      normalsCount: nn,
      tangentsCount: nt,
      uv: hasUv,
      uv2: hasUv2,
      trianglesCount: tris,
      subMeshStartingIndices: m.submeshStarts && m.submeshStarts.length ? [...m.submeshStarts] : [0],
    },
  };
}

/**
 * Decode mesh bytes using the descriptor stored in contentInfo.json.
 * With `lenient`, triangles that point past the vertex list are dropped instead of failing,
 * which is how broken workshop items get repaired (`droppedTriangles` says how many).
 */
export function decodeMesh(descriptor, bytes, { lenient = false } = {}) {
  const n = descriptor.verticesCount | 0;
  const tris = descriptor.trianglesCount | 0;
  if (n < 0 || n > MAX_MESH_VERTICES) throw new Error(`Invalid vertex count in the mesh data (${n})`);
  if (tris < 0 || tris > MAX_MESH_TRIANGLES) throw new Error(`Invalid triangle count in the mesh data (${tris})`);
  if (!bytes || bytes.length < 5) throw new Error('Invalid mesh file');
  const r = new Reader(bytes);
  const positions = readVec3Quantized(r, n);
  const normals = descriptor.normalsCount > 0 ? readBytes(r, descriptor.normalsCount, 3) : null;
  const tangents = descriptor.tangentsCount > 0 ? readBytes(r, descriptor.tangentsCount, 4) : null;
  const uv = descriptor.uv ? readVec2Quantized(r, n) : null;
  const uv2 = descriptor.uv2 ? readVec2Quantized(r, n) : null;
  const raw = new Uint32Array(tris * 3);
  let bad = 0;
  for (let i = 0; i < tris * 3; i++) {
    const v = r.u16();
    if (v >= n) {
      if (!lenient) throw new Error(`Triangle index ${v} out of range (${n} vertices)`);
      bad++;
    }
    raw[i] = v;
  }
  const starts = descriptor.subMeshStartingIndices && descriptor.subMeshStartingIndices.length ? descriptor.subMeshStartingIndices : [0];
  let submeshes = starts.map((s, i) => ({ start: s, count: (i + 1 < starts.length ? starts[i + 1] : tris * 3) - s }));
  let indices = raw;
  let droppedTriangles = 0;
  if (bad) {
    // rebuild each submesh without the broken triangles
    const out = [];
    const subs = [];
    for (const sm of submeshes) {
      const start = out.length;
      for (let i = sm.start; i + 2 < sm.start + sm.count; i += 3) {
        if (raw[i] < n && raw[i + 1] < n && raw[i + 2] < n) out.push(raw[i], raw[i + 1], raw[i + 2]);
        else droppedTriangles++;
      }
      subs.push({ start, count: out.length - start });
    }
    indices = Uint32Array.from(out);
    submeshes = subs;
  }
  const trailing = bytes.length - r.p;
  return { positions, normals, tangents, uv, uv2, indices, submeshes, trailing, droppedTriangles };
}

/** Byte length the descriptor implies, used by the health checker. */
export function expectedMeshSize(d) {
  const n = d.verticesCount | 0;
  return (n ? 24 + n * 6 : 0) + (d.normalsCount | 0) * 3 + (d.tangentsCount | 0) * 4 +
    (d.uv ? 16 + n * 4 : 0) + (d.uv2 ? 16 + n * 4 : 0) + (d.trianglesCount | 0) * 6;
}
