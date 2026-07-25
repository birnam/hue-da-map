// Browser entry point: drag-and-drop colored 3MF file(s), get snorca-painted 3MFs.
import { convert3mf, outputName, DEFAULT_SUFFIX } from './convert.js';

const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const suffixInput = document.getElementById('suffix');
const status = document.getElementById('status');
const result = document.getElementById('result');

// Load the working snorca templates once (served alongside this module).
const templatesReady = Promise.all([
  fetch(new URL('./templates/project_settings.base.json', import.meta.url)).then((r) => r.text()),
  fetch(new URL('./templates/slice_info.base.xml', import.meta.url)).then((r) => r.text()),
]);

function setStatus(msg, kind = '') {
  status.className = kind;
  status.textContent = msg;
}

// Strip characters that are invalid/awkward in file names; fall back to default.
function currentSuffix() {
  const raw = suffixInput.value.replace(/[\\/:*?"<>|]/g, '').trim();
  return raw;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/3mf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// Trigger downloads with a short stagger. The second+ download in quick
// succession is what makes the browser show its "Download multiple files?"
// permission prompt; once allowed, the rest proceed automatically.
async function downloadAll(items) {
  for (let i = 0; i < items.length; i++) {
    download(items[i].bytes, items[i].name);
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
}

const swatch = (hex) => `<span class="sw" style="background:${hex}"></span>`;

function fileCard({ name, summary, bytes }) {
  const rows = summary.mapping.map((m) =>
    `<tr><td>${swatch(m.input)}<code>${m.input}</code></td>` +
    `<td>slot ${m.slot} ${summary.slotColors[m.slot - 1] ? swatch(summary.slotColors[m.slot - 1]) : ''}</td></tr>`
  ).join('');
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="ok">✓ <strong>${name}</strong></div>
    <div class="meta">${summary.triangles} triangles · ${summary.inputColors.length} input color(s) → ${summary.numSlots} slot(s)</div>
    <table class="map"><tbody>${rows}</tbody></table>
    <button type="button" class="small">Download again</button>`;
  card.querySelector('button').addEventListener('click', () => download(bytes, name));
  return card;
}

function fileError(name, message) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="err">✗ <strong>${name}</strong></div><div class="meta">${message}</div>`;
  return card;
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => /\.3mf$/i.test(f.name));
  const skipped = fileList.length - files.length;
  if (!files.length) { setStatus('No .3mf files to convert.', 'err'); return; }

  result.hidden = true;
  result.innerHTML = '';
  setStatus(`Converting ${files.length} file(s)…`);

  const [settings, sliceInfo] = await templatesReady;
  const suffix = currentSuffix() || DEFAULT_SUFFIX;
  const outputs = [];
  const cards = [];

  for (const file of files) {
    try {
      const input = new Uint8Array(await file.arrayBuffer());
      const { bytes, summary } = await convert3mf(input, settings, sliceInfo);
      const name = outputName(file.name, suffix);
      const out = { name, bytes, summary };
      outputs.push(out);
      cards.push(fileCard(out));
    } catch (err) {
      console.error(file.name, err);
      cards.push(fileError(file.name, `Conversion failed: ${err.message}`));
    }
  }

  await downloadAll(outputs); // auto-trigger within the drop gesture

  const header = document.createElement('div');
  header.className = 'summary';
  const parts = [`Converted ${outputs.length}/${files.length} file(s).`];
  if (skipped) parts.push(`${skipped} non-.3mf file(s) skipped.`);
  header.innerHTML = `<div>${parts.join(' ')}</div>` +
    (outputs.length > 1 ? '<button id="all" type="button">Download all again</button>' : '');
  result.appendChild(header);
  if (outputs.length > 1) header.querySelector('#all').addEventListener('click', () => downloadAll(outputs));
  cards.forEach((c) => result.appendChild(c));
  result.hidden = false;
  setStatus('');
}

// --- drag & drop wiring ---
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

// Feature check for the native zip codec.
if (typeof DecompressionStream === 'undefined') {
  setStatus('This browser lacks the Compression Streams API. Use a recent Chrome, Edge, Firefox, or Safari.', 'err');
}
