// Minimal three.js viewer for the mapping editor. Renders flat per-triangle
// colors, supports orbit, recoloring (input vs output view), highlighting the
// triangles of one input color, and switching between the project's Assembly /
// Plate / Object preview views (see setProject/setViewMode).
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { IDENTITY_TRANSFORM, composeTransform, applyTransform } from './convert.js';

const DIM = 0.12; // brightness of non-highlighted triangles when highlighting

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0f1115');

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    // 3MF is Z-up. OrbitControls fixes its orbit axis from camera.up at
    // construction, so this MUST be set before `new OrbitControls`, otherwise
    // the controls orbit around Y while the camera renders Z-up → wobble.
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true; // right-drag pans in the view plane
    // Default mouse map is already CAD-like: LEFT=rotate, RIGHT=pan, wheel=zoom.

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(1, 1.3, 1.6);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-1, -0.5, -1);
    this.scene.add(dir2);

    this.mesh = null;
    this.tris = [];
    this.view = null;
    this.mode = { type: 'all' };
    this.provider = (t) => t.hex;
    this.highlightHex = null;

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas.parentElement || canvas);
    this._resize();

    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  _resize() {
    const el = this.canvas.parentElement || this.canvas;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // `view` is the `view` field of a parsed project (parseAnyProject): { parts,
  // objects, plates, hasAssembly, buildTransform, assembleTransform }.
  setProject(view, mode) {
    this.view = view;
    this.setViewMode(mode);
  }

  // mode: { type: 'assembly' } | { type: 'plate', id } | { type: 'object', id } | { type: 'all' }
  setViewMode(mode) {
    this.mode = mode;
    this._rebuild();
  }

  // Which parts are visible for the current mode, and the world transform to
  // apply to each (composed with the part's own local/component transform).
  _partsForMode() {
    const view = this.view;
    if (!view) return [];
    const { type, id } = this.mode;
    if (type === 'plate') {
      const plate = view.plates.find((p) => p.id === id);
      const ids = new Set(plate ? plate.objectIds : []);
      return view.parts.filter((p) => ids.has(p.objId)).map((p) => ({ part: p, world: view.buildTransform[p.objId] || IDENTITY_TRANSFORM }));
    }
    if (type === 'assembly') {
      return view.parts.map((p) => ({ part: p, world: view.assembleTransform[p.objId] || IDENTITY_TRANSFORM }));
    }
    if (type === 'object') {
      return view.parts.filter((p) => p.objId === id).map((p) => ({ part: p, world: IDENTITY_TRANSFORM }));
    }
    return view.parts.map((p) => ({ part: p, world: IDENTITY_TRANSFORM })); // 'all'
  }

  _rebuild() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    const placed = this._partsForMode();
    const tris = [];
    let n = 0;
    for (const { part } of placed) n += part.tris.length;
    const pos = new Float32Array(n * 9);
    this.colors = new Float32Array(n * 9);

    let i = 0;
    for (const { part, world } of placed) {
      const m = composeTransform(part.localTransform, world);
      const wv = part.verts.map((v) => applyTransform(v, m));
      for (const t of part.tris) {
        const a = wv[t.v1], b = wv[t.v2], c = wv[t.v3];
        pos.set([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]], i * 9);
        tris.push(t);
        i++;
      }
    }
    this.tris = tris;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.0, roughness: 0.7 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    this._fit(geo);
    this.updateColors();
  }

  _fit(geo) {
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 180 / 2);

    this.controls.target.copy(center);
    this.camera.position.set(center.x + dist * 0.8, center.y - dist * 0.9, center.z + dist * 0.9);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setProvider(fn) { this.provider = fn; this.updateColors(); }
  setHighlight(hex) { this.highlightHex = hex; this.updateColors(); }

  updateColors() {
    if (!this.mesh) return;
    const c = new THREE.Color();
    const hl = this.highlightHex;
    for (let i = 0; i < this.tris.length; i++) {
      const t = this.tris[i];
      c.set(this.provider(t, i) || '#808080');
      let r = c.r, g = c.g, b = c.b;
      if (hl && t.hex !== hl) { r *= DIM; g *= DIM; b *= DIM; }
      const o = i * 9;
      for (let k = 0; k < 9; k += 3) { this.colors[o + k] = r; this.colors[o + k + 1] = g; this.colors[o + k + 2] = b; }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
