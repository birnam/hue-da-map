// Browser entry point (phase 2): drop 3MF file(s) → interactive viewer + mapping
// matrix → Export. Multiple files are edited one at a time (a queue); an
// "Apply to all" checkbox best-effort applies the current settings to the rest.
import {
  parseAnyProject, defaultSwatches, mappingForSwatches, buildOutputBytes,
  outputName, DEFAULT_SUFFIX,
} from './convert.js';
import { Viewer } from './viewer.js';
import { MappingMatrix } from './matrix.js';
import { templatesReady } from './templates.js';

const $ = (id) => document.getElementById(id);
const drop = $('drop');
const fileInput = $('file');
const suffixInput = $('suffix');
const targetSel = $('target');
const status = $('status');
const result = $('result');
const editor = $('editor');
const canvas = $('canvas');
const matrixEl = $('matrix');
const queueLabel = $('queue');
const editInfo = $('editinfo');
const applyAll = $('applyAll');
const exportBtn = $('export');
const modeInput = $('mode-input');
const modeOutput = $('mode-output');
const viewAssemblyBtn = $('view-assembly');
const plateDd = $('plate-dd');
const plateDdBtn = $('plate-dd-btn');
const plateDdList = $('plate-dd-list');
const viewObjectSel = $('view-object');

let viewer = null;
let matrix = null;
let queue = [];        // File[]
let idx = 0;
let current = null;    // parsed project for queue[idx]
let mode = 'output';   // 'input' | 'output'
let currentView = null; // current.view (Assembly/Plate/Object preview data)
let viewMode = { type: 'all' }; // { type: 'assembly' | 'plate' | 'object' | 'all', id? }
let converted = 0;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plateIconSvg(label) {
  return `<svg viewBox="0 0 24 24" width="18" height="18"><rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">${escapeHtml(label)}</text></svg>`;
}

function plateRowHtml(plate) {
  return plateIconSvg(plate.id) + (plate.name ? `<span class="plate-name">${escapeHtml(plate.name)}</span>` : '');
}

// Bambu Studio's "duplicate object" operation gives several distinct
// top-level objects the same source name (e.g. 4 copies of one clip) — number
// them so the Objects dropdown doesn't show identical, unpickable entries.
function disambiguateNames(objects) {
  const counts = {};
  for (const o of objects) counts[o.name] = (counts[o.name] || 0) + 1;
  const seen = {};
  return objects.map((o) => {
    if (counts[o.name] <= 1) return o;
    seen[o.name] = (seen[o.name] || 0) + 1;
    return { ...o, name: `${o.name} (${seen[o.name]})` };
  });
}

function defaultModeFor(view) {
  if (view.hasAssembly) return { type: 'assembly' };
  if (view.plates.length) return { type: 'plate', id: view.plates[0].id };
  return { type: 'all' };
}

function closePlateDd() {
  plateDdList.hidden = true;
  plateDdBtn.setAttribute('aria-expanded', 'false');
}

function togglePlateDd() {
  const opening = plateDdList.hidden;
  plateDdList.hidden = !opening;
  plateDdBtn.setAttribute('aria-expanded', String(opening));
}

function updateViewModeUI(m) {
  viewAssemblyBtn.classList.toggle('active', m.type === 'assembly');
  const activePlate = m.type === 'plate';
  plateDdBtn.classList.toggle('active', activePlate);
  plateDdBtn.innerHTML = activePlate ? plateRowHtml(currentView.plates.find((p) => p.id === m.id) || {}) : 'Plates';
  viewObjectSel.value = m.type === 'object' ? m.id : '__all__';
}

// User picked a view (assembly button / plate row / object select) for the
// project already loaded in the viewer.
function applyViewMode(m) {
  viewMode = m;
  viewer.setViewMode(m);
  updateViewModeUI(m);
}

// New file loaded: populate the controls for its structure and pick the
// default view (Assembly > first Plate > Object "All"), without touching the
// viewer — the caller still needs to setProject() with this file's geometry.
function setupViewControls(view) {
  currentView = view;
  viewAssemblyBtn.hidden = !view.hasAssembly;
  plateDd.hidden = !view.plates.length;
  viewObjectSel.hidden = view.objects.length <= 1;

  plateDdList.innerHTML = '';
  for (const plate of view.plates) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.id = plate.id;
    li.innerHTML = plateRowHtml(plate);
    li.addEventListener('click', () => { applyViewMode({ type: 'plate', id: plate.id }); closePlateDd(); });
    plateDdList.appendChild(li);
  }
  closePlateDd();

  viewObjectSel.innerHTML = '<option value="__all__">All</option>'
    + disambiguateNames(view.objects).map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join('');

  viewMode = defaultModeFor(view);
  updateViewModeUI(viewMode);
}

function setStatus(msg, kind = '') { status.className = kind; status.textContent = msg; }

function currentSuffix() {
  const raw = suffixInput.value.replace(/[\\/:*?"<>|]/g, '').trim();
  return raw || DEFAULT_SUFFIX;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'model/3mf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// --- viewer coloring providers ---
function applyProvider() {
  if (!viewer) return;
  if (mode === 'input') {
    viewer.setProvider((t) => t.hex);
  } else {
    const { swatches, colorToSlot } = matrix.getState();
    viewer.setProvider((t) => swatches[colorToSlot[t.hex] - 1] || '#808080');
  }
}

function setMode(m) {
  mode = m;
  modeInput.classList.toggle('active', m === 'input');
  modeOutput.classList.toggle('active', m === 'output');
  applyProvider();
}

function refreshExportLabel() {
  const last = idx >= queue.length - 1;
  exportBtn.textContent = applyAll.checked
    ? (queue.length - idx > 1 ? `Export all ${queue.length - idx} remaining` : 'Export')
    : (last ? 'Export' : 'Export & continue');
  queueLabel.textContent = queue.length > 1 ? `File ${idx + 1} of ${queue.length}` : '';
}

async function loadCurrent() {
  const file = queue[idx];
  setStatus(`Loading ${file.name}…`);
  try {
    current = await parseAnyProject(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    console.error(err);
    setStatus(`Could not read ${file.name}: ${err.message}`, 'err');
    // Skip this file.
    if (++idx < queue.length) return loadCurrent();
    return finish();
  }

  // Reveal the editor first so the canvas has real dimensions at viewer init.
  drop.hidden = true;
  editor.hidden = false;
  result.hidden = true;

  if (!viewer) viewer = new Viewer(canvas);
  setupViewControls(current.view);
  viewer.setProject(current.view, viewMode);

  const swatches = defaultSwatches(current.definedColors, current.paintedColors);
  const colorToSlot = mappingForSwatches(current.paintedColors, swatches);
  if (!matrix) {
    matrix = new MappingMatrix(matrixEl, {
      onChange: () => { if (mode === 'output') applyProvider(); },
      onHighlight: (hex) => viewer.setHighlight(hex),
    });
  }
  matrix.setData({ inputColors: current.paintedColors, swatches, colorToSlot });
  setStatus('');
  setMode(mode);            // re-apply provider for the new model
  viewer.setHighlight(null);
  updateEditInfo();
  refreshExportLabel();
}

function updateEditInfo() {
  if (!current) { editInfo.textContent = ''; return; }
  const kind = current.kind === 'bambu' ? 'Bambu project' : 'OpenSCAD model';
  let profile;
  if (targetSel.value === 'u1') profile = '→ Snapmaker U1 profile';
  else if (current.kind === 'bambu') profile = '→ no change (⚠ keeps the source printer settings; Snapmaker OrcaSlicer may flag them — pick “Snapmaker U1” to print on a U1)';
  else profile = '→ no change (paint only; no printer/filament profile written, so slot colors come from the filaments loaded in your slicer)';
  let msg = `${kind} ${profile}`;
  if (current.complexPaintCount) msg += ` · ⚠ ${current.complexPaintCount} finely-painted triangle(s) flattened`;
  editInfo.textContent = msg;
}

// Build output bytes for a parsed project, honoring the Target Printer dropdown.
async function buildBytesFor(parsed, swatches, colorToSlot) {
  const [u1Base, u1Supports] = await templatesReady;
  return buildOutputBytes(parsed, { colorToSlot, swatches, target: targetSel.value, u1Base, u1Supports });
}

async function exportCurrent() {
  const { swatches, colorToSlot } = matrix.getState();
  const bytes = await buildBytesFor(current, swatches, colorToSlot);
  download(bytes, outputName(queue[idx].name, currentSuffix()));
  converted++;
  return { swatches, colorToSlot };
}

// Best-effort: reuse the just-edited swatches + mapping for every remaining file.
async function applyToRemaining(swatches, priorMapping) {
  for (let i = idx + 1; i < queue.length; i++) {
    try {
      const p = await parseAnyProject(new Uint8Array(await queue[i].arrayBuffer()));
      const colorToSlot = mappingForSwatches(p.paintedColors, swatches, priorMapping);
      const bytes = await buildBytesFor(p, swatches, colorToSlot);
      download(bytes, outputName(queue[i].name, currentSuffix()));
      converted++;
      await new Promise((r) => setTimeout(r, 300)); // stagger → multi-download prompt
    } catch (err) {
      console.error(queue[i].name, err);
    }
  }
}

async function onExport() {
  exportBtn.disabled = true;
  try {
    const { swatches, colorToSlot } = await exportCurrent();
    if (applyAll.checked) {
      await applyToRemaining(swatches, colorToSlot);
      return finish();
    }
    if (++idx < queue.length) { await new Promise((r) => setTimeout(r, 300)); return loadCurrent(); }
    finish();
  } finally {
    exportBtn.disabled = false;
  }
}

function finish() {
  editor.hidden = true;
  drop.hidden = false;
  result.hidden = false;
  result.innerHTML = `<div class="summary"><div>Exported ${converted} file(s).</div></div>`;
  queue = []; idx = 0; current = null;
  setStatus('');
}

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => /\.3mf$/i.test(f.name));
  if (!files.length) { setStatus('No .3mf files.', 'err'); return; }
  queue = files; idx = 0; converted = 0;
  applyAll.checked = false;
  await loadCurrent();
}

// --- wiring ---
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

modeInput.addEventListener('click', () => setMode('input'));
modeOutput.addEventListener('click', () => setMode('output'));
viewAssemblyBtn.addEventListener('click', () => applyViewMode({ type: 'assembly' }));
plateDdBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlateDd(); });
document.addEventListener('click', (e) => { if (!plateDd.contains(e.target)) closePlateDd(); });
viewObjectSel.addEventListener('change', () => {
  const v = viewObjectSel.value;
  applyViewMode(v === '__all__' ? { type: 'all' } : { type: 'object', id: v });
});
applyAll.addEventListener('change', refreshExportLabel);
targetSel.addEventListener('change', updateEditInfo);
exportBtn.addEventListener('click', onExport);

if (typeof DecompressionStream === 'undefined') {
  setStatus('This browser lacks the Compression Streams API. Use a recent Chrome, Edge, Firefox, or Safari.', 'err');
}
