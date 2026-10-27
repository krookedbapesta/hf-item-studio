// Headless stand-in for src/three/viewport.js (no WebGL in jsdom). Only methods that exist
// on the real Viewport may be added here; ui.test.mjs checks that.
import * as THREE from 'three';
import { ROOM_DEFAULTS } from '../../src/three/room.js';

export class Viewport {
  constructor(container, cbs = {}) {
    this.container = container;
    this.cbs = cbs;
    this.showColliders = true; this.showDims = true; this.xray = false;
    this.roomOpts = { ...ROOM_DEFAULTS };
    this.roomPos = new THREE.Vector3(0, 0, 1.6);
    this.lastCollisions = [];
    this.camera = new THREE.PerspectiveCamera();
    this.controls = { target: new THREE.Vector3() };
    this.selected = -1;
    this.calls = [];
    Viewport.last = this;
  }
  log(n, ...a) { this.calls.push([n, ...a]); }
  setItem(model, colliders, placement) { this.log('setItem'); this.model = model; this.colliders = colliders; this.placement = placement; }
  setColliders(c) { this.log('setColliders'); this.colliders = c; }
  setPlacement(p) { this.placement = p; }
  setMode(m) { this.log('setMode', m); this.mode = m; if (m === 'room') this.cbs.onRoomMove?.([], this.roomPos); }
  frame() {}
  view() {}
  setVisibility(v) { Object.assign(this, v.colliders !== undefined ? { showColliders: v.colliders } : {}, v.dims !== undefined ? { showDims: v.dims } : {}, v.xray !== undefined ? { xray: v.xray } : {}); }
  setGizmoMode(m) { this.gizmoMode = m; }
  rebuildColliders() {}
  setRoomOptions(o) { this.roomOpts = { ...this.roomOpts, ...o }; }
  setRoomExtras(e) { this.log('setRoomExtras', e); }
  rotateInRoom() {}
  setCompareItems(l) { this.log('setCompareItems', l.length); }
  setCompareLayout(l) { this.compareLayout = l; }
  layoutCompare() {}
  resize() {}
  dispose() {}
}
