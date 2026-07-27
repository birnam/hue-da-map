// Phase 3 checks: input detection, paint_color decoding, and the
// input-type × target-printer conversion matrix. Runs under Node.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertProject, parseAnyProject, detectInputType } from '../src/convert.js';
import { decodePaintSlot } from '../src/paint.js';
import { unzip } from '../src/zip.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => new Uint8Array(readFileSync(join(root, f)));
const u1Base = readFileSync(join(root, 'src/templates/project_settings.base.json'), 'utf8');
const u1Supports = readFileSync(join(root, 'src/templates/project_settings.supports.json'), 'utf8');

let ok = true;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) ok = false; };
const psOf = async (bytes) => JSON.parse(new TextDecoder().decode((await unzip(bytes))['Metadata/project_settings.config']));
const meshOf = async (bytes) => new TextDecoder().decode((await unzip(bytes))['3D/Objects/Object_1.model']);

// 1. detection
check(detectInputType(await unzip(load('colored-cube.3mf'))) === 'bambu', 'detect colored-cube → bambu');
check(detectInputType(await unzip(load('gridfinity-cup-1x1x3U-label-v1-color.3mf'))) === 'openscad', 'detect gridfinity → openscad');

// 2. paint decode
check(decodePaintSlot('').slot === 1 && decodePaintSlot('').known, 'decode "" → base slot 1');
check(decodePaintSlot('8').slot === 2, 'decode "8" → slot 2');
check(decodePaintSlot('0C').slot === 3, 'decode "0C" → slot 3');
check(decodePaintSlot('1C').slot === 4, 'decode "1C" → slot 4');
check(!decodePaintSlot('ABCD').known, 'decode unknown → known:false');

// 3. Bambu parse
const b = await parseAnyProject(load('colored-cube.3mf'));
check(b.kind === 'bambu' && b.tris.length === 12, `bambu parse: kind=${b.kind}, tris=${b.tris.length}`);
check(b.paintedColors.length === 4 && b.complexPaintCount === 0, `bambu: 4 colors, complexPaint=${b.complexPaintCount}`);

// 4. Bambu + keep → preserve printer profile, remap colors
const bk = await convertProject(load('colored-cube.3mf'), { target: 'keep', u1Base, u1Supports });
const bkps = await psOf(bk.bytes);
check(bkps.printer_model === 'Snapmaker U1', `bambu+keep printer preserved (${bkps.printer_model})`);
check(JSON.stringify(bkps.filament_colour) === JSON.stringify(b.paintedColors), 'bambu+keep filament_colour = palette');
check(/paint_color="/.test(await meshOf(bk.bytes)), 'bambu+keep output has paint_color');

// preview thumbnails carried over + referenced
const bkOut = await unzip(bk.bytes);
check(Object.keys(bkOut).filter((n) => n.endsWith('.png')).length === 5, 'bambu+keep preserves 5 thumbnails');
check(/cover-thumbnail-middle/.test(new TextDecoder().decode(bkOut['_rels/.rels'])), 'bambu+keep references the cover thumbnail');

// 5. Bambu + u1 → U1 profile
const bu = await convertProject(load('colored-cube.3mf'), { target: 'u1', u1Base, u1Supports });
check((await psOf(bu.bytes)).printer_model === 'Snapmaker U1', 'bambu+u1 → Snapmaker U1 profile');

// 6. OpenSCAD + u1 → U1 profile, 4 slots, paint present, filament arrays length 4
const ou = await convertProject(load('gridfinity-cup-1x1x3U-label-v1-color.3mf'), { target: 'u1', u1Base, u1Supports });
const ops = await psOf(ou.bytes);
check(ops.printer_model === 'Snapmaker U1', 'openscad+u1 → Snapmaker U1');
check(ops.filament_colour.length === 4 && ops.nozzle_diameter.length === 4, 'openscad+u1 filament arrays normalized to 4');
check(ou.summary.numSlots === 4, `openscad+u1 numSlots=${ou.summary.numSlots}`);

// 7. all outputs are valid archives
for (const [name, bytes] of [['bambu+keep', bk.bytes], ['bambu+u1', bu.bytes], ['openscad+u1', ou.bytes]]) {
  try { await unzip(bytes); check(true, `${name} produces a valid zip`); }
  catch { check(false, `${name} produces a valid zip`); }
}

console.log(ok ? '\nPASS ✅\n' : '\nFAIL ❌\n');
process.exit(ok ? 0 : 1);
