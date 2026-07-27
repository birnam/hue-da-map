// Load the real index.html in headless chromium and assert the app module
// evaluates without uncaught exceptions and the key controls exist.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const PORT = 8098;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.xml': 'text/xml', '.3mf': 'application/octet-stream' };
const server = createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(p) || !p.startsWith(ROOT)) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('Content-Type', TYPES[extname(p)] || 'application/octet-stream');
  res.end(readFileSync(p));
});
const profile = mkdtempSync(join(tmpdir(), 'chr-'));
let chrome;
const cleanup = () => { try { chrome?.kill('SIGKILL'); } catch {} try { server.close(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--user-data-dir=${profile}`, '--remote-debugging-port=9334',
    `http://localhost:${PORT}/index.html`], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 60 && !target?.webSocketDebuggerUrl; i++) {
    try { target = (await (await fetch('http://localhost:9334/json')).json()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
  let id = 0; const pending = new Map(); const exceptions = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception');
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 1500)); // let the module load
  const evalExpr = async (ex) => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value;

  const hasControls = await evalExpr(`!!(document.getElementById('target') && document.getElementById('editinfo') && document.querySelector('#target option[value="u1"]'))`);
  const targetDefault = await evalExpr(`document.getElementById('target').value`);
  ws.close(); cleanup();

  let ok = true;
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) ok = false; };
  check(exceptions.length === 0, `no uncaught exceptions on load${exceptions.length ? ': ' + exceptions.join(' | ') : ''}`);
  check(hasControls === true, 'Target Printer control present (with U1 option)');
  check(targetDefault === 'keep', `Target defaults to "keep" (got "${targetDefault}")`);
  console.log(ok ? '\nPASS ✅\n' : '\nFAIL ❌\n');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { cleanup(); console.error('smoke error:', e.message); process.exit(2); });
