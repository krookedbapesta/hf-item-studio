// A furnished test room in item space (Unity coordinates). Back wall interior face at z = 0,
// room extends into +Z, floor at y = 0. Wall items hang on the back wall exactly like in game.
import * as THREE from 'three';

function plankTexture(base = '#b08a63') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    let x = -(r % 3) * 90;
    while (x < 512) {
      const w = 160 + ((r * 37 + x) % 120);
      const shade = 0.85 + (((r * 13 + x * 7) % 30) / 100);
      g.fillStyle = base;
      g.filter = `brightness(${shade})`;
      g.fillRect(x, r * 64, w, 64);
      g.filter = 'none';
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x, r * 64, 2, 64);
      x += w;
    }
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, r * 64, 512, 2);
  }
  for (let i = 0; i < 1200; i++) {
    g.fillStyle = `rgba(60,35,10,${Math.random() * 0.08})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 30 + Math.random() * 60, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export const ROOM_DEFAULTS = { width: 5, depth: 4.5, height: 2.75, wallColor: '#e9e4da', floorColor: '#b08a63', wallThickness: 0.15 };

/**
 * Build the room. Returns { group, solids } where solids are named item-space boxes used for
 * collision tests (walls, floor, ceiling, door and window frames).
 */
export function buildRoom(opts = {}) {
  const o = { ...ROOM_DEFAULTS, ...opts };
  const g = new THREE.Group();
  g.name = 'Room';
  const solids = [];
  const W = o.width, D = o.depth, H = o.height, T = o.wallThickness;
  const wallMat = new THREE.MeshStandardMaterial({ color: o.wallColor, roughness: 0.92 });
  const floorTex = plankTexture(o.floorColor);
  floorTex.repeat.set(W / 1.6, D / 1.6);
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.7 });
  const trimMat = new THREE.MeshStandardMaterial({ color: '#f6f3ee', roughness: 0.6 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.95, side: THREE.DoubleSide });

  const box = (name, min, max, mat, solid = true, cast = true) => {
    const size = new THREE.Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const m = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
    m.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    m.name = name;
    m.receiveShadow = true;
    m.castShadow = cast;
    g.add(m);
    if (solid) solids.push({ name, box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)) });
    return m;
  };

  box('Floor', [-W / 2 - T, -0.1, -T], [W / 2 + T, 0, D], floorMat, true, false);
  box('Back wall', [-W / 2 - T, 0, -T], [W / 2 + T, H, 0], wallMat, true, false);
  // left wall with a door opening (1.0 x 2.0 m like the base game doors)
  const doorZ0 = 1.0, doorZ1 = 2.0, doorH = 2.0;
  box('Left wall', [-W / 2 - T, 0, 0], [-W / 2, H, doorZ0], wallMat, true, false);
  box('Left wall', [-W / 2 - T, 0, doorZ1], [-W / 2, H, D], wallMat, true, false);
  box('Left wall (above door)', [-W / 2 - T, doorH, doorZ0], [-W / 2, H, doorZ1], wallMat, true, false);
  box('Door frame', [-W / 2 - 0.02, 0, doorZ0 - 0.06], [-W / 2 + 0.02, doorH + 0.06, doorZ0], trimMat);
  box('Door frame', [-W / 2 - 0.02, 0, doorZ1], [-W / 2 + 0.02, doorH + 0.06, doorZ1 + 0.06], trimMat);
  box('Door frame', [-W / 2 - 0.02, doorH, doorZ0 - 0.06], [-W / 2 + 0.02, doorH + 0.06, doorZ1 + 0.06], trimMat);
  // right wall with a window (1.5 x 1.5 m, sill at 0.85 m)
  const winZ0 = 1.4, winZ1 = 2.9, sill = 0.85, winTop = 2.35;
  box('Right wall', [W / 2, 0, 0], [W / 2 + T, H, winZ0], wallMat, true, false);
  box('Right wall', [W / 2, 0, winZ1], [W / 2 + T, H, D], wallMat, true, false);
  box('Right wall (below window)', [W / 2, 0, winZ0], [W / 2 + T, sill, winZ1], wallMat, true, false);
  box('Right wall (above window)', [W / 2, winTop, winZ0], [W / 2 + T, H, winZ1], wallMat, true, false);
  box('Window sill', [W / 2 - 0.06, sill - 0.03, winZ0 - 0.05], [W / 2 + 0.02, sill, winZ1 + 0.05], trimMat);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(winZ1 - winZ0, winTop - sill), new THREE.MeshPhysicalMaterial({ color: '#cfe8ff', transparent: true, opacity: 0.25, roughness: 0.05, side: THREE.DoubleSide }));
  glass.rotation.y = Math.PI / 2;
  glass.position.set(W / 2 + T / 2, (sill + winTop) / 2, (winZ0 + winZ1) / 2);
  g.add(glass);
  // baseboards
  const bb = 0.08, bt = 0.015;
  box('Baseboard', [-W / 2, 0, 0], [W / 2, bb, bt], trimMat, true, false);
  box('Baseboard', [-W / 2, 0, 0], [-W / 2 + bt, bb, doorZ0 - 0.06], trimMat, true, false);
  box('Baseboard', [-W / 2, 0, doorZ1 + 0.06], [-W / 2 + bt, bb, D], trimMat, true, false);
  box('Baseboard', [W / 2 - bt, 0, 0], [W / 2, bb, D], trimMat, true, false);
  // ceiling (rendered from inside only)
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, H, D / 2);
  ceil.name = 'Ceiling';
  g.add(ceil);
  solids.push({ name: 'Ceiling', box: new THREE.Box3(new THREE.Vector3(-W / 2, H, 0), new THREE.Vector3(W / 2, H + 0.1, D)) });
  // light switch and socket for scale
  box('Light switch', [-0.9, 1.05, 0], [-0.82, 1.13, 0.012], trimMat, false);
  box('Socket', [1.2, 0.3, 0], [1.28, 0.38, 0.012], trimMat, false);
  g.userData.dims = { W, D, H };
  return { group: g, solids, dims: { W, D, H } };
}

/** Stylised 1.8 m mannequin standing on y = 0, facing +Z. */
export function buildPerson(height = 1.8) {
  const g = new THREE.Group();
  g.name = 'Person';
  const mat = new THREE.MeshStandardMaterial({ color: '#7d8fa6', roughness: 0.6 });
  const k = height / 1.8;
  const part = (geo, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x * k, y * k, z * k); m.castShadow = true; g.add(m); return m; };
  part(new THREE.SphereGeometry(0.11 * k, 20, 16), 0, 1.68, 0);
  part(new THREE.CapsuleGeometry(0.17 * k, 0.42 * k, 4, 12), 0, 1.25, 0).scale.set(1, 1, 0.65);
  part(new THREE.CapsuleGeometry(0.065 * k, 0.72 * k, 4, 10), -0.1, 0.46, 0);
  part(new THREE.CapsuleGeometry(0.065 * k, 0.72 * k, 4, 10), 0.1, 0.46, 0);
  const armL = part(new THREE.CapsuleGeometry(0.045 * k, 0.6 * k, 4, 10), -0.24, 1.2, 0);
  const armR = part(new THREE.CapsuleGeometry(0.045 * k, 0.6 * k, 4, 10), 0.24, 1.2, 0);
  armL.rotation.z = -0.08; armR.rotation.z = 0.08;
  g.userData.size = [0.5 * k, height, 0.3 * k];
  return g;
}

/** Translucent multi-box stand-in for a base-game item from the reference library. */
export function buildReferenceProxy(ref, color = '#c89b5a') {
  const g = new THREE.Group();
  g.name = ref.name;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, transparent: true, opacity: 0.85 });
  const edge = new THREE.LineBasicMaterial({ color: '#3b2a14', transparent: true, opacity: 0.6 });
  const boxes = ref.boxes?.length ? ref.boxes : [{ min: ref.min, max: ref.max }];
  for (const b of boxes) {
    const s = b.max.map((v, i) => Math.max(v - b.min[i], 0.004));
    const geo = new THREE.BoxGeometry(...s);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...b.min.map((v, i) => v + s[i] / 2));
    m.castShadow = true; m.receiveShadow = true;
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge);
    l.position.copy(m.position);
    g.add(m, l);
  }
  g.userData.reference = ref;
  return g;
}
