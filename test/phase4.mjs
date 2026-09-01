// Phase 4 checks: multi-plate / multi-object Bambu projects must survive the
// round trip structurally intact — plates, per-object transforms, the
// assemble view, and thumbnails/auxiliaries are only ever byte-identical
// pass-through; only color-bearing bits (paint_color, extruder metadata,
// filament palette) may change. Runs under Node.
//
// sample-multi-plate.3mf is a real, gitignored Bambu Studio export (kept out
// of git for copyright/licensing reasons — see CLAUDE.md) with 4 plates, 7
// top-level objects sharing 4 geometry files, an <assemble> block, and a mix
// of per-triangle painting + whole-part/object base filaments across 8
// source filament colors. sample-multi-plate-U1.3mf is the SAME project after
// manually switching the printer profile to Snapmaker U1 *inside* Orca Slicer
// — ground truth for how Orca itself repositions multi-plate layouts across a
// bed-size change, which our per-plate grid-recenter logic aims to reproduce.
// Both files must exist locally for this test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertProject, parseAnyProject, detectInputType } from '../src/convert.js';
import { unzip } from '../src/zip.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => new Uint8Array(readFileSync(join(root, f)));
const u1Base = readFileSync(join(root, 'src/templates/project_settings.base.json'), 'utf8');
const u1Supports = readFileSync(join(root, 'src/templates/project_settings.supports.json'), 'utf8');

let ok = true;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) ok = false; };

const SAMPLE = 'sample-multi-plate.3mf';
const inputBytes = load(SAMPLE);
const inputFiles = await unzip(inputBytes);
const dec = new TextDecoder();
const inputModelSettings = dec.decode(inputFiles['Metadata/model_settings.config']);
const inputRootModel = dec.decode(inputFiles['3D/3dmodel.model']);

const countOf = (re, s) => (s.match(re) || []).length;
const plateCount = countOf(/<plate>/g, inputModelSettings);
const assembleItemCount = countOf(/<assemble_item\b/g, inputModelSettings);
const buildItemCount = countOf(/<item\b/g, inputRootModel);
const auxCount = Object.keys(inputFiles).filter((n) => n.startsWith('Auxiliaries/')).length;

// 1. detection + parse
check(detectInputType(inputFiles) === 'bambu', 'detect sample-multi-plate → bambu');
const p = await parseAnyProject(inputBytes);
check(p.kind === 'bambu', `parse kind=${p.kind}`);
check(p.hasSupport === false, `parse hasSupport=${p.hasSupport} (source has enable_support=0)`);
// Fixed resolution bug: object-level `extruder` (not just per-triangle paint_color)
// must contribute to the distinct-color set, so this must be > 1 (not just the
// one color used by the engraved-text paint_color region).
check(p.paintedColors.length > 1, `parse resolves multiple colors (${p.paintedColors.length}) via object/part extruder + paint_color`);

const itemTransformsById = (xml) => {
  const out = {};
  for (const m of xml.matchAll(/<item\b[^>]*\/>/g)) {
    const oid = (m[0].match(/objectid="(\d+)"/) || [])[1];
    const t = (m[0].match(/transform="([^"]+)"/) || [])[1];
    if (oid && t) out[oid] = t.trim().split(/\s+/).map(Number);
  }
  return out;
};

for (const target of ['keep', 'u1']) {
  const { bytes, kind, summary } = await convertProject(inputBytes, { target, u1Base, u1Supports });
  const label = `target=${target}`;
  check(kind === 'bambu', `${label}: kind=${kind}`);

  const out = await unzip(bytes);
  const outModelSettings = dec.decode(out['Metadata/model_settings.config']);
  const outRootModel = dec.decode(out['3D/3dmodel.model']);
  const outProjectSettings = JSON.parse(dec.decode(out['Metadata/project_settings.config']));

  if (target === 'keep') {
    // Same printer profile in and out → no bed-size change → byte-identical.
    check(outRootModel === inputRootModel, `${label}: 3D/3dmodel.model unchanged (plates/objects/build/components/transforms)`);
  } else {
    // Ground truth: the same project, with the printer profile switched to
    // Snapmaker U1 *inside* Orca Slicer itself. Our per-plate grid-recenter
    // logic (see recenterPlatesForBed in src/convert.js) should reproduce its
    // repositioning closely (rotation/Z untouched either way).
    const refFiles = await unzip(load('sample-multi-plate-U1.3mf'));
    const refItems = itemTransformsById(dec.decode(refFiles['3D/3dmodel.model']));
    const outItems = itemTransformsById(outRootModel);
    const ids = Object.keys(refItems);
    check(ids.length === buildItemCount && Object.keys(outItems).length === buildItemCount, `${label}: item count unchanged (${buildItemCount})`);
    const close = (a, b, eps) => Math.abs(a - b) < eps;
    check(ids.every((id) => outItems[id] && close(outItems[id][9], refItems[id][9], 0.01) && close(outItems[id][10], refItems[id][10], 0.01)),
      `${label}: XY placement matches Orca's own U1 switch within 0.01mm`);
    check(ids.every((id) => outItems[id][11] === refItems[id][11]), `${label}: Z translation matches Orca's own U1 switch exactly`);
    check(ids.every((id) => outItems[id].slice(0, 9).every((v, j) => v === refItems[id][j])), `${label}: rotation/scale unchanged`);
  }
  check(countOf(/<plate>/g, outModelSettings) === plateCount, `${label}: plate count preserved (${plateCount})`);
  check(countOf(/<assemble_item\b/g, outModelSettings) === assembleItemCount, `${label}: assemble_item count preserved (${assembleItemCount})`);
  check(countOf(/<item\b/g, outRootModel) === buildItemCount, `${label}: build item count preserved (${buildItemCount})`);
  check(Object.keys(out).filter((n) => n.startsWith('Auxiliaries/')).length === auxCount, `${label}: auxiliaries preserved (${auxCount} files)`);

  // Filament palette collapsed to 4 slots.
  check(outProjectSettings.filament_colour.length === 4, `${label}: filament_colour normalized to 4 (${JSON.stringify(outProjectSettings.filament_colour)})`);
  check(summary.numSlots <= 4, `${label}: numSlots=${summary.numSlots} <= 4`);

  // Only known paint_color codes appear in the rewritten mesh parts.
  const meshNames = Object.keys(out).filter((n) => /^3D\/Objects\/.*\.model$/.test(n));
  let badCode = false;
  for (const name of meshNames) {
    const xml = dec.decode(out[name]);
    for (const m of xml.matchAll(/paint_color="([^"]*)"/g)) {
      if (!['8', '0C', 'C', '1C'].includes(m[1].toUpperCase())) badCode = true;
    }
  }
  check(!badCode, `${label}: all output paint_color codes are known/re-encodable`);
}

console.log(ok ? '\nPASS ✅\n' : '\nFAIL ❌\n');
process.exit(ok ? 0 : 1);
