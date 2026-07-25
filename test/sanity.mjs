// End-to-end sanity check runnable under Node (no browser needed).
// Converts a real input .3mf and validates the output structure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convert3mf, outputName, PAINT_CODES } from '../src/convert.js';
import { unzip } from '../src/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const input = process.argv[2] || 'gridfinity-cup-1x1x3U-label-v1-color.3mf';
const inputBytes = new Uint8Array(readFileSync(join(root, input)));
const settings = readFileSync(join(root, 'src/templates/project_settings.base.json'), 'utf8');
const sliceInfo = readFileSync(join(root, 'src/templates/slice_info.base.xml'), 'utf8');

const { bytes, summary } = await convert3mf(inputBytes, settings, sliceInfo);

console.log(`\ninput : ${input}`);
console.log(`output: ${outputName(input)}  (${bytes.length} bytes)`);
console.log(`title : ${summary.title}`);
console.log(`triangles: ${summary.triangles}`);
console.log(`input colors (${summary.inputColors.length}): ${summary.inputColors.join(' ')}`);
console.log(`filament slots (${summary.numSlots}): ${summary.slotColors.join(' ')}`);
console.log('mapping:');
for (const m of summary.mapping) console.log(`  ${m.input}  ->  slot ${m.slot}  (paint_color=${PAINT_CODES[m.slot] ?? '(none)'})`);

// --- validate the produced archive ---
const out = await unzip(bytes);
const expected = [
  '[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model',
  '3D/_rels/3dmodel.model.rels', '3D/Objects/Object_1.model',
  'Metadata/project_settings.config', 'Metadata/model_settings.config', 'Metadata/slice_info.config',
];
let ok = true;
for (const name of expected) {
  if (!out[name]) { console.error(`  MISSING: ${name}`); ok = false; }
}

const mesh = new TextDecoder().decode(out['3D/Objects/Object_1.model']);
const painted = [...mesh.matchAll(/paint_color="([^"]+)"/g)].map((m) => m[1]);
const codeCounts = {};
for (const c of painted) codeCounts[c] = (codeCounts[c] || 0) + 1;
const triTotal = [...mesh.matchAll(/<triangle\b/g)].length;
const vertTotal = [...mesh.matchAll(/<vertex\b/g)].length;

console.log('\nvalidation:');
console.log(`  output vertices : ${vertTotal}`);
console.log(`  output triangles: ${triTotal}`);
console.log(`  painted triangles: ${painted.length} (base/unpainted: ${triTotal - painted.length})`);
console.log(`  paint_color codes used:`, codeCounts);

const proj = JSON.parse(new TextDecoder().decode(out['Metadata/project_settings.config']));
console.log(`  filament_colour: ${JSON.stringify(proj.filament_colour)}`);

// assertions
if (triTotal !== summary.triangles) { console.error('  FAIL: triangle count mismatch'); ok = false; }
if (!painted.length && summary.numSlots > 1) { console.error('  FAIL: expected painted triangles'); ok = false; }
const validCodes = new Set(Object.values(PAINT_CODES).filter(Boolean));
for (const c of painted) if (!validCodes.has(c)) { console.error(`  FAIL: unexpected paint_color ${c}`); ok = false; }
if (proj.filament_colour.length !== 4) { console.error('  FAIL: filament_colour must have 4 entries'); ok = false; }

console.log(ok ? '\nPASS ✅\n' : '\nFAIL ❌\n');
process.exit(ok ? 0 : 1);
