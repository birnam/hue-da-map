# 3mf-color-to-part

Convert colored 3MF files (as exported by OpenSCAD) into **Snapmaker OrcaSlicer
("snorca")** projects whose colors show up correctly, mapping an arbitrary
number of source colors down to the **4 filament slots** of a Snapmaker U1.

This is a **browser-only** tool (no server-side processing). It's packaged as a
static site served by nginx so it can run as a self-contained microservice
(e.g. a Portainer stack).

---

## Why this exists — the core problem

OpenSCAD exports color using **standard 3MF color mechanisms**:

- **`<basematerials>`** + per-triangle `pid`/`p1` (a base-material index), or
- **`<m:colorgroup>`** (material extension) + per-triangle `pid`/`p1`.

Both are spec-compliant and both put **one solid color index on each whole
triangle**. But **snorca/Bambu-derived slicers do not read either of them as
paint.** Their entire multi-color pipeline keys off a *different*, proprietary
representation:

- Per-triangle **`paint_color="<code>"`** attribute (Bambu/Orca "painting"), and
- A filament palette in **`Metadata/project_settings.config`** (`filament_colour`).

So an OpenSCAD colored 3MF opens in snorca as a **single uniform color** — the
color data is present but written in a language snorca ignores. This tool
bridges that gap: it reads the `pid`/`p1` colors and re-expresses them as
`paint_color` regions inside a proper Bambu/Orca project structure.

### Reference: two encodings side by side

| | OpenSCAD export (input) | snorca project (output) |
|---|---|---|
| Color model | `basematerials` or `m:colorgroup` | Bambu/Orca `paint_color` |
| Per-triangle | `pid="1" p1="N"` | `paint_color="<code>"` |
| Palette lives in | model XML resources | `project_settings.config` → `filament_colour` |
| File layout | single flat `3D/3dmodel.model` | multi-file: root + `3D/Objects/*.model` + `Metadata/*.config` |
| Namespace | `.../material/2015/02` | `schemas.bambulab.com/package/2021` |
| Zip | **Zip64** (OpenSCAD writer) | standard zip |

The sample files in the repo root document this:
- `gridfinity-cup-1x1x3U-label.3mf`, `-v1-basematerial.3mf` — `basematerials`, 6 colors used
- `-v1-color.3mf` — `m:colorgroup`, same 6 colors
- `-v2.3mf` — `m:colorgroup`, single color
- `colored-cube.3mf` — **a real snorca export** (the "Rosetta Stone"): the source
  of our `paint_color` codes and the `project_settings`/`model_settings` templates.

---

## Reverse-engineered facts (from `colored-cube.3mf`)

`paint_color` maps a triangle to a **filament slot**. Slot 1 is the base filament
and carries **no attribute**. Observed codes:

| Slot | `paint_color` |
|------|---------------|
| 1 | *(none)* |
| 2 | `8` |
| 3 | `0C` |
| 4 | `1C` |

These live in `src/convert.js` as `PAINT_CODES`.

⚠️ **Open items to verify in snorca (not yet confirmed on hardware/UI):**
1. **Code ↔ slot order.** The reference cube proved base + `{8, 0C, 1C}` across
   4 slots. The 1:1 pairing is *assumed monotonic*. If output colors land on the
   wrong filaments, reorder `PAINT_CODES`. (The underlying encoding is Bambu's
   `TriangleSelector` split-tree bitstream; we only ever emit "solid unsplit
   leaf" codes because our input is one color per whole triangle.)
2. **`BED_CENTER`** (`convert.js`) = `[135.5, 136]`, taken from the reference.
   Confirm the U1 plate origin; positioning is cosmetic (user can re-drop).
3. **Print profile.** Output reuses the reference's `project_settings.config`
   verbatim except for `filament_colour`/`filament_multi_colors`. The embedded
   printer/process is a Bambu profile placeholder — snorca users switch printer.
   If snorca rejects/repairs it, trim the template to essentials.
4. **Thumbnails** are intentionally omitted (snorca regenerates them). If snorca
   complains about missing previews, generate placeholder PNGs.

> The output only ever needs 4 slots (U1 has 4 toolheads), so we never need
> `paint_color` codes beyond slot 4. That earlier "need a 6-color reference"
> concern is moot for output.

---

## Phase 1 — DONE (drag-drop converter)

Drop **one or more** `.3mf` files → each converts client-side and
**auto-downloads** as `<original><suffix>.3mf`, with a per-file mapping summary
and "Download again" buttons (plus "Download all again" for batches).

- **Editable suffix** — a text field (default `-snorcapaint`) controls the output
  filename suffix; invalid filename characters are stripped.
- **Batch conversion** — multiple files can be dropped or selected at once.
  Downloads are fired with a ~300 ms stagger, which is what makes the browser
  surface its "Download multiple files?" permission prompt; once allowed, the
  rest proceed. (There is no explicit API to pre-request that permission.)

**Default color reduction** (no UI yet): discover the distinct painted colors in
first-seen order, keep the first four as filament slots, snap any extras to the
nearest slot by RGB distance. Output always defines 4 filament slots (unused
slots padded gray). Phase 2 replaces this with an interactive mapping.

### Layout
```
index.html                 UI shell
src/main.js                drag-drop, download, summary rendering (browser only)
src/convert.js             pure conversion: parse 3MF → plan mapping → build snorca project
src/zip.js                 dependency-free zip read/write (native Compression Streams; handles Zip64 input)
src/style.css
src/templates/             working snorca files lifted from colored-cube.3mf
  project_settings.base.json
  slice_info.base.xml
test/sanity.mjs            Node end-to-end test + validation
Dockerfile, nginx.conf, docker-compose.yml
```
`convert.js`/`zip.js` are DOM-free and run under Node, which is how the test
exercises the full pipeline without a browser.

### Run / develop
```bash
# Local dev — any static server works:
python3 -m http.server 8080      # then open http://localhost:8080

# Test the conversion pipeline (no browser):
node test/sanity.mjs                                   # default sample
node test/sanity.mjs gridfinity-cup-1x1x3U-label-v2.3mf
```

### Deploy (microservice / Portainer)
```bash
docker compose up -d --build      # serves on :8080
```
See `docker-compose.yml` header for Portainer options (Git-repo build vs
pre-built image).

### Browser support
Uses the native **Compression Streams API** (`DecompressionStream` /
`CompressionStream`, `deflate-raw`). Requires a recent Chrome/Edge/Firefox/Safari.
No bundler, no npm dependencies.

---

## Phase 2 — NEXT (interactive viewer + color-mapping matrix)

**Goal:** let the user control the >4 → 4 color mapping instead of the automatic
nearest-color default, with a live 3D preview.

### 3D viewer
- Render the objects from the 3MF (ignore multi-plate layouts for now — just the
  objects), painted to show the separate colors.
- Two overlay toggle buttons: **Input** and **Output**. Toggling recolors the
  objects to show either the original source coloring or the mapped output
  coloring. (Likely three.js; the mesh + per-triangle color/slot data already
  come out of `planConversion` in `convert.js` and can feed the viewer directly.)

### Mapping matrix (a 5×N grid → effectively a column of radio groups)
- **r1c1**: empty.
- **r1c2–r1c5**: the four **output** snorca filament swatches.
  - If the 3MF defines filaments/materials, the first four populate these.
  - If it defines none, use the first four **painted** colors (from
    `m:colorgroup`/`basematerials`).
  - If there are fewer than four defined filaments but more painted colors,
    supplement with painted colors.
  - If neither source has enough, show **`X`** (that slot can be ignored).
  - These swatches are **clickable → color picker**; changing one updates the 3D
    view when in **Output** mode (and rewrites `filament_colour` on export).
- **r2c1–rNc1**: the **input** color swatches (not editable). Clicking one can
  highlight the corresponding triangles in the 3D viewer. This column may exceed
  four rows (more input colors than the U1 can print).
- **Body cells (each input row × each output column)**: clickable; exactly one
  cell per row is "mapped" and filled with that output color. **One output color
  per row** → each row behaves as a **radio group** selecting the output slot for
  that input color.

Export then uses the user's chosen `input color → slot` map in place of the
automatic nearest-color logic. The plumbing point is `planConversion()` in
`src/convert.js`: keep its output shape (`colorToSlot`, `slotColors`, `numSlots`)
and let the UI supply an override.

### Likely refactor when starting phase 2
- Split parsing (`parseModelXml`/`collectGeometry`) from planning (`planConversion`)
  from serialization (already fairly separate) so the viewer and matrix can call
  parse+plan, mutate the plan, then serialize on demand.
- Expose the merged geometry (`verts`/`tris` with per-triangle input color) to the
  viewer.

---

## Not doing yet
- Multi-plate / multi-object plate layouts (just render objects).
- "Painted regions → separate parts" export (the other conversion strategy we
  discussed; more robust but more work — revisit after phase 2).
- Baking object/component transforms (input assumed identity, true for the
  OpenSCAD exports).
