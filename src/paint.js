// Bambu/Orca `paint_color` decoding.
//
// A triangle's paint_color encodes which filament slot paints it. Bambu/Orca use
// a recursive "TriangleSelector" bitstream so a single triangle can be split into
// sub-regions of different filaments. We only need to DECODE an input triangle to
// a filament slot (our output is always one color per whole triangle, re-encoded
// by convert.js via PAINT_CODES). So this module handles the SOLID-LEAF codes
// (whole triangle = one slot) that were reverse-engineered from real snorca/Bambu
// exports:
//
//   slot 1 (base) = no attribute
//   slot 2 = "8"   slot 3 = "0C"/"C"   slot 4 = "1C"
//
// Subdivided-triangle bitstreams (fine brush painting) and codes for slots >4 are
// NOT yet reverse-engineered. Such triangles decode as { known:false } and the
// caller flattens them to a best-effort slot and surfaces a warning count, rather
// than silently mis-coloring. Completing this needs reference files (a brush-
// painted, boundary-subdividing model, and a >4-filament model) — see CLAUDE.md.

// Input solid-leaf code → filament slot (1-based). Accept the zero-padded and bare
// nibble forms both slicers emit.
const SOLID_DECODE = { '8': 2, 'C': 3, '0C': 3, '1C': 4 };

/**
 * Decode a paint_color attribute value to a filament slot.
 * @param {string|null|undefined} code
 * @returns {{slot: number|null, known: boolean}}
 *   known=false → subdivided or slot>4 (not decodable yet).
 */
export function decodePaintSlot(code) {
  if (code == null || code === '') return { slot: 1, known: true }; // base filament
  const k = String(code).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(SOLID_DECODE, k)) return { slot: SOLID_DECODE[k], known: true };
  return { slot: null, known: false };
}

export { SOLID_DECODE };
