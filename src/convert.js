// Convert an OpenSCAD-style colored 3MF (basematerials or m:colorgroup, with
// per-triangle pid/p1 color indices) into a Snapmaker-OrcaSlicer ("snorca")
// project that stores color as Bambu/Orca `paint_color` triangle attributes.
//
// Pure, DOM-free logic so it runs identically in the browser and under Node
// (CLI + tests). Zip I/O lives in ./zip.js.
//
// Pipeline, split so the interactive editor (phase 2) can reuse each stage:
//   parseProject()      → geometry + input/defined colors (no mapping committed)
//   planConversion()    → default "first-4-painted" mapping (CLI / non-interactive)
//   defaultSwatches()   → initial output-slot colors for the matrix UI
//   mappingForSwatches()→ input→slot mapping given chosen swatches
//   buildProjectBytes() → serialize a snorca .3mf from geometry + mapping + swatches
//   convert3mf()        → convenience: parse → plan → build (used by CLI/tests)

import { unzip, zipDeflate } from './zip.js';
import { decodePaintSlot } from './paint.js';

// --- Reverse-engineered from colored-cube.3mf (a real snorca export) --------
// A triangle painted with filament slot N carries paint_color="<code>".
// Slot 1 is the base filament and carries NO attribute. (See CLAUDE.md.)
export const PAINT_CODES = { 1: null, 2: '8', 3: '0C', 4: '1C' };
export const MAX_SLOTS = 4;

// Plate center used to position the object on the bed (from the reference export).
export const BED_CENTER = [135.5, 136];
export const DEFAULT_SUFFIX = '-HdM';

const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
const NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const PAD_COLOR = '#CCCCCC'; // filament_colour value for unused ("X") slots

// --- small helpers ----------------------------------------------------------
export function normHex(h) {
  if (!h) return '#808080';
  h = h.replace('#', '');
  if (h.length >= 6) h = h.slice(0, 6);
  else h = h.padEnd(6, '0');
  return '#' + h.toUpperCase();
}
export function rgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function dist(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
function attr(s, name) {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function uuid() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : '00000000-0000-4000-8000-000000000000';
}

// --- transform math, for the 3D preview's Assembly / Plate / Object views --
// A 3MF transform string is 12 numbers, row-major: 3 linear rows (indices
// 0-8) then 1 translation row (indices 9-11). Point transform: p' = p·L + T.
export const IDENTITY_TRANSFORM = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function parseTransform(str) {
  const n = (str || '').trim().split(/\s+/).map(Number);
  return (n.length === 12 && n.every(Number.isFinite)) ? n : IDENTITY_TRANSFORM;
}

// Combine two transforms so that applying the result equals applying `a` then `b`.
export function composeTransform(a, b) {
  const la = a.slice(0, 9), ta = a.slice(9, 12);
  const lb = b.slice(0, 9), tb = b.slice(9, 12);
  const l = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += la[i * 3 + k] * lb[k * 3 + j];
    l.push(s);
  }
  const t = [0, 1, 2].map((j) => ta[0] * lb[j] + ta[1] * lb[3 + j] + ta[2] * lb[6 + j] + tb[j]);
  return [...l, ...t];
}

export function applyTransform(p, m) {
  return [0, 1, 2].map((j) => p[0] * m[j] + p[1] * m[3 + j] + p[2] * m[6 + j] + m[9 + j]);
}

// --- 3MF model parsing (regex based; 3MF model XML is machine-regular) ------
export function parseModelXml(xml) {
  const groups = {};        // resourceId -> [hex, ...]
  const baseMaterials = []; // hex list from <basematerials> (true "materials")

  for (const bm of xml.matchAll(/<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g)) {
    const id = attr(bm[1], 'id');
    const colors = [];
    for (const b of bm[2].matchAll(/<base\b[^>]*\bdisplaycolor="(#[0-9A-Fa-f]+)"/g)) colors.push(b[1]);
    if (id) groups[id] = colors;
    baseMaterials.push(...colors);
  }
  for (const cg of xml.matchAll(/<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g)) {
    const id = attr(cg[1], 'id');
    const colors = [];
    for (const c of cg[2].matchAll(/<(?:\w+:)?color\b[^>]*\bcolor="(#[0-9A-Fa-f]+)"/g)) colors.push(c[1]);
    if (id) groups[id] = colors;
  }

  const objects = [];
  for (const om of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const a = om[1], body = om[2];
    const verts = [];
    const vblock = (body.match(/<vertices>([\s\S]*?)<\/vertices>/) || [])[1] || '';
    for (const v of vblock.matchAll(/<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g))
      verts.push([parseFloat(v[1]), parseFloat(v[2]), parseFloat(v[3])]);

    const tris = [];
    const tblock = (body.match(/<triangles>([\s\S]*?)<\/triangles>/) || [])[1] || '';
    for (const t of tblock.matchAll(/<triangle\b([^>]*?)\/?>/g)) {
      const ta = t[1];
      tris.push({
        v1: +attr(ta, 'v1'), v2: +attr(ta, 'v2'), v3: +attr(ta, 'v3'),
        pid: attr(ta, 'pid'), p1: attr(ta, 'p1'), paint: attr(ta, 'paint_color'),
      });
    }
    objects.push({
      id: attr(a, 'id'), pid: attr(a, 'pid'), pindex: attr(a, 'pindex'),
      name: attr(a, 'name') || '', verts, tris,
    });
  }
  return { groups, objects, baseMaterials };
}

function rootModelName(files) {
  if (files['3D/3dmodel.model']) return '3D/3dmodel.model';
  const rels = files['_rels/.rels'] && new TextDecoder().decode(files['_rels/.rels']);
  if (rels) {
    const m = rels.match(/Target="([^"]+\.model)"[^>]*3dmodel/i) || rels.match(/Target="([^"]+\.model)"/i);
    if (m) { const n = m[1].replace(/^\//, ''); if (files[n]) return n; }
  }
  const any = Object.keys(files).find((k) => k.endsWith('.model'));
  if (!any) throw new Error('No 3MF model part found in archive.');
  return any;
}

// Every model part (root .model + any production-extension component parts it
// references via p:path), so callers only walk the "find referenced files" logic once.
function listModelParts(files) {
  const rootName = rootModelName(files);
  const rootXml = new TextDecoder().decode(files[rootName]);
  const modelParts = [rootName];
  for (const m of rootXml.matchAll(/p:path="([^"]+)"/g)) {
    const path = m[1].replace(/^\//, '');
    if (files[path] && !modelParts.includes(path)) modelParts.push(path);
  }
  return { rootName, modelParts, rootXml };
}

// Gather all mesh-bearing objects, following production-extension components.
function collectGeometry(files) {
  const dec = new TextDecoder();
  const { modelParts, rootXml } = listModelParts(files);
  const textByName = { [modelParts[0]]: rootXml };

  const groups = {};
  const objects = [];
  const baseMaterials = [];
  const title = (rootXml.match(/<metadata name="Title"[^>]*>([\s\S]*?)<\/metadata>/) || [])[1] || 'model';
  for (const part of modelParts) {
    const xml = textByName[part] || (textByName[part] = dec.decode(files[part]));
    const { groups: g, objects: o, baseMaterials: bm } = parseModelXml(xml);
    Object.assign(groups, g);
    baseMaterials.push(...bm);
    for (const obj of o) if (obj.verts.length && obj.tris.length) objects.push(obj);
  }
  return { groups, objects, title, baseMaterials, modelParts, textByName };
}

// Every top-level "assembly" object's own <components><component objectid
// p:path transform=.../> list, keyed by the enclosing object's id → [{partId,
// localTransform}]. A mesh-bearing part can be referenced by MORE than one
// top-level object (Bambu Studio's "duplicate object" reuses the mesh
// resource rather than copying it), so this is object→components, not a
// single part→object lookup.
function parseComponentGraph(modelParts, textByName) {
  const componentsByObject = {};
  for (const name of modelParts) {
    const xml = textByName[name];
    for (const om of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const objId = attr(om[1], 'id');
      const comps = [];
      for (const c of om[2].matchAll(/<component\b([^>]*?)\/>/g)) {
        const partId = attr(c[1], 'objectid');
        if (partId) comps.push({ partId, localTransform: parseTransform(attr(c[1], 'transform')) });
      }
      if (comps.length) componentsByObject[objId] = comps;
    }
  }
  return componentsByObject;
}

// Metadata/model_settings.config: per-object `name` + `extruder` (base filament
// slot) metadata, and part-level `extruder` overrides *scoped to their enclosing
// object* (object ids and part ids are different id spaces, and — because of the
// "duplicate object" mesh reuse above — the same part id can appear inside
// several different objects with different overrides). value="0" means "unset"
// (falls through to the object-level value, ultimately slot 1).
function parseExtruderMetadata(msXml) {
  const objectExtruder = {}, objectName = {}, partExtruderByObject = {};
  for (const om of msXml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const objId = attr(om[1], 'id');
    const body = om[2];
    const headEnd = body.search(/<part\b/);
    const head = headEnd === -1 ? body : body.slice(0, headEnd);
    const oe = (head.match(/<metadata\s+key="extruder"\s+value="(\d+)"/) || [])[1];
    if (oe && +oe > 0) objectExtruder[objId] = +oe;
    const on = (head.match(/<metadata\s+key="name"\s+value="([^"]*)"/) || [])[1];
    if (on) objectName[objId] = on;
    const parts = {};
    for (const pm of body.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)) {
      const partId = attr(pm[1], 'id');
      const pe = (pm[2].match(/<metadata\s+key="extruder"\s+value="(\d+)"/) || [])[1];
      if (pe && +pe > 0) parts[partId] = +pe;
    }
    partExtruderByObject[objId] = parts;
  }
  return { objectExtruder, objectName, partExtruderByObject };
}

// Blank out a plate name that's just Bambu Studio's placeholder for "no name".
function cleanPlateName(name) {
  const n = (name || '').trim();
  return /^untitled$/i.test(n) ? '' : n;
}

// <assemble><assemble_item object_id transform/></assemble>: per-object world
// placement for the preview's Assembly view. First instance per object id.
function parseAssembleItems(msXml) {
  const out = {};
  for (const m of msXml.matchAll(/<assemble_item\b([^>]*?)\/>/g)) {
    const objId = attr(m[1], 'object_id');
    if (objId && !(objId in out)) out[objId] = parseTransform(attr(m[1], 'transform'));
  }
  return out;
}

// First <build><item objectid transform> per object id — an object may have
// several build-item instances, but the preview only ever shows one.
function firstBuildTransformByObject(items) {
  const out = {};
  for (const it of items) if (!(it.objectId in out)) out[it.objectId] = parseTransform(it.transform);
  return out;
}

// Merge all objects into one vertex/triangle list, resolving each triangle's
// source color to a normalized hex. Also keeps each source object's own
// (un-merged, un-offset) geometry as a `viewParts` entry, for the 3D preview's
// per-object views (OpenSCAD objects have no components/build-item
// indirection, so each is its own part at an identity transform).
function mergeGeometry(groups, objects) {
  const verts = [];
  const tris = []; // { v1, v2, v3, hex }
  const viewParts = [];
  for (const obj of objects) {
    const base = verts.length;
    for (const v of obj.verts) verts.push(v);
    const partTris = [];
    for (const t of obj.tris) {
      let g, idx;
      if (t.pid !== undefined && t.p1 !== undefined) { g = t.pid; idx = +t.p1; }
      else { g = obj.pid; idx = obj.pindex !== undefined ? +obj.pindex : 0; }
      const hex = normHex((groups[g] || [])[idx]);
      tris.push({ v1: t.v1 + base, v2: t.v2 + base, v3: t.v3 + base, hex });
      partTris.push({ v1: t.v1, v2: t.v2, v3: t.v3, hex });
    }
    viewParts.push({ objId: obj.id, localTransform: IDENTITY_TRANSFORM, verts: obj.verts, tris: partTris });
  }
  return { verts, tris, viewParts };
}

function uniq(list) {
  const out = [], seen = new Set();
  for (const c of list) { const h = normHex(c); if (!seen.has(h)) { seen.add(h); out.push(h); } }
  return out;
}

// The original package's thumbnail / cover relationships (so we can keep whatever
// image the source designated as its preview — not force the plate render).
function parseCoverRels(files) {
  const rels = files['_rels/.rels'] && new TextDecoder().decode(files['_rels/.rels']);
  if (!rels) return [];
  const out = [];
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const type = (m[0].match(/\bType="([^"]*)"/) || [])[1] || '';
    const target = (m[0].match(/\bTarget="([^"]*)"/) || [])[1] || '';
    if (/thumbnail|cover/i.test(type) && target) out.push({ type, target: target.replace(/^\//, '') });
  }
  return out;
}

// Preview thumbnails + auxiliary assets to carry through a conversion verbatim,
// so downloaded projects keep their previews (we regenerate geometry/configs).
function collectPreviewFiles(files) {
  const out = {};
  for (const name of Object.keys(files)) {
    if ((name.startsWith('Metadata/') && /\.png$/i.test(name)) || name.startsWith('Auxiliaries/')) out[name] = files[name];
  }
  // Also keep any file the original cover/thumbnail relationships point at.
  for (const r of parseCoverRels(files)) if (files[r.target]) out[r.target] = files[r.target];
  return out;
}

function distinctHexes(tris) {
  const out = [], seen = new Set();
  for (const t of tris) if (!seen.has(t.hex)) { seen.add(t.hex); out.push(t.hex); }
  return out;
}

// --- OpenSCAD-colored 3MF (basematerials / colorgroup + pid/p1) -------------
function buildOpenscad(files) {
  const { groups, objects, title, baseMaterials } = collectGeometry(files);
  if (!objects.length) throw new Error('No mesh geometry found in this 3MF.');
  const { verts, tris, viewParts } = mergeGeometry(groups, objects);
  const view = {
    parts: viewParts,
    objects: viewParts.map((p, i) => ({ id: p.objId, name: `Object ${i + 1}` })),
    plates: [], hasAssembly: false, buildTransform: {}, assembleTransform: {},
  };
  return { title, verts, tris, paintedColors: distinctHexes(tris), definedColors: uniq(baseMaterials), previewFiles: collectPreviewFiles(files), coverRels: parseCoverRels(files), view };
}

/**
 * Parse an OpenSCAD-colored 3MF into geometry + color info (no mapping committed).
 * @param {Uint8Array} inputBytes
 */
export async function parseProject(inputBytes) {
  return buildOpenscad(await unzip(inputBytes));
}

// --- Bambu/Orca project 3MF (paint_color + filament palette) ----------------

export function detectInputType(files) {
  if (files['Metadata/project_settings.config']) return 'bambu';
  const root = files['3D/3dmodel.model'] && new TextDecoder().decode(files['3D/3dmodel.model']);
  if (root && /paint_color=|<component\b/.test(root)) return 'bambu';
  return 'openscad';
}

function buildBambu(files) {
  const { objects, title, modelParts, textByName } = collectGeometry(files);
  if (!objects.length) throw new Error('No mesh geometry found in this 3MF.');

  const dec = new TextDecoder();
  const rawProjectSettings = files['Metadata/project_settings.config'] ? dec.decode(files['Metadata/project_settings.config']) : null;
  const rawSliceInfo = files['Metadata/slice_info.config'] ? dec.decode(files['Metadata/slice_info.config']) : null;
  const rawModelSettings = files['Metadata/model_settings.config'] ? dec.decode(files['Metadata/model_settings.config']) : '';

  let palette = [], hasSupport = false;
  if (rawProjectSettings) {
    try {
      const s = JSON.parse(rawProjectSettings);
      palette = (s.filament_colour || []).map(normHex);
      hasSupport = String(s.enable_support) === '1';
    } catch { /* ignore */ }
  }
  // Base filament for a mesh part: its own <part> override (scoped to whichever
  // top-level object it's being resolved through — see parseExtruderMetadata),
  // else that top-level object's own override, else slot 1.
  const componentsByObject = parseComponentGraph(modelParts, textByName);
  const { objectExtruder, objectName, partExtruderByObject } = parseExtruderMetadata(rawModelSettings);
  const baseSlotFor = (topId, partId) => (partExtruderByObject[topId] || {})[partId] || objectExtruder[topId] || 1;
  const paletteHex = (slot) => normHex(palette[(slot | 0) - 1]);

  const meshById = {};
  for (const obj of objects) meshById[obj.id] = obj;

  // Every top-level "assembly" object: one with its own <components> entry, or
  // (for simple single-object files with no component indirection, e.g.
  // colored-cube.3mf) a mesh-bearing object that's never itself referenced as
  // someone else's component.
  const referencedPartIds = new Set();
  for (const comps of Object.values(componentsByObject)) for (const c of comps) referencedPartIds.add(c.partId);
  const topIds = [
    ...Object.keys(componentsByObject),
    ...objects.map((o) => o.id).filter((id) => !referencedPartIds.has(id) && !componentsByObject[id]),
  ];

  const verts = [];
  const tris = [];
  const viewParts = [];
  const viewObjects = [];
  let complexPaintCount = 0;

  const emit = (meshObj, topId, partId, localTransform) => {
    const slot0 = baseSlotFor(topId, partId);
    const base = verts.length;
    for (const v of meshObj.verts) verts.push(v);
    const partTris = [];
    for (const t of meshObj.tris) {
      let slot = slot0;
      if (t.paint !== undefined) {
        const d = decodePaintSlot(t.paint);
        if (d.known) slot = d.slot; else complexPaintCount++; // flatten unknown → base
      }
      const hex = paletteHex(slot);
      tris.push({ v1: t.v1 + base, v2: t.v2 + base, v3: t.v3 + base, hex });
      partTris.push({ v1: t.v1, v2: t.v2, v3: t.v3, hex });
    }
    viewParts.push({ objId: topId, localTransform, verts: meshObj.verts, tris: partTris });
  };

  for (const topId of topIds) {
    viewObjects.push({ id: topId, name: objectName[topId] || `Object ${viewObjects.length + 1}` });
    const comps = componentsByObject[topId];
    if (comps) {
      for (const c of comps) { const meshObj = meshById[c.partId]; if (meshObj) emit(meshObj, topId, c.partId, c.localTransform); }
    } else {
      const meshObj = meshById[topId];
      if (meshObj) emit(meshObj, topId, topId, IDENTITY_TRANSFORM);
    }
  }

  const rootXml = textByName[modelParts[0]];
  const buildTransform = firstBuildTransformByObject(parseBuildItems(rootXml));
  const assembleTransform = parseAssembleItems(rawModelSettings);
  const plates = parsePlateGroups(rawModelSettings)
    .filter((p) => p.objectIds.length)
    .map((p) => ({ id: String(p.platerId), name: cleanPlateName(p.platerName), objectIds: p.objectIds }));
  const view = {
    parts: viewParts, objects: viewObjects, plates,
    hasAssembly: Object.keys(assembleTransform).length > 0,
    buildTransform, assembleTransform,
  };

  return {
    kind: 'bambu', title, verts, tris,
    paintedColors: distinctHexes(tris), definedColors: palette.slice(),
    rawProjectSettings, rawSliceInfo, hasSupport, complexPaintCount,
    previewFiles: collectPreviewFiles(files), coverRels: parseCoverRels(files),
    rawFiles: files, view,
  };
}

/** Parse a Bambu/Orca project 3MF (decoding paint_color to filament slots). */
export async function parseBambuProject(inputBytes) {
  return buildBambu(await unzip(inputBytes));
}

/** Detect the input type and parse into a common shape (single unzip). */
export async function parseAnyProject(inputBytes) {
  const files = await unzip(inputBytes);
  if (detectInputType(files) === 'bambu') return buildBambu(files);
  return { kind: 'openscad', ...buildOpenscad(files), rawProjectSettings: null, rawSliceInfo: null, hasSupport: false, complexPaintCount: 0 };
}

// --- mapping strategies -----------------------------------------------------
/**
 * Input→slot mapping given chosen output swatches (length-4, null = unused).
 * Preference: an existing prior slot (if that swatch still exists) → exact color
 * match → nearest non-null swatch by RGB.
 */
export function mappingForSwatches(paintedColors, swatches, prior = {}) {
  const slots = swatches.map((c, i) => ({ slot: i + 1, hex: c })).filter((s) => s.hex);
  const map = {};
  for (const hex of paintedColors) {
    if (prior[hex] && swatches[prior[hex] - 1]) { map[hex] = prior[hex]; continue; }
    const exact = slots.find((s) => s.hex === hex);
    if (exact) { map[hex] = exact.slot; continue; }
    if (!slots.length) { map[hex] = 1; continue; }
    let best = slots[0].slot, bd = Infinity;
    const c = rgb(hex);
    for (const s of slots) { const d = dist(c, rgb(s.hex)); if (d < bd) { bd = d; best = s.slot; } }
    map[hex] = best;
  }
  return map;
}

/**
 * Default output-slot swatches for the matrix UI: prefer defined materials,
 * supplement with painted colors, pad unused slots with null ("X").
 */
export function defaultSwatches(definedColors, paintedColors) {
  const out = [];
  const push = (c) => { if (out.length < MAX_SLOTS && c && !out.includes(c)) out.push(c); };
  for (const c of definedColors) push(c);
  for (const c of paintedColors) push(c);
  while (out.length < MAX_SLOTS) out.push(null);
  return out;
}

/**
 * Non-interactive default (CLI/phase-1): first four painted colors become the
 * slots; extras snap to the nearest by RGB.
 */
export function planConversion(paintedColors) {
  const numSlots = Math.min(MAX_SLOTS, Math.max(1, paintedColors.length));
  const swatches = paintedColors.slice(0, numSlots);
  while (swatches.length < MAX_SLOTS) swatches.push(null);
  const colorToSlot = mappingForSwatches(paintedColors, swatches);
  return { swatches, slotColors: swatches.slice(0, numSlots), colorToSlot, numSlots };
}

// --- snorca project assembly ------------------------------------------------
function meshModelXml(verts, tris, colorToSlot) {
  const vLines = verts.map((v) => `     <vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('\n');
  const tLines = tris.map((t) => {
    const code = PAINT_CODES[colorToSlot[t.hex]];
    const pc = code ? ` paint_color="${code}"` : '';
    return `     <triangle v1="${t.v1}" v2="${t.v2}" v3="${t.v3}"${pc}/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:BambuStudio="${NS_BAMBU}" xmlns:p="${NS_PROD}" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" p:UUID="${uuid()}" type="model">
   <mesh>
    <vertices>
${vLines}
    </vertices>
    <triangles>
${tLines}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build/>
</model>
`;
}

function rootXml(title, transform) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}" xmlns:BambuStudio="${NS_BAMBU}" xmlns:p="${NS_PROD}" requiredextensions="p">
 <metadata name="Application">Hue da Map</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">${xmlEscape(title)}</metadata>
 <resources>
  <object id="2" p:UUID="${uuid()}" type="model">
   <components>
    <component p:path="/3D/Objects/Object_1.model" objectid="1" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build p:UUID="${uuid()}">
  <item objectid="2" p:UUID="${uuid()}" transform="${transform}" printable="1"/>
 </build>
</model>
`;
}

function modelSettingsConfig(title, transform, thumbs = {}) {
  const plateThumbs = [
    thumbs.plate && `    <metadata key="thumbnail_file" value="${thumbs.plate}"/>`,
    thumbs.plateNoLight && `    <metadata key="thumbnail_no_light_file" value="${thumbs.plateNoLight}"/>`,
    thumbs.top && `    <metadata key="top_file" value="${thumbs.top}"/>`,
    thumbs.pick && `    <metadata key="pick_file" value="${thumbs.pick}"/>`,
  ].filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="${xmlEscape(title)}"/>
    <metadata key="extruder" value="0"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="${xmlEscape(title)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="filament_maps" value="1 1 1 1"/>
${plateThumbs ? plateThumbs + '\n' : ''}    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="${transform}" offset="0 0 0" />
  </assemble>
</config>
`;
}

// [Content_Types].xml declaring every extension present (so preserved thumbnails/
// auxiliaries keep the package valid).
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', gcode: 'text/x.gcode', json: 'application/json', txt: 'text/plain' };
function contentTypes(preserveNames) {
  const exts = new Set(['rels', 'model', 'png', 'gcode']);
  for (const n of preserveNames) { const e = n.split('.').pop().toLowerCase(); if (e) exts.add(e); }
  const ct = (e) => e === 'rels' ? 'application/vnd.openxmlformats-package.relationships+xml'
    : e === 'model' ? 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
    : (MIME[e] || 'application/octet-stream');
  const defs = [...exts].map((e) => ` <Default Extension="${e}" ContentType="${ct(e)}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defs}
</Types>
`;
}

// Root .rels. Reproduces the source's own thumbnail/cover relationships (so the
// original preview image is kept, not the plate render); falls back to the plate
// image only when the source declared no cover relationship.
function rootRels(coverRels, thumbs = {}) {
  const rels = [' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'];
  let list = coverRels && coverRels.length ? coverRels : [];
  if (!list.length && thumbs.plate) {
    list = [
      { type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail', target: thumbs.plate },
      { type: 'http://schemas.bambulab.com/package/2021/cover-thumbnail-middle', target: thumbs.plate },
      ...(thumbs.plateSmall ? [{ type: 'http://schemas.bambulab.com/package/2021/cover-thumbnail-small', target: thumbs.plateSmall }] : []),
    ];
  }
  let n = 2;
  for (const r of list) rels.push(` <Relationship Target="/${r.target}" Id="rel-${n++}" Type="${r.type}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
</Relationships>
`;
}

const MODEL_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/Object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

const MIN_SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value=""/>
  </header>
</config>
`;

// Apply our 4 output swatches to a project_settings template: override the
// filament palette and normalize every per-filament array to 4 entries, so a
// reused (Bambu) profile with a different filament count stays internally
// consistent (pad by repeating the last entry, or truncate).
function applySwatchesToSettings(projectSettingsTemplate, swatches) {
  const four = (swatches || []).slice(0, 4);
  while (four.length < 4) four.push(null);
  const filament = four.map((c) => c || PAD_COLOR);

  const settings = JSON.parse(projectSettingsTemplate);
  settings.filament_colour = filament.slice();
  settings.filament_multi_colors = filament.slice();
  for (const k of Object.keys(settings)) {
    if (k.startsWith('filament_') && Array.isArray(settings[k]) && settings[k].length && settings[k].length !== MAX_SLOTS) {
      const a = settings[k];
      while (a.length < MAX_SLOTS) a.push(a[a.length - 1]);
      a.length = MAX_SLOTS;
    }
  }
  return settings;
}

/**
 * Serialize a snorca .3mf from geometry + mapping + output swatches.
 * @returns {Uint8Array}
 */
export async function buildProjectBytes({ title, verts, tris, colorToSlot, swatches, projectSettingsTemplate, sliceInfoTemplate, preserveFiles = {}, coverRels = [] }) {
  const enc = new TextEncoder();

  // Carry over preview thumbnails / auxiliaries verbatim, and point the cover
  // thumbnail + plate at a preserved plate image when present.
  const preserveNames = Object.keys(preserveFiles);
  const pick = (re) => preserveNames.find((n) => re.test(n));
  const thumbs = {
    plate: pick(/(^|\/)plate_\d+\.png$/i),
    plateSmall: pick(/(^|\/)plate_\d+_small\.png$/i),
    plateNoLight: pick(/(^|\/)plate_no_light_\d+\.png$/i),
    top: pick(/(^|\/)top_\d+\.png$/i),
    pick: pick(/(^|\/)pick_\d+\.png$/i),
  };

  // Placement: center bbox on the plate, sit on the bed.
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of verts) {
    minx = Math.min(minx, v[0]); maxx = Math.max(maxx, v[0]);
    miny = Math.min(miny, v[1]); maxy = Math.max(maxy, v[1]);
    minz = Math.min(minz, v[2]);
  }
  const transform = `1 0 0 0 1 0 0 0 1 ${BED_CENTER[0] - (minx + maxx) / 2} ${BED_CENTER[1] - (miny + maxy) / 2} ${-minz}`;

  // No template = "don't add a printer profile": omit project_settings.config
  // entirely (see chooseProjectSettings). Paint slots then land on whatever
  // filaments the opening slicer has loaded.
  const settings = projectSettingsTemplate ? applySwatchesToSettings(projectSettingsTemplate, swatches) : null;

  const entries = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes(preserveNames)) },
    { name: '_rels/.rels', data: enc.encode(rootRels(coverRels.filter((r) => preserveFiles[r.target]), thumbs)) },
    { name: '3D/3dmodel.model', data: enc.encode(rootXml(title, transform)) },
    { name: '3D/_rels/3dmodel.model.rels', data: enc.encode(MODEL_RELS) },
    { name: '3D/Objects/Object_1.model', data: enc.encode(meshModelXml(verts, tris, colorToSlot)) },
    { name: 'Metadata/model_settings.config', data: enc.encode(modelSettingsConfig(title, transform, thumbs)) },
    { name: 'Metadata/slice_info.config', data: enc.encode(sliceInfoTemplate || MIN_SLICE_INFO) },
  ];
  if (settings) {
    entries.splice(5, 0, { name: 'Metadata/project_settings.config', data: enc.encode(JSON.stringify(settings, null, 4)) });
  }
  // Preserved thumbnails / auxiliaries (skip any name we already generate).
  const generated = new Set(entries.map((e) => e.name));
  for (const name of preserveNames) if (!generated.has(name)) entries.push({ name, data: preserveFiles[name] });
  return zipDeflate(entries);
}

/**
 * Convenience end-to-end conversion using the non-interactive default mapping.
 * @param {Uint8Array} inputBytes
 * @param {string} projectSettingsTemplate
 * @param {string} sliceInfoTemplate
 */
export async function convert3mf(inputBytes, projectSettingsTemplate, sliceInfoTemplate) {
  const p = await parseProject(inputBytes);
  const plan = planConversion(p.paintedColors);
  const bytes = await buildProjectBytes({
    title: p.title, verts: p.verts, tris: p.tris,
    colorToSlot: plan.colorToSlot, swatches: plan.swatches,
    projectSettingsTemplate, sliceInfoTemplate, preserveFiles: p.previewFiles, coverRels: p.coverRels,
  });

  const usedSlots = new Set(Object.values(plan.colorToSlot));
  return {
    bytes,
    summary: {
      title: p.title,
      triangles: p.tris.length,
      inputColors: p.paintedColors,
      slotColors: plan.slotColors,
      numSlots: usedSlots.size,
      mapping: p.paintedColors.map((hex) => ({ input: hex, slot: plan.colorToSlot[hex] })),
    },
  };
}

/**
 * Pick the project_settings template string for a given parsed input + target.
 * - any kind + 'u1': the genuine U1 profile (supports variant if the input had supports).
 * - bambu + 'keep': the input's own profile (preserve its printer).
 * - openscad + 'keep': null — emit no project_settings.config at all.
 * @param {{kind, rawProjectSettings, hasSupport}} parsed
 * @param {'keep'|'u1'} target
 * @param {{u1Base:string, u1Supports:string}} templates
 * @returns {string|null} template JSON, or null for "no profile at all"
 */
export function chooseProjectSettings(parsed, target, { u1Base, u1Supports }) {
  if (target === 'u1') {
    return (parsed.kind === 'bambu' && parsed.hasSupport && u1Supports) ? u1Supports : u1Base;
  }
  // target 'keep' = "No change": don't add/modify a printer profile.
  if (parsed.kind === 'bambu' && parsed.rawProjectSettings) return parsed.rawProjectSettings;
  // OpenSCAD had no profile at all, so emit no project_settings.config. Any config
  // — even a palette-only one — makes Bambu/Orca fabricate print/filament/printer
  // presets from *defaults*, named after the project file (the "(<filename>)"
  // presets), which then fail validation (e.g. relative-E vs. empty layer_gcode).
  // Without the file, the slicer keeps the presets the user already has selected.
  return null;
}

// Splice a list of {start, end, text} replacements into a string (non-overlapping,
// any order in).
function applyReplacements(str, replacements) {
  if (!replacements.length) return str;
  const sorted = replacements.slice().sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  for (const r of sorted) { out += str.slice(pos, r.start) + r.text; pos = r.end; }
  return out + str.slice(pos);
}

function setPaintColorAttr(attrs, newCode) {
  const has = /\bpaint_color="[^"]*"/.test(attrs);
  if (newCode == null) return has ? attrs.replace(/\s*paint_color="[^"]*"/, '') : attrs;
  return has ? attrs.replace(/paint_color="[^"]*"/, `paint_color="${newCode}"`) : `${attrs} paint_color="${newCode}"`;
}

// A printer profile's bed rectangle, from its `printable_area` polygon (list of
// "XxY" strings): center + span. Used to recompute <build><item> placement when
// the source and target printers have different bed sizes (e.g. Bambu P1S
// 256×256 vs. Snapmaker U1 ~270×270) — otherwise preserved-verbatim item
// transforms land off wherever they happened to sit on the OLD bed.
function bedRectFromSettings(json) {
  const area = json && json.printable_area;
  if (!Array.isArray(area) || !area.length) return null;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const pt of area) {
    const [x, y] = String(pt).split('x').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    minx = Math.min(minx, x); maxx = Math.max(maxx, x);
    miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, sx: maxx - minx, sy: maxy - miny };
}

// Metadata/model_settings.config: which object ids belong to each <plate>, in
// plater_id order.
function parsePlateGroups(msXml) {
  const plates = [];
  for (const pm of msXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const body = pm[1];
    const platerId = +((body.match(/<metadata\s+key="plater_id"\s+value="(\d+)"/) || [])[1] || 0);
    const platerName = (body.match(/<metadata\s+key="plater_name"\s+value="([^"]*)"/) || [])[1] || '';
    const objectIds = [...body.matchAll(/<model_instance>[\s\S]*?<metadata\s+key="object_id"\s+value="(\d+)"/g)].map((m) => m[1]);
    plates.push({ platerId, platerName, objectIds });
  }
  plates.sort((a, b) => a.platerId - b.platerId);
  return plates;
}

// Every <build><item objectid="X" transform="..."/> in the root model.
function parseBuildItems(rootXml) {
  const items = [];
  for (const m of rootXml.matchAll(/<item\b[^>]*\/>/g)) {
    const objectId = attr(m[0], 'objectid');
    const transform = attr(m[0], 'transform');
    if (objectId && transform) items.push({ objectId, transform, start: m.index, end: m.index + m[0].length, tag: m[0] });
  }
  return items;
}

// Apply a per-object-id XY delta to <build><item> transforms (rotation + Z are
// left as the exact original text).
function shiftBuildItemsXY(xml, items, deltaByObjectId) {
  const repls = [];
  for (const it of items) {
    const d = deltaByObjectId[it.objectId];
    if (!d || (!d[0] && !d[1])) continue;
    const parts = it.transform.trim().split(/\s+/);
    if (parts.length !== 12) continue;
    parts[9] = String(parseFloat(parts[9]) + d[0]);
    parts[10] = String(parseFloat(parts[10]) + d[1]);
    const newTag = it.tag.replace(/transform="[^"]*"/, `transform="${parts.join(' ')}"`);
    repls.push({ start: it.start, end: it.end, text: newTag });
  }
  return applyReplacements(xml, repls);
}

// Reverse-engineered from a real Orca Slicer "switch printer profile" action (see
// CLAUDE.md): it does NOT apply one global shift. Each PLATE's group of items is
// recentered onto a zone in an approximately-square grid — zone pitch = 1.2× the
// bed span, zone origin = bed center + (col, -row) × pitch — replacing that
// plate's own current centroid. Verified exactly against a real 4-plate/7-object
// reference; the grid-column count for other plate counts (ceil(sqrt(N))) is a
// best-effort generalization beyond that one data point.
const PLATE_ZONE_GAP_FACTOR = 1.2;

function recenterPlatesForBed(rootXml, msXml, sourceSettings, targetSettings) {
  const src = bedRectFromSettings(sourceSettings), dst = bedRectFromSettings(targetSettings);
  if (!src || !dst) return rootXml;
  if (Math.abs(src.cx - dst.cx) < 1e-9 && Math.abs(src.cy - dst.cy) < 1e-9 &&
      Math.abs(src.sx - dst.sx) < 1e-9 && Math.abs(src.sy - dst.sy) < 1e-9) {
    return rootXml; // same bed → nothing to compensate
  }

  const items = parseBuildItems(rootXml);
  if (!items.length) return rootXml;
  const posOf = {};
  for (const it of items) {
    const parts = it.transform.trim().split(/\s+/);
    if (parts.length === 12) posOf[it.objectId] = [parseFloat(parts[9]), parseFloat(parts[10])];
  }

  let plates = parsePlateGroups(msXml).filter((p) => p.objectIds.length);
  if (!plates.length) plates = [{ platerId: 1, objectIds: items.map((it) => it.objectId) }];
  const cols = Math.max(1, Math.ceil(Math.sqrt(plates.length)));

  const deltaByObjectId = {};
  plates.forEach((plate, i) => {
    const pts = plate.objectIds.map((id) => posOf[id]).filter(Boolean);
    if (!pts.length) return;
    const row = Math.floor(i / cols), col = i % cols;
    const zoneX = dst.cx + col * PLATE_ZONE_GAP_FACTOR * dst.sx;
    const zoneY = dst.cy - row * PLATE_ZONE_GAP_FACTOR * dst.sy;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const delta = [zoneX - cx, zoneY - cy];
    for (const id of plate.objectIds) deltaByObjectId[id] = delta;
  });

  return shiftBuildItemsXY(rootXml, items, deltaByObjectId);
}

/**
 * Rebuild a Bambu/Orca project by rewriting ONLY the color-bearing bits in
 * place — per-triangle `paint_color`, part/object base `extruder` (filament)
 * metadata, and the project_settings filament palette — leaving every other
 * file (plates, per-object transforms, the assemble view, supports,
 * thumbnails, cut info…) byte-identical to the source. This is what lets
 * multi-plate / multi-object Bambu projects survive the round trip intact.
 * @param {{rawFiles: Record<string,Uint8Array>, colorToSlot: object, palette: string[],
 *   swatches: (string|null)[], projectSettingsTemplate: string, sliceInfoTemplate: string|null}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function buildBambuPreservingBytes({ rawFiles, colorToSlot, palette, swatches, projectSettingsTemplate, sliceInfoTemplate }) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  const entries = { ...rawFiles };
  const { rootName, modelParts } = listModelParts(rawFiles);
  const targetSettings = applySwatchesToSettings(projectSettingsTemplate, swatches);

  // Old palette slot (1-based, as it literally appears in paint_color / extruder
  // metadata) → new output slot (1-4), via each old slot's resolved hex.
  const slotRemap = {};
  palette.forEach((hex, i) => { slotRemap[i + 1] = colorToSlot[normHex(hex)] || 1; });

  // 1. Per-triangle paint_color, in every model part that carries mesh triangles.
  for (const name of modelParts) {
    const xml = dec.decode(rawFiles[name]);
    const repls = [];
    for (const t of xml.matchAll(/<triangle\b([^>]*?)\/?>/g)) {
      const a = t[1];
      const code = attr(a, 'paint_color');
      if (code === undefined) continue;
      const d = decodePaintSlot(code);
      if (!d.known) continue; // sub-triangle bitstream we can't re-encode: leave it exactly as-is
      const newSlot = slotRemap[d.slot] || d.slot;
      if (newSlot === d.slot) continue;
      const text = `<triangle${setPaintColorAttr(a, PAINT_CODES[newSlot])}/>`;
      repls.push({ start: t.index, end: t.index + t[0].length, text });
    }
    if (repls.length) entries[name] = enc.encode(applyReplacements(xml, repls));
  }

  // 2. Whole part/object base "extruder" (filament) metadata in model_settings.config.
  if (rawFiles['Metadata/model_settings.config']) {
    const msXml = dec.decode(rawFiles['Metadata/model_settings.config']);
    const rewritten = msXml.replace(/(<metadata\s+key="extruder"\s+value=")(\d+)("\s*\/>)/g, (m, pre, val, post) => {
      const oldSlot = +val || 1; // 0/unset = implicit default filament (slot 1)
      const newSlot = slotRemap[oldSlot] || oldSlot;
      if (+val === 0 && newSlot === 1) return m; // still default — keep it implicit, minimal diff
      return `${pre}${newSlot}${post}`;
    });
    entries['Metadata/model_settings.config'] = enc.encode(rewritten);
  }

  // 3. Filament palette: keep/replace the printer profile per target (same
  // selection as chooseProjectSettings), override colors to our 4 swatches.
  entries['Metadata/project_settings.config'] = enc.encode(JSON.stringify(targetSettings, null, 4));
  entries['Metadata/slice_info.config'] = enc.encode(sliceInfoTemplate || MIN_SLICE_INFO);

  // 4. Recenter each plate's placement for a bed-size difference between the
  // source printer and the target profile just chosen (see recenterPlatesForBed).
  // A no-op for 'keep' (target profile = source profile → identical bed).
  const sourceSettings = rawFiles['Metadata/project_settings.config'] ? JSON.parse(dec.decode(rawFiles['Metadata/project_settings.config'])) : null;
  if (sourceSettings) {
    const rootXml = dec.decode(entries[rootName]);
    const msXmlNow = dec.decode(entries['Metadata/model_settings.config'] || rawFiles['Metadata/model_settings.config']);
    const shifted = recenterPlatesForBed(rootXml, msXmlNow, sourceSettings, targetSettings);
    if (shifted !== rootXml) entries[rootName] = enc.encode(shifted);
  }

  return zipDeflate(Object.entries(entries).map(([name, data]) => ({ name, data })));
}

/**
 * Build the final output bytes for a parsed project, routing Bambu-kind input
 * through the structure-preserving rewrite and OpenSCAD-kind input through the
 * from-scratch rebuild (it has no plate/multi-object structure to preserve).
 * @param {object} parsed - result of parseAnyProject
 * @param {{colorToSlot: object, swatches: (string|null)[], target?: 'keep'|'u1', u1Base: string, u1Supports?: string}} opts
 */
export async function buildOutputBytes(parsed, { colorToSlot, swatches, target = 'keep', u1Base, u1Supports }) {
  const projectSettingsTemplate = chooseProjectSettings(parsed, target, { u1Base, u1Supports });
  const sliceInfoTemplate = (parsed.kind === 'bambu' && target === 'keep') ? parsed.rawSliceInfo : null;
  if (parsed.kind === 'bambu') {
    return buildBambuPreservingBytes({
      rawFiles: parsed.rawFiles, colorToSlot, palette: parsed.definedColors, swatches,
      projectSettingsTemplate, sliceInfoTemplate,
    });
  }
  return buildProjectBytes({
    title: parsed.title, verts: parsed.verts, tris: parsed.tris, colorToSlot, swatches,
    projectSettingsTemplate, sliceInfoTemplate, preserveFiles: parsed.previewFiles, coverRels: parsed.coverRels,
  });
}

/**
 * Target-aware, non-interactive conversion (auto color mapping). Used by the CLI.
 * @param {Uint8Array} inputBytes
 * @param {{target?:'keep'|'u1', u1Base:string, u1Supports?:string}} opts
 */
export async function convertProject(inputBytes, { target = 'keep', u1Base, u1Supports } = {}) {
  const p = await parseAnyProject(inputBytes);
  const plan = planConversion(p.paintedColors);
  const bytes = await buildOutputBytes(p, { colorToSlot: plan.colorToSlot, swatches: plan.swatches, target, u1Base, u1Supports });
  const usedSlots = new Set(Object.values(plan.colorToSlot));
  return {
    bytes,
    kind: p.kind,
    complexPaintCount: p.complexPaintCount || 0,
    summary: {
      title: p.title, triangles: p.tris.length, inputColors: p.paintedColors,
      slotColors: plan.slotColors, numSlots: usedSlots.size,
      mapping: p.paintedColors.map((hex) => ({ input: hex, slot: plan.colorToSlot[hex] })),
    },
  };
}

export function outputName(inputName, suffix = DEFAULT_SUFFIX) {
  return inputName.replace(/\.3mf$/i, '') + suffix + '.3mf';
}
