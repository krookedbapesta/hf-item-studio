// End-to-end checks of the import -> edit -> export pipeline without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadModelFile, bakeToItemSpace } from '../src/three/importers.js';
import { generateColliders, applyPivot, fitCollidersToSurface, autoOrientForWall, guessPlacement, colliderReport } from '../src/three/tools.js';
import { exportItem, splitForGame } from '../src/three/exporter.js';
import { itemFromContent, modelBounds, colliderBounds } from '../src/three/hfscene.js';
import { readHfContent, checkHfContent } from '../src/core/hfcontent.js';
import { PLACEMENT } from '../src/core/constants.js';

import { loadCollections } from './game-data.mjs';

const collections = loadCollections();
const tagByName = new Map(collections.tags.map((t) => [t.name, t]));
const cat = collections.categories[0].guid;

// --- tiny OBJ writers ---
function boxObj(boxes) {
  let v = '', f = '', n = 1;
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const p of P) v += `v ${p.join(' ')}\n`;
    const F = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]];
    for (const q of F) f += `f ${q.map((i) => i + n - 1).join(' ')}\n`;
    n += 8;
  }
  return new TextEncoder().encode(v + f);
}

async function importObj(name, boxes) {
  const { scene } = await loadModelFile({ name, bytes: boxObj(boxes) });
  return bakeToItemSpace(scene);
}

function exportAndReread(model, colliders, meta) {
  const out = exportItem({ meta: { name: 'Test', price: 10, currency: 8, categoryGuid: cat, tagGuids: [], ...meta }, model, colliders, thumbnail: null }, { tagByName });
  return { out, back: readHfContent(out.bytes) };
}

test('table imports with legs and top as separate colliders, pivot on the floor', async () => {
  // 1.2 x 0.75 x 0.7 m table: top slab + 4 legs
  const legs = [[-0.58, 0, -0.33], [0.53, 0, -0.33], [-0.58, 0, 0.28], [0.53, 0, 0.28]].map(([x, y, z]) => [x, y, z, x + 0.05, 0.71, z + 0.05]);
  const model = await importObj('table.obj', [[-0.6, 0.71, -0.35, 0.6, 0.75, 0.35], ...legs]);
  let cols = applyPivot(model, [], PLACEMENT.Floor);
  const b = modelBounds(model);
  assert.ok(Math.abs(b.min.y) < 1e-6, 'rests on the floor');
  assert.ok(Math.abs((b.min.x + b.max.x) / 2) < 1e-6 && Math.abs((b.min.z + b.max.z) / 2) < 1e-6, 'centred');
  cols = generateColliders(model, { mode: 'fit', maxBoxes: 5, canPutOnTop: true });
  assert.ok(cols.length >= 3 && cols.length <= 5, `got ${cols.length} boxes`);
  const total = cols.reduce((a, c) => a + c.size[0] * c.size[1] * c.size[2], 0);
  const single = b.getSize(new THREE.Vector3());
  assert.ok(total < single.x * single.y * single.z * 0.5, 'smart fit leaves the space under the table open');
  assert.ok(cols.some((c) => c.canPutOnTop), 'table top is a surface');
  const { back } = exportAndReread(model, cols, {});
  const chk = checkHfContent(back.info, back.files);
  assert.deepEqual(chk.errors, []);
  const re = await itemFromContent(back.info, back.files);
  const rb = modelBounds(re.model);
  assert.ok(rb.min.distanceTo(b.min) < 0.002 && rb.max.distanceTo(b.max) < 0.002, 'geometry survives the round trip');
  assert.equal(re.colliders.length, cols.length);
});

test('painting lying flat becomes a wall item flush with the wall, colliders 5 mm off it', async () => {
  const model = await importObj('painting.obj', [[0, 0, 0, 0.8, 0.03, 0.6]]);
  assert.equal(guessPlacement(model), PLACEMENT.Floor);
  let cols = autoOrientForWall(model, []).colliders;
  cols = applyPivot(model, cols, PLACEMENT.Wall);
  const b = modelBounds(model);
  const s = b.getSize(new THREE.Vector3());
  assert.ok(Math.abs(s.z - 0.03) < 1e-5, 'thin side faces the wall');
  assert.ok(Math.abs(b.min.z) < 1e-6, 'back on the wall plane');
  assert.equal(guessPlacement(model), PLACEMENT.Wall);
  cols = generateColliders(model, { mode: 'single' });
  assert.ok(colliderReport(model, cols, PLACEMENT.Wall).some((r) => r.fix === 'wallfit'), 'warns before fitting');
  cols = fitCollidersToSurface(cols, PLACEMENT.Wall, { gap: 0.005 });
  const cb = colliderBounds(cols[0]);
  assert.ok(Math.abs(cb.min.z - 0.005) < 1e-6, 'collider starts 5 mm from the wall');
  assert.ok(Math.abs(cb.max.z - 0.03) < 1e-6, 'collider still reaches the front');
  assert.ok(!colliderReport(model, cols, PLACEMENT.Wall).some((r) => r.fix === 'wallfit'));
  const { back } = exportAndReread(model, cols, { placement: PLACEMENT.Wall });
  assert.ok(back.info.ItemTags.includes(tagByName.get('Limits/Hanging').guid), 'hanging tag added for wall items');
  assert.equal(back.info.ItemData.PlacementOption, 2);
});

test('meshes over 64,000 vertices are split and every part loads', () => {
  const n = 330; // 330 x 330 grid = 108,900 vertices
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), idx = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    pos.set([x / n, 0.01 * Math.sin(x), y / n], i * 3);
    uv.set([x / n, y / n], i * 2);
    if (x < n - 1 && y < n - 1) idx.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.addGroup(0, idx.length, 0);
  const chunks = splitForGame(g);
  assert.ok(chunks.length >= 4, `split into ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.positions.length / 3 <= 64000);
    assert.ok(c.indices.length / 3 <= 64000);
  }
  const model = new THREE.Group();
  model.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x808080 })));
  const cols = generateColliders(model, { mode: 'single' });
  const { out, back } = exportAndReread(model, cols, {});
  assert.ok(out.report.split === 1);
  const chk = checkHfContent(back.info, back.files);
  assert.deepEqual(chk.errors, []);
  assert.equal(chk.stats.triangles, idx.length / 3);
});

test('models shown in the (mirrored, moved) viewport still measure and export in item space', async () => {
  const model = await importObj('box.obj', [[0, 0, 0, 0.4, 0.2, 0.1]]);
  applyPivot(model, [], PLACEMENT.Floor);
  const before = modelBounds(model);
  const display = new THREE.Group();
  display.scale.set(-1, 1, 1);
  display.position.set(3, 1, -2);
  display.add(model);
  display.updateMatrixWorld(true);
  const after = modelBounds(model);
  assert.ok(before.min.distanceTo(after.min) < 1e-9 && before.max.distanceTo(after.max) < 1e-9, 'bounds ignore the display parent');
  const cols = generateColliders(model, { mode: 'fit', maxBoxes: 2 });
  const cb = colliderBounds(cols[0]);
  assert.ok(cb.min.x > -0.21 && cb.max.x < 0.21 && cb.min.y > -0.01, 'colliders in item space');
  const { back } = exportAndReread(model, cols, {});
  const re = await itemFromContent(back.info, back.files);
  const rb = modelBounds(re.model);
  assert.ok(rb.min.distanceTo(before.min) < 0.002, 'export not mirrored or offset');
});

test('room check flags a wall collider flush with the wall but not one 5 mm off it', async () => {
  const { Viewport } = await import('../src/three/viewport.js');
  const vp = Object.create(Viewport.prototype);
  Object.assign(vp, {
    mode: 'room', placement: PLACEMENT.Wall, selected: -1, colliderObjs: [],
    itemRoot: new THREE.Group(),
    room: { solids: [{ name: 'Back wall', box: new THREE.Box3(new THREE.Vector3(-3, 0, -0.15), new THREE.Vector3(3, 2.75, 0)) }, { name: 'Floor', box: new THREE.Box3(new THREE.Vector3(-3, -0.1, -0.15), new THREE.Vector3(3, 0, 5)) }] },
    roomProps: [],
  });
  vp.itemRoot.position.set(0, 1.4, 0);
  vp.colliders = [{ type: 'box', center: [0, 0, 0.015], size: [0.8, 0.6, 0.03], canPutOnTop: false, matrix: null }];
  let hits = vp.checkRoomCollisions();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'touch');
  vp.colliders = fitCollidersToSurface(vp.colliders, PLACEMENT.Wall, { gap: 0.005 });
  hits = vp.checkRoomCollisions();
  assert.equal(hits.length, 0, 'wall fit clears it');
  // a floor item resting on the floor is fine
  vp.placement = PLACEMENT.Floor;
  vp.itemRoot.position.set(0, 0, 1);
  vp.colliders = [{ type: 'box', center: [0, 0.25, 0], size: [0.5, 0.5, 0.5], canPutOnTop: false, matrix: null }];
  assert.equal(vp.checkRoomCollisions().length, 0);
});

const WORKSHOP = 'D:/SteamLibrary/steamapps/workshop/content/613100';
test('workshop wall item survives open -> re-export with materials passed through', { skip: !fs.existsSync(WORKSHOP) }, async () => {
  const dirs = fs.readdirSync(WORKSHOP).slice(0, 400);
  let tested = 0;
  for (const d of dirs) {
    const f = fs.readdirSync(path.join(WORKSHOP, d)).find((x) => x.endsWith('.hfcontent'));
    if (!f) continue;
    const bytes = new Uint8Array(fs.readFileSync(path.join(WORKSHOP, d, f)));
    if (bytes.length > 4e6) continue;
    const src = readHfContent(bytes);
    if (src.info.ItemData.PlacementOption !== 2) continue;
    const { model, colliders } = await itemFromContent(src.info, src.files);
    const before = modelBounds(model);
    const { back } = exportAndReread(model, colliders, { placement: 2, categoryGuid: src.info.ItemCategory });
    const chk = checkHfContent(back.info, back.files);
    assert.deepEqual(chk.errors.filter((e) => !/thumbnail/i.test(e)), [], `${d}`);
    const srcTex = Object.keys(src.files).filter((k) => k.endsWith('.png') && k !== src.info.ItemData.Thumbnail);
    const outTex = Object.keys(back.files).filter((k) => k.endsWith('.png'));
    assert.ok(outTex.length >= Math.min(1, srcTex.length), `${d} textures kept`);
    const re = await itemFromContent(back.info, back.files);
    const after = modelBounds(re.model);
    assert.ok(before.min.distanceTo(after.min) < 0.01 && before.max.distanceTo(after.max) < 0.01, `${d} bounds`);
    if (++tested >= 6) break;
  }
  assert.ok(tested > 0);
});
