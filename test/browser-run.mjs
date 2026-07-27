// Self-contained headless browser test runner (Node built-ins + chromium):
// serves the repo, opens test/browser-test.html in headless chromium, polls the
// page result over the DevTools Protocol, prints it, and cleans up.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const PORT = 8097;
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

async function cdp(dbg, match) {
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
  const evaluate = (expression) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); })
    .then((m) => m.result?.result?.value);
  let out = null;
  for (let i = 0; i < 80; i++) {
    out = await evaluate(`document.body.getAttribute('data-done') ? document.getElementById('out').textContent : null`);
    if (out) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  ws.close();
  return out;
}

await new Promise((r) => server.listen(PORT, r));
chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, '--remote-debugging-port=9333',
  `http://localhost:${PORT}/test/browser-test.html`,
], { stdio: 'ignore' });

try {
  const out = await cdp('http://localhost:9333', 'browser-test.html');
  cleanup();
  if (!out) { console.error('test did not complete'); process.exit(2); }
  console.log(out);
  process.exit(/FAIL/.test(out) ? 1 : 0);
} catch (e) {
  cleanup();
  console.error('runner error:', e.message);
  process.exit(2);
}
