/* zumen-kit 着彩 — 最小の PSD 書き出し（自作・外部ライブラリなし）
 * PSD v1・RGB 8bit・PackBits(RLE)。層は下から上の順。名前は Pascal(ASCII) と luni(Unicode) の両方を持つ。
 * ブラウザでは window.PaintPSD、node では require('./psd.js')。
 * 参照した手順: 自作の PSD 書き出し台本（層の並び・RGB・RLE）。仕様は Adobe の公開資料 Photoshop File Format に基づく。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaintPSD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class BW {
    constructor(n) { this.b = new Uint8Array(n || 65536); this.n = 0; }
    ensure(k) {
      if (this.n + k <= this.b.length) return;
      let m = this.b.length * 2; while (m < this.n + k) m *= 2;
      const nb = new Uint8Array(m); nb.set(this.b.subarray(0, this.n)); this.b = nb;
    }
    u8(v) { this.ensure(1); this.b[this.n++] = v & 255; }
    u16(v) { this.ensure(2); this.b[this.n++] = (v >> 8) & 255; this.b[this.n++] = v & 255; }
    u32(v) { this.ensure(4); this.b[this.n++] = (v >>> 24) & 255; this.b[this.n++] = (v >>> 16) & 255; this.b[this.n++] = (v >>> 8) & 255; this.b[this.n++] = v & 255; }
    tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
    bytes(a) { this.ensure(a.length); this.b.set(a, this.n); this.n += a.length; }
    zeros(k) { this.ensure(k); this.n += k; } // 確保済みの領域は 0
    out() { return this.b.slice(0, this.n); }
  }

  /** PackBits で 1 行を符号化。dst に書き、書いた末尾位置を返す。 */
  function packBitsRow(src, len, dst, dpos) {
    let i = 0;
    while (i < len) {
      let run = 1;
      while (i + run < len && run < 128 && src[i + run] === src[i]) run++;
      if (run >= 2) { dst[dpos++] = 257 - run; dst[dpos++] = src[i]; i += run; continue; }
      const st = i; let cnt = 1; i++;
      while (i < len && cnt < 128) {
        if (i + 2 < len && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
        i++; cnt++;
      }
      dst[dpos++] = cnt - 1;
      for (let k = 0; k < cnt; k++) dst[dpos++] = src[st + k];
    }
    return dpos;
  }
  function unpackBitsRow(src, pos, end, dst, len) {
    let o = 0;
    while (pos < end && o < len) {
      const n = src[pos++]; // 0..255
      if (n < 128) { for (let k = 0; k <= n && o < len; k++) dst[o++] = src[pos++]; }
      else if (n > 128) { const v = src[pos++]; for (let k = 0; k < 257 - n && o < len; k++) dst[o++] = v; }
    }
    return pos;
  }

  /** RGBA データの 1 チャンネルを (圧縮種別2 + 行長 2*h + 行データ) に符号化。 */
  function encodePlane(rgba, w, h, ch) {
    const counts = new Uint16Array(h), tmpRow = new Uint8Array(w), enc = new Uint8Array(w * 2 + 16);
    const body = new BW(Math.max(1024, w * h >> 2));
    for (let y = 0; y < h; y++) {
      let p = (y * w) * 4 + ch;
      for (let x = 0; x < w; x++, p += 4) tmpRow[x] = rgba[p];
      const e = packBitsRow(tmpRow, w, enc, 0);
      counts[y] = e; body.ensure(e); body.b.set(enc.subarray(0, e), body.n); body.n += e;
    }
    const out = new Uint8Array(2 + h * 2 + body.n);
    out[0] = 0; out[1] = 1;
    for (let y = 0; y < h; y++) { out[2 + y * 2] = counts[y] >> 8; out[3 + y * 2] = counts[y] & 255; }
    out.set(body.b.subarray(0, body.n), 2 + h * 2);
    return out;
  }

  function asciiName(s) {
    let t = String(s || 'Layer').replace(/[^\x20-\x7e]/g, '_');
    if (!t.trim()) t = 'Layer';
    return t.slice(0, 31);
  }

  /** o: {width,height,layers:[{name,x,y,w,h,data(RGBA),opacity(0..1),visible,blend('norm'|'mul ')}],composite(RGBA, 全面)} */
  function writePSD(o) {
    const W = o.width, H = o.height, layers = o.layers || [];
    const encs = layers.map(L => [3, 0, 1, 2].map(ch => encodePlane(L.data, L.w, L.h, ch)));
    const chanIds = [-1, 0, 1, 2];
    const bw = new BW(1 << 20);
    // ヘッダ
    bw.tag('8BPS'); bw.u16(1); bw.zeros(6); bw.u16(3); bw.u32(H); bw.u32(W); bw.u16(8); bw.u16(3);
    bw.u32(0); // カラーモード
    bw.u32(0); // 画像リソース
    // 層情報
    const li = new BW(1 << 20);
    li.u16(layers.length & 0xffff);
    layers.forEach((L, k) => {
      li.u32(L.y); li.u32(L.x); li.u32(L.y + L.h); li.u32(L.x + L.w);
      li.u16(4);
      for (let c = 0; c < 4; c++) { li.u16(chanIds[c] & 0xffff); li.u32(encs[k][c].length); }
      li.tag('8BIM'); li.tag(L.blend || 'norm');
      li.u8(Math.round(Math.max(0, Math.min(1, L.opacity == null ? 1 : L.opacity)) * 255));
      li.u8(0); li.u8(L.visible === false ? 2 : 0); li.u8(0);
      // 追加情報
      const nm = asciiName(L.name), pl = 1 + nm.length, padded = Math.ceil(pl / 4) * 4;
      const uni = String(L.name || 'Layer'), ulen = 4 + uni.length * 2, upad = Math.ceil(ulen / 4) * 4;
      const extra = 4 + 4 + padded + 12 + upad;
      li.u32(extra);
      li.u32(0); li.u32(0);
      li.u8(nm.length); for (let i = 0; i < nm.length; i++) li.u8(nm.charCodeAt(i)); li.zeros(padded - pl);
      li.tag('8BIM'); li.tag('luni'); li.u32(upad);
      li.u32(uni.length); for (let i = 0; i < uni.length; i++) li.u16(uni.charCodeAt(i)); li.zeros(upad - ulen);
    });
    layers.forEach((L, k) => { for (let c = 0; c < 4; c++) li.bytes(encs[k][c]); });
    if (li.n & 1) li.u8(0);
    bw.u32(4 + li.n + 4);
    bw.u32(li.n); bw.bytes(li.b.subarray(0, li.n));
    bw.u32(0); // グローバルマスク
    // 合成画像
    bw.u16(1);
    const planes = [0, 1, 2].map(ch => encodePlane(o.composite, W, H, ch));
    for (let c = 0; c < 3; c++) bw.bytes(planes[c].subarray(2, 2 + H * 2));
    for (let c = 0; c < 3; c++) bw.bytes(planes[c].subarray(2 + H * 2));
    return bw.out();
  }

  /** 文脈と層から PSD を作る（下地・各塗り・線）。 */
  function buildDocPSD(core, ctx, layers, opts) {
    opts = opts || {};
    const W = ctx.w, H = ctx.h, out = [];
    const baseData = new Uint8ClampedArray(ctx.base); for (let i = 3; i < baseData.length; i += 4) baseData[i] = 255;
    out.push({ name: opts.baseName || 'Base', x: 0, y: 0, w: W, h: H, data: baseData, opacity: 1, visible: true, blend: 'norm' });
    for (const l of layers) {
      if (!l.mask) continue;
      const r = core.renderLayerRGBA(ctx, l);
      out.push({ name: l.name, x: r.x, y: r.y, w: r.w, h: r.h, data: r.data, opacity: l.opacity == null ? 1 : l.opacity, visible: l.visible !== false, blend: 'norm' });
    }
    if (ctx.line) out.push({ name: opts.lineName || 'Line', x: 0, y: 0, w: W, h: H, data: ctx.line, opacity: ctx.lineOpacity == null ? 1 : ctx.lineOpacity, visible: true, blend: 'mul ' });
    return writePSD({ width: W, height: H, layers: out, composite: core.flatten(ctx, layers) });
  }

  // ---- 読み戻し（試験用）。自分の書いた形式を独立に解釈して照合する ----
  function readPSD(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = 0;
    const tag = () => { const s = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]); p += 4; return s; };
    const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
    const i16 = () => { const v = dv.getInt16(p); p += 2; return v; };
    const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
    const i32 = () => { const v = dv.getInt32(p); p += 4; return v; };
    const skip32 = () => { const n = u32(); p += n; };
    const r = { layers: [] };
    r.signature = tag(); r.version = u16(); p += 6; r.channels = u16(); r.height = u32(); r.width = u32(); r.depth = u16(); r.mode = u16();
    skip32(); skip32(); // カラーモード・画像リソース
    const lmLen = u32(), lmEnd = p + lmLen;
    const liLen = u32(), liEnd = p + liLen;
    let count = i16(); count = Math.abs(count);
    const recs = [];
    for (let k = 0; k < count; k++) {
      const L = { y: i32(), x: i32() }; L.bottom = i32(); L.right = i32(); L.w = L.right - L.x; L.h = L.bottom - L.y;
      const nc = u16(); L.chans = [];
      for (let c = 0; c < nc; c++) L.chans.push({ id: i16(), len: u32() });
      tag(); L.blend = tag(); L.opacity = buf[p++]; p++; L.flags = buf[p++]; p++;
      const exLen = u32(), exEnd = p + exLen;
      skip32(); skip32();
      const nl = buf[p]; L.name = String.fromCharCode(...buf.subarray(p + 1, p + 1 + nl)); p += Math.ceil((1 + nl) / 4) * 4;
      while (p + 12 <= exEnd) {
        tag(); const key = tag(), len = u32();
        if (key === 'luni') { const n = dv.getUint32(p); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + 4 + i * 2)); L.unicodeName = s; }
        p += len;
      }
      p = exEnd; recs.push(L);
    }
    for (const L of recs) {
      L.rgba = new Uint8ClampedArray(L.w * L.h * 4);
      for (const ch of L.chans) {
        const start = p, comp = u16(); const plane = new Uint8Array(L.w * L.h);
        if (comp === 0) { plane.set(buf.subarray(p, p + L.w * L.h)); p += L.w * L.h; }
        else {
          const cnt = []; for (let y = 0; y < L.h; y++) cnt.push(u16());
          const row = new Uint8Array(L.w);
          for (let y = 0; y < L.h; y++) { unpackBitsRow(buf, p, p + cnt[y], row, L.w); plane.set(row, y * L.w); p += cnt[y]; }
        }
        p = start + ch.len;
        const ci = ch.id === -1 ? 3 : ch.id;
        for (let i = 0; i < plane.length; i++) L.rgba[i * 4 + ci] = plane[i];
      }
      r.layers.push(L);
    }
    p = liEnd; p = lmEnd;
    const comp = u16(); r.compression = comp;
    const W = r.width, H = r.height, nch = r.channels; r.composite = new Uint8ClampedArray(W * H * 4).fill(255);
    if (comp === 1) {
      const cnt = []; for (let i = 0; i < nch * H; i++) cnt.push(u16());
      const row = new Uint8Array(W);
      for (let c = 0; c < nch; c++) for (let y = 0; y < H; y++) {
        const n = cnt[c * H + y]; unpackBitsRow(buf, p, p + n, row, W); p += n;
        for (let x = 0; x < W; x++) r.composite[(y * W + x) * 4 + c] = row[x];
      }
    }
    return r;
  }

  return { writePSD, buildDocPSD, readPSD, packBitsRow, unpackBitsRow, encodePlane };
});
