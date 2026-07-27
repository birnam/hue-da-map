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
export const DEFAULT_SUFFIX = '-snorcapaint';

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

// Gather all mesh-bearing objects, following production-extension components.
function collectGeometry(files) {
  const dec = new TextDecoder();
  const rootName = rootModelName(files);
  const rootXml = dec.decode(files[rootName]);

  const modelParts = [rootName];
  for (const m of rootXml.matchAll(/p:path="([^"]+)"/g)) {
    const path = m[1].replace(/^\//, '');
    if (files[path] && !modelParts.includes(path)) modelParts.push(path);
  }

  const groups = {};
  const objects = [];
  const baseMaterials = [];
  const title = (rootXml.match(/<metadata name="Title"[^>]*>([\s\S]*?)<\/metadata>/) || [])[1] || 'model';
  for (const part of modelParts) {
    const { groups: g, objects: o, baseMaterials: bm } = parseModelXml(dec.decode(files[part]));
    Object.assign(groups, g);
    baseMaterials.push(...bm);
    for (const obj of o) if (obj.verts.length && obj.tris.length) objects.push(obj);
  }
  return { groups, objects, title, baseMaterials };
}

// Merge all objects into one vertex/triangle list, resolving each triangle's
// source color to a normalized hex.
function mergeGeometry(groups, objects) {
  const verts = [];
  const tris = []; // { v1, v2, v3, hex }
  for (const obj of objects) {
    const base = verts.length;
    for (const v of obj.verts) verts.push(v);
    for (const t of obj.tris) {
      let g, idx;
      if (t.pid !== undefined && t.p1 !== undefined) { g = t.pid; idx = +t.p1; }
      else { g = obj.pid; idx = obj.pindex !== undefined ? +obj.pindex : 0; }
      const hex = normHex((groups[g] || [])[idx]);
      tris.push({ v1: t.v1 + base, v2: t.v2 + base, v3: t.v3 + base, hex });
    }
  }
  return { verts, tris };
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
  const { verts, tris } = mergeGeometry(groups, objects);
  return { title, verts, tris, paintedColors: distinctHexes(tris), definedColors: uniq(baseMaterials), previewFiles: collectPreviewFiles(files), coverRels: parseCoverRels(files) };
}

/**
 * Parse an OpenSCAD-colored 3MF into geometry + color info (no mapping committed).
 * @param {Uint8Array} inputBytes
 */
export async function parseProject(inputBytes) {
  return buildOpenscad(await unzip(inputBytes));
}

// --- Bambu/Orca project 3MF (paint_color + filament palette) ----------------
// model_settings.config: part id -> extruder (1-based filament slot).
function parsePartExtruders(files) {
  const map = {};
  const txt = files['Metadata/model_settings.config'];
  if (!txt) return map;
  const xml = new TextDecoder().decode(txt);
  for (const part of xml.matchAll(/<part\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const e = (part[2].match(/key="extruder"[^>]*value="(\d+)"/) || [])[1];
    if (e) map[part[1]] = +e;
  }
  return map;
}

export function detectInputType(files) {
  if (files['Metadata/project_settings.config']) return 'bambu';
  const root = files['3D/3dmodel.model'] && new TextDecoder().decode(files['3D/3dmodel.model']);
  if (root && /paint_color=|<component\b/.test(root)) return 'bambu';
  return 'openscad';
}

function buildBambu(files) {
  const { objects, title } = collectGeometry(files);
  if (!objects.length) throw new Error('No mesh geometry found in this 3MF.');

  const dec = new TextDecoder();
  const rawProjectSettings = files['Metadata/project_settings.config'] ? dec.decode(files['Metadata/project_settings.config']) : null;
  const rawSliceInfo = files['Metadata/slice_info.config'] ? dec.decode(files['Metadata/slice_info.config']) : null;

  let palette = [], hasSupport = false;
  if (rawProjectSettings) {
    try {
      const s = JSON.parse(rawProjectSettings);
      palette = (s.filament_colour || []).map(normHex);
      hasSupport = String(s.enable_support) === '1';
    } catch { /* ignore */ }
  }
  const partExtruder = parsePartExtruders(files);
  const paletteHex = (slot) => normHex(palette[(slot | 0) - 1]);

  const verts = [];
  const tris = [];
  let complexPaintCount = 0;
  for (const obj of objects) {
    const base = verts.length;
    for (const v of obj.verts) verts.push(v);
    const objBaseSlot = partExtruder[obj.id] >= 1 ? partExtruder[obj.id] : 1;
    for (const t of obj.tris) {
      let slot = objBaseSlot;
      if (t.paint !== undefined) {
        const d = decodePaintSlot(t.paint);
        if (d.known) slot = d.slot; else complexPaintCount++; // flatten unknown → base
      }
      tris.push({ v1: t.v1 + base, v2: t.v2 + base, v3: t.v3 + base, hex: paletteHex(slot) });
    }
  }

  return {
    kind: 'bambu', title, verts, tris,
    paintedColors: distinctHexes(tris), definedColors: palette.slice(),
    rawProjectSettings, rawSliceInfo, hasSupport, complexPaintCount,
    previewFiles: collectPreviewFiles(files), coverRels: parseCoverRels(files),
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
 <metadata name="Application">3mf-color-to-part (snorcapaint)</metadata>
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

  // Always emit 4 filament slots so the template's per-filament arrays stay
  // consistent; unused ("X") slots get a neutral placeholder color.
  const four = (swatches || []).slice(0, 4);
  while (four.length < 4) four.push(null);
  const filament = four.map((c) => c || PAD_COLOR);

  const settings = JSON.parse(projectSettingsTemplate);
  settings.filament_colour = filament.slice();
  settings.filament_multi_colors = filament.slice();
  // Our output uses ≤4 filament slots. Normalize every per-filament array to 4
  // entries so a reused (Bambu) profile with a different filament count stays
  // internally consistent (pad by repeating the last entry, or truncate).
  for (const k of Object.keys(settings)) {
    if (k.startsWith('filament_') && Array.isArray(settings[k]) && settings[k].length && settings[k].length !== MAX_SLOTS) {
      const a = settings[k];
      while (a.length < MAX_SLOTS) a.push(a[a.length - 1]);
      a.length = MAX_SLOTS;
    }
  }

  const entries = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes(preserveNames)) },
    { name: '_rels/.rels', data: enc.encode(rootRels(coverRels.filter((r) => preserveFiles[r.target]), thumbs)) },
    { name: '3D/3dmodel.model', data: enc.encode(rootXml(title, transform)) },
    { name: '3D/_rels/3dmodel.model.rels', data: enc.encode(MODEL_RELS) },
    { name: '3D/Objects/Object_1.model', data: enc.encode(meshModelXml(verts, tris, colorToSlot)) },
    { name: 'Metadata/project_settings.config', data: enc.encode(JSON.stringify(settings, null, 4)) },
    { name: 'Metadata/model_settings.config', data: enc.encode(modelSettingsConfig(title, transform, thumbs)) },
    { name: 'Metadata/slice_info.config', data: enc.encode(sliceInfoTemplate || MIN_SLICE_INFO) },
  ];
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
 * - openscad (any target): the genuine U1 profile.
 * - bambu + 'keep': the input's own profile (preserve its printer).
 * - bambu + 'u1': the U1 profile (supports variant if the input enabled supports).
 * @param {{kind, rawProjectSettings, hasSupport}} parsed
 * @param {'keep'|'u1'} target
 * @param {{u1Base:string, u1Supports:string}} templates
 */
// "No change" for OpenSCAD input: carry only the filament palette, so we don't
// inject a printer profile that wasn't in the source. Lets the color fix land in
// whatever slicer/printer the user opens it with (Bambu / Orca main / snorca).
const MINIMAL_PROJECT_SETTINGS = JSON.stringify({
  from: 'project',
  version: '2.2.1',
  filament_colour: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
  filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
}, null, 4);

export function chooseProjectSettings(parsed, target, { u1Base, u1Supports }) {
  if (target === 'u1') {
    return (parsed.kind === 'bambu' && parsed.hasSupport && u1Supports) ? u1Supports : u1Base;
  }
  // target 'keep' = "No change": don't add/modify a printer profile.
  if (parsed.kind === 'bambu' && parsed.rawProjectSettings) return parsed.rawProjectSettings;
  return MINIMAL_PROJECT_SETTINGS; // OpenSCAD: palette only, no printer forced
}

/**
 * Target-aware, non-interactive conversion (auto color mapping). Used by the CLI.
 * @param {Uint8Array} inputBytes
 * @param {{target?:'keep'|'u1', u1Base:string, u1Supports?:string}} opts
 */
export async function convertProject(inputBytes, { target = 'keep', u1Base, u1Supports } = {}) {
  const p = await parseAnyProject(inputBytes);
  const plan = planConversion(p.paintedColors);
  const projectSettingsTemplate = chooseProjectSettings(p, target, { u1Base, u1Supports });
  const sliceInfoTemplate = (p.kind === 'bambu' && target === 'keep') ? p.rawSliceInfo : null;
  const bytes = await buildProjectBytes({
    title: p.title, verts: p.verts, tris: p.tris,
    colorToSlot: plan.colorToSlot, swatches: plan.swatches,
    projectSettingsTemplate, sliceInfoTemplate, preserveFiles: p.previewFiles, coverRels: p.coverRels,
  });
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
