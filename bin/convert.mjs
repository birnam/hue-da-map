#!/usr/bin/env node
// CLI wrapper around the shared conversion pipeline (src/convert.js).
//
//   convert <input.3mf...> [<output>] [-o [<output>]] [-s <suffix>] [-q]
//
// Output destination:
//   (no -o)              Write <input><suffix>.3mf into the current directory,
//                        e.g.  in.3mf -> ./in-HdM.3mf  (works with many inputs).
//   -o        (bare)     Stream the generated 3MF to stdout (single input only),
//                        e.g.  convert in.3mf -o > out.3mf | ...
//   -o <file>            Write to that exact path (single input only); -s is ignored.
//   -o <dir>             Write <dir>/<input><suffix>.3mf (works with many inputs).
//   <output>             A trailing positional (file or dir) that isn't an existing
//                        file means the same as -o <output>.
//
// Options:
//   -t, --target <k>     Printer profile: "keep" = no change (default), "u1" = Snapmaker U1.
//   -s, --suffix <text>  Suffix used when deriving names (default: -HdM).
//   -q, --quiet          Suppress the per-file summary (always on stderr anyway).
//   -h, --help           Show this help.
//
// Informational output goes to stderr so stdout stays a clean binary stream.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, sep } from 'node:path';
import { convertProject, outputName, DEFAULT_SUFFIX, PAINT_CODES } from '../src/convert.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Sentinel for a bare `-o` (stream to stdout).
const STDOUT = Symbol('stdout');

function usage() {
  console.error(`Convert a colored 3MF into a Snapmaker-OrcaSlicer (snorca) paint project.

Usage:
  convert <input.3mf...> [<output>] [options]

Output:
  (no -o)            Write <input><suffix>.3mf into the current directory.
  -o        (bare)   Stream the result to stdout (single input).
  -o <file>          Write to that exact path (single input); -s is ignored.
  -o <dir>           Write <dir>/<input><suffix>.3mf.
  <output>           A trailing positional that isn't an existing file is
                     treated as <output>, exactly like -o <output>.

Options:
  -t, --target <k>   Printer profile: "keep" = no change (default), "u1" = Snapmaker U1.
  -s, --suffix <t>   Suffix for derived names (default: "${DEFAULT_SUFFIX}").
  -q, --quiet        Suppress the per-file summary.
  -h, --help         Show this help.

Examples:
  convert in.3mf                   # -> ./in-HdM.3mf
  convert in.3mf out.3mf           # -> ./out.3mf (positional output)
  convert in.3mf -o in-U1.3mf      # explicit path
  convert in.3mf -o dist/          # -> dist/in-HdM.3mf
  convert in.3mf -o | some-tool    # stream to stdout
  convert bambu.3mf -t u1          # retarget a Bambu file to Snapmaker U1
  convert *.3mf -s -u1             # batch, derived names`);
}

function parseArgs(argv) {
  const positional = [];
  let output; // undefined = derive into cwd | STDOUT = bare -o | string = path
  let suffix = DEFAULT_SUFFIX, suffixGiven = false, quiet = false, target = 'keep';
  const setTarget = (v) => { if (v !== 'keep' && v !== 'u1') throw new Error(`--target must be "keep" or "u1", got "${v}"`); target = v; };
  const setSuffix = (v) => { suffix = v; suffixGiven = true; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    else if (a === '-q' || a === '--quiet') quiet = true;
    else if (a === '-o' || a === '--output') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) output = argv[++i];
      else output = STDOUT; // bare -o
    } else if (a.startsWith('--output=')) output = a.slice(9);
    else if (a.startsWith('-o=')) output = a.slice(3);
    else if (a === '-t' || a === '--target') setTarget(argv[++i]);
    else if (a.startsWith('--target=')) setTarget(a.slice(9));
    else if (a === '-s' || a === '--suffix') setSuffix(argv[++i]);
    else if (a.startsWith('--suffix=')) setSuffix(a.slice(9));
    else if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }

  const inputs = positional;
  // With no -o, a trailing positional that isn't an existing file is the output
  // (`convert in.3mf out.3mf`). Existing files stay inputs, so batch globs work.
  if (output === undefined && positional.length > 1 && !isFile(positional[positional.length - 1])) {
    output = inputs.pop();
  }
  return { inputs, output, suffix, suffixGiven, quiet, target };
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Classify a resolved output path: an existing directory or a trailing separator
// means "put derived names in here"; anything else is an exact file path.
function outputMode(output) {
  if (output === undefined) return { kind: 'dir', dir: '' };            // cwd
  if (output === STDOUT) return { kind: 'stdout' };
  if (output.endsWith('/') || output.endsWith(sep) || isDir(output)) return { kind: 'dir', dir: output };
  return { kind: 'file', file: output };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (opts.help) { usage(); return; }
  if (!opts.inputs || !opts.inputs.length) { usage(); process.exit(2); }

  const out = outputMode(opts.output);
  if (out.kind !== 'dir' && opts.inputs.length > 1) {
    console.error(out.kind === 'stdout'
      ? 'stdout (bare -o) takes a single input; omit -o or give a directory to batch.'
      : `-o <file> can only be used with a single input; give a directory instead of "${out.file}".`);
    process.exit(2);
  }
  if (out.kind === 'stdout' && process.stdout.isTTY && !opts.quiet) {
    console.error('warning: writing binary 3MF to your terminal. Redirect (> file) or pipe it.');
  }

  const info = (msg) => { if (!opts.quiet) console.error(msg); };
  if (out.kind === 'file' && opts.suffixGiven) {
    info(`note: ignoring -s "${opts.suffix}" — explicit output name "${out.file}" wins.`);
  }
  const u1Base = readFileSync(join(ROOT, 'src/templates/project_settings.base.json'), 'utf8');
  const u1Supports = readFileSync(join(ROOT, 'src/templates/project_settings.supports.json'), 'utf8');

  let failures = 0;
  for (const input of opts.inputs) {
    try {
      const bytes = new Uint8Array(readFileSync(input));
      const { bytes: bytesOut, summary, kind, complexPaintCount } = await convertProject(bytes, { target: opts.target, u1Base, u1Supports });

      let dest;
      if (out.kind === 'stdout') {
        process.stdout.write(Buffer.from(bytesOut));
        dest = 'stdout';
      } else {
        dest = out.kind === 'file'
          ? out.file
          : join(out.dir, outputName(basename(input), opts.suffix));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytesOut);
      }

      info(`\n${basename(input)} → ${dest}  [${kind}, target=${opts.target}]`);
      info(`  ${summary.triangles} triangles · ${summary.inputColors.length} input color(s) → ${summary.numSlots} slot(s)`);
      for (const m of summary.mapping) {
        info(`    ${m.input} → slot ${m.slot} (paint_color=${PAINT_CODES[m.slot] ?? 'none'})`);
      }
      if (complexPaintCount) info(`  warning: ${complexPaintCount} finely-painted triangle(s) flattened to a solid color`);
    } catch (e) {
      console.error(`error: ${input}: ${e.message}`);
      failures++;
    }
  }
  if (failures) process.exit(1);
}

main();
