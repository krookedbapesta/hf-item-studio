// Geometry tools: pivot conventions, orientation, sizing, automatic colliders and wall fitting.
import * as THREE from 'three';
import { modelBounds, colliderBounds, flipWinding, eachMesh } from './hfscene.js';
import { PLACEMENT, WALL_COLLIDER_GAP } from '../core/constants.js';

// ---------- transforms on the whole item (geometry + colliders together) ----------

export function transformItem(model, colliders, matrix) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.applyMatrix4(matrix);
    if (matrix.determinant() < 0) flipWinding(o.geometry);
    o.geometry.computeBoundingBox();
    o.geometry.computeBoundingSphere();
  });
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  matrix.decompose(pos, q, s);
  const pureTranslateScale = Math.abs(Math.abs(q.w) - 1) < 1e-6;
  return colliders.map((c) => {
    if (c.matrix || !pureTranslateScale) {
      const m = new THREE.Matrix4().multiplyMatrices(matrix, c.matrix ? new THREE.Matrix4().fromArray(c.matrix) : new THREE.Matrix4());
      return rebakeAxisAligned({ ...c, matrix: m.elements.slice() });
    }
    const center = new THREE.Vector3(...c.center).applyMatrix4(matrix).toArray();
    const out = { ...c, center };
    if (c.type === 'box') out.size = c.size.map((v, i) => Math.abs(v * s.getComponent(i)));
    else if (c.type === 'sphere') out.radius = c.radius * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
    else if (c.type === 'capsule') {
      out.height = c.height * Math.abs(s.getComponent(c.direction));
      out.radius = c.radius * Math.max(...[0, 1, 2].filter((i) => i !== c.direction).map((i) => Math.abs(s.getComponent(i))));
    }
    return out;
  });
}

/** A rotation by multiples of 90 degrees keeps boxes axis-aligned; fold it back into center/size. */
function rebakeAxisAligned(c) {
  const m = new THREE.Matrix4().fromArray(c.matrix);
  const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(pos, q, s);
  const rm = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const e = rm.elements;
  const near = (v) => Math.abs(v) < 1e-5 || Math.abs(Math.abs(v) - 1) < 1e-5;
  if (!e.every(near) || c.type !== 'box') return c;
  const bb = colliderBounds(c);
  const center = bb.getCenter(new THREE.Vector3()).toArray();
  const size = bb.getSize(new THREE.Vector3()).toArray();
  return { ...c, center, size, matrix: null };
}

export function translateItem(model, colliders, v) {
  return transformItem(model, colliders, new THREE.Matrix4().makeTranslation(v.x, v.y, v.z));
}

export function rotateItem(model, colliders, axis, degrees) {
  const m = new THREE.Matrix4();
  const r = THREE.MathUtils.degToRad(degrees);
  if (axis === 'x') m.makeRotationX(r); else if (axis === 'y') m.makeRotationY(r); else m.makeRotationZ(r);
  return transformItem(model, colliders, m);
}

export function scaleItem(model, colliders, factor) {
  const f = typeof factor === 'number' ? new THREE.Vector3(factor, factor, factor) : factor;
  return transformItem(model, colliders, new THREE.Matrix4().makeScale(f.x, f.y, f.z));
}

export function mirrorItem(model, colliders, axis) {
  const v = new THREE.Vector3(1, 1, 1);
  v[axis] = -1;
  return transformItem(model, colliders, new THREE.Matrix4().makeScale(v.x, v.y, v.z));
}

/** Resize so the model's bounding box has the given size on one axis (uniform) or all axes. */
export function resizeItem(model, colliders, target, { uniform = true, axis = null } = {}) {
  const size = modelBounds(model).getSize(new THREE.Vector3());
  if (uniform) {
    const ax = axis ?? (['x', 'y', 'z'].reduce((a, b) => (size[a] >= size[b] ? a : b)));
    const f = target[ax] / (size[ax] || 1);
    return scaleItem(model, colliders, f);
  }
  return scaleItem(model, colliders, new THREE.Vector3(target.x / (size.x || 1), target.y / (size.y || 1), target.z / (size.z || 1)));
}

/**
 * Move the item so its pivot follows the game's convention for the placement type:
 *   Floor   - bottom centre (min Y = 0, centred on X and Z)
 *   Wall    - back centre   (min Z = 0 against the wall, centred on X, Y centred or bottom)
 *   Ceiling - top centre    (max Y = 0, centred on X and Z)
 */
export function applyPivot(model, colliders, placement, { wallVertical = 'center' } = {}) {
  const b = modelBounds(model);
  if (b.isEmpty()) return colliders;
  const c = b.getCenter(new THREE.Vector3());
  const t = new THREE.Vector3();
  if (placement === PLACEMENT.Floor) t.set(-c.x, -b.min.y, -c.z);
  else if (placement === PLACEMENT.Ceiling) t.set(-c.x, -b.max.y, -c.z);
  else t.set(-c.x, wallVertical === 'bottom' ? -b.min.y : -c.y, -b.min.z);
  return translateItem(model, colliders, t);
}

/** Describe how far the current pivot is from the convention (for the checks panel). */
export function pivotReport(model, placement) {
  const b = modelBounds(model);
  const c = b.getCenter(new THREE.Vector3());
  const issues = [];
  const tol = 0.002;
  if (placement === PLACEMENT.Floor) {
    if (Math.abs(b.min.y) > tol) issues.push(`Bottom is at y = ${b.min.y.toFixed(3)} m; floor items should rest at y = 0`);
    if (Math.abs(c.x) > 0.05 || Math.abs(c.z) > 0.05) issues.push('Pivot is off-centre; the item will rotate around a corner in game');
  } else if (placement === PLACEMENT.Wall) {
    if (Math.abs(b.min.z) > tol) issues.push(`Back is at z = ${b.min.z.toFixed(3)} m; wall items should have their back at z = 0`);
    if (Math.abs(c.x) > 0.05) issues.push('Pivot is not centred horizontally');
  } else if (Math.abs(b.max.y) > tol) issues.push(`Top is at y = ${b.max.y.toFixed(3)} m; ceiling items should hang from y = 0`);
  return issues;
}

// ---------- orientation ----------

function triangleAreaByDirection(model) {
  // area of faces pointing along each signed axis, plus flat area at the extreme planes
  const b = modelBounds(model);
  const res = { '+x': 0, '-x': 0, '+y': 0, '-y': 0, '+z': 0, '-z': 0, backFlat: 0, frontFlat: 0 };
  const a = new THREE.Vector3(), bb = new THREE.Vector3(), cc = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const tol = Math.max(0.002, (b.max.z - b.min.z) * 0.03);
  const vn = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    const p = o.geometry.getAttribute('position');
    const nrm = o.geometry.getAttribute('normal');
    const idx = o.geometry.getIndex();
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(p, i0); bb.fromBufferAttribute(p, i1); cc.fromBufferAttribute(p, i2);
      e1.subVectors(bb, a); e2.subVectors(cc, a);
      n.crossVectors(e1, e2);
      const area = n.length() / 2;
      if (area === 0) continue;
      n.normalize();
      // the stored vertex normals say which way is out; the cross product only gives the axis
      if (nrm) {
        vn.fromBufferAttribute(nrm, i0).add(e1.fromBufferAttribute(nrm, i1)).add(e2.fromBufferAttribute(nrm, i2));
        if (vn.dot(n) < 0) n.negate();
      }
      const ax = Math.abs(n.x) > Math.abs(n.y) ? (Math.abs(n.x) > Math.abs(n.z) ? 'x' : 'z') : (Math.abs(n.y) > Math.abs(n.z) ? 'y' : 'z');
      res[(n[ax] >= 0 ? '+' : '-') + ax] += area;
      const zAvg = (a.z + bb.z + cc.z) / 3;
      if (n.z < -0.95 && zAvg - b.min.z < tol) res.backFlat += area;
      if (n.z > 0.95 && b.max.z - zAvg < tol) res.frontFlat += area;
    }
  });
  return res;
}

/**
 * Rotate a model so it can hang on a wall: thinnest dimension along Z, flat back facing -Z.
 * Returns { colliders, rotated: string[] } describing what was done.
 */
export function autoOrientForWall(model, colliders) {
  const steps = [];
  let size = modelBounds(model).getSize(new THREE.Vector3());
  const thin = ['x', 'y', 'z'].reduce((p, q) => (size[p] <= size[q] ? p : q));
  if (thin === 'x') { colliders = rotateItem(model, colliders, 'y', 90); steps.push('rotated 90° around Y (thin side was X)'); }
  else if (thin === 'y') { colliders = rotateItem(model, colliders, 'x', -90); steps.push('rotated -90° around X (item was lying flat)'); }
  const s = triangleAreaByDirection(model);
  // the flat side is the back; if the flat side faces +Z we are looking at the back
  if (s.frontFlat > s.backFlat * 1.25 && s.frontFlat > 0) {
    colliders = rotateItem(model, colliders, 'y', 180);
    steps.push('turned around so the flat back faces the wall');
  }
  return { colliders, steps };
}

/** Suggest a placement from the shape: thin and tall reads as a wall item. */
export function guessPlacement(model) {
  const size = modelBounds(model).getSize(new THREE.Vector3());
  const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
  if (dims[0] < 0.08 && dims[1] > dims[0] * 4 && size.y > size.z * 2 && size.x > size.z * 2) return PLACEMENT.Wall;
  return PLACEMENT.Floor;
}

// ---------- colliders ----------

export function boxFromBounds(b, canPutOnTop = false) {
  const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
  return { type: 'box', center: c.toArray(), size: s.toArray().map((v) => Math.max(v, 0.001)), canPutOnTop, matrix: null };
}

function collectTriangles(model, cb) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  eachMesh(model, (o, mw) => {
    const p = o.geometry.getAttribute('position');
    const idx = o.geometry.getIndex();
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(mw);
      b.fromBufferAttribute(p, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(mw);
      c.fromBufferAttribute(p, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(mw);
      cb(a, b, c, o);
    }
  });
}

/** Voxelise the model surface and fill the inside. */
export function voxelize(model, resolution = 32) {
  const bounds = modelBounds(model);
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-4);
  const vs = maxDim / resolution;
  const nx = Math.max(1, Math.ceil(size.x / vs)), ny = Math.max(1, Math.ceil(size.y / vs)), nz = Math.max(1, Math.ceil(size.z / vs));
  const grid = new Uint8Array(nx * ny * nz);
  const id = (x, y, z) => x + nx * (z + nz * y);
  const mark = (p) => {
    const x = Math.min(nx - 1, Math.max(0, Math.floor((p.x - bounds.min.x) / vs)));
    const y = Math.min(ny - 1, Math.max(0, Math.floor((p.y - bounds.min.y) / vs)));
    const z = Math.min(nz - 1, Math.max(0, Math.floor((p.z - bounds.min.z) / vs)));
    grid[id(x, y, z)] = 1;
  };
  const p = new THREE.Vector3();
  collectTriangles(model, (a, b, c) => {
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    const steps = Math.min(64, Math.max(1, Math.ceil(longest / (vs * 0.5))));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps, v = j / steps, w = 1 - u - v;
        p.set(a.x * w + b.x * u + c.x * v, a.y * w + b.y * u + c.y * v, a.z * w + b.z * u + c.z * v);
        mark(p);
      }
    }
  });
  // flood fill the outside from the padded border, everything not reached is solid
  const outside = new Uint8Array(nx * ny * nz);
  const stack = [];
  const push = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
    const i = id(x, y, z);
    if (grid[i] || outside[i]) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) { push(x, y, 0); push(x, y, nz - 1); }
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) { push(x, 0, z); push(x, ny - 1, z); }
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { push(0, y, z); push(nx - 1, y, z); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / (nx * nz));
    push(x + 1, y, z); push(x - 1, y, z); push(x, y + 1, z); push(x, y - 1, z); push(x, y, z + 1); push(x, y, z - 1);
  }
  for (let i = 0; i < grid.length; i++) if (!outside[i]) grid[i] = 1;
  return { grid, nx, ny, nz, vs, origin: bounds.min.clone(), bounds };
}

function greedyBoxes(vox) {
  const { grid, nx, ny, nz } = vox;
  const used = new Uint8Array(grid.length);
  const id = (x, y, z) => x + nx * (z + nz * y);
  const ok = (x, y, z) => grid[id(x, y, z)] && !used[id(x, y, z)];
  const boxes = [];
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!ok(x, y, z)) continue;
    let x1 = x;
    while (x1 + 1 < nx && ok(x1 + 1, y, z)) x1++;
    let z1 = z;
    outerZ: while (z1 + 1 < nz) {
      for (let xx = x; xx <= x1; xx++) if (!ok(xx, y, z1 + 1)) break outerZ;
      z1++;
    }
    let y1 = y;
    outerY: while (y1 + 1 < ny) {
      for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) if (!ok(xx, y1 + 1, zz)) break outerY;
      y1++;
    }
    for (let yy = y; yy <= y1; yy++) for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) used[id(xx, yy, zz)] = 1;
    boxes.push({ min: [x, y, z], max: [x1 + 1, y1 + 1, z1 + 1] });
  }
  return boxes;
}

const vol = (b) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
const union = (a, b) => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])), solid: (a.solid ?? vol(a)) + (b.solid ?? vol(b)) });

/** Merge boxes pairwise, always picking the merge that adds the least empty volume. */
function reduceBoxes(boxes, maxBoxes) {
  let list = boxes.map((b) => ({ ...b, solid: vol(b) }));
  while (list.length > maxBoxes) {
    let best = null, bestCost = Infinity;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const u = union(list[i], list[j]);
        const cost = vol(u) - u.solid;
        if (cost < bestCost) { bestCost = cost; best = [i, j, u]; }
      }
    }
    const [i, j, u] = best;
    list = list.filter((_, k) => k !== i && k !== j);
    list.push(u);
  }
  return list;
}

/** Pull each box in to the vertices that actually fall inside it. */
function tightenBoxes(model, boxes) {
  const tight = boxes.map(() => new THREE.Box3());
  const v = new THREE.Vector3();
  eachMesh(model, (o, mw) => {
    const p = o.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mw);
      boxes.forEach((b, k) => { if (b.containsPoint(v)) tight[k].expandByPoint(v); });
    }
  });
  return boxes.map((b, k) => {
    if (tight[k].isEmpty()) return b;
    // keep at least half a voxel of thickness so thin parts stay solid
    const out = tight[k].clone();
    const s = out.getSize(new THREE.Vector3()), bs = b.getSize(new THREE.Vector3());
    for (const ax of ['x', 'y', 'z']) {
      if (s[ax] < bs[ax] * 0.25) { const c = (out.min[ax] + out.max[ax]) / 2; out.min[ax] = c - bs[ax] * 0.125; out.max[ax] = c + bs[ax] * 0.125; }
    }
    return out;
  });
}

/** Mark boxes whose top is exposed and roughly flat as surfaces other items may stand on. */
export function autoTopSurfaces(colliders, { minArea = 0.02 } = {}) {
  const bbs = colliders.map(colliderBounds);
  return colliders.map((c, i) => {
    if (c.type !== 'box') return c;
    const b = bbs[i];
    const area = (b.max.x - b.min.x) * (b.max.z - b.min.z);
    if (area < minArea) return { ...c, canPutOnTop: false };
    const covered = bbs.some((o, j) => j !== i && o.min.y >= b.max.y - 0.01 &&
      o.min.x < b.max.x && o.max.x > b.min.x && o.min.z < b.max.z && o.max.z > b.min.z &&
      (Math.min(o.max.x, b.max.x) - Math.max(o.min.x, b.min.x)) * (Math.min(o.max.z, b.max.z) - Math.max(o.min.z, b.min.z)) > area * 0.5);
    return { ...c, canPutOnTop: !covered };
  });
}

/**
 * Generate colliders.
 *   mode 'single'  : one box around everything
 *   mode 'perMesh' : one box per mesh part
 *   mode 'fit'     : voxel decomposition into at most maxBoxes boxes
 */
export function generateColliders(model, { mode = 'fit', maxBoxes = 6, resolution = 28, canPutOnTop = false } = {}) {
  const bounds = modelBounds(model);
  if (bounds.isEmpty()) return [];
  if (mode === 'single') return [boxFromBounds(bounds, canPutOnTop)];
  if (mode === 'perMesh') {
    const list = [];
    eachMesh(model, (o, mw) => {
      o.geometry.computeBoundingBox();
      list.push(o.geometry.boundingBox.clone().applyMatrix4(mw));
    });
    // drop boxes swallowed by bigger ones
    const kept = list.filter((b, i) => !list.some((o, j) => j !== i && o.containsBox(b) && (!b.equals(o) || j < i)));
    let boxes = kept.map((b) => ({ min: b.min.toArray(), max: b.max.toArray() }));
    if (boxes.length > maxBoxes) boxes = reduceBoxes(boxes, maxBoxes);
    const out = boxes.map((b) => boxFromBounds(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))));
    return canPutOnTop ? autoTopSurfaces(out) : out;
  }
  let res = resolution;
  let vox, raw;
  for (let attempt = 0; attempt < 4; attempt++) {
    vox = voxelize(model, res);
    raw = greedyBoxes(vox);
    if (raw.length <= 220) break;
    res = Math.max(8, Math.floor(res * 0.7));
  }
  const merged = reduceBoxes(raw, Math.max(1, maxBoxes));
  const world = merged.map((b) => new THREE.Box3(
    new THREE.Vector3(...b.min).multiplyScalar(vox.vs).add(vox.origin),
    new THREE.Vector3(...b.max).multiplyScalar(vox.vs).add(vox.origin),
  ).intersect(bounds));
  const tight = tightenBoxes(model, world);
  const out = tight.filter((b) => !b.isEmpty()).map((b) => boxFromBounds(b));
  return canPutOnTop ? autoTopSurfaces(out) : out;
}

/**
 * Keep colliders clear of the surface the item is mounted on so the game does not report
 * a collision when the visible model sits flush against it.
 *   Wall:    every collider starts at z >= gap
 *   Ceiling: every collider ends at y <= -gap
 *   Floor:   colliders start at y >= floorGap (0 by default, the game is fine with 0)
 * `inset` shrinks colliders on the other axes so items can sit tight in corners and niches.
 */
export function fitCollidersToSurface(colliders, placement, { gap = WALL_COLLIDER_GAP, floorGap = 0, inset = 0, minThickness = 0.002 } = {}) {
  return colliders.map((c) => {
    if (c.type !== 'box' || c.matrix) return c;
    const min = c.center.map((v, i) => v - c.size[i] / 2);
    const max = c.center.map((v, i) => v + c.size[i] / 2);
    if (placement === PLACEMENT.Wall) {
      if (min[2] < gap) min[2] = gap;
      if (max[2] < min[2] + minThickness) max[2] = min[2] + minThickness;
      for (const ax of [0, 1]) if (inset > 0 && max[ax] - min[ax] > inset * 4) { min[ax] += inset; max[ax] -= inset; }
    } else if (placement === PLACEMENT.Ceiling) {
      if (max[1] > -gap) max[1] = -gap;
      if (min[1] > max[1] - minThickness) min[1] = max[1] - minThickness;
      for (const ax of [0, 2]) if (inset > 0 && max[ax] - min[ax] > inset * 4) { min[ax] += inset; max[ax] -= inset; }
    } else {
      if (min[1] < floorGap) min[1] = floorGap;
      if (max[1] < min[1] + minThickness) max[1] = min[1] + minThickness;
      for (const ax of [0, 2]) if (inset > 0 && max[ax] - min[ax] > inset * 4) { min[ax] += inset; max[ax] -= inset; }
    }
    return { ...c, center: min.map((v, i) => (v + max[i]) / 2), size: min.map((v, i) => max[i] - v) };
  });
}

/** Report on how colliders relate to the mounting surface and the model. */
export function colliderReport(model, colliders, placement) {
  const issues = [];
  if (!colliders.length) { issues.push({ level: 'error', text: 'No colliders: the game cannot place this item' }); return issues; }
  const mb = modelBounds(model);
  const cb = new THREE.Box3();
  colliders.forEach((c) => cb.union(colliderBounds(c)));
  if (placement === PLACEMENT.Wall && cb.min.z < 0.001) {
    issues.push({ level: 'warn', text: `Collider touches the wall plane (z = ${cb.min.z.toFixed(4)} m). The game may refuse to hang it; use Wall fit to leave a ${Math.round(WALL_COLLIDER_GAP * 1000)} mm gap.`, fix: 'wallfit' });
  }
  if (placement === PLACEMENT.Ceiling && cb.max.y > -0.001) {
    issues.push({ level: 'warn', text: 'Collider touches the ceiling plane; use Ceiling fit to leave a small gap.', fix: 'wallfit' });
  }
  if (placement === PLACEMENT.Floor && cb.min.y < -0.001) issues.push({ level: 'warn', text: `Collider goes below the floor (y = ${cb.min.y.toFixed(3)} m)`, fix: 'pivot' });
  if (!mb.isEmpty()) {
    const ms = mb.getSize(new THREE.Vector3()), cs = cb.getSize(new THREE.Vector3());
    for (const ax of ['x', 'y', 'z']) {
      if (cs[ax] > ms[ax] * 1.25 + 0.02) issues.push({ level: 'info', text: `Colliders are ${((cs[ax] - ms[ax]) * 100).toFixed(1)} cm larger than the model on ${ax.toUpperCase()}` });
      if (cs[ax] < ms[ax] * 0.6) issues.push({ level: 'info', text: `Colliders cover only ${Math.round((cs[ax] / ms[ax]) * 100)}% of the model on ${ax.toUpperCase()}; parts will clip through other items` });
    }
  }
  colliders.forEach((c, i) => {
    if (c.type === 'box' && c.size.some((v) => Math.abs(v) < 0.001)) issues.push({ level: 'warn', text: `Box ${i + 1} is paper-thin; it is hard to pick up in game`, fix: 'thicken' });
  });
  return issues;
}

export function thickenColliders(colliders, min = 0.01) {
  return colliders.map((c) => (c.type === 'box' ? { ...c, size: c.size.map((v) => Math.max(Math.abs(v), min)) } : c));
}
