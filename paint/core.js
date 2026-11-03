/* zumen-kit 着彩 — 計算の芯（DOM に触れない純粋な関数）
 * ブラウザでは window.PaintCore、node では require('./core.js')。
 * 画素は RGBA の Uint8ClampedArray（原寸）。マスクは Uint8Array（0..255）。
 * 外部ライブラリ・ネットワークなし。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaintCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TILE = 256;

  // ------------------------------------------------------------------ 小物
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function hexToRgb(h) {
    h = String(h || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  const lumOf = (r, g, b) => (r * 77 + g * 151 + b * 28) >> 8;
  function computeLum(rgba, n) {
    const o = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) o[i] = (rgba[p] * 77 + rgba[p + 1] * 151 + rgba[p + 2] * 28) >> 8;
    return o;
  }

  // ------------------------------------------------------------------ 矩形
  function rectUnion(a, b) {
    if (!a) return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
    if (!b) return { x: a.x, y: a.y, w: a.w, h: a.h };
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function rectIntersect(a, b) {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function rectClamp(r, W, H) {
    return rectIntersect(r, { x: 0, y: 0, w: W, h: H });
  }

  // ------------------------------------------------------------------ マスク
  function maskCount(d) { let c = 0; for (let i = 0; i < d.length; i++) if (d[i]) c++; return c; }
  function maskBBox(d, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const b = y * w; let first = -1, last = -1;
      for (let x = 0; x < w; x++) if (d[b + x]) { first = x; break; }
      if (first < 0) continue;
      for (let x = w - 1; x >= first; x--) if (d[b + x]) { last = x; break; }
      if (first < x0) x0 = first; if (last > x1) x1 = last;
      if (y < y0) y0 = y; y1 = y;
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  function cropMask(d, w, h) {
    const bb = maskBBox(d, w, h);
    if (!bb) return null;
    const o = new Uint8Array(bb.w * bb.h);
    for (let y = 0; y < bb.h; y++) {
      const s = (bb.y + y) * w + bb.x;
      o.set(d.subarray(s, s + bb.w), y * bb.w);
    }
    return { x: bb.x, y: bb.y, w: bb.w, h: bb.h, data: o };
  }
  function expandMask(m, W, H) {
    const o = new Uint8Array(W * H);
    if (!m) return o;
    for (let y = 0; y < m.h; y++) {
      const yy = m.y + y; if (yy < 0 || yy >= H) continue;
      for (let x = 0; x < m.w; x++) {
        const xx = m.x + x; if (xx < 0 || xx >= W) continue;
        o[yy * W + xx] = m.data[y * m.w + x];
      }
    }
    return o;
  }
  function maskUnion(dst, src) { for (let i = 0; i < dst.length; i++) if (src[i] > dst[i]) dst[i] = src[i]; return dst; }
  function maskSubtract(dst, src) {
    for (let i = 0; i < dst.length; i++) { const v = dst[i] - src[i]; dst[i] = v > 0 ? v : 0; }
    return dst;
  }
  function maskInvert(d) { for (let i = 0; i < d.length; i++) d[i] = 255 - d[i]; return d; }
  function maskCombine(dst, src, op) {
    if (op === 'add') return maskUnion(dst, src);
    if (op === 'sub') return maskSubtract(dst, src);
    dst.set(src); return dst;
  }

  /** 円を押す。hardness 0..1（1=縁まで 100%）。erase なら引く。返り値は触れた矩形。 */
  function stampCircle(d, w, h, cx, cy, r, hardness, erase) {
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
    if (x1 < x0 || y1 < y0) return null;
    const hd = clamp(hardness == null ? 1 : hardness, 0, 0.999);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (dd > 1) continue;
        let cov = dd <= hd ? 1 : (1 - dd) / (1 - hd);
        cov = cov * 255 + 0.5 | 0;
        const i = y * w + x;
        if (erase) { const v = d[i] - cov; d[i] = v > 0 ? v : 0; }
        else if (cov > d[i]) d[i] = cov;
      }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  function strokeSegment(d, w, h, x0, y0, x1, y1, r, hardness, erase) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1, r * 0.25);
    const n = Math.max(1, Math.ceil(len / step));
    let dirty = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      dirty = rectUnion(dirty, stampCircle(d, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, hardness, erase));
    }
    return dirty;
  }

  /** 多角形（偶奇規則）を縁をなめらかに塗る。pts: [[x,y],...] 画像座標。 */
  function rasterPolygon(pts, w, h) {
    const out = new Uint8Array(w * h);
    const n = pts.length;
    if (n < 3) return out;
    let ymin = Infinity, ymax = -Infinity;
    for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
    const ya = Math.max(0, Math.floor(ymin)), yb = Math.min(h - 1, Math.ceil(ymax));
    const SS = 4, acc = new Float32Array(w);
    const xs = [];
    for (let y = ya; y <= yb; y++) {
      acc.fill(0);
      for (let s = 0; s < SS; s++) {
        const sy = y + (s + 0.5) / SS;
        xs.length = 0;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
            xs.push(a[0] + (sy - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          let xa = clamp(xs[k], 0, w), xb = clamp(xs[k + 1], 0, w);
          if (xb <= xa) continue;
          const ia = Math.floor(xa), ib = Math.min(w - 1, Math.floor(xb));
          if (ia === ib) { acc[ia] += (xb - xa); continue; }
          acc[ia] += (ia + 1 - xa);
          for (let x = ia + 1; x < ib; x++) acc[x] += 1;
          if (ib < w) acc[ib] += (xb - ib);
        }
      }
      const b = y * w;
      for (let x = 0; x < w; x++) { const v = acc[x] / SS; if (v > 0) out[b + x] = Math.min(255, Math.round(v * 255)); }
    }
    return out;
  }

  // 値の連長（[個数, 値, 個数, 値 …]）。保存用。
  function encodeMaskRLE(d) {
    const out = []; const n = d.length; let i = 0;
    while (i < n) { const v = d[i]; let j = i + 1; while (j < n && d[j] === v) j++; out.push(j - i, v); i = j; }
    return out;
  }
  function decodeMaskRLE(rle, n) {
    const d = new Uint8Array(n); let p = 0;
    for (let k = 0; k + 1 < rle.length; k += 2) { const c = rle[k], v = rle[k + 1]; if (v) d.fill(v, p, p + c); p += c; }
    return d;
  }

  // ------------------------------------------------------------------ 選択（塗りつぶし・ID）
  function dilateBinary(src, w, h, r) {
    const n = w * h, tmp = new Uint8Array(n), out = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const b = y * w; let last = -1e9;
      for (let x = 0; x < w; x++) { if (src[b + x]) last = x; if (x - last <= r) tmp[b + x] = 1; }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (src[b + x]) last = x; if (last - x <= r) tmp[b + x] = 1; }
    }
    const lastRow = new Int32Array(w).fill(-1e9);
    for (let y = 0; y < h; y++) {
      const b = y * w;
      for (let x = 0; x < w; x++) { if (tmp[b + x]) lastRow[x] = y; if (y - lastRow[x] <= r) out[b + x] = 1; }
    }
    lastRow.fill(1e9);
    for (let y = h - 1; y >= 0; y--) {
      const b = y * w;
      for (let x = 0; x < w; x++) { if (tmp[b + x]) lastRow[x] = y; if (lastRow[x] - y <= r) out[b + x] = 1; }
    }
    return out;
  }

  function scanFill(w, h, sx, sy, test, out) {
    const stack = [sy * w + sx];
    while (stack.length) {
      const i = stack.pop();
      if (out[i] || !test(i)) continue;
      const y = (i / w) | 0, x = i - y * w, base = y * w;
      let xl = x; while (xl > 0 && !out[base + xl - 1] && test(base + xl - 1)) xl--;
      let xr = x; while (xr < w - 1 && !out[base + xr + 1] && test(base + xr + 1)) xr++;
      for (let k = xl; k <= xr; k++) out[base + k] = 255;
      for (let dy = -1; dy <= 1; dy += 2) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        const nb = ny * w; let inRun = false;
        for (let k = xl; k <= xr; k++) {
          const j = nb + k;
          const ok = !out[j] && test(j);
          if (ok && !inRun) { stack.push(j); inRun = true; } else if (!ok) inRun = false;
        }
      }
    }
  }

  function growConstrained(sel, line, w, h, steps) {
    let frontier = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x; if (!sel[i]) continue;
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx; if (!sel[j] && !line[j]) { edge = true; break; }
          }
        }
        if (edge) frontier.push(i);
      }
    }
    for (let s = 0; s < steps && frontier.length; s++) {
      const next = [];
      for (let q = 0; q < frontier.length; q++) {
        const i = frontier[q], y = (i / w) | 0, x = i - y * w;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!sel[j] && !line[j]) { sel[j] = 255; next.push(j); }
          }
        }
      }
      frontier = next;
    }
    return sel;
  }

  /** 自動選択（塗りつぶし）。o: {tol, lineThr, gap, lineRGBA}
   *  lineThr>0: その明るさ未満の画素を「線」＝壁として扱う。gap: 線を N px 太らせてから塗り、塗った後に N px 線へ寄せる。 */
  function floodSelect(rgba, w, h, sx, sy, o) {
    o = Object.assign({ tol: 24, lineThr: 0, gap: 0, lineRGBA: null }, o || {});
    const n = w * h;
    sx = clamp(sx | 0, 0, w - 1); sy = clamp(sy | 0, 0, h - 1);
    const out = new Uint8Array(n);
    let line = null, blocked = null;
    if (o.lineThr > 0) {
      const src = o.lineRGBA || rgba;
      line = new Uint8Array(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const a = src[p + 3];
        if (a > 40 && ((src[p] * 77 + src[p + 1] * 151 + src[p + 2] * 28) >> 8) < o.lineThr) line[i] = 1;
      }
      blocked = o.gap > 0 ? dilateBinary(line, w, h, o.gap) : line;
    }
    const si = sy * w + sx;
    if (line && line[si]) return out; // 線の上は選ばない
    let startX = sx, startY = sy;
    if (blocked && blocked[si]) {
      // 線の近傍（太らせた帯）を押した時は、近くの塗れる画素から始める
      const R = o.gap * 2 + 4; let found = false;
      for (let r = 1; r <= R && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = sx + dx, y = sy + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if (!blocked[y * w + x]) { startX = x; startY = y; found = true; break; }
          }
        }
      }
      if (!found) return out;
    }
    const p0 = si * 4, R0 = rgba[p0], G0 = rgba[p0 + 1], B0 = rgba[p0 + 2], tol = o.tol;
    const test = i => {
      if (blocked && blocked[i]) return false;
      const p = i * 4;
      let d = rgba[p] - R0; if (d < 0) d = -d; if (d > tol) return false;
      d = rgba[p + 1] - G0; if (d < 0) d = -d; if (d > tol) return false;
      d = rgba[p + 2] - B0; if (d < 0) d = -d; return d <= tol;
    };
    scanFill(w, h, startX, startY, test, out);
    if (line && o.gap > 0) growConstrained(out, line, w, h, o.gap);
    return out;
  }

  /** ID map による選択。contiguous=false なら同じ ID 色の画素をすべて。tol は JPEG 等の揺れ用。 */
  function selectByID(idRGBA, w, h, sx, sy, o) {
    o = Object.assign({ contiguous: false, tol: 0 }, o || {});
    sx = clamp(sx | 0, 0, w - 1); sy = clamp(sy | 0, 0, h - 1);
    const n = w * h, out = new Uint8Array(n), p0 = (sy * w + sx) * 4;
    const R = idRGBA[p0], G = idRGBA[p0 + 1], B = idRGBA[p0 + 2], tol = o.tol;
    const match = i => {
      const p = i * 4;
      return Math.abs(idRGBA[p] - R) <= tol && Math.abs(idRGBA[p + 1] - G) <= tol && Math.abs(idRGBA[p + 2] - B) <= tol;
    };
    if (o.contiguous) scanFill(w, h, sx, sy, match, out);
    else for (let i = 0; i < n; i++) if (match(i)) out[i] = 255;
    return out;
  }

  // ------------------------------------------------------------------ 雑音・素材
  function hash2(ix, iy, seed) {
    let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const smooth = t => t * t * (3 - 2 * t);
  function vnoise(x, y, px, py, seed) { // 周期つき（継ぎ目なし）
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const x0 = ((ix % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((iy % py) + py) % py, y1 = (y0 + 1) % py;
    const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function vnoiseFree(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fbm(u, v, base, oct, seed) {
    let s = 0, a = 1, tot = 0, p = base;
    for (let o = 0; o < oct; o++) { s += a * vnoise(u * p, v * p, p, p, seed + o * 17); tot += a; a *= 0.5; p *= 2; }
    return s / tot;
  }
  function fbmFree(x, y, oct, seed) {
    let s = 0, a = 1, tot = 0, f = 1;
    for (let o = 0; o < oct; o++) { s += a * vnoiseFree(x * f, y * f, seed + o * 13); tot += a; a *= 0.5; f *= 2; }
    return s / tot;
  }
  const _w = { d1: 9, d2: 9, id: 0 };
  function worley(u, v, N, seed) { // 周期つき
    const x = u * N, y = v * N, ix = Math.floor(x), iy = Math.floor(y);
    let d1 = 9, d2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j, wx = ((cx % N) + N) % N, wy = ((cy % N) + N) % N;
      const px = cx + 0.15 + 0.7 * hash2(wx, wy, seed), py = cy + 0.15 + 0.7 * hash2(wx, wy, seed + 101);
      const d = Math.hypot(px - x, py - y);
      if (d < d1) { d2 = d1; d1 = d; id = hash2(wx, wy, seed + 7); } else if (d < d2) d2 = d;
    }
    _w.d1 = d1; _w.d2 = d2; _w.id = id; return _w;
  }
  const mix = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const tone = (n, k, amp) => 1 + (n - 0.5) * 2 * amp * k;
  const TAU = Math.PI * 2;
  function setC(o, c, f) { o[0] = c[0] * f; o[1] = c[1] * f; o[2] = c[2] * f; }

  const MATERIALS = {
    concrete: { color: '#9d9d98', gen(u, v, X, Y, c, k, s, o) {
      const n = fbm(u, v, 4, 5, s), g = hash2(X, Y, s + 3);
      let f = tone(n, k, 0.22) + (g - 0.5) * 0.07 * k;
      if (hash2(X, Y, s + 9) > 0.994) f *= 0.72;
      setC(o, c, f);
    } },
    wood: { color: '#b0824f', gen(u, v, X, Y, c, k, s, o) {
      const pv = v * 8, pi = Math.floor(pv), pf = pv - pi;
      const jx = hash2(pi, 1, s), bu = (((u - jx) % 1) + 1) % 1 * 2, b = Math.floor(bu), bf = bu - b;
      const bid = pi * 2 + b, tn = hash2(bid, 5, s);
      const warp = fbm(u, v, 4, 3, s + bid * 3);
      const d = (pf - 0.5) * 2 + 0.55 * Math.sin(TAU * (u * 2 + hash2(bid, 6, s))) * (0.4 + 0.6 * hash2(bid, 7, s));
      const ring = 0.5 + 0.5 * Math.sin((d * 9 + warp * 5 + tn * 10) * Math.PI);
      const fibre = vnoise(u * 4, v * 64, 4, 64, s + 2);
      let f = tone(tn, k, 0.14) * (1 + (ring - 0.5) * 0.34 * k) * (1 + (fibre - 0.5) * 0.12 * k);
      if (pf < 0.025 || pf > 0.975 || bf < 0.008 || bf > 0.992) f *= 0.55;
      setC(o, c, f);
    } },
    brick: { color: '#a3503b', gen(u, v, X, Y, c, k, s, o) {
      const row = Math.floor(v * 8), rf = v * 8 - row, uu = u * 4 + ((row & 1) ? 0.5 : 0);
      const col = Math.floor(uu), cf = uu - col, cm = ((col % 4) + 4) % 4;
      const mu = 0.05, mv = 0.1;
      if (cf < mu / 2 || cf > 1 - mu / 2 || rf < mv / 2 || rf > 1 - mv / 2) {
        const f = 0.93 + 0.14 * vnoise(u * 64, v * 64, 64, 64, s + 4);
        o[0] = 198 * f; o[1] = 194 * f; o[2] = 186 * f; return;
      }
      const t = hash2(cm, row, s), n = fbm(u, v, 8, 3, s + 6);
      let f = tone(t, k, 0.22) * tone(n, k, 0.1) * (1 + (hash2(X, Y, s + 1) - 0.5) * 0.08 * k);
      const ex = Math.min(cf - mu / 2, 1 - mu / 2 - cf) * 64, ey = Math.min(rf - mv / 2, 1 - mv / 2 - rf) * 32;
      if (Math.min(ex, ey) < 1.5) f *= 0.9;
      setC(o, c, f);
    } },
    tile: { color: '#dad8d0', gen(u, v, X, Y, c, k, s, o) {
      const N = 8, cu = u * N, cv = v * N, ci = Math.floor(cu), cj = Math.floor(cv), fu = cu - ci, fv = cv - cj, g = 0.04;
      if (fu < g || fu > 1 - g || fv < g || fv > 1 - g) { const f = 0.95 + 0.1 * hash2(X, Y, s); o[0] = 150 * f; o[1] = 148 * f; o[2] = 142 * f; return; }
      const t = hash2(ci, cj, s);
      let f = tone(t, k, 0.05) * (1 + (fu + fv - 1) * 0.04 * k) * (1 + (hash2(X, Y, s + 1) - 0.5) * 0.03 * k);
      setC(o, c, f);
    } },
    stone: { color: '#8f8c84', gen(u, v, X, Y, c, k, s, o) {
      const w = worley(u, v, 5, s), gap = w.d2 - w.d1;
      if (gap < 0.05) { const f = 0.9 + 0.2 * hash2(X, Y, s); o[0] = 112 * f; o[1] = 109 * f; o[2] = 103 * f; return; }
      const n = fbm(u, v, 8, 4, s + 2);
      let f = tone(w.id, k, 0.2) * tone(n, k, 0.14) * (0.8 + 0.2 * sstep(0.05, 0.22, gap));
      setC(o, c, f);
    } },
    grass: { color: '#5e8d3e', gen(u, v, X, Y, c, k, s, o) {
      const n1 = fbm(u, v, 16, 5, s), pa = fbm(u, v, 3, 3, s + 5), bl = hash2(X, Y, s + 2);
      let f = tone(n1, k, 0.3) * (1 + (bl - 0.5) * 0.24 * k);
      const y = sstep(0.55, 0.8, pa) * 0.6;
      o[0] = c[0] * f * (1 + y * 0.5); o[1] = c[1] * f * (1 + y * 0.12); o[2] = c[2] * f * (1 - y * 0.35);
    } },
    water: { color: '#3f7fa6', gen(u, v, X, Y, c, k, s, o) {
      const q = fbm(u, v, 4, 3, s);
      const w1 = 0.5 + 0.5 * Math.sin(TAU * (2 * u + 3 * v + 0.6 * q));
      const w2 = 0.5 + 0.5 * Math.sin(TAU * (5 * u - 2 * v + 0.9 * q));
      const n = 0.6 * w1 + 0.4 * w2, hi = Math.max(0, n - 0.78) * 4.5 * k;
      const f = tone(n, k, 0.14);
      o[0] = c[0] * f + hi * 50; o[1] = c[1] * f + hi * 55; o[2] = c[2] * f + hi * 60;
    } },
    glass: { color: '#a9cad9', gen(u, v, X, Y, c, k, s, o) {
      const g = 0.92 + 0.16 * (0.5 + 0.5 * Math.sin(TAU * (u - v)));
      const b1 = Math.pow(Math.max(0, Math.sin(TAU * (u + v) + 0.5)), 12);
      const b2 = Math.pow(Math.max(0, Math.sin(TAU * (2 * u + 2 * v) + 2)), 20) * 0.6;
      const t = clamp((b1 * 0.55 + b2 * 0.4) * k, 0, 0.9);
      o[0] = mix(c[0] * g, 255, t); o[1] = mix(c[1] * g, 255, t); o[2] = mix(c[2] * g, 255, t);
    } },
    metal: { color: '#b4b7bc', gen(u, v, X, Y, c, k, s, o) {
      const st = vnoise(u * 2, v * 128, 2, 128, s), sh = 0.5 + 0.5 * Math.sin(TAU * (v + 0.25 * fbm(u, v, 2, 2, s + 1)));
      const f = (0.84 + 0.26 * sh * k) * (1 + (st - 0.5) * 0.18 * k) * (1 + (hash2(X, Y, s) - 0.5) * 0.03 * k);
      setC(o, c, f);
    } },
    plaster: { color: '#e6e2d8', gen(u, v, X, Y, c, k, s, o) {
      const n = fbm(u, v, 3, 4, s) * 0.6 + fbm(u, v, 32, 2, s + 4) * 0.4;
      setC(o, c, tone(n, k, 0.07) + (hash2(X, Y, s) - 0.5) * 0.035 * k);
    } },
    asphalt: { color: '#4b4b4e', gen(u, v, X, Y, c, k, s, o) {
      const n = fbm(u, v, 6, 4, s), h = hash2(X, Y, s + 2);
      let f = tone(n, k, 0.22);
      if (h > 0.9) f *= 1 + (h - 0.9) * 7 * k; else if (h < 0.06) f *= 0.8;
      setC(o, c, f);
    } },
    gravel: { color: '#8e8a82', gen(u, v, X, Y, c, k, s, o) {
      const w = worley(u, v, 22, s), d = w.d1;
      let f = tone(w.id, k, 0.42) * (1 - 0.55 * sstep(0.25, 0.75, d));
      if (d > 0.68) f *= 0.55;
      f *= 1 + (hash2(X, Y, s + 3) - 0.5) * 0.1 * k;
      o[0] = c[0] * f * (1 + 0.08 * (w.id - 0.5)); o[1] = c[1] * f; o[2] = c[2] * f * (1 - 0.08 * (w.id - 0.5));
    } },
  };
  const MATERIAL_KINDS = Object.keys(MATERIALS);
  const materialDefaultColor = k => (MATERIALS[k] ? MATERIALS[k].color : '#cccccc');

  function makeTile(kind, color, contrast, size, seed) {
    size = size || TILE; seed = seed == null ? 1 : seed;
    const g = MATERIALS[kind];
    if (!g) throw new Error('unknown material: ' + kind);
    const c = hexToRgb(color || g.color), k = contrast == null ? 1 : contrast;
    const data = new Uint8ClampedArray(size * size * 4), o = [0, 0, 0];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        g.gen((x + 0.5) / size, (y + 0.5) / size, x, y, c, k, seed, o);
        const p = (y * size + x) * 4;
        data[p] = o[0]; data[p + 1] = o[1]; data[p + 2] = o[2]; data[p + 3] = 255;
      }
    }
    return { w: size, h: size, data };
  }
  /** 使う人の画像を素材にする（色=乗算の色合い、コントラスト）。 */
  function prepareUserTile(img, color, contrast) {
    const c = hexToRgb(color || '#ffffff'), k = contrast == null ? 1 : contrast;
    const data = new Uint8ClampedArray(img.data.length);
    for (let p = 0; p < data.length; p += 4) {
      for (let q = 0; q < 3; q++) {
        let v = (img.data[p + q] - 128) * k + 128;
        data[p + q] = v * c[q] / 255;
      }
      data[p + 3] = 255;
    }
    return { w: img.w, h: img.h, data };
  }

  // ------------------------------------------------------------------ 遠近（射影変換）
  function solveHomography(src, dst) { // src[i] -> dst[i]（4 点）。返り値 h[0..7]（h8=1）
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const h = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
      h[r] = s / A[r][r];
    }
    return h;
  }
  function applyHomography(h, x, y) {
    const den = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / den, (h[3] * x + h[4] * y + h[5]) / den];
  }
  function quadAspect(q) {
    const d = (a, b) => Math.hypot(q[a][0] - q[b][0], q[a][1] - q[b][1]);
    const wv = (d(0, 1) + d(3, 2)) / 2, hv = (d(0, 3) + d(1, 2)) / 2;
    return wv > 0 ? hv / wv : 1;
  }

  // ------------------------------------------------------------------ 水彩の面（縁の溜まり・紙の粒・にじみ）
  function boxBlurF(src, w, h, r) {
    if (r < 1) return Float32Array.from(src);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const b = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += src[b + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[b + x] = s / win;
        s += src[b + clamp(x + r + 1, 0, w - 1)] - src[b + clamp(x - r, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / win;
        s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
      }
    }
    return out;
  }
  function wcParams(layer) {
    const p = Object.assign({ bleed: 5, edge: 0.7, grain: 0.5, seed: 1 }, layer.wc || {});
    p.bleed = clamp(Math.round(p.bleed), 1, 40); return p;
  }
  /** 水彩の被覆（にじんだ縁）と濃淡の係数。mask は {x,y,w,h,data}。 */
  function buildWatercolor(mask, W, H, p) {
    const pad = p.bleed * 2 + 3;
    const rect = rectClamp({ x: mask.x - pad, y: mask.y - pad, w: mask.w + pad * 2, h: mask.h + pad * 2 }, W, H);
    const rw = rect.w, rh = rect.h, m = new Float32Array(rw * rh);
    for (let y = 0; y < mask.h; y++) {
      const yy = mask.y + y - rect.y; if (yy < 0 || yy >= rh) continue;
      for (let x = 0; x < mask.w; x++) {
        const xx = mask.x + x - rect.x; if (xx < 0 || xx >= rw) continue;
        m[yy * rw + xx] = mask.data[y * mask.w + x] / 255;
      }
    }
    let b = boxBlurF(m, rw, rh, p.bleed); b = boxBlurF(b, rw, rh, Math.max(1, p.bleed >> 1));
    const cov = new Uint8Array(rw * rh), mod = new Uint8Array(rw * rh);
    const sc = Math.max(8, p.bleed * 4);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x, gx = x + rect.x, gy = y + rect.y;
        const wob = fbmFree(gx / sc, gy / sc, 3, p.seed * 7 + 1);
        const t = 0.5 + (wob - 0.5) * 0.7;
        const c = clamp((b[i] - t) / 0.3 + 0.5, 0, 1);
        if (c <= 0) continue;
        cov[i] = Math.round(c * 255);
        const edge = clamp((0.95 - b[i]) / 0.45, 0, 1);
        const grain = fbmFree(gx * 0.8, gy * 0.8, 2, p.seed * 5 + 2);
        const blot = fbmFree(gx / 70, gy / 70, 3, p.seed * 3 + 3);
        let f = 1 - p.edge * 0.5 * edge;
        f *= 1 - p.grain * (0.26 * (grain - 0.5) + 0.2 * (blot - 0.5) + 0.06);
        mod[i] = Math.round(clamp(f, 0, 1) * 255);
      }
    }
    return { cov: { x: rect.x, y: rect.y, w: rw, h: rh, data: cov }, mod };
  }

  // ------------------------------------------------------------------ 文脈・層
  let _uid = 1;
  const maskUid = m => (m._uid || (m._uid = _uid++));
  function createContext(o) {
    const w = o.w, h = o.h, n = w * h;
    const ctx = { w, h, base: o.base, id: o.id || null, shadow: o.shadow || null, ao: o.ao || null, line: o.line || null,
      userTex: o.userTex || {}, refMul: o.refMul || 1, lineOpacity: o.lineOpacity == null ? 1 : o.lineOpacity, _rt: new Map(), _tiles: new Map() };
    ctx.lum = computeLum(o.base, n);
    setShadeSources(ctx);
    return ctx;
  }
  function setShadeSources(ctx) {
    const n = ctx.w * ctx.h;
    if (ctx.shadow || ctx.ao) {
      const s = new Uint8Array(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        let v = 255;
        if (ctx.shadow) v = v * ((ctx.shadow[p] * 77 + ctx.shadow[p + 1] * 151 + ctx.shadow[p + 2] * 28) >> 8) / 255;
        if (ctx.ao) v = v * ((ctx.ao[p] * 77 + ctx.ao[p + 1] * 151 + ctx.ao[p + 2] * 28) >> 8) / 255;
        s[i] = v;
      }
      ctx.shade = s;
    } else ctx.shade = null;
    // 基準の明るさ：白背景（248 以上）を除いた画素の上位 98 パーセンタイル（明るい面を「色そのまま」にする）。
    // 除いた残りが 5% に満たなければ全体で数える。
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[ctx.lum[i]]++;
    let rest = 0; for (let v = 0; v < 248; v++) rest += hist[v];
    const top = rest >= n * 0.05 ? 248 : 256, tot = top === 248 ? rest : n;
    let acc = 0, ref = 255; const target = tot * 0.98;
    for (let v = 0; v < top; v++) { acc += hist[v]; if (acc >= target) { ref = v; break; } }
    ctx.ref = Math.max(60, ref);
    ctx._rt.clear();
  }

  function layerRTKey(l) {
    return JSON.stringify([l.material, l.persp || null, l.style || 'flat', l.wc || null, l.kind || '', l.rev || 0, l.gbox || null]) + '#' + (l.mask ? maskUid(l.mask) : 0) + (l.raster ? 'R' + maskUid(l.raster) : '');
  }
  function layerFullKey(l) {
    return JSON.stringify([l.visible, l.mode, l.opacity, l.amount, l.name]) + layerRTKey(l);
  }

  function getTile(ctx, mat) {
    const kind = mat.kind;
    if (kind === 'solid' || kind === 'gradient') return null;
    const contrast = mat.contrast == null ? 1 : mat.contrast;
    let key, make;
    if (kind === 'user') {
      key = 'u|' + mat.tex + '|' + mat.color + '|' + contrast;
      make = () => { const t = ctx.userTex[mat.tex]; return t ? prepareUserTile(t, mat.color, contrast) : makeTile('plaster', '#cccccc', 1); };
    } else {
      key = kind + '|' + mat.color + '|' + contrast;
      make = () => makeTile(kind, mat.color, contrast);
    }
    let t = ctx._tiles.get(key);
    if (!t) { t = make(); ctx._tiles.set(key, t); if (ctx._tiles.size > 64) ctx._tiles.delete(ctx._tiles.keys().next().value); }
    return t;
  }

  function layerCoverageRect(layer, W, H) {
    if (!layer.mask) return null;
    const m = layer.mask;
    let r = { x: m.x, y: m.y, w: m.w, h: m.h };
    if (layer.style === 'watercolor') { const pad = wcParams(layer).bleed * 2 + 3; r = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }; }
    return rectClamp(r, W, H);
  }

  function getRT(ctx, layer) {
    const key = layerRTKey(layer);
    const c = ctx._rt.get(layer.id);
    if (c && c.key === key) return c.rt;
    const mat = layer.material || { kind: 'solid', color: '#cccccc' };
    const rt = { type: 'solid', rgb: hexToRgb(mat.color), tile: null, cov: null, mod: null };
    const scale = Math.max(0.02, mat.scale || 1), rot = (mat.rot || 0) * Math.PI / 180;
    rt.ca = Math.cos(rot); rt.sa = Math.sin(rot); rt.inv = 1 / scale;
    if (mat.kind === 'gradient') {
      rt.type = 'gradient';
      rt.c1 = hexToRgb(mat.color); rt.c2 = hexToRgb(mat.color2 || mat.color); rt.c3 = mat.mid ? hexToRgb(mat.mid) : null;
      rt.radial = mat.shape === 'radial';
    } else if (mat.kind === 'raster') {
      rt.type = 'raster'; rt.raster = layer.raster || null;
    } else if (mat.kind !== 'solid') {
      rt.type = 'tile'; rt.tile = getTile(ctx, mat);
      if (layer.persp && layer.persp.quad && layer.persp.quad.length === 4) {
        const hm = solveHomography(layer.persp.quad, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        if (hm) { rt.type = 'persp'; rt.H = hm; rt.reps = (layer.persp.reps || 4) / scale; rt.aspect = quadAspect(layer.persp.quad) * (layer.persp.aspectMul || 1); }
      }
    }
    const m = layer.mask;
    if (m) {
      if (layer.style === 'watercolor') {
        const wc = buildWatercolor(m, ctx.w, ctx.h, wcParams(layer));
        rt.cov = wc.cov; rt.mod = wc.mod;
      } else rt.cov = m;
      if (rt.type === 'gradient') {
        const mm = layer.gbox || layer.mask;
        rt.gcx = mm.x + mm.w / 2; rt.gcy = mm.y + mm.h / 2;
        const ang = (mat.rot || 0) * Math.PI / 180;
        rt.gdx = Math.sin(ang); rt.gdy = Math.cos(ang);
        const ext = Math.abs(rt.gdx) * mm.w + Math.abs(rt.gdy) * mm.h; // 向きに沿った長さ
        rt.gext = rt.radial ? Math.hypot(mm.w, mm.h) / 2 : ext / 2;
        rt.gext = Math.max(1, rt.gext * scale);
        rt.midPos = clamp(mat.midPos == null ? 0.5 : mat.midPos, 0.05, 0.95);
      }
    }
    ctx._rt.set(layer.id, { key, rt });
    return rt;
  }

  /** 層の rows [ya,yb)×cols [xa,xb) の「陰影つきの色」と被覆（0..255）を buf(RGBA) に書く。被覆に不透明度は含めない。 */
  function computeLayerRows(ctx, layer, rt, ya, yb, xa, xb, buf) {
    const cov = rt.cov, W = ctx.w, bw = xb - xa;
    const mul = layer.mode === 'solid' ? 0 : 1, amt = layer.amount == null ? 1 : layer.amount;
    const shade = ctx.shade, lum = ctx.lum, ref = ctx.ref, mod = rt.mod, rmul = ctx.refMul || 1;
    const type = rt.type, ca = rt.ca, sa = rt.sa, inv = rt.inv;
    const tile = rt.tile, tw = tile ? tile.w : 0, th = tile ? tile.h : 0, td = tile ? tile.data : null;
    const rgb = rt.rgb, H = rt.H;
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const o = ((y - ya) * bw + (x - xa)) * 4;
        const ci = (y - cov.y) * cov.w + (x - cov.x);
        let a = cov.data[ci];
        if (a === 0) { buf[o + 3] = 0; continue; }
        let r, g, b;
        if (type === 'solid') { r = rgb[0]; g = rgb[1]; b = rgb[2]; }
        else if (type === 'raster') {
          const R = rt.raster, rx = x - R.x, ry = y - R.y;
          if (!R || rx < 0 || ry < 0 || rx >= R.w || ry >= R.h) { buf[o + 3] = 0; continue; }
          const q = (ry * R.w + rx) * 4, pa = R.data[q + 3];
          if (pa === 0) { buf[o + 3] = 0; continue; }
          r = R.data[q]; g = R.data[q + 1]; b = R.data[q + 2]; a = a * pa / 255;
        }
        else if (type === 'gradient') {
          let t;
          if (rt.radial) t = Math.hypot(x - rt.gcx, y - rt.gcy) / rt.gext;
          else t = ((x - rt.gcx) * rt.gdx + (y - rt.gcy) * rt.gdy) / rt.gext * 0.5 + 0.5;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          let c1 = rt.c1, c2 = rt.c2, u = t;
          if (rt.c3) { if (t < rt.midPos) { c2 = rt.c3; u = t / rt.midPos; } else { c1 = rt.c3; u = (t - rt.midPos) / (1 - rt.midPos); } }
          r = c1[0] + (c2[0] - c1[0]) * u; g = c1[1] + (c2[1] - c1[1]) * u; b = c1[2] + (c2[2] - c1[2]) * u;
        } else {
          let sx, sy;
          if (type === 'persp') {
            const den = H[6] * x + H[7] * y + 1;
            if (den < 1e-6) { buf[o + 3] = 0; continue; }
            const uu = (H[0] * x + H[1] * y + H[2]) / den, vv = (H[3] * x + H[4] * y + H[5]) / den;
            const tu = uu * rt.reps, tv = vv * rt.reps * rt.aspect;
            sx = (tu * ca + tv * sa) * tw; sy = (-tu * sa + tv * ca) * th;
          } else { sx = (x * ca + y * sa) * inv; sy = (-x * sa + y * ca) * inv; }
          const fx = Math.floor(sx), fy = Math.floor(sy), dx = sx - fx, dy = sy - fy;
          let x0 = fx % tw; if (x0 < 0) x0 += tw; let y0 = fy % th; if (y0 < 0) y0 += th;
          const x1 = x0 + 1 === tw ? 0 : x0 + 1, y1 = y0 + 1 === th ? 0 : y0 + 1;
          const p00 = (y0 * tw + x0) * 4, p10 = (y0 * tw + x1) * 4, p01 = (y1 * tw + x0) * 4, p11 = (y1 * tw + x1) * 4;
          const w00 = (1 - dx) * (1 - dy), w10 = dx * (1 - dy), w01 = (1 - dx) * dy, w11 = dx * dy;
          r = td[p00] * w00 + td[p10] * w10 + td[p01] * w01 + td[p11] * w11;
          g = td[p00 + 1] * w00 + td[p10 + 1] * w10 + td[p01 + 1] * w01 + td[p11 + 1] * w11;
          b = td[p00 + 2] * w00 + td[p10 + 2] * w10 + td[p01 + 2] * w01 + td[p11 + 2] * w11;
        }
        if (mul) {
          const i = y * W + x;
          let k = (shade ? shade[i] / 255 : lum[i] / ref) * rmul; if (k > 1) k = 1;
          k = 1 - amt * (1 - k);
          r *= k; g *= k; b *= k;
        }
        if (mod) { const f = mod[ci] / 255; r *= f; g *= f; b *= f; }
        buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
      }
    }
  }

  /** out（原寸 RGBA）の rect だけを、下地→層（下から）→線 の順に合成し直す。 */
  function compositeRegion(ctx, layers, rect, out) {
    const W = ctx.w, H = ctx.h;
    rect = rectClamp(rect, W, H); if (!rect) return null;
    const base = ctx.base;
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const p0 = (y * W + rect.x) * 4, p1 = p0 + rect.w * 4;
      for (let p = p0; p < p1; p += 4) { out[p] = base[p]; out[p + 1] = base[p + 1]; out[p + 2] = base[p + 2]; out[p + 3] = 255; }
    }
    const CH = 64; let buf = null;
    for (const layer of layers) {
      if (!layer.visible || !layer.mask) continue;
      const op = layer.opacity == null ? 1 : layer.opacity; if (op <= 0) continue;
      const rt = getRT(ctx, layer);
      const r = rectIntersect(rt.cov, rect); if (!r) continue;
      if (!buf || buf.length < r.w * CH * 4) buf = new Uint8ClampedArray(r.w * CH * 4);
      for (let ya = r.y; ya < r.y + r.h; ya += CH) {
        const yb = Math.min(r.y + r.h, ya + CH);
        computeLayerRows(ctx, layer, rt, ya, yb, r.x, r.x + r.w, buf);
        for (let y = ya; y < yb; y++) {
          for (let x = 0; x < r.w; x++) {
            const o = ((y - ya) * r.w + x) * 4, a = buf[o + 3];
            if (!a) continue;
            const al = a / 255 * op, p = (y * W + r.x + x) * 4;
            out[p] += (buf[o] - out[p]) * al; out[p + 1] += (buf[o + 1] - out[p + 1]) * al; out[p + 2] += (buf[o + 2] - out[p + 2]) * al;
          }
        }
      }
    }
    if (ctx.line) {
      const L = ctx.line, lo = ctx.lineOpacity;
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const p = (y * W + x) * 4, la = L[p + 3] / 255 * lo;
          if (la <= 0) continue;
          out[p] = out[p] * (255 + (L[p] - 255) * la) / 255;
          out[p + 1] = out[p + 1] * (255 + (L[p + 1] - 255) * la) / 255;
          out[p + 2] = out[p + 2] * (255 + (L[p + 2] - 255) * la) / 255;
        }
      }
    }
    return rect;
  }
  function flatten(ctx, layers) {
    const out = new Uint8ClampedArray(ctx.w * ctx.h * 4);
    compositeRegion(ctx, layers, { x: 0, y: 0, w: ctx.w, h: ctx.h }, out);
    return out;
  }
  /** PSD 用：層の矩形ぶんの「陰影つきの色＋被覆」を RGBA で返す（不透明度は PSD 側の値）。 */
  function renderLayerRGBA(ctx, layer) {
    const rt = getRT(ctx, layer), c = rt.cov;
    const buf = new Uint8ClampedArray(c.w * c.h * 4);
    computeLayerRows(ctx, layer, rt, c.y, c.y + c.h, c.x, c.x + c.w, buf);
    return { x: c.x, y: c.y, w: c.w, h: c.h, data: buf };
  }

  // ------------------------------------------------------------------ 保存・開き直し
  function serializeLayer(l) {
    return {
      id: l.id, name: l.name, kind: l.kind || 'fill', visible: !!l.visible, mode: l.mode, opacity: l.opacity, amount: l.amount == null ? 1 : l.amount,
      style: l.style || 'flat', wc: l.wc || null, material: l.material, persp: l.persp || null, gbox: l.gbox || null,
      mask: l.mask && !l.raster ? { x: l.mask.x, y: l.mask.y, w: l.mask.w, h: l.mask.h, rle: encodeMaskRLE(l.mask.data) } : null,
      raster: l.raster ? { x: l.raster.x, y: l.raster.y, w: l.raster.w, h: l.raster.h, b64: _b64(new Uint8Array(l.raster.data.buffer, l.raster.data.byteOffset, l.raster.data.length)) } : null,
    };
  }
  function parseLayer(o) {
    let raster = null;
    if (o.raster) raster = { x: o.raster.x, y: o.raster.y, w: o.raster.w, h: o.raster.h, data: _unb64(o.raster.b64) };
    const m = raster ? { x: raster.x, y: raster.y, w: raster.w, h: raster.h, data: new Uint8Array(raster.w * raster.h).fill(255) } : o.mask ? { x: o.mask.x, y: o.mask.y, w: o.mask.w, h: o.mask.h, data: decodeMaskRLE(o.mask.rle, o.mask.w * o.mask.h) } : null;
    return { id: o.id, name: o.name, kind: o.kind || 'fill', visible: o.visible !== false, mode: o.mode || 'multiply', opacity: o.opacity == null ? 1 : o.opacity,
      amount: o.amount == null ? 1 : o.amount, style: o.style || 'flat', wc: o.wc || null, material: o.material, persp: o.persp || null, gbox: o.gbox || null, rev: 0, mask: m, raster };
  }
  function serializeDoc(doc) {
    return JSON.stringify({
      format: 'zumen-paint', version: 1, width: doc.width, height: doc.height,
      images: doc.images, textures: doc.textures || [], layers: doc.layers.map(serializeLayer), settings: doc.settings || {},
    });
  }
  function parseDoc(text) {
    const o = typeof text === 'string' ? JSON.parse(text) : text;
    if (!o || o.format !== 'zumen-paint') throw new Error('not a zumen-paint file');
    if (o.version > 1) throw new Error('newer file version');
    return { width: o.width, height: o.height, images: o.images || {}, textures: o.textures || [], layers: (o.layers || []).map(parseLayer), settings: o.settings || {} };
  }

  // ===================================================================== 図面の着彩（平面・立面・断面）
  // 作者が課題制作で詰めた着彩の手続きを、画素の関数として移したもの。AI もネットも使わない。
  // 値は「実装の値」であり、opts で変えられる。層は RGBA の raster 層として分けて返す（線・切断面・塗り・木・影…）。
  const SHADOW_RGB = [0x3a, 0x43, 0x4d], INK_LINE = [0xf2, 0xf4, 0xec];
  const SLEN = 1 / Math.tan(64 * Math.PI / 180);
  const _photos = new Map(), _sprites = new Map(), _ptiles = new Map();
  const _clip = (v, a, b) => v < a ? a : v > b ? b : v;

  function _rng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function _hh(ix, iy, s) { let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1274126177) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
  function _vn(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = _hh(ix, iy, s), b = _hh(ix + 1, iy, s), c = _hh(ix, iy + 1, s), d = _hh(ix + 1, iy + 1, s);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  }
  /** 三段のノイズ。cell は最大の波長（画素）。 */
  function _nz(x, y, cell, s) { return _vn(x / cell, y / cell, s) * 0.6 + _vn(x / (cell * 0.5), y / (cell * 0.5), s + 7) * 0.3 + _vn(x / (cell * 0.25), y / (cell * 0.25), s + 13) * 0.1; }

  function _box(src, dst, w, h, r, horiz) {
    const n = horiz ? w : h, m = horiz ? h : w, si = horiz ? 1 : w, sj = horiz ? w : 1, inv = 1 / (2 * r + 1);
    for (let j = 0; j < m; j++) {
      const b = j * sj; let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[b + (k < 0 ? 0 : k > n - 1 ? n - 1 : k) * si];
      for (let i = 0; i < n; i++) {
        dst[b + i * si] = acc * inv;
        const a1 = i + r + 1, a0 = i - r;
        acc += src[b + (a1 > n - 1 ? n - 1 : a1) * si] - src[b + (a0 < 0 ? 0 : a0) * si];
      }
    }
  }
  /** 正規分布に近いぼかし（箱を三度）。 */
  function _blur(src, w, h, sigma) {
    const r = Math.max(1, Math.round(sigma - 0.5)); let a = Float32Array.from(src), b = new Float32Array(a.length);
    for (let k = 0; k < 3; k++) { _box(a, b, w, h, r, true); _box(b, a, w, h, r, false); }
    return a;
  }
  function _noiseField(w, h, sigma, seed) {
    const rnd = _rng(seed), f = new Float32Array(w * h); for (let i = 0; i < f.length; i++) f[i] = rnd() * 2 - 1;
    const g = _blur(f, w, h, sigma); let s = 0; for (let i = 0; i < g.length; i++) s += g[i] * g[i];
    const k = 1 / (Math.sqrt(s / g.length) + 1e-9); for (let i = 0; i < g.length; i++) g[i] *= k; return g;
  }
  function _dist(m, w, h) {
    const d = new Float32Array(w * h), INF = 1e4, B = 1.4142; for (let i = 0; i < d.length; i++) d[i] = m[i] ? INF : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let v = d[i]; if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + B); if (x < w - 1) v = Math.min(v, d[i - w + 1] + B); }
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let v = d[i]; if (!v) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + B); if (x > 0) v = Math.min(v, d[i + w - 1] + B); }
      d[i] = v;
    }
    return d;
  }
  function _morph(m, w, h, r, grow) {
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) { const q = m[y * w + k]; if (grow ? q : !q) { v = grow ? 1 : 0; break; } }
      t[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1; const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let k = a; k <= b; k++) { const q = t[k * w + x]; if (grow ? q : !q) { v = grow ? 1 : 0; break; } }
      o[y * w + x] = v;
    }
    return o;
  }
  function _label(test, w, h) {
    const lab = new Int32Array(w * h), comps = [null], st = new Int32Array(w * h); let n = 0;
    for (let s = 0; s < w * h; s++) {
      if (lab[s] || !test(s)) continue;
      n++; let sp = 0; st[sp++] = s; lab[s] = n;
      const c = { id: n, area: 0, x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0 };
      while (sp) {
        const i = st[--sp], y = (i / w) | 0, x = i - y * w; c.area++; c.sx += x; c.sy += y;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        if (x > 0 && !lab[i - 1] && test(i - 1)) { lab[i - 1] = n; st[sp++] = i - 1; }
        if (x < w - 1 && !lab[i + 1] && test(i + 1)) { lab[i + 1] = n; st[sp++] = i + 1; }
        if (y > 0 && !lab[i - w] && test(i - w)) { lab[i - w] = n; st[sp++] = i - w; }
        if (y < h - 1 && !lab[i + w] && test(i + w)) { lab[i + w] = n; st[sp++] = i + w; }
      }
      comps.push(c);
    }
    return { lab, comps };
  }

  // ---- 素材（写真の明暗だけを取る）
  /** 利用者が取り込んだ写真（素材名ごと：'concrete'＝打放し、'planks'＝木の板 …）。明暗だけを使う。img＝{w,h,data RGBA}、null で外して手続きの既定へ戻す。 */
  function registerPhoto(name, img) {
    for (const k of [..._ptiles.keys()]) if (k.startsWith(name + '|')) _ptiles.delete(k);
    if (!img) { _photos.delete(name); return; }
    const L = new Float32Array(img.w * img.h);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) L[i] = (0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]) / 255;
    _photos.set(name, { w: img.w, h: img.h, L }); for (const k of [..._ptiles.keys()]) if (k.startsWith(name + '|')) _ptiles.delete(k);
  }
  /** 利用者が取り込んだ影絵。view＝'elev'（立面の木）｜'plan'（平面の木の記号）なら name は樹種名
   *  （keyaki／konara／multi／momiji／olive／shrub）で、手続きの既定より優先する。view 無し＝人など（walk_m …）。img＝{w,h,data RGBA}、null で外す。 */
  const _spKey = (name, view) => view === 'elev' || view === 'plan' ? 'tree_' + view + ':' + name : name;
  function registerSprite(name, img, view) { const k = _spKey(name, view); if (img) _sprites.set(k, img); else _sprites.delete(k); }
  function hasSprite(name, view) { return _sprites.has(_spKey(name, view)); }
  function hasPhoto(name) { return _photos.has(name); }
  /** 写真から t×t の「明暗だけ」の板を作る：L − blur(t/6)×0.6 − mean×0.4 を標準偏差で割る（回転は 90 度刻み）。 */
  function _photoTile(name, t, rot) {
    const key = name + '|' + t + '|' + rot; let T = _ptiles.get(key); if (T) return T;
    const P = _photos.get(name), L = new Float32Array(t * t), f = P.w / t, ss = Math.max(1, Math.min(4, Math.round(f)));
    const rr = ((rot % 360) + 360) % 360;
    for (let j = 0; j < t; j++) for (let i = 0; i < t; i++) {
      let u = (i + 0.5) / t, v = (j + 0.5) / t;
      if (rr === 90) { const q = u; u = v; v = 1 - q; } else if (rr === 180) { u = 1 - u; v = 1 - v; } else if (rr === 270) { const q = u; u = 1 - v; v = q; }
      let acc = 0;
      for (let b = 0; b < ss; b++) for (let a = 0; a < ss; a++) {
        const sx = Math.min(P.w - 1, Math.floor((u + (a + 0.5 - ss / 2) / ss / t) * P.w)), sy = Math.min(P.h - 1, Math.floor((v + (b + 0.5 - ss / 2) / ss / t) * P.h));
        acc += P.L[Math.max(0, sy) * P.w + Math.max(0, sx)];
      }
      L[j * t + i] = acc / (ss * ss);
    }
    let mean = 0; for (let i = 0; i < L.length; i++) mean += L[i]; mean /= L.length;
    const g = _blur(L, t, t, t / 6); let s2 = 0;
    for (let i = 0; i < L.length; i++) { L[i] = L[i] - g[i] * 0.6 - mean * 0.4; s2 += L[i] * L[i]; }
    const k = 1 / (Math.sqrt(s2 / L.length) + 1e-6); for (let i = 0; i < L.length; i++) L[i] *= k;
    _ptiles.set(key, L); return L;
  }
  /** 素材の濃淡 d（正＝暗）。写真が無い時は手続きの壁／木目に落ちる。 */
  function _texD(spec, x, y) {
    const k = spec.k == null ? 1.6 : spec.k;
    if (spec.photo && _photos.has(spec.photo)) {
      const t = Math.max(8, Math.round(spec.tileM * spec.ppm)), L = _photoTile(spec.photo, t, spec.rot || 0);
      const cx = Math.floor(x / t), cy = Math.floor(y / t);
      const ox = spec.wood ? 0 : Math.floor(_hh(cx, cy, 11) * t), oy = Math.floor(_hh(cx, cy, 23) * t);
      const i = (((x + ox) % t) + t) % t, j = (((y + oy) % t) + t) % t;
      return -L[j * t + i] * 0.11 * k;
    }
    const p = spec.ppm;
    if (spec.wood) {
      const bw = (0.12 + 0.06 * _hh(Math.floor(x / (0.15 * p)), 3, 9)) * p, bi = Math.floor(x / bw), tone = (_hh(bi, 5, 4) * 2 - 1) * 0.9;
      const edge = Math.abs((x / bw) - bi - 0.5) > 0.47 ? 2.2 : 0, grain = _vn(x / (0.9 * p), y / (0.012 * p), 3 + (bi & 15));
      return (tone * 0.5 + edge + grain * 0.5) * 0.07 * k;
    }
    const v = 0.55 * _nz(x, y, 2.2 * p, 2) + 0.35 * _nz(x, y, 0.6 * p, 3) + 0.12 * _nz(x, y, 0.12 * p, 4) + 0.12 * _vn(x / (0.07 * p), y / (1.6 * p), 6);
    return (v * 0.10 + Math.max(0, _nz(x, y, 0.02 * p + 2, 8)) * 0.05) * k * 0.9;
  }
  /** 下地の色の上へ素材の明暗を載せて R(RGBA) に書く。mask の画素だけ。 */
  function _paintTex(R, W, mask, spec, x0, y0, x1, y1) {
    const base = spec.base, dk = spec.dark;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x; if (!mask[i]) continue;
      const d = _texD(spec, x, y), p = i * 4; let r = base[0], g = base[1], b = base[2];
      if (d > 0) { const a = _clip(d, 0, 0.40); r += (dk[0] - r) * a; g += (dk[1] - g) * a; b += (dk[2] - b) * a; }
      else { const a = _clip(-0.75 * d, 0, 0.40); r += (255 - r) * a; g += (255 - g) * a; b += (255 - b) * a; }
      R[p] = r; R[p + 1] = g; R[p + 2] = b; R[p + 3] = 255;
    }
  }
  const SPEC_CONC = ppm => ({ photo: 'concrete', tileM: 4.0, rot: 0, ppm, k: 1.0, base: [208, 207, 202], dark: [86, 84, 80] });
  const SPEC_WOOD = ppm => ({ photo: 'planks', tileM: 2.0, rot: 90, ppm, k: 1.5, wood: true, base: [132, 118, 104], dark: [58, 50, 44] });

  // ---- 水彩の塗り（同じ色の面に むら・縁の溜まり・粒。泡は入れない）
  function _wash(R, W, H, mask, rgb, k, seed, x0, y0, x1, y1) {
    const sz = Math.max(W, H), big = _noiseField(W, H, sz * 0.035, seed), med = _noiseField(W, H, sz * 0.010, seed + 1), fine = _noiseField(W, H, 0.8, seed + 2);
    const dist = _dist(mask, W, H), pr = Math.max(sz * 0.004, 1.5);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x; if (!mask[i]) continue;
      const pool = Math.exp(-dist[i] / pr), gran = Math.max(0, fine[i]) * _clip(0.5 + 0.5 * med[i], 0, 1);
      const dark = (0.10 * Math.max(0, big[i]) + 0.05 * Math.max(0, med[i]) + 0.20 * pool + 0.05 * gran) * k;
      const light = (0.10 * Math.max(0, -big[i]) + 0.05 * Math.max(0, -med[i])) * k;
      const ad = _clip(dark, 0, 0.45), al = _clip(light, 0, 0.30), p = i * 4;
      let r = rgb[0], g = rgb[1], b = rgb[2];
      r += (r * 0.80 - r) * ad; g += (g * 0.82 - g) * ad; b += (b * 0.80 - b) * ad;
      r += (255 - r) * al; g += (255 - g) * al; b += (255 - b) * al;
      R[p] = r; R[p + 1] = g; R[p + 2] = b; R[p + 3] = 255;
    }
  }

  // ---- 影：足跡を方向へ動かした和集合（倍々の移動）
  function _sweep(F, W, H, dx, dy, len) {
    let S = Uint8Array.from(F), cover = 1;
    const shift = (A, sx, sy) => {
      const B = Uint8Array.from(A);
      for (let y = 0; y < H; y++) { const ty = y + sy; if (ty < 0 || ty >= H) continue; for (let x = 0; x < W; x++) { if (!A[y * W + x]) continue; const tx = x + sx; if (tx >= 0 && tx < W) B[ty * W + tx] = 1; } }
      return B;
    };
    while (cover * 2 <= len + 1) { S = shift(S, Math.round(cover * dx), Math.round(cover * dy)); cover *= 2; }
    if (cover < len + 1) S = shift(S, Math.round((len + 1 - cover) * dx), Math.round((len + 1 - cover) * dy));
    return S;
  }
  function _alphaRGBA(A, W, H, rgb, scale) {
    const R = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < A.length; i++) { const a = A[i] * scale; if (a > 0.004) { R[i * 4] = rgb[0]; R[i * 4 + 1] = rgb[1]; R[i * 4 + 2] = rgb[2]; R[i * 4 + 3] = _clip(a, 0, 1) * 255; } }
    return R;
  }

  // ---- 合成の小道具（straight alpha の over）
  function _over(R, p, r, g, b, a) {
    if (a <= 0) return; const A = R[p + 3] / 255, o = a + A * (1 - a);
    R[p] = (r * a + R[p] * A * (1 - a)) / o; R[p + 1] = (g * a + R[p + 1] * A * (1 - a)) / o; R[p + 2] = (b * a + R[p + 2] * A * (1 - a)) / o; R[p + 3] = o * 255;
  }
  function _seg(R, W, H, ax, ay, bx, by, lw, rgb, al) {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - lw - 1)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + lw + 1));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - lw - 1)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + lw + 1));
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = _clip(((x - ax) * vx + (y - ay) * vy) / L2, 0, 1), d = Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
      const a = _clip(lw / 2 + 0.5 - d, 0, 1) * al; if (a > 0) _over(R, (y * W + x) * 4, rgb[0], rgb[1], rgb[2], a);
    }
  }
  function _rasterLayer(name, R, W, H, mode) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (R[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) data.set(R.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + w) * 4), y * w * 4);
    return { id: 0, name, kind: 'raster', visible: true, mode: mode || 'solid', opacity: 1, amount: 1, style: 'flat', wc: null, material: { kind: 'raster', color: '#808080' }, persp: null, gbox: null, rev: 0,
      mask: { x: x0, y: y0, w, h, data: new Uint8Array(w * h).fill(255) }, raster: { x: x0, y: y0, w, h, data } };
  }

  // ---- 色の整え（木）。sat＝彩度、tint＝寄せる色、amt＝寄せる量、gamma、lift＝白へ持ち上げ
  const TGRADE = {
    elev: { sat: 0.55, tint: [0x8a, 0x9a, 0x84], amt: 0.30, gamma: 0.88, lift: 0.10 },
    top: { sat: 0.50, tint: [0x7d, 0x8c, 0x74], amt: 0.35, gamma: 1.05, lift: 0.06 },
    shrub: { sat: 0.45, tint: [0x7d, 0x8c, 0x74], amt: 0.35, gamma: 0.85, lift: 0.14 },
    momiji: { sat: 0.62, tint: [0xb4, 0x60, 0x5a], amt: 0.55, gamma: 0.90, lift: 0.10 },
    olive: { sat: 0.30, tint: [0x9b, 0xa7, 0x9c], amt: 0.55, gamma: 0.88, lift: 0.12 },
  };
  function _grade(c, G) {
    const L = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], tl = 0.299 * G.tint[0] + 0.587 * G.tint[1] + 0.114 * G.tint[2], o = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      let v = L + (c[k] - L) * G.sat; v = v * (1 - G.amt) + (L * G.tint[k] / tl) * G.amt;
      v = Math.pow(_clip(v / 255, 0, 1), G.gamma); v = 1 - (1 - v) * (1 - G.lift); o[k] = v * 255;
    }
    return o;
  }
  /** 木・人の影絵を R へ置く。foot＝足元の中心。hPx＝高さ。 */
  function _blit(R, W, H, spr, footX, footY, hPx, flip, colorFn) {
    const sc = hPx / spr.h, w = Math.round(spr.w * sc), h = Math.round(hPx), x0 = Math.round(footX - (flip ? (1 - (spr.baseX == null ? 0.5 : spr.baseX)) : (spr.baseX == null ? 0.5 : spr.baseX)) * w), y0 = Math.round(footY - h);
    for (let j = 0; j < h; j++) {
      const y = y0 + j; if (y < 0 || y >= H) continue;
      for (let i = 0; i < w; i++) {
        const x = x0 + i; if (x < 0 || x >= W) continue;
        const sx = Math.min(spr.w - 1, Math.floor((flip ? w - 1 - i : i) / sc)), sy = Math.min(spr.h - 1, Math.floor(j / sc)), q = (sy * spr.w + sx) * 4, a = spr.data[q + 3] / 255; if (a <= 0.01) continue;
        const c = colorFn(spr.data[q], spr.data[q + 1], spr.data[q + 2], x, y, j / h); _over(R, (y * W + x) * 4, c[0], c[1], c[2], a * c[3]);
      }
    }
  }
  const _gauss = rnd => (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;

  // ---- 立面の木（手続きの既定）：枝の骨組み＋小さな葉の粒の房。輪郭線を引かず、縁は粒がまばらになって透ける。
  // 樹冠の形 [横の半径, 縦の半径, 樹冠の中心の高さ（いずれも樹高比）, 幹の数]
  const ELEV_FORM = { keyaki: [0.42, 0.40, 0.58, 1], konara: [0.36, 0.38, 0.60, 1], multi: [0.36, 0.36, 0.58, 3], momiji: [0.42, 0.34, 0.56, 1], olive: [0.30, 0.30, 0.62, 2], shrub: [0.55, 0.45, 0.50, 3] };
  /** mode：'front'｜'autumn'（斑に紅葉）｜'back'（白へ寄せる：rgb＝1−(1−rgb)×s）。取り込んだ 'tree_elev:'+樹種 があればそれを優先。 */
  function _elevTree(R, W, H, fx, fy, hM, ppm, kind, rnd, mode, s) {
    const hp = hM * ppm, back = mode === 'back', aut = mode === 'autumn', G = kind === 'olive' ? TGRADE.olive : TGRADE.elev;
    const white = c => back ? [255 - (255 - c[0]) * s, 255 - (255 - c[1]) * s, 255 - (255 - c[2]) * s] : c;
    const mott = (c, x, y) => { if (!aut) return c; const m = _clip(_nz(x, y, 1.6 * ppm, 4) * 1.4 + 0.25, 0, 1) * 0.5; return [c[0] + (0xb4 - c[0]) * m, c[1] + (0x60 - c[1]) * m, c[2] + (0x5a - c[2]) * m]; };
    const spr = _sprites.get('tree_elev:' + kind);
    if (spr) { _blit(R, W, H, spr, fx, fy, hp, rnd() < 0.5, (r, g, b, x, y) => { const c = white(mott(_grade([r, g, b], G), x, y)); return [c[0], c[1], c[2], 0.95]; }); return; }
    const f = ELEV_FORM[kind] || ELEV_FORM.konara, rx = f[0] * hp * (0.9 + 0.25 * rnd()), ry = f[1] * hp, cy = fy - f[2] * hp, stems = f[3];
    const eD = (x, y) => Math.hypot((x - fx) / rx, (y - cy) / ry);
    const segs = [], tips = [], bw = Math.max(1.0, 0.022 * hp);
    const limb = (x, y, a, len, w, depth) => {
      const st = 5, cur = (rnd() - 0.5) * 0.5; let px = x, py = y;
      for (let k = 0; k < st; k++) {
        a += cur / st + (rnd() - 0.5) * 0.10;
        const nx = px + Math.sin(a) * len / st, ny = py - Math.cos(a) * len / st; if (eD(nx, ny) > 0.86) break;
        segs.push([px, py, nx, ny, w * (1 - 0.3 * k / st)]); px = nx; py = ny;
        if (depth <= 1 && k >= 2 && rnd() < 0.35) tips.push([px, py]);
      }
      if (depth > 0) { const nc = 2 + (rnd() < 0.45 ? 1 : 0); for (let c = 0; c < nc; c++) limb(px, py, a + (c - (nc - 1) / 2) * (0.5 + 0.35 * rnd()) + (rnd() - 0.5) * 0.2, len * (0.6 + 0.1 * rnd()), w * 0.62, depth - 1); }
      else tips.push([px, py]);
    };
    const topY = fy - (f[2] - f[1] * 0.55) * hp;
    for (let k = 0; k < stems; k++) {
      const sa = stems === 1 ? (rnd() - 0.5) * 0.06 : (k - (stems - 1) / 2) * 0.28 + (rnd() - 0.5) * 0.08, w0 = stems === 1 ? bw : bw * 0.7, st = 6;
      let px = fx + (k - (stems - 1) / 2) * bw * 0.8, py = fy; const tl = (fy - topY) / Math.cos(sa);
      for (let j = 0; j < st; j++) { const nx = px + Math.sin(sa) * tl / st + (rnd() - 0.5) * 0.004 * hp, ny = py - Math.cos(sa) * tl / st; segs.push([px, py, nx, ny, w0 * (1 - 0.35 * j / st)]); px = nx; py = ny; }
      const nm = (stems === 1 ? 4 : 2) + Math.floor(rnd() * 2), fan = stems === 1 ? 0.95 : 0.6;
      for (let m = 0; m < nm; m++) limb(px, py, sa + (m / (nm - 1) - 0.5) * 2 * fan + (rnd() - 0.5) * 0.2, 0.30 * hp * (0.85 + 0.3 * rnd()), w0 * 0.62, 2);
    }
    for (let k = 0; k < 22; k++) { const a = rnd() * 6.2832, d = Math.sqrt(rnd()) * 0.78; tips.push([fx + Math.cos(a) * d * rx, cy + Math.sin(a) * d * ry]); }
    // 枝（灰茶）。粒の隙間から見える
    const bc = white([78, 74, 68]);
    for (const g of segs) _seg(R, W, H, g[0], g[1], g[2], g[3], Math.max(0.7, g[4]), bc, back ? 0.55 : 0.90);
    // 葉の粒：房ごとに正規分布。上・左上ほど明るく、樹冠の下ほど暗い。縁ほど粒がまばら
    const D0 = [0x34, 0x44, 0x33], L0 = [0x92, 0xa4, 0x86], sq = Math.sqrt(hM / 9), g0 = 0.09 * ppm;
    for (const t of tips) {
      const rc = (0.55 + 0.55 * rnd()) * sq * ppm, nG = Math.max(8, Math.round(1.1 * Math.pow(rc / g0, 2)));
      for (let q = 0; q < nG; q++) {
        const gx = t[0] + _gauss(rnd) * 0.5 * rc, gy = t[1] + _gauss(rnd) * 0.5 * rc, ed = eD(gx, gy);
        if (ed > 1.06 || rnd() > _clip((1.06 - ed) / 0.30, 0, 1)) continue;
        const dir = _clip((-(gx - t[0]) * 0.5 - (gy - t[1]) * 0.85) / rc, -1, 1), v = _clip((gy - cy) / ry, -1, 1);
        const lv = _clip(0.12 + 0.45 * (0.5 + 0.5 * dir) + 0.30 * (0.5 - 0.5 * v) + 0.15 * (rnd() - 0.5), 0, 1);
        const c = white(mott(_grade([D0[0] + (L0[0] - D0[0]) * lv, D0[1] + (L0[1] - D0[1]) * lv, D0[2] + (L0[2] - D0[2]) * lv], G), gx, gy));
        const a = g0 * (0.6 + 0.8 * rnd()), b = a * (0.6 + 0.4 * rnd()), th = rnd() * 3.1416, ct = Math.cos(th), st2 = Math.sin(th), e = a + 1;
        for (let y = Math.max(0, Math.floor(gy - e)); y <= Math.min(H - 1, Math.ceil(gy + e)); y++) for (let x = Math.max(0, Math.floor(gx - e)); x <= Math.min(W - 1, Math.ceil(gx + e)); x++) {
          const u = (x - gx) * ct + (y - gy) * st2, w2 = -(x - gx) * st2 + (y - gy) * ct, d = Math.sqrt((u / a) * (u / a) + (w2 / b) * (w2 / b));
          const al = _clip((1 - d) * b + 0.5, 0, 1) * 0.80; if (al > 0) _over(R, (y * W + x) * 4, c[0], c[1], c[2], al);
        }
      }
    }
  }

  // ---- 図の前処理：紙・線・切断面
  function _inkSplit(base, W, H, soft) {
    const n = W * H, paper = new Uint8ClampedArray(n * 4).fill(255), line = new Uint8ClampedArray(n * 4), cutA = new Uint8ClampedArray(n * 4), A = new Float32Array(n), lum = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const l = (base[p] * 77 + base[p + 1] * 151 + base[p + 2] * 28) >> 8; lum[i] = l;
      A[i] = soft ? _clip((165 - l) / 125, 0, 1) : (l < 235 ? (255 - l) / 255 : 0);
    }
    const hard = new Uint8Array(n); for (let i = 0; i < n; i++) hard[i] = A[i] > 0.7 ? 1 : 0;
    const thick = _morph(_morph(_morph(hard, W, H, 2, false), W, H, 3, true), W, H, 0, true);
    for (let i = 0; i < n; i++) {
      const p = i * 4, a = A[i] * 255;
      if (thick[i] && A[i] > 0.1) { cutA[p + 3] = a; } else if (a > 0) { line[p + 3] = a; }
    }
    paper.fill(255); for (let i = 3; i < paper.length; i += 4) paper[i] = 255;
    return { paper, line, cutA, thick, lum, A };
  }

  // ---- 立面・断面
  function _paintSide(kind, base, opts) {
    const W = base.w, H = base.h, n = W * H, ppm = opts.ppm || 39.4, sp = _inkSplit(base.data, W, H, false), lum = sp.lum, layers = [], info = { kind };
    // 地盤線：十分に長い横の線のうち一番下
    const rowInk = new Int32Array(H); for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) if (lum[y * W + x] < 150) c++; rowInk[y] = c; }
    let gy = opts.groundY;
    if (gy == null) { let best = -1; for (let y = Math.floor(H * 0.3); y <= Math.floor(H * 0.85); y++) if (rowInk[y] > best) { best = rowInk[y]; gy = y; } while (gy > 0 && rowInk[gy - 1] >= best * 0.5) gy--; if (best < W * 0.2) gy = Math.round(H * 0.65); }
    info.groundY = gy;
    // 地盤線の左右の端（gy〜gy+3 の行で一番長い黒の連なり。6 画素までの切れ目は続きとみなす）
    let gl0 = 0, gl1 = -1;
    { const dk = new Uint8Array(W); for (let y = gy; y <= Math.min(H - 1, gy + 3); y++) for (let x = 0; x < W; x++) if (lum[y * W + x] < 150) dk[x] = 1;
      let s = -1, last = -1; for (let x = 0; x <= W; x++) { if (x < W && dk[x]) { if (s < 0) s = x; last = x; } else if (s >= 0 && (x - last > 6 || x === W)) { if (last - s > gl1 - gl0) { gl0 = s; gl1 = last; } s = -1; } } }
    let fx0 = W, fx1 = 0; for (let i = 0; i < n; i++) if (sp.A[i] > 0.5) { const x = i % W; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; }
    if (gl1 - gl0 < W * 0.2) { gl0 = fx0; gl1 = fx1; }
    info.ground = [gl0, gl1];
    // 白い面の連結成分
    const L = _label(i => lum[i] >= 205, W, H), comps = L.comps; let sky = null, below = null;
    for (const c of comps) { if (!c) continue; if (c.y0 === 0 && (!sky || c.area > sky.area)) sky = c; if (c.y1 >= H - 1 && c.y0 > gy - 4 && (!below || c.area > below.area)) below = c; }
    const lab = L.lab; // 縁の半端な画素へ二画素ひろげる
    for (let it = 0; it < 2; it++) { const nl = Int32Array.from(lab); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (lab[i] || lum[i] < 100) continue; nl[i] = Math.max(lab[i - 1], lab[i + 1], lab[i - W], lab[i + W]); } lab.set(nl); }
    // 空（地盤線より上）と、そこから線一本で接する面＝外の壁。接しない面は、立面ではガラス、断面では室内（入れ子はガラス）
    const skyM = new Uint8Array(n); if (sky) for (let i = 0; i < (gy - 1) * W; i++) if (lab[i] === sky.id) skyM[i] = 1;
    const skyD = _morph(skyM, W, H, Math.max(3, Math.round(ppm / 8)), true), touch = new Int32Array(comps.length);
    for (let i = 0; i < n; i++) if (skyD[i] && lab[i] > 0) touch[lab[i]]++;
    const minA = Math.pow(0.5 * ppm, 2) * 2, tMin = Math.max(6, Math.round(0.3 * ppm)), bxA = c => (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
    const valid = c => c && c.area >= minA && c !== sky && c !== below && c.y1 <= gy + 6 && !(c.y0 >= gy - 0.3 * ppm && c.y1 - c.y0 < 0.3 * ppm); // 地盤線の二重線の隙間は除く
    const walls = [], glass = [], rooms = [];
    for (const c of comps) {
      if (!valid(c)) continue;
      if (touch[c.id] >= tMin) { walls.push(c); continue; }
      let nested = false;
      for (const p of comps) if (p && p !== c && valid(p) && p.x0 <= c.x0 + 2 && p.x1 >= c.x1 - 2 && p.y0 <= c.y0 + 2 && p.y1 >= c.y1 - 2 && bxA(c) < 0.8 * bxA(p)) { nested = true; break; }
      (nested || kind === 'elev' ? glass : rooms).push(c);
    }
    info.counts = { walls: walls.length, glass: glass.length, rooms: rooms.length };
    const ids = (arr) => { const s = new Set(arr.map(c => c.id)); return i => s.has(lab[i]); };
    // 建物の幅（地盤線より上の縦の線のある範囲）
    let bx0 = W, bx1 = 0; for (const c of walls.concat(glass, rooms)) if (c.y1 - c.y0 >= 0.5 * ppm) { if (c.x0 < bx0) bx0 = c.x0; if (c.x1 > bx1) bx1 = c.x1; }
    if (bx1 <= bx0) { bx0 = Math.round(W * 0.2); bx1 = Math.round(W * 0.8); }
    info.span = [bx0, bx1];
    const rnd = _rng(opts.seed || 7), people = opts.people !== false, trees = opts.trees !== false;
    const skyUp = i => sky && lab[i] === sky.id && i < (gy + 1) * W;
    const xA = Math.round(gl0 - 2 * ppm), xB = Math.round(gl1 + 2 * ppm), eF = 2 * ppm;
    const xFade = x => { const e = Math.min(x - xA, xB - x) / eF; return e >= 1 ? 1 : e <= 0 ? 0 : e * e * (3 - 2 * e); };
    // 奥の林（白へ寄せた木）と霧（地盤から 9m で消える）。空の部分だけ＝建物の後ろ
    if (trees) {
      const R = new Uint8ClampedArray(n * 4), lim = gy / ppm - 0.4, ks = ['konara', 'keyaki', 'konara', 'multi', 'keyaki']; let x = xA, k = 0;
      while (x < xB) { const h = Math.min(9 + 7 * rnd(), lim), s = 0.42 * (0.8 + 0.35 * rnd()); if (h > 4) _elevTree(R, W, H, x, gy, h, ppm, ks[k++ % ks.length], rnd, 'back', s); x += (3.5 + 4.5 * rnd()) * ppm; }
      for (let i = 0; i < n; i++) if (!skyUp(i)) R[i * 4 + 3] = 0;
      const l = _rasterLayer('奥の木', R, W, H, 'solid'); if (l) layers.push(l);
      const RF = new Uint8ClampedArray(n * 4);
      for (let y = Math.max(0, Math.round(gy - 9 * ppm)); y <= gy; y++) {
        const t = Math.pow(_clip(1 - (gy - y) / ppm / 9, 0, 1), 1.4), a = 0.82 * Math.pow(t, 1.3);
        for (let x = Math.max(0, xA); x <= Math.min(W - 1, xB); x++) { const i = y * W + x; if (!skyUp(i)) continue; const p = i * 4; RF[p] = 236; RF[p + 1] = 235; RF[p + 2] = 233; RF[p + 3] = a * xFade(x) * 255; }
      }
      const lf = _rasterLayer('霧', RF, W, H, 'solid'); if (lf) layers.push(lf);
    }
    // 地面（水彩の灰の面。地盤線から図の下まで、下ほど白へ溶ける。泡は入れない）
    {
      const R = new Uint8ClampedArray(n * 4), dcol = Math.max(1, Math.min((opts.groundDepthM || 8) * ppm, H - 1 - gy)) / ppm, g2 = Math.max(1.2, 0.022 * ppm), g3 = Math.max(1, 0.05 * ppm);
      for (let x = Math.max(0, gl0); x <= Math.min(W - 1, gl1); x++) {
        for (let y = gy + 1; y < H; y++) {
          const e = _clip((Math.min(x - gl0, gl1 - x) + 0.8 * ppm * _nz(x, y, 1.5 * ppm, 9)) / (1.5 * eF), 0, 1), edge = e * e * (3 - 2 * e);
          const i = y * W + x, dep = (y - gy) / ppm; if (dep > dcol) break; if (lum[i] < 200 || sp.thick[i]) continue;
          let v = 0.76 + 0.045 * _nz(x, y, 4.0 * ppm, 1) + 0.028 * _nz(x, y, 1.4 * ppm, 2) + 0.010 * _nz(x, y, 0.3 * ppm, 3);
          v -= 0.16 * Math.exp(-dep / 0.10) + 0.05 * Math.exp(-dep / 0.9) + 0.07 * Math.exp(-dep / 2.2); v += 0.06 * (1 - Math.exp(-dep / 6));
          const pg = _nz(x, y, g2, 5) + 0.6 * _vn(x / g3, y / (g3 * 0.35), 6); v += 0.012 * pg - 0.022 * _clip(-pg, 0, 1) * (1.15 - v);
          const td = _clip((dep / dcol - 0.12) / 0.88, 0, 1), f = Math.pow(td, 1.25) * 0.85 * (1.08 + 0.10 * _nz(x, y, 1.2 * ppm, 4));
          v = _clip(v + (1 - v) * f, 0, 1); const p = i * 4;
          R[p] = v * 255; R[p + 1] = v * 255 * 0.993; R[p + 2] = v * 255 * 0.982; R[p + 3] = 255 * edge;
        }
      }
      const l = _rasterLayer(kind === 'section' ? '地面の断面（水彩）' : '地面（水彩）', R, W, H, 'solid'); if (l) layers.push(l);
    }
    // 壁（打放し）と、木の壁（帯でない小さい壁面の一つ）
    if (walls.length) {
      const strip = c => { const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1; return w > 6 * h || h > 6 * w; };
      let woodC = null; if (opts.woodWall !== false) { const s = walls.filter(c => c.area > minA * 6 && !strip(c)).sort((a, b) => a.area - b.area); if (s.length >= 2) woodC = s[0]; }
      const isW = ids(walls), R = new Uint8ClampedArray(n * 4), RW = new Uint8ClampedArray(n * 4), mC = new Uint8Array(n), mW = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (isW(i)) { if (woodC && lab[i] === woodC.id) mW[i] = 1; else mC[i] = 1; }
      _paintTex(R, W, mC, SPEC_CONC(ppm), 0, 0, W - 1, H - 1);
      const l1 = _rasterLayer('壁（打放し）', R, W, H, 'solid'); if (l1) layers.push(l1);
      if (woodC) { _paintTex(RW, W, mW, SPEC_WOOD(ppm), woodC.x0 - 3, woodC.y0 - 3, Math.min(W - 1, woodC.x1 + 3), Math.min(H - 1, woodC.y1 + 3)); const l2 = _rasterLayer('壁（木の縦張り）', RW, W, H, 'solid'); if (l2) layers.push(l2); }
    }
    // 断面の室内：白に近い面＋天井の陰（奥行き）。depth=0 なら奥行きの無い版（陰なし）
    if (rooms.length) {
      const depth = opts.depth == null ? 1 : opts.depth, R = new Uint8ClampedArray(n * 4), b0 = [248, 248, 246], cs = [51, 56, 64];
      for (const c of rooms) {
        const hh = c.y1 - c.y0 + 1;
        for (let y = c.y0; y <= c.y1; y++) {
          const a = depth > 0 ? _clip(0.24 * depth * Math.pow(1 - (y - c.y0) / hh, 1.3), 0, 1) : 0, cr = b0[0] + (cs[0] - b0[0]) * a, cg = b0[1] + (cs[1] - b0[1]) * a, cb = b0[2] + (cs[2] - b0[2]) * a;
          for (let x = c.x0; x <= c.x1; x++) { const i = y * W + x; if (lab[i] !== c.id) continue; const p = i * 4; R[p] = cr; R[p + 1] = cg; R[p + 2] = cb; R[p + 3] = 255; }
        }
      }
      const l = _rasterLayer(depth > 0 ? '室内（奥行き）' : '室内', R, W, H, 'solid'); if (l) layers.push(l);
    }
    // ガラス：#4e5964 の上下のグラデ（上 ×0.78 → 下 ×0.90＋空色 0.10）。上端 0.30m に軽い陰。反射なし・影を出さない
    if (glass.length) {
      const R = new Uint8ClampedArray(n * 4), c0 = [0x4e, 0x59, 0x64], sky0 = [0xcd, 0xd6, 0xdb], gA = opts.glassAlpha == null ? 0.80 : opts.glassAlpha;
      for (const c of glass) {
        const hh = c.y1 - c.y0 + 1;
        for (let y = c.y0; y <= c.y1; y++) {
          const t = (y - c.y0) / hh, f = _clip(0.10 + 0.90 * Math.pow(t, 0.85), 0, 1), sh = 1 - _clip(1 - ((y - c.y0) / ppm) / 0.30, 0, 1) * 0.30, a = _clip(gA * (0.85 + 0.30 * (1 - t)), 0, 1) * 255;
          const col = [0, 1, 2].map(k => { const top = c0[k] * 0.78, bot = c0[k] * 0.90 + sky0[k] * 0.10; return (top + (bot - top) * f) * sh; });
          for (let x = c.x0; x <= c.x1; x++) { const i = y * W + x; if (lab[i] !== c.id) continue; const p = i * 4; R[p] = col[0]; R[p + 1] = col[1]; R[p + 2] = col[2]; R[p + 3] = a; }
        }
      }
      const l = _rasterLayer('ガラス', R, W, H, 'solid'); if (l) layers.push(l);
    }
    // 人（黒の影絵）
    if (people && _sprites.has('walk_m')) {
      const R = new Uint8ClampedArray(n * 4);
      const footAt = x => { let f = gy; for (const c of rooms) if (x > c.x0 + 0.6 * ppm && x < c.x1 - 0.6 * ppm && c.y1 > gy - 2.5 * ppm && c.y1 < gy + 4 && c.y1 - c.y0 > 2 * ppm) f = Math.min(f, c.y1 + 1); return f; };
      const spots = [[-0.10, 'walk_m', 1.72], [0.22, 'stand_m', 1.75], [0.62, 'walk_w', 1.62]];
      spots.forEach(([fr, nm, hM], k) => { const spr = _sprites.get(nm); if (!spr) return; spr.baseX = 0.5; const x = bx0 + (bx1 - bx0) * fr; _blit(R, W, H, spr, x, footAt(x), hM * ppm, k % 2 === 1, () => [20, 22, 24, 0.92]); });
      const l = _rasterLayer('人', R, W, H, 'solid'); if (l) layers.push(l);
    }
    // 手前の木（濃い・一本は斑に紅葉）。地盤線の上だけに立てる
    if (trees) {
      const R = new Uint8ClampedArray(n * 4), r2 = _rng((opts.seed || 7) + 101), lim = gy / ppm - 0.3;
      // 建物の右手前に紅葉（低め・壁に少し掛かる）と欅。左は寸法の札が来やすいので立てない
      const xa = Math.min(bx1 + 6.2 * ppm, gl1 - 3 * ppm), xb = bx1 + 1.2 * ppm;
      if (xb < gl1 - ppm) _elevTree(R, W, H, xb, gy + 2, Math.min(6.5, lim), ppm, 'momiji', r2, 'autumn');
      if (xa > bx1 + 3 * ppm) _elevTree(R, W, H, xa, gy + 2, Math.min(9.5, lim), ppm, 'keyaki', r2, 'front');
      const l = _rasterLayer('手前の木', R, W, H, 'solid'); if (l) layers.push(l);
    }
    return { layers, sp, info };
  }

  // ---- 平面
  // 平面の木の記号：樹種ごとに [塗り, 塗りの不透明度, 記号]。線はすべて INK_LINE（輪郭も白）。
  const PLAN_INK = { keyaki: [[0x4f, 0x64, 0x49], 0.78, 'branch'], konara: [[0x5a, 0x6f, 0x51], 0.76, 'leafy'], multi: [[0x66, 0x79, 0x5c], 0.74, 'cluster'], momiji: [[0x7d, 0x5a, 0x4f], 0.72, 'frond'], olive: [[0x6b, 0x78, 0x68], 0.72, 'spokes'], shrub: [[0x4c, 0x60, 0x43], 0.80, 'scallop'] };
  function _inkTree(R, W, H, cx, cy, r, kind, rnd, ppm) {
    const P = PLAN_INK[kind] || PLAN_INK.keyaki, fill = P[0], fa = P[1], sym = P[2], rot = rnd() * 6.2832, N = (s) => _gauss(rnd) * s, U = (a, b) => a + (b - a) * rnd();
    const lw = pt => Math.max(0.5, pt * ppm * 0.0706);
    const spr = _sprites.get('tree_plan:' + kind);
    if (spr) { const G = kind === 'momiji' ? TGRADE.momiji : kind === 'olive' ? TGRADE.olive : kind === 'shrub' ? TGRADE.shrub : TGRADE.top; _blit(R, W, H, spr, cx, cy + r, 2 * r, rnd() < 0.5, (q, g, b) => { const c = _grade([q, g, b], G); return [c[0], c[1], c[2], 1]; }); return; }
    // 輪郭：ρ(θ)（樹冠の半径に対する比）。揺らぎはガウスで均す
    const NS = 180, jit = new Float32Array(NS);
    { const raw = Array.from({ length: NS }, () => N(1)); for (let i = 0; i < NS; i++) { let s = 0, w = 0; for (let k = -12; k <= 12; k++) { const g = Math.exp(-k * k / 32); s += raw[(i + k + NS) % NS] * g; w += g; } jit[i] = s / w; } }
    const circ = (k) => th => 1 + k * 4 * jit[(Math.round(((th % 6.2832) + 6.2832) % 6.2832 / 6.2832 * NS)) % NS];
    const scal = (nb, dep) => th => 1 - dep + dep * Math.abs(Math.sin(nb * (th - rot) / 2));
    const puffs = [];
    let rho = null;
    if (sym === 'leafy') rho = scal(Math.round(U(15, 21)), 0.09);
    else if (sym === 'scallop') rho = scal(Math.round(U(8, 12)), 0.14);
    else if (sym === 'cluster') { const np = 3 + (rnd() < 0.5 ? 1 : 0); for (let k = 0; k < np; k++) { const a = rot + k / np * 6.2832; puffs.push([Math.cos(a) * 0.40, Math.sin(a) * 0.40, 0.60, scal(Math.round(U(7, 10)), 0.12)]); } }
    else rho = circ(0.025);
    // u,v＝半径比の座標。返り値＝縁からの距離（px、正＝内）
    const inside = (u, v) => {
      if (!puffs.length) return (rho(Math.atan2(v, u)) - Math.hypot(u, v)) * r;
      let m = -1e9; for (const p of puffs) { const du = u - p[0], dv = v - p[1]; m = Math.max(m, (p[2] * p[3](Math.atan2(dv, du)) - Math.hypot(du, dv)) * r); } return m;
    };
    // 塗り（控えめな濃淡）
    const sd = Math.floor(rnd() * 1000), e0 = 1.25 * r;
    for (let y = Math.max(0, Math.floor(cy - e0)); y <= Math.min(H - 1, Math.ceil(cy + e0)); y++) for (let x = Math.max(0, Math.floor(cx - e0)); x <= Math.min(W - 1, Math.ceil(cx + e0)); x++) {
      const e = _clip(inside((x - cx) / r, (y - cy) / r) + 0.5, 0, 1); if (e <= 0) continue;
      const m = 1 + 0.08 * _nz(x, y, r * 0.8, sd) + 0.04 * _nz(x, y, r * 0.25, sd + 1);
      _over(R, (y * W + x) * 4, fill[0] * m, fill[1] * m, fill[2] * m, fa * e);
    }
    const L = INK_LINE, A = 0.95, X = (u) => cx + u * r, Y = (v) => cy + v * r;
    const seg = (u0, v0, u1, v1, pt) => _seg(R, W, H, X(u0), Y(v0), X(u1), Y(v1), lw(pt), L, A);
    const outline = (pt, dotted) => {
      if (!puffs.length) { for (let i = 0; i < NS; i++) { if (dotted && i % 3) continue; const a = i / NS * 6.2832, b = (i + 1) / NS * 6.2832, f = dotted ? 0.98 : 1; seg(Math.cos(a) * rho(a) * f, Math.sin(a) * rho(a) * f, Math.cos(b) * rho(b) * f, Math.sin(b) * rho(b) * f, pt); } return; }
      for (const p of puffs) for (let i = 0; i < 120; i++) {
        const a = i / 120 * 6.2832, b = (i + 1) / 120 * 6.2832, u0 = p[0] + Math.cos(a) * p[2] * p[3](a), v0 = p[1] + Math.sin(a) * p[2] * p[3](a);
        if (puffs.some(q => q !== p && Math.hypot(u0 - q[0], v0 - q[1]) < q[2] * q[3](Math.atan2(v0 - q[1], u0 - q[0])) - 0.01)) continue;
        seg(u0, v0, p[0] + Math.cos(b) * p[2] * p[3](b), p[1] + Math.sin(b) * p[2] * p[3](b), pt);
      }
    };
    const ok = (u, v) => inside(u, v) > 0.03 * r;
    // 曲がった枝。深さ 0 の先に葉の刻み
    const limb = (u, v, ang, len, n, pt, depth, pinnate) => {
      const pts = [[u, v, ang]], cur = N(0.35);
      for (let s = 0; s < n; s++) {
        ang += cur / n + N(0.05); const nu = u + Math.cos(ang) * len / n, nv = v + Math.sin(ang) * len / n; if (!ok(nu, nv)) break;
        seg(u, v, nu, nv, pt); u = nu; v = nv; pts.push([u, v, ang]);
        if (pinnate) for (const sg of [-1, 1]) { const ta = ang + sg * U(0.5, 0.9), tl = 0.08 * (1 - s / n) + 0.03, eu = u + Math.cos(ta) * tl, ev = v + Math.sin(ta) * tl; if (ok(eu, ev)) seg(u, v, eu, ev, 0.22); }
      }
      if (depth > 0) { for (const k of [3, 4]) if (pts[k]) { const sg = rnd() < 0.5 ? -1 : 1; limb(pts[k][0], pts[k][1], pts[k][2] + sg * U(0.35, 0.6), len * U(0.45, 0.6), 6, pt * 0.7, depth - 1, false); } }
      else { const t = pts[pts.length - 1]; for (const sg of [-1, 1]) if (rnd() < 0.8) { const ta = t[2] + sg * U(0.4, 0.8), eu = t[0] + Math.cos(ta) * 0.07, ev = t[1] + Math.sin(ta) * 0.07; if (ok(eu, ev)) seg(t[0], t[1], eu, ev, 0.22); } }
    };
    const ring = (rr, pt) => { for (let i = 0; i < 24; i++) { const a = i / 24 * 6.2832, b = (i + 1) / 24 * 6.2832; seg(Math.cos(a) * rr, Math.sin(a) * rr, Math.cos(b) * rr, Math.sin(b) * rr, pt); } };
    if (sym === 'branch') { outline(0.55); const nl = 6 + Math.floor(rnd() * 3); for (let k = 0; k < nl; k++) limb(0, 0, rot + k / nl * 6.2832 + N(0.12), U(0.5, 0.62), 6, 0.40, 2, false); ring(0.05, 0.40); }
    else if (sym === 'leafy') {
      outline(0.55); const nl = 4 + (rnd() < 0.5 ? 1 : 0); for (let k = 0; k < nl; k++) limb(0, 0, rot + k / nl * 6.2832 + N(0.15), U(0.55, 0.7), 6, 0.34, 1, false);
      const nt = 45 + Math.floor(rnd() * 26); for (let k = 0; k < nt; k++) { const a = rnd() * 6.2832, dd = 0.15 + 0.75 * Math.sqrt(rnd()), u = Math.cos(a) * dd, v = Math.sin(a) * dd, ta = rnd() * 6.2832, tl = U(0.05, 0.09); if (ok(u + Math.cos(ta) * tl, v + Math.sin(ta) * tl)) seg(u, v, u + Math.cos(ta) * tl, v + Math.sin(ta) * tl, 0.22); }
    }
    else if (sym === 'cluster') { outline(0.55); for (const p of puffs) { const a0 = Math.atan2(p[1], p[0]); for (let k = 0; k < 3; k++) limb(p[0] * 0.25, p[1] * 0.25, a0 + (k - 1) * 0.6 + N(0.1), p[2] * 0.95, 6, 0.34, 1, false); } ring(0.05, 0.40); }
    else if (sym === 'frond') { outline(0.40, true); const nl = 7 + Math.floor(rnd() * 3); for (let k = 0; k < nl; k++) limb(0, 0, rot + k / nl * 6.2832 + N(0.1), U(0.85, 0.95), 8, 0.34, 0, true); }
    else if (sym === 'spokes') { outline(0.33); const nl = 60 + Math.floor(rnd() * 26); for (let k = 0; k < nl; k++) { const a = rot + k / nl * 6.2832 + N(0.02), r0 = U(0.05, 0.15), r1 = U(0.7, 0.98) * rho(a); seg(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1, 0.22); } seg(-0.06, 0, 0.06, 0, 0.40); seg(0, -0.06, 0, 0.06, 0.40); }
    else { outline(0.55); const na = 3 + Math.floor(rnd() * 3); for (let k = 0; k < na; k++) { const a0 = rnd() * 6.2832, rr = U(0.35, 0.7); for (let i = 0; i < 8; i++) { const a = a0 + i * 0.12, b = a0 + (i + 1) * 0.12; seg(Math.cos(a) * rr, Math.sin(a) * rr, Math.cos(b) * rr, Math.sin(b) * rr, 0.34); } } }
  }
  // 木の円：濃い緑の塊を距離変換の極大から円に割る（細長い塊や二本が繋がった塊でも落とさない）
  function _treeDiscs(mask, W, H, minR) {
    const n = W * H, D = _dist(mask, W, H), used = new Uint8Array(n), cand = [], out = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x, v = D[i]; if (!mask[i] || v < minR) continue; if (v >= D[i - 1] && v >= D[i + 1] && v >= D[i - W] && v >= D[i + W] && v >= D[i - W - 1] && v >= D[i - W + 1] && v >= D[i + W - 1] && v >= D[i + W + 1]) cand.push([v, x, y]); }
    cand.sort((a, b) => b[0] - a[0]);
    for (const [v, x, y] of cand) { if (used[y * W + x]) continue; out.push({ x, y, r: v });
      const rr = v * 0.85; for (let yy = Math.max(0, Math.floor(y - rr)); yy <= Math.min(H - 1, Math.ceil(y + rr)); yy++) for (let xx = Math.max(0, Math.floor(x - rr)); xx <= Math.min(W - 1, Math.ceil(x + rr)); xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= rr * rr) used[yy * W + xx] = 1; }
    return out;
  }
  function _paintPlan(base, opts) {
    const W = base.w, H = base.h, n = W * H, ppm = opts.ppm || 39.4, sp = _inkSplit(base.data, W, H, true), lum = sp.lum, d = base.data, role = new Uint8Array(n), layers = [], info = { kind: 'plan' };
    // 0＝白、1＝線、2＝芝・地面の緑、3＝木の塗り（濃い緑）、4＝木部、5＝明るい床・舗装、6＝灰（砂利など）
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], l = lum[i];
      // 明るい無彩・寒色の灰（入力に描かれた影）は地として扱う。舗装は暖かい灰だけ
      role[i] = l < 120 ? 1 : Math.min(r, g, b) >= 243 ? 0 : (g - b >= 16 && g >= r && l < 200) ? 3 : (g - b >= 8 && g >= r) ? 2 : (r - b >= 14 && r >= g - 1) ? 4 : l >= 200 ? (r - b >= 4 ? 5 : 0) : 6;
    }
    // 建物の箱：厚い黒（切断面）の大きな連結成分の外接箱を合わせる（開口で壁が切れていても一つに）
    // 最大の成分から始め、5m 以内に近い成分を足していく（窓で切れた壁を繋ぐ。方位記号・縮尺の棒は離れているので入らない）
    const thickL = _label(i => sp.thick[i] === 1, W, H), tc = thickL.comps.filter(c => c && c.area >= 20).sort((a, b) => b.area - a.area), bb = { x0: W, y0: H, x1: -1, y1: -1 };
    if (tc.length) { Object.assign(bb, { x0: tc[0].x0, y0: tc[0].y0, x1: tc[0].x1, y1: tc[0].y1 }); const gap = 5 * ppm, used = new Set([tc[0]]); let grow = true;
      while (grow) { grow = false; for (const c of tc) { if (used.has(c)) continue; if (c.x0 <= bb.x1 + gap && c.x1 >= bb.x0 - gap && c.y0 <= bb.y1 + gap && c.y1 >= bb.y0 - gap) { used.add(c); grow = true; bb.x0 = Math.min(bb.x0, c.x0); bb.y0 = Math.min(bb.y0, c.y0); bb.x1 = Math.max(bb.x1, c.x1); bb.y1 = Math.max(bb.y1, c.y1); } } } }
    let fx0 = W, fy0 = H, fx1 = 0, fy1 = 0; for (let i = 0; i < n; i++) if (role[i] !== 0) { const x = i % W, y = (i / W) | 0; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y; }
    info.building = bb;
    const inB = (x, y) => x >= bb.x0 && x <= bb.x1 && y >= bb.y0 && y <= bb.y1;
    const paving = new Uint8Array(n), lawn = new Uint8Array(n), out = new Uint8Array(n), deck = new Uint8Array(n), F = new Uint8Array(n), grv = new Uint8Array(n);
    // 木の円（先に求め、樹冠の下は芝として扱う＝見本の木の白い線を地に残さない）
    const tm = new Uint8Array(n); for (let i = 0; i < n; i++) tm[i] = role[i] === 3 ? 1 : 0;
    const tmm = _morph(_morph(tm, W, H, 1, false), W, H, 3, true), discs = _treeDiscs(tmm, W, H, 0.8 * ppm), under = new Uint8Array(n);
    for (const t of discs) for (let y = Math.max(0, Math.floor(t.y - t.r)); y <= Math.min(H - 1, Math.ceil(t.y + t.r)); y++) for (let x = Math.max(0, Math.floor(t.x - t.r)); x <= Math.min(W - 1, Math.ceil(t.x + t.r)); x++) if ((x - t.x) ** 2 + (y - t.y) ** 2 <= t.r * t.r) under[y * W + x] = 1;
    info.trees = discs.length;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, r = role[i], inb = inB(x, y), inF = x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
      if (inb && r !== 4 && r !== 3) F[i] = 1;                         // 室内は塗らない（白）
      else if (under[i] && r !== 4) lawn[i] = 1;
      else if (r === 5) paving[i] = 1;
      else if (r === 4) deck[i] = 1;
      else if (inF && (r === 2 || r === 3)) lawn[i] = 1;
      else if (inF && r === 6) grv[i] = 1;
      else if (inF && r === 0) out[i] = 1;
    }
    // 地面：芝はくすんだ明るい灰緑、それ以外はほとんど白。濃淡は静かに
    { const R = new Uint8ClampedArray(n * 4); _wash(R, W, H, out, [238, 240, 233], 0.25, 11, fx0, fy0, fx1, fy1); _wash(R, W, H, lawn, [212, 217, 200], 0.30, 12, fx0, fy0, fx1, fy1);
      // 敷地の外の地は敷地から 5m で白へ溶かす（紙の縁に枠を作らない）
      const site = new Uint8Array(n); for (let i = 0; i < n; i++) site[i] = lawn[i] || paving[i] || deck[i] || F[i] ? 1 : 0;
      const away = new Uint8Array(n); for (let i = 0; i < n; i++) away[i] = site[i] ? 0 : 1; const dS = _dist(away, W, H), fadeR = 5 * ppm;
      for (let i = 0; i < n; i++) if (out[i]) { const t = _clip(1 - dS[i] / fadeR + 0.15 * _nz(i % W, (i / W) | 0, 2 * ppm, 7), 0, 1); R[i * 4 + 3] *= t * t; }
      const l = _rasterLayer('地面（水彩）', R, W, H, 'solid'); if (l) layers.push(l); }
    // 砂利（1m² を超える灰の面だけ）：地の色＋小石の点描
    { const GL = _label(i => grv[i] === 1, W, H), R = new Uint8ClampedArray(n * 4), r2 = _rng((opts.seed || 5) + 31); let ng = 0;
      for (const c of GL.comps) {
        if (!c || c.area < ppm * ppm || c.area < 0.5 * (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) continue; ng++;
        for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const i = y * W + x; if (GL.lab[i] === c.id) { const p = i * 4; R[p] = 0xe7; R[p + 1] = 0xe4; R[p + 2] = 0xdd; R[p + 3] = 255; } }
        const cnt = Math.round(c.area / (ppm * ppm) * 38);
        for (let k = 0; k < cnt; k++) {
          const sx = c.x0 + r2() * (c.x1 - c.x0), sy = c.y0 + r2() * (c.y1 - c.y0); if (GL.lab[Math.round(sy) * W + Math.round(sx)] !== c.id) continue;
          const a = Math.max(0.8, (0.035 + 0.055 * r2()) * ppm * 0.5), b = a * (0.55 + 0.45 * r2()), v = 95 + 110 * r2(), th = r2() * 3.1416, ct = Math.cos(th), st = Math.sin(th);
          for (const [ox, oy, col, al] of [[0.6, 0.9, [60, 60, 60], 70 / 255], [0, 0, [v * 0.96, v * 0.95, v * 0.93], 150 / 255]]) {
            const gx = sx + ox, gy = sy + oy, e = a + 1;
            for (let y = Math.max(0, Math.floor(gy - e)); y <= Math.min(H - 1, Math.ceil(gy + e)); y++) for (let x = Math.max(0, Math.floor(gx - e)); x <= Math.min(W - 1, Math.ceil(gx + e)); x++) {
              const u = (x - gx) * ct + (y - gy) * st, w2 = -(x - gx) * st + (y - gy) * ct, dd = Math.sqrt((u / a) ** 2 + (w2 / b) ** 2), q = _clip((1 - dd) * b + 0.5, 0, 1) * al;
              if (q > 0) _over(R, (y * W + x) * 4, col[0], col[1], col[2], q);
            }
          }
        }
      }
      info.gravel = ng; const l = _rasterLayer('砂利', R, W, H, 'solid'); if (l) layers.push(l); }
    // 舗装・外の階段：明るい打放し
    { const pm = _morph(_morph(paving, W, H, 1, true), W, H, 1, false), R = new Uint8ClampedArray(n * 4);
      _paintTex(R, W, pm, { photo: 'concrete', tileM: 4.0, rot: 0, ppm, k: 0.8, base: [214, 213, 209], dark: [86, 84, 80] }, fx0, fy0, fx1, fy1);
      const l = _rasterLayer('舗装（打放し）', R, W, H, 'solid'); if (l) layers.push(l); }
    // 影：建物（#3a434d α0.30）と木。柱・ガラスの枠のような細い物からは出さない（建物の箱だけから落とす）
    const dir = opts.shadowDir || [0.7071, 0.7071], hM = opts.buildingHeightM || 7, sh = new Float32Array(n);
    { const Bm = new Uint8Array(n); if (bb.x1 > bb.x0) for (let y = bb.y0; y <= bb.y1; y++) for (let x = bb.x0; x <= bb.x1; x++) Bm[y * W + x] = 1;
      const S = _sweep(Bm, W, H, dir[0], dir[1], Math.round(hM * SLEN * ppm)); for (let i = 0; i < n; i++) if (S[i] && !Bm[i]) sh[i] = 0.30; }
    { const ts = new Float32Array(n);
      for (const t of discs) {
        const hT = Math.min(11, (t.r / ppm) / 0.38), off = 0.585 * hT * SLEN * 0.92 * ppm, sx = t.x + dir[0] * off, sy = t.y + dir[1] * off, rr = t.r * 0.92;
        for (let y = Math.max(0, Math.floor(sy - rr - 2)); y <= Math.min(H - 1, Math.ceil(sy + rr + 2)); y++) for (let x = Math.max(0, Math.floor(sx - rr - 2)); x <= Math.min(W - 1, Math.ceil(sx + rr + 2)); x++) { const e = _clip(rr - Math.hypot(x - sx, y - sy) + 0.5, 0, 1); if (e > 0 && !F[y * W + x]) ts[y * W + x] = Math.max(ts[y * W + x], 0.26 * e); }
      }
      const tsb = _blur(ts, W, H, 2); for (let i = 0; i < n; i++) sh[i] = Math.max(sh[i], tsb[i]);
      const shb = _blur(sh, W, H, 1.2), Rs = _alphaRGBA(shb, W, H, SHADOW_RGB, 1); const l = _rasterLayer('影（建物・木）', Rs, W, H, 'solid'); if (l) layers.push(l); }
    // デッキ（木の板）
    { const R = new Uint8ClampedArray(n * 4), dm = _morph(_morph(deck, W, H, 1, true), W, H, 1, false); _paintTex(R, W, dm, SPEC_WOOD(ppm), fx0, fy0, fx1, fy1); const l = _rasterLayer('デッキ（木の板）', R, W, H, 'solid'); if (l) layers.push(l); }
    // 木（塗り＋白い線）。建物に掛かる所は 0.30、外は 0.94
    { const R = new Uint8ClampedArray(n * 4), kinds = ['keyaki', 'konara', 'multi', 'keyaki', 'olive', 'shrub', 'momiji'], rnd = _rng(opts.seed || 5);
      discs.forEach(t => { const kind = kinds[Math.floor(_hh(Math.round(t.x), Math.round(t.y), 3) * kinds.length) % kinds.length]; _inkTree(R, W, H, t.x, t.y, t.r, kind, rnd, ppm); });
      for (let i = 0; i < n; i++) R[i * 4 + 3] *= inB(i % W, (i / W) | 0) ? 0.30 : 0.94;
      const l = _rasterLayer('木', R, W, H, 'solid'); if (l) layers.push(l); }
    // 舗装と芝の境の細い線（#6d7176）
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (paving[i] && sp.A[i] < 0.1 && (lawn[i - 1] || lawn[i + 1] || lawn[i - W] || lawn[i + W])) { const p = i * 4; sp.line[p] = 0x6d; sp.line[p + 1] = 0x71; sp.line[p + 2] = 0x76; sp.line[p + 3] = 140; } }
    return { layers, sp, info };
  }

  /** 図の種類（'plan' | 'elev' | 'section'）に応じて着彩する。base＝{w,h,data}。
   *  返り値：紙（白）・線（インク）・層の並び。切断面は別の層。opts.ppm＝1m あたりの画素。 */
  function autoPaint(kind, base, opts) {
    opts = opts || {};
    const res = kind === 'plan' ? _paintPlan(base, opts) : _paintSide(kind === 'section' ? 'section' : 'elev', base, opts);
    const W = base.w, H = base.h, n = W * H, cutLayer = (() => { const R = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { const a = res.sp.cutA[i * 4 + 3]; if (a) { R[i * 4] = 18; R[i * 4 + 1] = 20; R[i * 4 + 2] = 22; R[i * 4 + 3] = a; } } return _rasterLayer('切断面（黒）', R, W, H, 'solid'); })();
    const layers = res.layers.slice(); if (cutLayer) layers.push(cutLayer);
    const line = new Uint8ClampedArray(n * 4); // 線の層：黒、被覆＝暗さ
    for (let i = 0; i < n; i++) { const a = res.sp.line[i * 4 + 3]; if (a) { line[i * 4] = res.sp.line[i * 4]; line[i * 4 + 1] = res.sp.line[i * 4 + 1]; line[i * 4 + 2] = res.sp.line[i * 4 + 2]; line[i * 4 + 3] = a; } }
    return { paper: res.sp.paper, line, layers, info: res.info };
  }

  // ---- raster 層の保存
  function _b64(u8) { if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64'); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function _unb64(s) { if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8ClampedArray(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); } const bin = atob(s), u = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  return {
    TILE, clamp, hexToRgb, rgbToHex, lumOf, computeLum, rectUnion, rectIntersect, rectClamp,
    maskCount, maskBBox, cropMask, expandMask, maskUnion, maskSubtract, maskInvert, maskCombine, stampCircle, strokeSegment, rasterPolygon,
    encodeMaskRLE, decodeMaskRLE, dilateBinary, floodSelect, selectByID,
    MATERIAL_KINDS, materialDefaultColor, makeTile, prepareUserTile, hash2, fbm, vnoiseFree,
    solveHomography, applyHomography, quadAspect, buildWatercolor, boxBlurF, wcParams,
    createContext, setShadeSources, layerRTKey, layerFullKey, layerCoverageRect, getRT, getTile,
    computeLayerRows, compositeRegion, flatten, renderLayerRGBA, serializeDoc, parseDoc, serializeLayer, parseLayer, maskUid,
    registerPhoto, registerSprite, hasSprite, hasPhoto, autoPaint, TGRADE,
  };
});
