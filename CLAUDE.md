# Hue da Map

npm package `hue-da-map`; CLI/bin `huedamap`; Docker service/image `huedamap`. Output
filename suffix defaults to `-HdM`.

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
3. **Print profile.** ~~Placeholder Bambu profile.~~ RESOLVED in phase 3: output now
   uses the **genuine "Snapmaker U1" `project_settings.config`** extracted from bl2u1's
   `u1_template.3mf` (`src/templates/project_settings.base.json`, + supports variant),
   with only `filament_colour`/`filament_multi_colors` overridden and all `filament_*`
   arrays normalized to 4.
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

- **Editable suffix** — a text field (default `-HdM`) controls the output
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
index.html                 UI shell (+ importmap for three.js)
src/main.js                editor orchestration: drop → viewer + matrix → export queue
src/convert.js             DOM-free pipeline (see functions below)
src/zip.js                 dependency-free zip read/write (native Compression Streams; handles Zip64 input)
src/viewer.js              three.js viewer (flat per-triangle colors, input/output recolor, highlight)
src/matrix.js              the 5-column mapping matrix component
src/paint.js               Bambu/Orca paint_color decoder (solid-leaf → filament slot)
src/style.css
src/assets/gunhand.svg     favicon when project is not built to single html
src/vendor/                vendored three.js ESM (no build step)
  three.module.js, three.core.js, OrbitControls.js
src/templates/             genuine Snapmaker U1 profiles (from bl2u1's u1_template*.3mf)
  project_settings.base.json      real "Snapmaker U1" profile (549 keys)
  project_settings.supports.json  same, Tree Supports on
  slice_info.base.xml, filament_map.json (type → U1 settings-id)
bin/convert.mjs            CLI wrapper (same pipeline as the browser)
package.json               scripts + bin entry (no runtime deps)
test/sanity.mjs            Node end-to-end test + validation
test/browser-run.mjs       headless-chromium runner (Node http server + CDP, no deps)
test/browser-test.html     in-browser self-test (parse → build → matrix → viewer/WebGL)
Dockerfile, nginx.conf, docker-compose.yml
```

`convert.js` exposes the pipeline as composable stages so the CLI, tests, and the
interactive editor all reuse the exact same logic (no duplication):
`parseProject` → `planConversion` / `defaultSwatches` + `mappingForSwatches` →
`buildProjectBytes`; `convert3mf` composes them for the non-interactive path.
`convert.js`/`zip.js` are DOM-free and run under Node.

### CLI
```bash
pnpm convert <input.3mf...> [<output>] [-o [<output>]] [-s <suffix>] [-q]
# equivalently: node bin/convert.mjs ... , or the bin: huedamap ...
```
The output destination depends on `-o` / a trailing positional (`outputMode()` in
`bin/convert.mjs`): **files by default, stdout only on request.**

| Invocation | Result |
|---|---|
| `convert in.3mf` | derive into **cwd** → `./in<suffix>.3mf` (works with many inputs) |
| `convert in.3mf out.3mf` | trailing positional = output → `./out.3mf` |
| `convert in.3mf -o out.3mf` | write to the explicit path (single input) |
| `convert in.3mf -o dist/` | derive into a directory → `dist/in<suffix>.3mf` |
| `convert in.3mf -o` | bare `-o` → stream to **stdout** (single input) |
| `convert *.3mf -s -u1` | batch, derive names with a custom suffix |

- A **trailing positional** is taken as the output only when `-o` is absent and it
  is *not an existing file* — so globs of existing files stay inputs. It behaves
  exactly like `-o <same value>`.
- **Directory vs. file**: an existing directory or a trailing `/` means "derive
  names in here"; anything else is an exact filename. Missing parent directories
  are created. An explicit filename **overrides `-s`** (noted on stderr if `-s`
  was passed).
- **All informational output (summary, warnings, pnpm's own logging) goes to
  stderr**, so `> file` and pipes stay clean binary streams. `-q` silences the
  per-file summary.
- Stdout (bare `-o`) and an explicit `-o <file>` require a single input; omitting
  `-o` or giving a directory is the way to batch. Per-file failures print to
  stderr and set a non-zero exit code.
- No dependency install needed — `pnpm convert` runs the script directly.

### Run / develop
```bash
# Local dev — any static server works:
pnpm serve                       # python3 -m http.server 8080 → http://localhost:8080

# Test the conversion pipeline (no browser):
pnpm test                                             # node test/sanity.mjs (default sample)
node test/sanity.mjs gridfinity-cup-1x1x3U-label-v2.3mf

# Headless browser test (needs a `chromium` binary): parse → build → matrix → WebGL:
pnpm test:browser
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

## Phase 2 — DONE (interactive viewer + color-mapping matrix)

Dropping file(s) opens an **editor** (no auto-download in the browser); you map
colors, preview in 3D, then **Export**.

### Flow / queue (`src/main.js`)
- Files are edited **one at a time** (a queue). The Export button reads
  "Export & continue" until the last file.
- An **"Apply to all remaining"** checkbox (default off): exporting also converts
  every remaining file with the *current* swatches + mapping, no further
  interaction. Best-effort per file via `mappingForSwatches(painted, swatches,
  priorMapping)` — same slot for matching input colors, nearest for the rest.
- Downloads are staggered ~300 ms (multi-download prompt). CLI keeps instant/batch.

### 3D viewer (`src/viewer.js`, three.js, vendored)
- Non-indexed `BufferGeometry` (3 verts/triangle) → flat per-face color; orbit
  controls; Z-up; auto-fit camera.
- Overlay **Input / Output** toggle recolors via a provider: input → `tri.hex`,
  output → `swatches[colorToSlot[tri.hex]-1]`.
- `setHighlight(hex)` dims all triangles except those of one input color (driven
  by clicking an input swatch in the matrix).

### Mapping matrix (`src/matrix.js`)
Implements the spec exactly:
- Header: empty corner + 4 **output swatches** (click → color picker; `X` = unused
  slot, from `defaultSwatches`: defined materials first, supplement with painted,
  pad null).
- One row per **input color**: left swatch (click → highlight in 3D), then 4
  **radio dots** — exactly one selected per row (`colorToSlot`); dots for unused
  (`X`) slots are disabled.
- Emits `onChange` (recolor viewer in Output mode + used on export) and `onHighlight`.

### Testing
- `pnpm test` — Node pipeline/validation (unchanged).
- `pnpm test:browser` — headless chromium via CDP: parse → build → matrix render +
  interactions → viewer/WebGL. All green (needs a `chromium` binary).

**Not yet verified by a human:** the live drag-drop UX, the color-picker dialog,
and the actual file download gesture (headless can't drive these), plus opening
the result in snorca (the code↔slot verification from phase 1 still stands).

---

## Phase 3 — DONE (Bambu 3MF input + "Target Printer: Snapmaker U1")

Accept **Bambu Studio project 3MFs** in addition to OpenSCAD-colored ones, reuse our
color-mapping UI, and optionally retarget to the Snapmaker U1 — folding in the useful
part of `/home/david/projects/bl2u1` (Flask app; reviewed, not copied — clean-room, only
its Snapmaker-generated template configs reused, since its LICENSE=GPLv3/README=MIT).

### What bl2u1 does (for reference)
`convert()` streams the input zip through, **rewriting only 3 metadata files** and copying
all geometry/paint/thumbnails verbatim: replaces `project_settings.config` wholesale with
a U1 profile + filament overrides; forces `slice_info` `printer_model_id="Snapmaker U1"` +
rebuilds `<filament>` nodes; remaps `model_settings` `extruder` ids. **No geometry,
paint_color, or repositioning changes.** It has a latent bug (renumbers filaments but not
per-triangle `paint_color`), which our rebuild approach avoids.

### Our design (`src/convert.js`)
- **Auto-detect** input type: `detectInputType(files)` — `bambu` if it has
  `Metadata/project_settings.config` (or `paint_color`/components), else `openscad`.
- **`parseAnyProject(bytes)`** returns a common shape for both kinds
  (`kind, title, verts, tris{hex}, paintedColors, definedColors, rawProjectSettings,
  rawSliceInfo, hasSupport, complexPaintCount`), so the matrix + viewer are unchanged.
  Bambu: `src/paint.js` `decodePaintSlot()` turns each triangle's `paint_color` into a
  filament slot; slot→hex via the file's `filament_colour` palette; part-based color via
  `model_settings` part `extruder`.
- **Rebuild, don't patch.** Because our output is one color per triangle, every path goes
  through `buildProjectBytes` (emits fresh mesh with our `paint_color` + configs). The
  Bambu paint tree is only *decoded*, never re-encoded — so we never need a tree codec.
- **Preview thumbnails preserved.** Rebuilding would drop the input's previews, so
  `collectPreviewFiles()` carries over `Metadata/*.png` + `Auxiliaries/**` verbatim, and
  the writer re-advertises the plate image as the cover thumbnail (`_rels/.rels` +
  `model_settings` `thumbnail_file`/`top_file`/`pick_file`). `[Content_Types].xml` is
  generated to cover every preserved extension.
- **Compressed output.** `zip.js` `zipDeflate()` writes DEFLATE (per-entry best-of vs.
  store), so outputs stay small despite embedding the 34 KB U1 profile + thumbnails
  (e.g. the gridfinity U1 output is ~43 KB vs ~317 KB stored). `buildProjectBytes` is
  therefore `async`.
- **`chooseProjectSettings(parsed, target, {u1Base,u1Supports})`** selects the profile:
  OpenSCAD→U1; Bambu+`keep`→its own profile; Bambu+`u1`→U1 (supports variant if input
  had supports). `buildProjectBytes` normalizes all `filament_*` arrays to 4.
- **`convertProject(bytes, {target, u1Base, u1Supports})`** — non-interactive, used by CLI.

### UI (`index.html`, `src/main.js`)
- **Printer profile** `<select>` beside the suffix (50/50 row): `No change` (value `keep`,
  default) / `Snapmaker U1` (value `u1`). Editor uses `parseAnyProject`; export routes via
  `chooseProjectSettings`. A load-info line notes the kind, profile effect, and any
  flattened-paint warning.
- **`No change`** = do the color fix but **don't inject/modify a printer profile**:
  - OpenSCAD → **no `Metadata/project_settings.config` at all**
    (`chooseProjectSettings` returns `null`; `buildProjectBytes` omits the entry). The
    slicer keeps the presets the user already has selected, and paint slots 1-4 land on
    their loaded filaments — so **slot colors are the user's filament colors, not our
    swatches**. Pick `Snapmaker U1` if you want the palette embedded.
    - **Why not a palette-only profile?** That was the old behavior
      (`MINIMAL_PROJECT_SETTINGS`: `filament_colour`/`filament_type` only) and it was
      **wrong**: Bambu/Orca's `PresetBundle::load_config_file_config` fabricates
      print + filament + printer presets from *defaults* for **any** embedded config,
      naming them after the project file when `*_settings_id` keys are absent. Result
      in snorca: a printer profile and 4 filaments all called `(<filename>)`, plus a
      validation error — *"Relative extruder addressing requires resetting the extruder
      position at each layer… Add "G92 E0" to layer_gcode"* (default relative-E vs. the
      empty `layer_gcode` of a from-defaults printer). Adding preset ids or patching
      `layer_gcode` would only paper over a fabricated printer; the fix is to ship no
      config. *(Reported 2026-07-29 by the user from a real snorca open.)*
  - Bambu → preserve the source's own `project_settings` verbatim (only `filament_colour`
    overridden). Its printer is unchanged, so opening in the Snapmaker Orca fork may flag
    Bambu-vs-Orca schema differences (e.g. `ensure_vertical_shell_thickness
    "enabled"→"ensure_all"`, `raft_first_layer_expansion -1 not in range`). That's
    expected — **pick `Snapmaker U1` for a clean, print-ready U1 file.**
- **`Snapmaker U1`** = add/replace with the genuine U1 profile (supports variant if the
  Bambu source had supports). This is what bl2u1 always does (`combined = u1_settings.copy()`
  — no per-key migration exists to port).
- **Preview preservation:** `_rels/.rels` now **reproduces the source's own
  thumbnail/cover relationships** (`parseCoverRels`) so the original preview image is kept,
  rather than forcing the plate render; falls back to the plate image only if the source
  declared no cover. Target files are carried in `collectPreviewFiles` (incl. cover-rel
  targets). `model_settings` still points its plate thumbnails at `plate_*.png`.

### CLI: `--target keep|u1` (default `keep`), plus the `-o` rules in the CLI section above.

### Known limitations
- **Sub-triangle (brush) painting** in a Bambu file leaves the triangle's `paint_color`
  untouched (rather than remapping it) with a warning (`complexPaintCount`) — we decode
  only **solid-leaf** `paint_color` codes (slots 1-4: `none/8/0C/1C`). Codes for slots >4
  and subdivided bitstreams are not yet reverse-engineered; completing them needs
  reference files (a brush-painted, boundary-subdividing model; a >4-filament model) and
  a full encoder.

### Tests
- `pnpm test` = `test/sanity.mjs` (+ genuine U1 profile), `test/phase3.mjs` (detection,
  paint decode, input×target matrix), **and** `test/phase4.mjs` (multi-plate structure
  preservation — see Phase 4). `pnpm test:browser` adds Bambu detect/parse in headless
  chromium. **Not human-verified:** opening Bambu→U1 / Bambu→keep / OpenSCAD→U1 outputs
  in snorca.

---

## Phase 4 — DONE (multi-plate / multi-object structure preservation)

Fixed a bug where a Bambu Studio export with **multiple plates and an assembled view**
converted into a single flattened/merged object, losing every plate's layout,
orientation, and per-object base filament — because the phase-3 pipeline parsed a Bambu
project down to a flat triangle soup and always rebuilt one hardcoded object/part/plate.

### What a real multi-plate Bambu 3MF actually looks like
(reverse-engineered from a real Bambu Studio export, kept locally as `sample-multi-plate.3mf`
— **gitignored, never committed**, for copyright/licensing reasons; see "Reference
fixtures" below)
- `3D/3dmodel.model`'s `<resources>` has one **top-level "assembly" `<object>`
  per plate item**, each wrapping one or more mesh-bearing parts via
  `<components><component p:path="…" objectid="Y".../></components>` (geometry is
  de-duplicated: several assembly objects can point at the same component file/objectid,
  e.g. 4 instances of one clip).
- `<build><item objectid="X" transform="…"/></build>` places every plate's items in one
  shared coordinate space (Bambu Studio offsets each plate into its own zone rather than
  storing plates as separate files).
- `Metadata/model_settings.config` has one `<object id="X">` per assembly object
  (mirroring the root model's ids), each with a base `<metadata key="extruder"
  value="N"/>` (the whole object's default filament slot; `N="0"` = unset/implicit),
  containing one or more `<part id="Y">` (Y = the mesh object's own id inside its
  component file) with an optional **part-level** `extruder` override. A `<plate>` per
  plate groups `<model_instance>` entries (`object_id`+`instance_id`) to say which items
  belong to that plate; a single project-wide `<assemble>` block lists `<assemble_item>`
  transforms for Bambu Studio's "assembled view".
- Per-triangle `paint_color` (decoded per Phase 1) only appears for **brush-painted
  regions**; everywhere else, color comes from the part/object `extruder` metadata above.
  Object id and part id are **different id spaces** — resolving a mesh part's base color
  requires walking component→object, not just matching ids directly.

### Our fix (`src/convert.js`)
- **Stopped rebuilding from scratch for Bambu input.** Rather than flattening every
  object into a merged triangle soup and reconstructing a single-object/single-plate
  project, `buildBambuPreservingBytes()` takes the parsed project's original unzipped
  files (`parseAnyProject`'s `rawFiles`) and rewrites **only the color-bearing bits in
  place**:
  1. per-triangle `paint_color` in every model part (root + every `p:path` component),
     decoded → old slot → remapped → re-encoded (or dropped, for slot 1);
  2. every `<metadata key="extruder" value="N"/>` in `model_settings.config` (object- and
     part-level alike — a single regex pass, since the remap table is a plain
     old-slot→new-slot lookup independent of which element it's attached to);
  3. `project_settings.config`'s filament palette (same `keep`/`u1` template selection as
     Phase 3, via the new shared `applySwatchesToSettings()`/`buildOutputBytes()`).

  Every other file — plates, per-object/instance transforms, the `<assemble>` block,
  support settings, thumbnails, `cut_information.xml`, `[Content_Types].xml`, `_rels/*`
  — passes through **byte-identical**, because it's never touched, *except* the one
  compensating step below. `test/phase4.mjs` asserts the `keep` case is byte-identical,
  and that `u1` matches Orca's own repositioning (see below) within 0.01mm.
- **Per-plate bed recentering** (`recenterPlatesForBed()`), reverse-engineered by diffing
  a real Bambu Studio export against **the same file after manually switching its
  printer profile to Snapmaker U1 inside Orca Slicer** (`sample-multi-plate.3mf` vs.
  `sample-multi-plate-U1.3mf`, both gitignored local-only fixtures — see "Reference
  fixtures"). Orca does **not** apply one global shift for a bed-size change (e.g. Bambu
  P1S `printable_area` `0,0`→`256,256` vs. the genuine U1 profile's `0.5,1`→`270.5,271`).
  Instead, comparing all 7 items across the 4 plates showed each **plate's whole group**
  gets recentered:
  - the group's *current* centroid (mean of its items' XY translations) is computed,
  - and replaced by a **zone origin** in an approximately-square grid of plates: zone
    pitch = **1.2× the bed span**, zone = `bed_center + (col, -row) × pitch`, `row`/`col`
    from the plate's index (ordered by `plater_id`) into a `ceil(sqrt(numPlates))`-column
    grid.
  This reproduced Orca's own output for all 7 items to within floating-point noise
  (verified directly, not just self-consistently). `bedRectFromSettings()` reads each
  side's bed center+span from its `printable_area`; `parsePlateGroups()` reads plate→
  object-id membership from `model_settings.config`; `shiftBuildItemsXY()` applies the
  resulting per-object delta to just the XY translation of each `<item transform="...">`
  in the root model — rotation, Z, and the `<assemble>` view (a part-fit-together view,
  unrelated to bed placement) are untouched. A no-op when source and target beds are
  identical (e.g. `target: 'keep'`, where the target profile = source profile).
  **Caveat:** the grid math is verified exactly against one 4-plate reference; the
  `ceil(sqrt(numPlates))`-column generalization to other plate counts is best-effort and
  unverified beyond that.
- **Fixed a latent color-resolution bug** found while building this: the old
  `parsePartExtruders()` looked up an object's base filament by `<part id>` keyed off the
  **object's own id** — but object ids and part ids are different id spaces (confirmed
  above), so non-painted parts already silently mis-resolved to slot 1 pre-Phase-4. Fixed
  via `parseComponentGraph()` (walks `<component objectid>` to link a mesh part to its
  enclosing assembly object) + `parseExtruderMetadata()` (reads both levels), shared by
  the read path (`buildBambu`, for accurate `paintedColors`/matrix rows) and the
  write path above.
- OpenSCAD input is unaffected — it's always a single flat mesh with no plate concept,
  so it still goes through the from-scratch `buildProjectBytes()` rebuild.
- **Not yet touched: the 3D viewer.** The preview still shows the old flattened/merged
  geometry (positions may not reflect per-plate layout) — the *exported file* is now
  structurally faithful; making the on-page preview match is a follow-up.

### Reference fixtures
All `.3mf` files (including `sample-multi-plate.3mf` and `sample-multi-plate-U1.3mf`,
the latter being the former after manually switching its printer profile to Snapmaker
U1 *inside Orca Slicer* — our ground truth for the bed-recentering math above) are
**gitignored** and never committed — several are real-world downloads, and even the
synthetic ones could be mistaken for redistributed copyrighted content. Tests that need
them (`sanity.mjs`, `phase3.mjs`, `phase4.mjs`) assume they exist locally and don't skip
gracefully if missing; there's no CI. Anyone continuing this work needs their own local
copies.

### Tests
- `test/phase4.mjs` (needs local `sample-multi-plate.3mf` + `sample-multi-plate-U1.3mf`):
  detection, corrected multi-color resolution, plate/assemble/build-item/thumbnail/
  auxiliary counts and a 4-length filament palette for both `keep`/`u1` targets, `keep`
  being byte-identical to the source, `u1`'s item placement matching Orca's own U1-switch
  output (the `-U1.3mf` fixture) within 0.01mm with rotation/Z unchanged, and only
  known/re-encodable `paint_color` codes in the rewritten mesh parts.

---

## Not doing yet
- Preserving Bambu sub-triangle (brush) painting (needs the full paint bitstream codec +
  reference files) and slots >4.
- "Painted regions → separate parts" export.
- Baking object/component transforms (input assumed identity).
- Per-file mapping memory across the queue beyond the "apply to all" carry-over.
- Multi-plate-aware 3D viewer preview (Phase 4 fixed the *exported file*; the on-page
  preview still shows a flattened merge — see Phase 4).
