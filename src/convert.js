// Convert an OpenSCAD-style colored 3MF (basematerials or m:colorgroup, with
// per-triangle pid/p1 color indices) into a Snapmaker-OrcaSlicer ("snorca")
// project that stores color as Bambu/Orca `paint_color` triangle attributes.
//
// Pure, DOM-free logic so it runs identically in the browser and under Node
// (see test/sanity.mjs). Zip I/O lives in ./zip.js.

import { unzip, zipStore } from './zip.js';

// --- Reverse-engineered from colored-cube.3mf (a real snorca export) --------
// A triangle painted with filament slot N carries paint_color="<code>".
// Slot 1 is the base filament and carries NO attribute.
//   Observed codes in the reference: base=(none), and {"8","0C","1C"} across
//   the other three of its four filament slots. Order assumed monotonic; this
//   should be visually confirmed in snorca. Snapmaker U1 has 4 toolheads, so
//   the OUTPUT never needs more than these four slots.
export const PAINT_CODES = { 1: null, 2: '8', 3: '0C', 4: '1C' };
export const MAX_SLOTS = 4;

// Plate center used to position the object on the bed. Taken from the
// reference snorca export; adjust if the U1 plate origin differs.
export const BED_CENTER = [135.5, 136];

const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
const NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

// --- small helpers ----------------------------------------------------------
function normHex(h) {
  if (!h) return '#808080';
  h = h.replace('#', '');
  if (h.length >= 6) h = h.slice(0, 6);        // drop alpha if present
  else h = h.padEnd(6, '0');
  return '#' + h.toUpperCase();
}
function rgb(hex) {
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

// --- 3MF model parsing (regex based; 3MF model XML is machine-regular) ------
export function parseModelXml(xml) {
  const groups = {}; // resourceId -> [hex, ...]

  for (const bm of xml.matchAll(/<basematerials\b([^>]*)>([\s\S]*?)<\/basematerials>/g)) {
    const id = attr(bm[1], 'id');
    const colors = [];
    for (const b of bm[2].matchAll(/<base\b[^>]*\bdisplaycolor="(#[0-9A-Fa-f]+)"/g)) colors.push(b[1]);
    if (id) groups[id] = colors;
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
        pid: attr(ta, 'pid'), p1: attr(ta, 'p1'),
      });
    }
    objects.push({
      id: attr(a, 'id'), pid: attr(a, 'pid'), pindex: attr(a, 'pindex'),
      name: attr(a, 'name') || '', verts, tris,
    });
  }
  return { groups, objects };
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
  let title = (rootXml.match(/<metadata name="Title"[^>]*>([\s\S]*?)<\/metadata>/) || [])[1] || 'model';
  for (const part of modelParts) {
    const { groups: g, objects: o } = parseModelXml(dec.decode(files[part]));
    Object.assign(groups, g);
    for (const obj of o) if (obj.verts.length && obj.tris.length) objects.push(obj);
  }
  return { groups, objects, title };
}

// --- default (phase 1) color reduction --------------------------------------
// Merge all geometry, discover the distinct painted colors in first-seen order,
// keep the first four as filament slots, and snap any extras to the nearest
// slot by RGB distance.
export function planConversion({ groups, objects }) {
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

  const inputColors = [];
  const seen = new Set();
  for (const t of tris) if (!seen.has(t.hex)) { seen.add(t.hex); inputColors.push(t.hex); }

  const numSlots = Math.min(MAX_SLOTS, Math.max(1, inputColors.length));
  const slotColors = inputColors.slice(0, numSlots);
  const colorToSlot = {};
  inputColors.forEach((hex, i) => {
    if (i < numSlots) { colorToSlot[hex] = i + 1; return; }
    let best = 0, bd = Infinity;
    const c = rgb(hex);
    slotColors.forEach((sc, j) => { const d = dist(c, rgb(sc)); if (d < bd) { bd = d; best = j; } });
    colorToSlot[hex] = best + 1;
  });

  return { verts, tris, inputColors, slotColors, colorToSlot, numSlots };
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

function modelSettingsConfig(title, transform, numSlots) {
  const maps = Array(numSlots).fill('1').join(' ');
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
    <metadata key="filament_maps" value="${maps}"/>
    <model_instance>
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

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

const MODEL_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/Object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function uuid() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : '00000000-0000-4000-8000-000000000000';
}

/**
 * Full conversion. Accepts the raw input .3mf bytes plus the project-settings
 * template text (the working snorca profile shipped in src/templates/), and
 * returns the output bytes + a summary of what was mapped.
 *
 * @param {Uint8Array} inputBytes
 * @param {string} projectSettingsTemplate  contents of project_settings.base.json
 * @param {string} sliceInfoTemplate        contents of slice_info.base.xml
 */
export async function convert3mf(inputBytes, projectSettingsTemplate, sliceInfoTemplate) {
  const files = await unzip(inputBytes);
  const { groups, objects, title } = collectGeometry(files);
  if (!objects.length) throw new Error('No mesh geometry found in this 3MF.');

  const plan = planConversion({ groups, objects });
  const enc = new TextEncoder();

  // Placement transform: center the bbox on the plate, sit it on the bed.
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const v of plan.verts) {
    minx = Math.min(minx, v[0]); maxx = Math.max(maxx, v[0]);
    miny = Math.min(miny, v[1]); maxy = Math.max(maxy, v[1]);
    minz = Math.min(minz, v[2]);
  }
  const tx = BED_CENTER[0] - (minx + maxx) / 2;
  const ty = BED_CENTER[1] - (miny + maxy) / 2;
  const tz = -minz;
  const transform = `1 0 0 0 1 0 0 0 1 ${tx} ${ty} ${tz}`;

  // Project settings: keep the working template, swap in the mapped filament
  // colors. Output is always 4 filament slots (pad unused with gray) so the
  // template's per-filament arrays stay length-4 and consistent.
  const settings = JSON.parse(projectSettingsTemplate);
  const four = plan.slotColors.slice(0, 4);
  while (four.length < 4) four.push('#CCCCCC');
  settings.filament_colour = four.slice();
  settings.filament_multi_colors = four.slice();

  const entries = [
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: '3D/3dmodel.model', data: enc.encode(rootXml(title, transform)) },
    { name: '3D/_rels/3dmodel.model.rels', data: enc.encode(MODEL_RELS) },
    { name: '3D/Objects/Object_1.model', data: enc.encode(meshModelXml(plan.verts, plan.tris, plan.colorToSlot)) },
    { name: 'Metadata/project_settings.config', data: enc.encode(JSON.stringify(settings, null, 4)) },
    { name: 'Metadata/model_settings.config', data: enc.encode(modelSettingsConfig(title, transform, plan.numSlots)) },
    { name: 'Metadata/slice_info.config', data: enc.encode(sliceInfoTemplate) },
  ];

  return {
    bytes: zipStore(entries),
    summary: {
      title,
      triangles: plan.tris.length,
      inputColors: plan.inputColors,
      slotColors: plan.slotColors,
      numSlots: plan.numSlots,
      mapping: plan.inputColors.map((hex) => ({ input: hex, slot: plan.colorToSlot[hex] })),
    },
  };
}

export const DEFAULT_SUFFIX = '-snorcapaint';

export function outputName(inputName, suffix = DEFAULT_SUFFIX) {
  return inputName.replace(/\.3mf$/i, '') + suffix + '.3mf';
}
