// Headless-browser check for the Assembly/Plate/Object preview controls
// (index.html's #view-controls, wired in src/main.js) against a real
// multi-plate Bambu Studio export. Drives the actual app page (not a
// self-test harness) via the DevTools Protocol: drops a file, then inspects
// DOM state after each interaction.
//
// Needs sample-multi-plate.3mf and gridfinity-cup-1x1x3U-label-v1-color.3mf
// locally (both gitignored — see CLAUDE.md "Reference fixtures"). No skip
// guard, matching the other fixture-dependent tests in this repo.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const PORT = 8199;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.xml': 'text/xml', '.3mf': 'application/octet-stream' };

const server = createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(p) || !p.startsWith(ROOT)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', TYPES[extname(p)] || 'application/octet-stream');
  res.end(readFileSync(p));
});

const profile = mkdtempSync(join(tmpdir(), 'chr-'));
let chrome;
const cleanup = () => { try { chrome?.kill('SIGKILL'); } catch {} try { server.close(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };

async function connectCDP(dbg, match) {
  let target;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`${dbg}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes(match));
      if (target?.webSocketDebuggerUrl) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('target page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = (expression, awaitPromise = false) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    .then((m) => {
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || JSON.stringify(m.result.exceptionDetails));
      return m.result?.result?.value;
    });
  return { evaluate, send, close: () => ws.close() };
}

// Dispatching a synthetic drag-drop DragEvent with a script-constructed
// DataTransfer is a known-flaky way to feed files into a page under headless
// automation (Chromium's drag data store isn't reliably readable outside a
// real drag). Use the DevTools Protocol's dedicated file-input hook instead —
// the same mechanism Playwright/Puppeteer use — which is what a real user
// picking a file through the hidden <input> would produce.
async function pickFile(send, absPath) {
  const { root } = (await send('DOM.getDocument', { depth: -1 })).result;
  const { nodeId } = (await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' })).result;
  await send('DOM.setFileInputFiles', { files: [absPath], nodeId });
}

// `#file` exists in the static HTML the instant the document parses, well
// before main.js (an ES module, fetched + evaluated after parsing) has run
// and attached its 'change' listener — a ~100ms window. Dispatching into
// that window silently drops the event (no listener yet, and events aren't
// queued for later listeners), so wait for the listener itself rather than
// just the element.
async function waitForFileInputReady(send) {
  for (let i = 0; i < 100; i++) {
    const { root } = (await send('DOM.getDocument', { depth: -1 })).result;
    const q = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
    if (q.result.nodeId) {
      const resolved = await send('DOM.resolveNode', { nodeId: q.result.nodeId });
      const lst = await send('DOMDebugger.getEventListeners', { objectId: resolved.result.object.objectId });
      if ((lst.result.listeners || []).some((l) => l.type === 'change')) return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// Generous budget: building the 583k-triangle multi-plate mesh under headless
// software rendering (swiftshader) can take a while, especially back-to-back
// with the other browser-run.mjs/smoke-index.mjs chromium launches in `pnpm
// test:browser`.
async function waitFor(evaluate, expr, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let ok = true;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) ok = false; };

await new Promise((r) => server.listen(PORT, r));
chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, '--remote-debugging-port=9339',
  `http://localhost:${PORT}/index.html`,
], { stdio: 'ignore' });

try {
  const { evaluate, send, close } = await connectCDP('http://localhost:9339', 'index.html');
  check(await waitFor(evaluate, `!!document.getElementById('drop')`), 'app loaded');
  check(await waitForFileInputReady(send), 'app finished initializing (file input listener attached)');

  // --- multi-plate Bambu file: assembly + plates + objects all present ---
  await pickFile(send, join(ROOT, 'sample-multi-plate.3mf'));
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change', { bubbles: true }))`);
  check(await waitFor(evaluate, `!document.getElementById('editor').hidden`), 'editor opened for multi-plate file');
  check(await waitFor(evaluate, `document.getElementById('status').textContent === ''`), 'load finished without error');

  check(!(await evaluate(`document.getElementById('view-assembly').hidden`)), 'assembly button visible');
  check(await evaluate(`document.getElementById('view-assembly').classList.contains('active')`), 'assembly view selected by default');
  check(!(await evaluate(`document.getElementById('plate-dd').hidden`)), 'plate dropdown visible');
  check((await evaluate(`document.getElementById('plate-dd-list').children.length`)) === 4, 'plate dropdown lists 4 plates');
  check(!(await evaluate(`document.getElementById('view-object').hidden`)), 'object select visible');
  check((await evaluate(`document.getElementById('view-object').options.length`)) === 8, 'object select lists 7 objects + All');

  // Pick plate 3 ("Clip's", 4 instanced objects) from the dropdown.
  await evaluate(`document.getElementById('plate-dd-btn').click()`);
  check(!(await evaluate(`document.getElementById('plate-dd-list').hidden`)), 'plate dropdown opens on click');
  await evaluate(`document.getElementById('plate-dd-list').children[2].click()`);
  check(await evaluate(`document.getElementById('plate-dd-list').hidden`), 'plate dropdown closes after picking a plate');
  check(await evaluate(`document.getElementById('plate-dd-btn').classList.contains('active')`), 'plate button becomes active');
  check(!(await evaluate(`document.getElementById('view-assembly').classList.contains('active')`)), 'assembly button deactivates once a plate is picked');
  check((await evaluate(`document.getElementById('status').className`)) !== 'err', 'no error after switching to plate view');

  // Pick a specific object from the select.
  await evaluate(`
    const sel = document.getElementById('view-object');
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event('change'));
  `);
  check(!(await evaluate(`document.getElementById('plate-dd-btn').classList.contains('active')`)), 'plate button deactivates once an object is picked');
  check((await evaluate(`document.getElementById('status').className`)) !== 'err', 'no error after switching to object view');

  // --- single-object OpenSCAD file: no assembly/plates, and the object
  // dropdown itself (not just its "All" option) is hidden since there's
  // nothing to disambiguate. ---
  await pickFile(send, join(ROOT, 'gridfinity-cup-1x1x3U-label-v1-color.3mf'));
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change', { bubbles: true }))`);
  check(await waitFor(evaluate, `document.getElementById('status').textContent === ''`), 'load finished for single-object file');
  check(await evaluate(`document.getElementById('view-assembly').hidden`), 'assembly button hidden (no <assemble> block)');
  check(await evaluate(`document.getElementById('plate-dd').hidden`), 'plate dropdown hidden (no plates)');
  check(await evaluate(`document.getElementById('view-object').hidden`), 'object select hidden (only one object)');

  close();
  cleanup();
} catch (e) {
  cleanup();
  console.error('runner error:', e.message);
  process.exit(2);
}

console.log(ok ? '\nPASS ✅\n' : '\nFAIL ❌\n');
process.exit(ok ? 0 : 1);
