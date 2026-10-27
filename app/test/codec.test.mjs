import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readHfContent, writeHfContent, checkHfContent, decodeAllMeshes } from '../src/core/hfcontent.js';
import { encodeMesh, decodeMesh } from '../src/core/meshcodec.js';
import { decodePng, encodePng } from '../src/core/png.js';
import { md5Hex } from '../src/core/md5.js';

const WORKSHOP = process.env.HF_WORKSHOP || 'D:/SteamLibrary/steamapps/workshop/content/613100';

function sampleItems(n) {
  if (!fs.existsSync(WORKSHOP)) return [];
  const dirs = fs.readdirSync(WORKSHOP).sort();
  const step = Math.max(1, Math.floor(dirs.length / n));
  const out = [];
  for (let i = 0; i < dirs.length && out.length < n; i += step) {
    const d = path.join(WORKSHOP, dirs[i]);
    const f = fs.readdirSync(d).find((x) => x.endsWith('.hfcontent'));
    if (f) out.push(path.join(d, f));
  }
  return out;
}

test('md5 matches node crypto', () => {
  for (const s of ['', 'abc', 'x'.repeat(1000)]) {
    const b = new TextEncoder().encode(s);
    assert.equal(md5Hex(b), crypto.createHash('md5').update(b).digest('hex'));
  }
});

test('png encode/decode round trip keeps alpha channel exactly', () => {
  const w = 37, h = 19;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = (i * 31 + (i >> 3)) & 0xff;
  const png = encodePng(w, h, px);
  const back = decodePng(png);
  assert.equal(back.width, w);
  assert.deepEqual(back.data, px);
});

test('mesh codec round trip is within quantisation error', () => {
  const n = 500;
  const positions = new Float32Array(n * 3).map(() => Math.random() * 2 - 1);
  const normals = new Float32Array(n * 3).map(() => Math.random() * 2 - 1);
  const uv = new Float32Array(n * 2).map(() => Math.random());
  const indices = new Uint32Array(300).map(() => Math.floor(Math.random() * n));
  const { bytes, descriptor } = encodeMesh({ positions, normals, uv, indices, submeshStarts: [0, 150] });
  const m = decodeMesh(descriptor, bytes);
  for (let i = 0; i < positions.length; i++) assert.ok(Math.abs(m.positions[i] - positions[i]) < 2 / 65535 + 1e-6);
  for (let i = 0; i < normals.length; i++) assert.ok(Math.abs(m.normals[i] - normals[i]) < 1 / 127 + 1e-6);
  assert.deepEqual([...m.indices], [...indices]);
  assert.deepEqual(m.submeshes, [{ start: 0, count: 150 }, { start: 150, count: 150 }]);
});

test('workshop items decode, re-encode and re-read identically', { skip: !fs.existsSync(WORKSHOP) }, () => {
  const items = sampleItems(60);
  assert.ok(items.length > 10);
  let meshes = 0;
  for (const p of items) {
    const bytes = new Uint8Array(fs.readFileSync(p));
    const { info, files } = readHfContent(bytes);
    const decoded = decodeAllMeshes(info, files);
    for (const [d, m] of decoded) {
      if (m.error) continue;
      meshes++;
      // re-encode the decoded data; decoding that must give back the same values
      const re = encodeMesh({
        positions: m.positions, normals: m.normals, tangents: m.tangents, uv: m.uv, uv2: m.uv2,
        indices: m.indices, submeshStarts: d.subMeshStartingIndices,
      });
      assert.equal(re.bytes.length, files[d.filename].length, `${p} ${d.filename} size`);
      const m2 = decodeMesh(re.descriptor, re.bytes);
      const ext = m.positions.reduce((a, v) => Math.max(a, Math.abs(v)), 1);
      for (let i = 0; i < m.positions.length; i++) assert.ok(Math.abs(m2.positions[i] - m.positions[i]) <= ext * 4e-5, `${p} pos ${i}`);
    }
    // archive rewrite must parse back to equal JSON
    const out = writeHfContent(info, files);
    const again = readHfContent(out);
    assert.equal(again.info.Meshes.length, info.Meshes.length);
    assert.equal(again.info.ItemData.ItemName.Default, info.ItemData.ItemName.Default);
    assert.deepEqual(Object.keys(again.files).sort(), Object.keys(files).sort());
    checkHfContent(again.info, again.files);
  }
  assert.ok(meshes > 10);
});
