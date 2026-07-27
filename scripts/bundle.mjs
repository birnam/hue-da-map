#!/usr/bin/env node
// Builds a single, dependency-free dist/index.html you can share or run from
// file:// with no server. It bundles all JS (app + vendored three.js) and
// inlines the CSS, favicon, and project-settings templates into index.html.
//
// The served build (index.html + native ES modules, used by the Dockerfile /
// `pnpm serve`) is untouched — this only produces an extra artifact.
//
//   pnpm build            → dist/index.html (minified)
//   pnpm build --debug    → dist/index.html (readable, for troubleshooting)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => path.join(root, ...parts);
const minify = !process.argv.includes('--debug');

// Swap src/templates.js (which fetches the JSON at runtime) for a version with
// the JSON baked in, so the single file needs no network. Everything else in
// the module graph bundles normally.
const inlineTemplates = {
  name: 'inline-templates',
  setup(build) {
    build.onResolve({ filter: /(^|\/)templates\.js$/ }, (args) => {
      if (!args.importer.endsWith('main.js')) return null;
      return { path: args.path, namespace: 'inline-templates' };
    });
    build.onLoad({ filter: /.*/, namespace: 'inline-templates' }, async () => {
      const [base, supports] = await Promise.all([
        readFile(p('src/templates/project_settings.base.json'), 'utf8'),
        readFile(p('src/templates/project_settings.supports.json'), 'utf8'),
      ]);
      return {
        loader: 'js',
        contents: `export const templatesReady = Promise.resolve([\n`
          + `  ${JSON.stringify(base)},\n`
          + `  ${JSON.stringify(supports)},\n`
          + `]);\n`,
      };
    });
  },
};

const result = await esbuild.build({
  entryPoints: [p('src/main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify,
  legalComments: 'none',
  write: false,
  // OrbitControls (and viewer.js) import the bare specifier "three"; the served
  // build resolves it via the <script type="importmap"> in index.html.
  alias: { three: p('src/vendor/three.module.js') },
  plugins: [inlineTemplates],
});

const js = result.outputFiles[0].text;
const css = await readFile(p('src/style.css'), 'utf8');
const favicon = await readFile(p('src/assets/gunhand.svg'), 'utf8');
const faviconUri = `data:image/svg+xml,${encodeURIComponent(favicon)}`;

// Anchor-based replacements: fail loudly if index.html drifts from what we
// expect. The function replacer inserts `value` verbatim — a plain string would
// let `$&`/`$1` sequences in the minified bundle trigger substitution.
function replace(html, needle, value) {
  if (!html.includes(needle)) {
    throw new Error(`bundle: could not find in index.html:\n  ${needle}`);
  }
  return html.replace(needle, () => value);
}

let html = await readFile(p('index.html'), 'utf8');

html = replace(
  html,
  '<link rel="icon" type="image/svg+xml" href="./src/assets/gunhand.svg" />',
  `<link rel="icon" type="image/svg+xml" href="${faviconUri}" />`,
);
html = replace(
  html,
  '<link rel="stylesheet" href="./src/style.css" />',
  `<style>\n${css}\n</style>`,
);

// Collapse the importmap + module entry into one inline script. `</script` in
// the bundle would prematurely close the tag, so neutralize it.
const importmap = '<script type="importmap">\n'
  + '    { "imports": { "three": "./src/vendor/three.module.js" } }\n'
  + '  </script>';
const entry = '<script type="module" src="./src/main.js"></script>';
const safeJs = js.replace(/<\/script/gi, '<\\/script');
html = replace(html, importmap, '');
html = replace(html, entry, `<script>\n${safeJs}\n</script>`);
// Drop the blank line the removed importmap left behind.
html = html.replace(/\n\s*\n(\s*<script>)/, '\n$1');

await mkdir(p('dist'), { recursive: true });
await writeFile(p('dist/index.html'), html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`dist/index.html — ${kb} KB${minify ? ' (minified)' : ' (debug)'}`);
