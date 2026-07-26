#!/usr/bin/env node
// CLI wrapper around the shared conversion pipeline (src/convert.js).
//
//   convert <input.3mf...> [-o [<output.3mf>]] [-s <suffix>] [-q]
//
// Output destination:
//   (no -o)              Write the generated 3MF to stdout (single input only).
//                        e.g.  convert in.3mf > out.3mf
//   -o <path>            Write to an explicit path (single input only).
//   -o        (bare)     Derive the name from the input using the suffix,
//                        e.g.  in.3mf -> in-snorcapaint.3mf  (works with many inputs).
//
// Options:
//   -s, --suffix <text>  Suffix used when deriving names (default: -snorcapaint).
//   -q, --quiet          Suppress the per-file summary (always on stderr anyway).
//   -h, --help           Show this help.
//
// Informational output goes to stderr so stdout stays a clean binary stream.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { convert3mf, outputName, DEFAULT_SUFFIX, PAINT_CODES } from '../src/convert.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Sentinel for a bare `-o` (derive the output name from the input).
const DERIVE = Symbol('derive');

function usage() {
  console.error(`Convert a colored 3MF into a Snapmaker-OrcaSlicer (snorca) paint project.

Usage:
  convert <input.3mf...> [options]

Output:
  (no -o)            Stream the result to stdout (single input).
  -o <path>          Write to an explicit path (single input).
  -o        (bare)   Derive <input><suffix>.3mf (works with multiple inputs).

Options:
  -s, --suffix <t>   Suffix for derived names (default: "${DEFAULT_SUFFIX}").
  -q, --quiet        Suppress the per-file summary.
  -h, --help         Show this help.

Examples:
  convert in.3mf -o in-U1.3mf      # explicit path
  convert in.3mf -o                # -> in-snorcapaint.3mf
  convert in.3mf                   # -> stdout
  convert in.3mf > in-U1.3mf       # -> in-U1.3mf (shell redirect)
  convert *.3mf -o -s -u1          # batch, derived names`);
}

function parseArgs(argv) {
  const inputs = [];
  let output; // undefined = stdout | DERIVE = bare -o | string = explicit path
  let suffix = DEFAULT_SUFFIX, quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    else if (a === '-q' || a === '--quiet') quiet = true;
    else if (a === '-o' || a === '--output') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) output = argv[++i];
      else output = DERIVE; // bare -o
    } else if (a.startsWith('--output=')) output = a.slice(9);
    else if (a.startsWith('-o=')) output = a.slice(3);
    else if (a === '-s' || a === '--suffix') suffix = argv[++i];
    else if (a.startsWith('--suffix=')) suffix = a.slice(9);
    else if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option: ${a}`);
    else inputs.push(a);
  }
  return { inputs, output, suffix, quiet };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (opts.help) { usage(); return; }
  if (!opts.inputs || !opts.inputs.length) { usage(); process.exit(2); }

  const toStdout = opts.output === undefined;
  const explicitPath = typeof opts.output === 'string';
  if ((toStdout || explicitPath) && opts.inputs.length > 1) {
    console.error(toStdout
      ? 'Multiple inputs require -o (bare) to derive output names; stdout takes a single input.'
      : '-o <path> can only be used with a single input; use bare -o to derive names.');
    process.exit(2);
  }
  if (toStdout && process.stdout.isTTY && !opts.quiet) {
    console.error('warning: writing binary 3MF to your terminal. Redirect (> file) or use -o.');
  }

  const info = (msg) => { if (!opts.quiet) console.error(msg); };
  const settings = readFileSync(join(ROOT, 'src/templates/project_settings.base.json'), 'utf8');
  const sliceInfo = readFileSync(join(ROOT, 'src/templates/slice_info.base.xml'), 'utf8');

  let failures = 0;
  for (const input of opts.inputs) {
    try {
      const bytes = new Uint8Array(readFileSync(input));
      const { bytes: out, summary } = await convert3mf(bytes, settings, sliceInfo);

      let dest;
      if (toStdout) {
        process.stdout.write(Buffer.from(out));
        dest = 'stdout';
      } else {
        dest = explicitPath ? opts.output : outputName(input, opts.suffix);
        writeFileSync(dest, out);
      }

      info(`\n${basename(input)} → ${dest}`);
      info(`  ${summary.triangles} triangles · ${summary.inputColors.length} input color(s) → ${summary.numSlots} slot(s)`);
      for (const m of summary.mapping) {
        info(`    ${m.input} → slot ${m.slot} (paint_color=${PAINT_CODES[m.slot] ?? 'none'})`);
      }
    } catch (e) {
      console.error(`error: ${input}: ${e.message}`);
      failures++;
    }
  }
  if (failures) process.exit(1);
}

main();
