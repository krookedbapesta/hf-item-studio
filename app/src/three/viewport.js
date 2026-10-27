// Interactive 3D viewport: model / collision / room / compare views.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { colliderMesh, colliderColorFor, colliderBounds, modelBounds } from './hfscene.js';
import { buildRoom, buildPerson, buildReferenceProxy, ROOM_DEFAULTS } from './room.js';
import { PLACEMENT } from '../core/constants.js';

const fmt = (m) => (m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(1)} cm`);

export class Viewport {
  constructor(container, { onSelectCollider, onColliderEdited, onRoomMove } = {}) {
    this.container = container;
    this.onSelectCollider = onSelectCollider;
    this.onColliderEdited = onColliderEdited;
    this.onRoomMove = onRoomMove;
    this.mode = 'model';
    this.colliders = [];
    this.selected = -1;
    this.colliding = new Set();
    this.showColliders = true;
    this.showModel = true;
    this.showDims = true;
    this.xray = false;
    this.roomOpts = { ...ROOM_DEFAULTS };
    this.roomPos = new THREE.Vector3(0, 0, 1.6);
    this.roomRotY = 0;
    this.refs = [];

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'vp-labels';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTex;
    this.setBackground('#20242b');

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
    this.camera.position.set(1.6, 1.3, 2.2);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x5a5048, 0.5);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(2.5, 5, 4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -4; this.sun.shadow.camera.right = 4;
    this.sun.shadow.camera.top = 4; this.sun.shadow.camera.bottom = -4;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(hemi, this.sun);

    // item space: Unity coordinates shown through a mirror on X
    this.world = new THREE.Group();
    this.world.scale.set(-1, 1, 1);
    this.scene.add(this.world);
    this.itemRoot = new THREE.Group();
    this.modelHolder = new THREE.Group();
    this.colliderHolder = new THREE.Group();
    this.pivotMarker = this.makePivotMarker();
    this.itemRoot.add(this.modelHolder, this.colliderHolder, this.pivotMarker);
    this.world.add(this.itemRoot);
    this.helpers = new THREE.Group();
    this.world.add(this.helpers);
    this.grid = new THREE.GridHelper(10, 100, 0x4a5260, 0x2d323b);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.6;
    this.scene.add(this.grid);
    this.shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.25 }));
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.shadowCatcher);
    this.roomGroup = new THREE.Group();
    this.world.add(this.roomGroup);
    this.compareGroup = new THREE.Group();
    this.world.add(this.compareGroup);
    this.dimGroup = new THREE.Group();
    this.world.add(this.dimGroup);

    this.gizmo = new TransformControls(this.camera, r.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value) this.commitGizmo();
    });
    this.gizmo.addEventListener('objectChange', () => this.previewGizmo());
    this.scene.add(this.gizmo.getHelper());

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    r.domElement.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    r.domElement.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', () => { this.dragging = false; });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      r.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
  }

  setBackground(color) {
    this.scene.background = new THREE.Color(color);
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  makePivotMarker() {
    const g = new THREE.Group();
    const s = 0.06;
    const mk = (dir, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(s)]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    };
    g.add(mk(new THREE.Vector3(1, 0, 0), 0xff5a5a), mk(new THREE.Vector3(0, 1, 0), 0x6adf6a), mk(new THREE.Vector3(0, 0, 1), 0x5aa0ff));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    g.add(dot);
    g.renderOrder = 20;
    return g;
  }

  // ---------- content ----------

  setItem(model, colliders, placement = PLACEMENT.Floor) {
    this.modelHolder.clear();
    this.model = model;
    this.placement = placement;
    if (model) {
      model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.modelHolder.add(model);
    }
    this.setColliders(colliders || []);
    this.updateGhost();
    this.applyMode();
  }

  setPlacement(p) {
    this.placement = p;
    this.applyMode();
  }

  setColliders(colliders, selected = this.selected) {
    this.colliders = colliders;
    this.selected = selected < colliders.length ? selected : -1;
    this.rebuildColliders();
    this.updateDims();
    if (this.mode === 'room') this.checkRoomCollisions();
  }

  rebuildColliders() {
    this.gizmo.detach();
    this.colliderHolder.clear();
    this.colliderObjs = this.colliders.map((c, i) => {
      const o = colliderMesh(c, colliderColorFor(c, i === this.selected, this.colliding.has(i)));
      o.userData.index = i;
      this.colliderHolder.add(o);
      return o;
    });
    this.colliderHolder.visible = this.showColliders;
    const sel = this.colliderObjs[this.selected];
    if (sel && this.mode === 'collision' && !this.colliders[this.selected].matrix) {
      this.gizmo.attach(sel);
      this.gizmo.setMode(this.gizmoMode || 'translate');
      this.gizmoStart = { center: [...this.colliders[this.selected].center], size: this.colliders[this.selected].size ? [...this.colliders[this.selected].size] : null };
    }
  }

  setGizmoMode(m) {
    this.gizmoMode = m;
    this.gizmo.setMode(m);
  }

  previewGizmo() {
    // live feedback while dragging: keep the dimension labels following the box
    if (this.gizmo.object) this.updateDims();
  }

  commitGizmo() {
    const o = this.gizmo.object;
    if (!o || this.selected < 0) return;
    const c = { ...this.colliders[this.selected] };
    c.center = [o.position.x, o.position.y, o.position.z];
    if (c.type === 'box') c.size = c.size.map((v, i) => Math.max(0.001, Math.abs(v * o.scale.getComponent(i))));
    else if (c.type === 'sphere') c.radius = c.radius * Math.max(o.scale.x, o.scale.y, o.scale.z);
    else if (c.type === 'capsule') { c.radius *= Math.max(o.scale.x, o.scale.z); c.height *= o.scale.y; }
    this.onColliderEdited && this.onColliderEdited(this.selected, c);
  }

  setVisibility({ colliders, model, dims, xray } = {}) {
    if (colliders !== undefined) { this.showColliders = colliders; this.colliderHolder.visible = colliders; }
    if (model !== undefined) { this.showModel = model; this.modelHolder.visible = model; }
    if (dims !== undefined) { this.showDims = dims; this.updateDims(); }
    if (xray !== undefined) { this.xray = xray; this.updateGhost(); }
  }

  /**
   * X-ray shows a see-through copy instead of touching the item's own materials, which are
   * what gets exported.
   */
  updateGhost() {
    if (this.ghost) { this.itemRoot.remove(this.ghost); this.ghost = null; }
    this.modelHolder.visible = this.showModel && !this.xray;
    if (!this.xray || !this.model) return;
    const cache = new Map();
    const ghostOf = (m) => {
      if (!cache.has(m)) cache.set(m, new THREE.MeshStandardMaterial({ color: m.color, map: m.map, transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.8 }));
      return cache.get(m);
    };
    this.ghost = this.model.clone(true);
    this.ghost.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(ghostOf) : ghostOf(o.material);
      o.castShadow = false;
    });
    this.itemRoot.add(this.ghost);
  }

  // ---------- modes ----------

  setMode(mode) {
    this.mode = mode;
    this.applyMode();
    this.frame();
  }

  applyMode() {
    const m = this.mode;
    this.gizmo.detach();
    this.roomGroup.visible = m === 'room';
    this.compareGroup.visible = m === 'compare';
    this.grid.visible = m !== 'room';
    this.shadowCatcher.visible = m !== 'room';
    this.pivotMarker.visible = m === 'model' || m === 'collision';
    this.colliderHolder.visible = this.showColliders && m !== 'compare';
    this.setBackground(m === 'room' ? '#1b1d21' : '#20242b');
    this.itemRoot.position.set(0, 0, 0);
    this.itemRoot.rotation.set(0, 0, 0);
    if (m === 'room') this.layoutRoom();
    else if (m === 'compare') this.layoutCompare();
    else this.colliding.clear();
    if (m === 'model' || m === 'collision') {
      // show the mounting surface for wall and ceiling items
      this.helpers.clear();
      if (this.placement === PLACEMENT.Wall) {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ color: '#59606b', transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
        wall.position.set(0, 0, 0);
        this.helpers.add(wall);
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(3, 3)), new THREE.LineBasicMaterial({ color: 0x8a93a0 }));
        this.helpers.add(edge);
      } else if (this.placement === PLACEMENT.Ceiling) {
        const c = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ color: '#59606b', transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
        c.rotation.x = Math.PI / 2;
        this.helpers.add(c);
      }
    } else this.helpers.clear();
    this.rebuildColliders();
    this.updateDims();
  }

  // ---------- dimensions ----------

  updateDims() {
    for (const ch of [...this.dimGroup.children]) { ch.traverse((o) => o.element?.remove()); }
    this.dimGroup.clear();
    if (!this.showDims || !this.model || this.mode === 'room') return;
    if (this.mode === 'compare') return; // compare draws its own labels
    const b = modelBounds(this.model);
    if (b.isEmpty()) return;
    this.addDimensionBox(b, this.dimGroup, this.itemRoot.position);
  }

  addDimensionBox(b, group, offset = new THREE.Vector3()) {
    const s = b.getSize(new THREE.Vector3());
    const mn = b.min.clone().add(offset), mx = b.max.clone().add(offset);
    const pad = Math.max(s.x, s.y, s.z) * 0.06 + 0.02;
    const line = (a, c, label) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, c]);
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }));
      l.renderOrder = 30;
      group.add(l);
      const div = document.createElement('div');
      div.className = 'dim-label';
      div.textContent = label;
      const o = new CSS2DObject(div);
      o.position.copy(a).add(c).multiplyScalar(0.5);
      group.add(o);
    };
    line(new THREE.Vector3(mn.x, mn.y, mx.z + pad), new THREE.Vector3(mx.x, mn.y, mx.z + pad), `W ${fmt(s.x)}`);
    line(new THREE.Vector3(mx.x + pad, mn.y, mx.z + pad), new THREE.Vector3(mx.x + pad, mx.y, mx.z + pad), `H ${fmt(s.y)}`);
    line(new THREE.Vector3(mx.x + pad, mn.y, mn.z), new THREE.Vector3(mx.x + pad, mn.y, mx.z), `D ${fmt(s.z)}`);
  }

  // ---------- room ----------

  setRoomOptions(opts) {
    this.roomOpts = { ...this.roomOpts, ...opts };
    if (this.mode === 'room') this.layoutRoom();
  }

  setRoomExtras({ person, refs } = {}) {
    if (person !== undefined) this.roomPerson = person;
    if (refs !== undefined) this.roomRefs = refs;
    if (this.mode === 'room') this.layoutRoom();
  }

  layoutRoom() {
    this.roomGroup.clear();
    const { group, solids, dims } = buildRoom(this.roomOpts);
    this.room = { solids, dims };
    this.roomGroup.add(group);
    this.roomProps = [];
    if (this.roomPerson !== false) {
      const p = buildPerson();
      p.position.set(dims.W / 2 - 0.7, 0, dims.D - 0.9);
      p.rotation.y = Math.PI;
      this.roomGroup.add(p);
    }
    let x = -dims.W / 2 + 0.5;
    for (const ref of this.roomRefs || []) {
      const proxy = ref.object ? ref.object.clone() : buildReferenceProxy(ref);
      const size = ref.size || [0.5, 0.5, 0.5];
      const hanging = (ref.tags || []).some((t) => /hanging/i.test(t)) || ref.placement === PLACEMENT.Wall;
      const px = x + size[0] / 2;
      if (hanging) proxy.position.set(px, 1.5, 0);
      else proxy.position.set(px, 0, 0.6 + (ref.min ? -ref.min[2] : 0));
      x += size[0] + 0.3;
      this.roomGroup.add(proxy);
      this.roomProps.push({ name: ref.name, box: this.itemSpaceBox(proxy) });
    }
    this.clampRoomPos();
    this.placeInRoom();
  }

  itemSpaceBox(obj) {
    this.world.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.world.matrixWorld).invert();
    const b = new THREE.Box3();
    obj.updateMatrixWorld(true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      b.union(o.geometry.boundingBox.clone().applyMatrix4(m));
    });
    return b;
  }

  clampRoomPos() {
    if (!this.room) return;
    const { W, D, H } = this.room.dims;
    const p = this.roomPos;
    if (this.placement === PLACEMENT.Wall) {
      p.z = 0;
      if (p.y <= 0 || p.y > H) p.y = 1.45;
    } else if (this.placement === PLACEMENT.Ceiling) {
      p.y = H;
      if (p.z <= 0) p.z = D / 2;
    } else {
      p.y = 0;
      if (p.z <= 0) p.z = 1.6;
    }
    p.x = Math.max(-W / 2, Math.min(W / 2, p.x));
    p.z = Math.max(0, Math.min(D, p.z));
  }

  placeInRoom() {
    this.itemRoot.position.copy(this.roomPos);
    this.itemRoot.rotation.set(0, this.placement === PLACEMENT.Wall ? 0 : this.roomRotY, 0);
    this.checkRoomCollisions();
  }

  rotateInRoom(deg) {
    this.roomRotY += THREE.MathUtils.degToRad(deg);
    this.placeInRoom();
  }

  /** Test each collider against room solids the way the game's placement check would. */
  checkRoomCollisions() {
    if (this.mode !== 'room' || !this.room) { this.lastCollisions = []; return []; }
    this.itemRoot.updateMatrix();
    const m = this.itemRoot.matrix;
    const hits = [];
    this.colliding = new Set();
    // Resting on the floor is fine for floor items. Flush contact with the wall or ceiling a
    // wall/ceiling item is mounted on is what makes the game refuse it, so that counts.
    const touchCounts = (name) => (this.placement === PLACEMENT.Wall && name === 'Back wall') || (this.placement === PLACEMENT.Ceiling && name === 'Ceiling');
    const TOUCH = 0.001;
    this.colliders.forEach((c, i) => {
      const b = colliderBounds(c).applyMatrix4(m);
      for (const s of [...this.room.solids, ...(this.roomProps || [])]) {
        const grown = touchCounts(s.name) ? s.box.clone().expandByScalar(TOUCH) : s.box;
        if (!b.intersectsBox(grown)) continue;
        const ov = b.clone().intersect(s.box).getSize(new THREE.Vector3());
        const depth = Math.min(ov.x, ov.y, ov.z);
        if (depth > 1e-5) {
          this.colliding.add(i);
          hits.push({ collider: i, with: s.name, depth, kind: 'overlap' });
        } else if (touchCounts(s.name)) {
          this.colliding.add(i);
          hits.push({ collider: i, with: s.name, depth: 0, kind: 'touch' });
        }
      }
    });
    // recolour without rebuilding gizmo state
    this.colliderObjs?.forEach((o, i) => {
      const state = colliderColorFor(this.colliders[i], i === this.selected, this.colliding.has(i));
      const col = { normal: 0x35d07f, top: 0x4aa8ff, selected: 0xffc23d, bad: 0xff4d5e }[state];
      o.traverse((x) => { if (x.material?.color) x.material.color.setHex(col); });
    });
    this.lastCollisions = hits;
    this.onRoomMove && this.onRoomMove(hits, this.roomPos.clone());
    return hits;
  }

  // ---------- compare ----------

  setCompareItems(list) {
    this.compareList = list;
    if (this.mode === 'compare') this.layoutCompare();
  }

  setCompareLayout(layout) {
    this.compareLayout = layout;
    if (this.mode === 'compare') this.layoutCompare();
  }

  layoutCompare() {
    for (const ch of [...this.compareGroup.children]) ch.traverse((o) => o.element?.remove());
    this.compareGroup.clear();
    const list = this.compareList || [];
    const overlay = this.compareLayout === 'overlay';
    const palette = ['#c89b5a', '#6aa5d8', '#9b7bd0', '#5fb98a', '#d07b7b', '#c9c35a', '#5ac9c1'];
    const entries = [];
    if (this.compareWithPerson !== false) entries.push({ obj: buildPerson(), name: 'Person 1.80 m', size: [0.5, 1.8, 0.3], min: [-0.25, 0, -0.15], person: true });
    const mine = modelBounds(this.model || new THREE.Group());
    entries.push({ mine: true, name: 'Your item', min: mine.min.toArray(), size: mine.getSize(new THREE.Vector3()).toArray() });
    list.forEach((ref, i) => {
      const obj = ref.object ? ref.object.clone() : buildReferenceProxy(ref, palette[i % palette.length]);
      if (overlay && ref.object == null) obj.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.opacity = 0.35; } });
      entries.push({ obj, name: ref.name, size: ref.size, min: ref.min, ref });
    });
    let x = 0;
    const gap = 0.25;
    for (const e of entries) {
      const w = e.size[0];
      const cx = overlay && !e.person ? 0 : x + w / 2 - (e.min[0] + w / 2);
      const pos = new THREE.Vector3(overlay && !e.person ? 0 : x - e.min[0], 0, 0);
      if (overlay && !e.person) pos.set(0, 0, 0);
      if (e.mine) this.itemRoot.position.copy(pos);
      else {
        e.obj.position.copy(pos);
        this.compareGroup.add(e.obj);
      }
      const box = new THREE.Box3(new THREE.Vector3(...e.min), new THREE.Vector3(...e.min.map((v, i) => v + e.size[i])));
      if (this.showDims && !e.person && !overlay) this.addDimensionBox(box, this.compareGroup, pos);
      const div = document.createElement('div');
      div.className = 'cmp-label' + (e.mine ? ' mine' : '');
      div.textContent = e.name;
      const lab = new CSS2DObject(div);
      lab.position.set(pos.x + e.min[0] + w / 2, e.min[1] + e.size[1] + 0.06, pos.z + e.min[2] + e.size[2] / 2);
      if (!overlay || e.mine || e.person) this.compareGroup.add(lab);
      if (!overlay || e.person) x += w + gap;
      void cx;
    }
    this.compareExtent = Math.max(x, 1);
  }

  // ---------- picking ----------

  ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  onPointerDown(e) {
    if (e.button !== 0 || this.gizmo.dragging) return;
    this.ndc(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.mode === 'collision' && this.showColliders) {
      const hits = this.raycaster.intersectObjects(this.colliderObjs || [], true);
      if (hits.length) {
        let o = hits[0].object;
        while (o && o.userData.index === undefined) o = o.parent;
        if (o) { this.selected = o.userData.index; this.rebuildColliders(); this.onSelectCollider && this.onSelectCollider(this.selected); }
        return;
      }
    }
    if (this.mode === 'room' && e.shiftKey === false && this.room) {
      // start dragging the item if it was clicked
      const hits = this.raycaster.intersectObject(this.itemRoot, true);
      if (hits.length) { this.dragging = true; this.controls.enabled = false; const stop = () => { this.controls.enabled = true; window.removeEventListener('pointerup', stop); }; window.addEventListener('pointerup', stop); }
    }
  }

  onPointerMove(e) {
    if (!this.dragging || this.mode !== 'room' || !this.room) return;
    this.ndc(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // intersect the mounting plane in scene space, then convert to item space
    let plane;
    if (this.placement === PLACEMENT.Wall) plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    else if (this.placement === PLACEMENT.Ceiling) plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), this.room.dims.H);
    else plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return;
    hit.x = -hit.x; // undo the display mirror
    const snap = (v) => Math.round(v * 100) / 100;
    if (this.placement === PLACEMENT.Wall) { this.roomPos.x = snap(hit.x); this.roomPos.y = snap(hit.y); }
    else { this.roomPos.x = snap(hit.x); this.roomPos.z = snap(hit.z); }
    this.clampRoomPos();
    this.placeInRoom();
  }

  // ---------- camera ----------

  frame() {
    let box;
    if (this.mode === 'room' && this.room) {
      const { W, D, H } = this.room.dims;
      this.camera.position.set(-W * 0.1, H * 0.62, D * 1.05);
      this.controls.target.set(-this.roomPos.x * 0.6, Math.min(H * 0.45, Math.max(0.6, this.roomPos.y || 0.9)), D * 0.25);
      this.camera.near = 0.02; this.camera.updateProjectionMatrix();
      return;
    }
    if (this.mode === 'compare') {
      const e = this.compareExtent || 2;
      const h = 2;
      box = new THREE.Box3(new THREE.Vector3(-e, 0, -0.5), new THREE.Vector3(0.5, h, 0.5));
    } else {
      box = this.model ? modelBounds(this.model) : new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
      if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
      box.min.x = -box.min.x; box.max.x = -box.max.x;
      const t = box.min.x; box.min.x = Math.min(t, box.max.x); box.max.x = Math.max(t, box.max.x);
    }
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z, 0.1);
    const dist = r / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.45;
    const dir = this.placement === PLACEMENT.Ceiling ? new THREE.Vector3(0.55, -0.35, 1) : new THREE.Vector3(-0.6, 0.45, 1);
    if (this.mode === 'compare') dir.set(0, 0.25, 1);
    dir.normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist + r * 0.5);
    this.camera.near = Math.max(0.001, r / 500);
    this.camera.far = r * 100 + 50;
    this.camera.updateProjectionMatrix();
  }

  view(name) {
    const t = this.controls.target.clone();
    const d = this.camera.position.distanceTo(t);
    const dirs = { front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0.0001], three: [-0.6, 0.45, 1] };
    const v = new THREE.Vector3(...(dirs[name] || dirs.three)).normalize();
    this.camera.position.copy(t).addScaledVector(v, d);
  }

  screenshot() {
    return this.renderer.domElement.toDataURL('image/png');
  }
}
