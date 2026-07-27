// The 5-column mapping matrix.
//   row 1:        [ empty ] [ out swatch 1 ] .. [ out swatch 4 ]   (clickable → color picker)
//   rows 2..N+1:  [ in swatch ] [ radio ] [ radio ] [ radio ] [ radio ]
// Each input row is a radio group: exactly one output slot selected. Output
// swatches are editable; input swatches highlight their triangles.
import { MAX_SLOTS } from './convert.js';

export class MappingMatrix {
  constructor(container, { onChange, onHighlight } = {}) {
    this.el = container;
    this.onChange = onChange || (() => {});
    this.onHighlight = onHighlight || (() => {});
    this.inputColors = [];
    this.swatches = [];       // length MAX_SLOTS, hex | null
    this.colorToSlot = {};    // inputHex -> slot (1..MAX_SLOTS)
    this.highlighted = null;

    // Hidden color input reused for editing output swatches.
    this.picker = document.createElement('input');
    this.picker.type = 'color';
    this.picker.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;opacity:0';
    this.picker.addEventListener('input', () => {
      if (this._editing != null) {
        this.swatches[this._editing] = this.picker.value.toUpperCase();
        this.render();
        this.onChange();
      }
    });
    container.appendChild(this.picker);
  }

  setData({ inputColors, swatches, colorToSlot }) {
    this.inputColors = inputColors.slice();
    this.swatches = swatches.slice(0, MAX_SLOTS);
    while (this.swatches.length < MAX_SLOTS) this.swatches.push(null);
    this.colorToSlot = { ...colorToSlot };
    this.highlighted = null;
    this.render();
  }

  getState() {
    return { swatches: this.swatches.slice(), colorToSlot: { ...this.colorToSlot } };
  }

  _editSwatch(i) {
    this._editing = i;
    this.picker.value = this.swatches[i] || '#CCCCCC';
    this.picker.click();
  }

  _setHighlight(hex) {
    this.highlighted = this.highlighted === hex ? null : hex;
    this.render();
    this.onHighlight(this.highlighted);
  }

  render() {
    const el = this.el;
    // Preserve the picker node across re-renders.
    [...el.children].forEach((c) => { if (c !== this.picker) c.remove(); });

    const table = document.createElement('table');
    table.className = 'matrix';

    // Header row: empty corner + output swatches.
    const head = document.createElement('tr');
    head.appendChild(cell('th', '', 'corner'));
    for (let s = 0; s < MAX_SLOTS; s++) {
      const th = document.createElement('th');
      th.className = 'outhead';
      const hex = this.swatches[s];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch out' + (hex ? '' : ' empty');
      btn.title = hex ? `Slot ${s + 1}: ${hex} (click to change)` : `Slot ${s + 1}: unused (click to set)`;
      if (hex) btn.style.background = hex; else btn.textContent = 'X';
      btn.addEventListener('click', () => this._editSwatch(s));
      const label = document.createElement('div');
      label.className = 'slotnum';
      label.textContent = `slot ${s + 1}`;
      th.appendChild(btn);
      th.appendChild(label);
      head.appendChild(th);
    }
    table.appendChild(head);

    // One row per input color.
    for (const hex of this.inputColors) {
      const tr = document.createElement('tr');
      if (this.highlighted === hex) tr.className = 'hl';

      const td0 = document.createElement('td');
      td0.className = 'inhead';
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'swatch in' + (this.highlighted === hex ? ' active' : '');
      sw.style.background = hex;
      sw.title = `${hex} — click to highlight in the 3D view`;
      sw.addEventListener('click', () => this._setHighlight(hex));
      const code = document.createElement('code');
      code.textContent = hex;
      td0.appendChild(sw);
      td0.appendChild(code);
      tr.appendChild(td0);

      for (let s = 1; s <= MAX_SLOTS; s++) {
        const td = document.createElement('td');
        td.className = 'radio';
        const on = this.colorToSlot[hex] === s;
        const slotHex = this.swatches[s - 1];
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'dot' + (on ? ' on' : '');
        if (!slotHex) { dot.classList.add('disabled'); dot.disabled = true; dot.title = 'Unused slot'; }
        else { dot.title = `Map ${hex} → slot ${s}`; }
        if (on && slotHex) dot.style.background = slotHex;
        dot.addEventListener('click', () => {
          if (!slotHex) return;
          this.colorToSlot[hex] = s;
          this.render();
          this.onChange();
        });
        td.appendChild(dot);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    el.appendChild(table);
  }
}

function cell(tag, text, cls) {
  const c = document.createElement(tag);
  if (cls) c.className = cls;
  if (text) c.textContent = text;
  return c;
}
