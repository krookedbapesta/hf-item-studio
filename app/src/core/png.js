// Minimal PNG codec (8-bit, non-interlaced) so channel data survives untouched.
// Canvas round-trips premultiply alpha, which destroys the packed normal maps the
// game uses (X stored in alpha), so all texture IO goes through this module.
import { zlibSync, unzlibSync } from '../../node_modules/fflate/esm/browser.js';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes) {
  return bytes && bytes.length > 8 && SIG.every((v, i) => bytes[i] === v);
}

/** Read width/height from a PNG header without decoding. */
export function pngSize(bytes) {
  if (!isPng(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG into RGBA8. Returns null for variants this decoder does not handle
 * (interlaced, 16-bit); callers fall back to the browser decoder for those.
 */
export function decodePng(bytes) {
  if (!isPng(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace || (depth !== 8 && !(colorType === 3 && depth <= 8) && !(colorType === 0 && depth <= 8))) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) return null;
  let total = 0;
  for (const c of idat) total += c.length;
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { joined.set(c, o); o += c.length; }
  const raw = unzlibSync(joined);
  const bitsPP = channels * depth;
  const stride = Math.ceil((width * bitsPP) / 8);
  const bpp = Math.max(1, bitsPP >> 3);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let r;
      switch (ft) {
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: r = v;
      }
      cur[x] = r & 0xff;
    }
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const d = row + x * 4;
      if (depth === 8) {
        const s = x * channels;
        if (colorType === 6) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3]; }
        else if (colorType === 2) {
          out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
          out[d + 3] = trns && trns.length >= 6 && cur[s] === trns[1] && cur[s + 1] === trns[3] && cur[s + 2] === trns[5] ? 0 : 255;
        } else if (colorType === 4) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
        else if (colorType === 0) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
        else if (colorType === 3) {
          const i = cur[s];
          out[d] = palette[i * 3]; out[d + 1] = palette[i * 3 + 1]; out[d + 2] = palette[i * 3 + 2];
          out[d + 3] = trns && i < trns.length ? trns[i] : 255;
        }
      } else {
        // sub-byte grayscale or palette
        const bit = x * depth;
        const byte = cur[bit >> 3];
        const shift = 8 - depth - (bit & 7);
        const v = (byte >> shift) & ((1 << depth) - 1);
        if (colorType === 3) {
          out[d] = palette[v * 3]; out[d + 1] = palette[v * 3 + 1]; out[d + 2] = palette[v * 3 + 2];
          out[d + 3] = trns && v < trns.length ? trns[v] : 255;
        } else {
          const g = Math.round((v * 255) / ((1 << depth) - 1));
          out[d] = out[d + 1] = out[d + 2] = g; out[d + 3] = 255;
        }
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

/** Encode RGBA8 pixels as PNG. Drops the alpha channel when it is fully opaque. */
export function encodePng(width, height, rgba, { level = 6, forceAlpha = false } = {}) {
  let opaque = !forceAlpha;
  if (opaque) for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const stride = width * ch;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // filter type 1 (Sub) per row: cheap and usually better than none
    const ro = y * (stride + 1);
    raw[ro] = 1;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = ro + 1 + x * ch;
      for (let c = 0; c < ch; c++) {
        const left = x > 0 ? rgba[s - 4 + c] : 0;
        raw[d + c] = (rgba[s + c] - left) & 0xff;
      }
    }
  }
  const comp = zlibSync(raw, { level });
  const chunks = [];
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(['IHDR', ihdr], ['IDAT', comp], ['IEND', new Uint8Array(0)]);
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  out.set(SIG, 0);
  const dv = new DataView(out.buffer);
  let p = 8;
  for (const [type, d] of chunks) {
    dv.setUint32(p, d.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(d, p + 8);
    dv.setUint32(p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

/** Box-filter / bilinear resize of RGBA8 pixels. */
export function resizeRgba(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  if (sx >= 1 && sy >= 1) {
    // area average for downscaling
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * sw + xx) * 4;
            r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
          }
        }
        const o = (y * dw + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
      }
    }
    return out;
  }
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c];
        const d = src[(y1 * sw + x0) * 4 + c], e = src[(y1 * sw + x1) * 4 + c];
        out[o + c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
      }
    }
  }
  return out;
}
