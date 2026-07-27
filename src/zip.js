// Minimal, dependency-free ZIP reader/writer.
// Uses the native Compression Streams API (DecompressionStream / 'deflate-raw'),
// available in modern browsers and Node >= 18. Output archives are written
// STORE (uncompressed) which every 3MF reader accepts.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Parse a ZIP archive into a { name: Uint8Array } map.
 * @param {Uint8Array} buf
 */
export async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Locate End Of Central Directory (scan backwards, comment can be up to 64KB).
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip (no End Of Central Directory).');

  let count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  // Zip64: the 32-bit EOCD carries sentinels; real values live in the Zip64
  // EOCD record, located via the Zip64 EOCD locator (sig 0x07064b50) that
  // precedes the standard EOCD. (OpenSCAD's zip writer always emits these.)
  if (count === 0xffff || p === 0xffffffff) {
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x07064b50) { loc = i; break; }
    }
    if (loc < 0) throw new Error('Zip64 archive but locator not found.');
    const z64 = Number(dv.getBigUint64(loc + 8, true)); // offset of Zip64 EOCD record
    if (dv.getUint32(z64, true) !== 0x06064b50) throw new Error('Bad Zip64 EOCD record.');
    count = Number(dv.getBigUint64(z64 + 32, true));
    p = Number(dv.getBigUint64(z64 + 48, true));
  }

  const files = {};
  const dec = new TextDecoder();

  // Read a Zip64 extended-info extra field, overriding any 0xFFFFFFFF sentinels.
  const zip64Extra = (start, len, cur) => {
    let q = start;
    const end = start + len;
    while (q + 4 <= end) {
      const id = dv.getUint16(q, true);
      const size = dv.getUint16(q + 2, true);
      if (id === 0x0001) {
        let r = q + 4;
        const out = { ...cur };
        if (out.uncompSize === 0xffffffff) { out.uncompSize = Number(dv.getBigUint64(r, true)); r += 8; }
        if (out.compSize === 0xffffffff) { out.compSize = Number(dv.getBigUint64(r, true)); r += 8; }
        if (out.localOff === 0xffffffff) { out.localOff = Number(dv.getBigUint64(r, true)); r += 8; }
        return out;
      }
      q += 4 + size;
    }
    return cur;
  };

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt central directory.');
    const method = dv.getUint16(p + 10, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    let { compSize, localOff } = zip64Extra(p + 46 + nameLen, extraLen, {
      uncompSize: dv.getUint32(p + 24, true),
      compSize: dv.getUint32(p + 20, true),
      localOff: dv.getUint32(p + 42, true),
    });

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) files[name] = comp.slice();
    else if (method === 8) files[name] = await inflateRaw(comp);
    else throw new Error(`Unsupported compression method ${method} for "${name}".`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Core writer. `records` carry the final stored bytes + method/crc/uncompressed size.
function writeZip(records) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, stored, method, crc, uncompSize } of records) {
    const nameBytes = enc.encode(name);

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);          // version needed
    ldv.setUint16(6, 0, true);           // flags
    ldv.setUint16(8, method, true);      // 0 = store, 8 = deflate
    ldv.setUint16(10, 0, true);          // mod time
    ldv.setUint16(12, 0, true);          // mod date
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, stored.length, true);  // compressed size
    ldv.setUint32(22, uncompSize, true);      // uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    local.push(lh, stored);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, stored.length, true);
    cdv.setUint32(24, uncompSize, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + stored.length;
  }

  const cdStart = offset;
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, records.length, true);
  edv.setUint16(10, records.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);

  const parts = [...local, ...central, eocd];
  const total = parts.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let q = 0;
  for (const c of parts) { out.set(c, q); q += c.length; }
  return out;
}

/**
 * Build a ZIP archive (STORE) from an ordered list of entries.
 * @param {{name:string, data:Uint8Array}[]} entries
 * @returns {Uint8Array}
 */
export function zipStore(entries) {
  return writeZip(entries.map(({ name, data }) => ({ name, stored: data, method: 0, crc: crc32(data), uncompSize: data.length })));
}

/**
 * Build a ZIP archive with DEFLATE compression (per-entry best-of vs. STORE, so
 * already-compressed data like PNGs never grows). Async: uses CompressionStream.
 * @param {{name:string, data:Uint8Array}[]} entries
 * @returns {Promise<Uint8Array>}
 */
export async function zipDeflate(entries) {
  const records = [];
  for (const { name, data } of entries) {
    const crc = crc32(data);
    let stored = data, method = 0;
    if (data.length > 0) {
      const comp = await deflateRaw(data);
      if (comp.length < data.length) { stored = comp; method = 8; }
    }
    records.push({ name, stored, method, crc, uncompSize: data.length });
  }
  return writeZip(records);
}
