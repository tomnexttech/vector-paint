/* VECTOR PAINT  ai/regions.js
   線画（または粘土模型の画像）→ 線で閉じた領域 → 画面全体の分割（ID マップ）と領域ごとの特徴量。
   外部ライブラリ・ネットワーク呼び出しなし。ブラウザ（window.VP.regions）と node（require）の両方で動く。
   これは「AI」ではなく古典的な画像処理（モルフォロジー・連結成分・幅優先の割り当て）。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.VP = root.VP || {}; root.VP.regions = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    blackR: 3,      // 黒の細線を拾う窓の半径（これより細い暗線がインク）
    blackT: 30,     // 黒の細線とみなす差（0..255）
    edgeT: 34,      // 段差エッジ（1 画素あたりの輝度の段）。線が無い絵でも領域が割れる。0 で無効
    closeR: 3,      // 線の隙間を閉じる膨張半径（隙間 2*closeR 画素まで）
    minAreaFrac: 0.00012,
    minAreaMin: 40,
    minThick: 2.4,  // これより細い切れ端は隣へ併合
    rescueMin: 24   // 膨張で消えた細い領域を救う最小面積
  };

  function opt(o) { var r = {}, k; for (k in DEFAULTS) r[k] = o && o[k] != null ? o[k] : DEFAULTS[k]; return r; }

  // ---------------------------------------------------------------- 画素の基本処理
  function lumOf(img) {
    var d = img.data, n = img.width * img.height, L = new Uint8Array(n), q = 0, i, r, g, b, a;
    for (i = 0; i < n; i++, q += 4) {
      a = d[q + 3];
      if (a === 255) { r = d[q]; g = d[q + 1]; b = d[q + 2]; }
      else { a /= 255; r = d[q] * a + 255 * (1 - a); g = d[q + 1] * a + 255 * (1 - a); b = d[q + 2] * a + 255 * (1 - a); }
      L[i] = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
    }
    return L;
  }

  // 正方形窓の最大 / 最小（分離可能）
  function rank(src, w, h, r, mx) {
    if (r <= 0) return src.slice();
    var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), x, y, k, a, b, v, o, i;
    for (y = 0; y < h; y++) {
      o = y * w;
      for (x = 0; x < w; x++) {
        a = x - r < 0 ? 0 : x - r; b = x + r >= w ? w - 1 : x + r; v = src[o + a];
        if (mx) { for (k = a + 1; k <= b; k++) if (src[o + k] > v) v = src[o + k]; }
        else { for (k = a + 1; k <= b; k++) if (src[o + k] < v) v = src[o + k]; }
        tmp[o + x] = v;
      }
    }
    for (y = 0; y < h; y++) {
      a = y - r < 0 ? 0 : y - r; b = y + r >= h ? h - 1 : y + r; o = y * w;
      for (x = 0; x < w; x++) out[o + x] = tmp[a * w + x];
      for (k = a + 1; k <= b; k++) {
        i = k * w;
        if (mx) { for (x = 0; x < w; x++) if (tmp[i + x] > out[o + x]) out[o + x] = tmp[i + x]; }
        else { for (x = 0; x < w; x++) if (tmp[i + x] < out[o + x]) out[o + x] = tmp[i + x]; }
      }
    }
    return out;
  }

  function sobel(L, w, h) {
    var g = new Uint8Array(w * h), x, y, i, gx, gy, m;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      gx = (L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1]) - (L[i - w - 1] + 2 * L[i - 1] + L[i + w - 1]);
      gy = (L[i + w - 1] + 2 * L[i + w] + L[i + w + 1]) - (L[i - w - 1] + 2 * L[i - w] + L[i - w + 1]);
      m = ((gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy)) >> 2;
      g[i] = m > 255 ? 255 : m;
    }
    return g;
  }

  // インク（線）の検出: 黒の細線（black-hat）＋強い段差。幅のある暗い面（暗いガラス）はインクにならない。
  function detectInk(L, w, h, o) {
    var n = w * h, ink = new Uint8Array(n), i, closed, grad = sobel(L, w, h);
    closed = rank(rank(L, w, h, o.blackR, true), w, h, o.blackR, false);
    for (i = 0; i < n; i++) {
      if (closed[i] - L[i] > o.blackT) ink[i] = 1;
      else if (o.edgeT > 0 && grad[i] > o.edgeT) ink[i] = 1;
    }
    return { ink: ink, grad: grad };
  }

  // 4 連結の自由画素（mask==0）の連結成分。戻り値 lab は -1 = 遮られた画素
  function labelFree(blocked, w, h) {
    var n = w * h, lab = new Int32Array(n), parent = new Int32Array(n + 1), next = 0, x, y, i, l, u, ra, rb, k;
    lab.fill(-1);
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; if (blocked[i]) continue;
      l = x > 0 ? lab[i - 1] : -1; u = y > 0 ? lab[i - w] : -1;
      if (l < 0 && u < 0) { lab[i] = next; parent[next] = next; next++; }
      else if (l >= 0 && u >= 0) { lab[i] = l; if (l !== u) { ra = find(l); rb = find(u); if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; } } }
      else lab[i] = l >= 0 ? l : u;
    }
    var map = new Int32Array(next).fill(-1), cnt = 0, area = [];
    for (k = 0; k < next; k++) { ra = find(k); if (map[ra] < 0) { map[ra] = cnt++; area.push(0); } map[k] = map[ra]; }
    for (i = 0; i < n; i++) if (lab[i] >= 0) { lab[i] = map[lab[i]]; area[lab[i]]++; }
    return { lab: lab, count: cnt, area: area };
  }

  // 幅優先で、ラベルの無い画素（インクと膨張帯と細い帯）を最も近い領域へ割り当てる → 画面全体の分割。
  // comp があれば、成分に属する画素は同じ成分の中からしか埋めない（漏れた成分を L1 の領域で割る時に、別の領域へ溢れない）。
  function floodAssign(lab, w, h, comp) {
    var n = w * h, q = new Int32Array(n), qh = 0, qt = 0, i, l, x, c, j;
    for (i = 0; i < n; i++) if (lab[i] >= 0) q[qt++] = i;
    if (qt === 0) { lab.fill(0); return; }
    while (qh < qt) {
      i = q[qh++]; l = lab[i]; x = i % w; c = comp ? comp[i] : -1;
      if (x > 0 && lab[(j = i - 1)] < 0 && (!comp || comp[j] < 0 || comp[j] === c)) { lab[j] = l; q[qt++] = j; }
      if (x < w - 1 && lab[(j = i + 1)] < 0 && (!comp || comp[j] < 0 || comp[j] === c)) { lab[j] = l; q[qt++] = j; }
      if (i >= w && lab[(j = i - w)] < 0 && (!comp || comp[j] < 0 || comp[j] === c)) { lab[j] = l; q[qt++] = j; }
      if (i < n - w && lab[(j = i + w)] < 0 && (!comp || comp[j] < 0 || comp[j] === c)) { lab[j] = l; q[qt++] = j; }
    }
  }

  // L1（隙間を閉じた）の各成分が「太い」か。細い帯（幅が closeR の数倍に満たない）は隙間の漏れを割る根拠にしない。
  function fatFlags(l1, w, h, thickMin) {
    var m = l1.count, per = new Int32Array(m), lab = l1.lab, x, y, i, a, b, fat = new Uint8Array(m);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; a = lab[i];
      if (a >= 0 && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) per[a] += (x === 0) + (y === 0) + (x === w - 1) + (y === h - 1);
      if (x < w - 1 && (b = lab[i + 1]) !== a) { if (a >= 0) per[a]++; if (b >= 0) per[b]++; }
      if (y < h - 1 && (b = lab[i + w]) !== a) { if (a >= 0) per[a]++; if (b >= 0) per[b]++; }
    }
    for (a = 0; a < m; a++) fat[a] = per[a] > 0 && 2 * l1.area[a] / per[a] >= thickMin ? 1 : 0;
    return fat;
  }

  // 領域の面積・周長（隣と接する辺の数）・隣接ごとの共有辺長
  function stats(lab, m, w, h) {
    var area = new Int32Array(m), perim = new Int32Array(m), border = new Map(), x, y, i, a, b, key;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; a = lab[i]; area[a]++;
      if (x < w - 1 && (b = lab[i + 1]) !== a) { perim[a]++; perim[b]++; key = a < b ? a * m + b : b * m + a; border.set(key, (border.get(key) || 0) + 1); }
      if (y < h - 1 && (b = lab[i + w]) !== a) { perim[a]++; perim[b]++; key = a < b ? a * m + b : b * m + a; border.set(key, (border.get(key) || 0) + 1); }
    }
    return { area: area, perim: perim, border: border };
  }

  // 小さい・細い切れ端を、共有する境界が最も長い隣へ併合する
  function mergeSmall(lab, m, w, h, minArea, minThick) {
    var round, n = w * h, i, merged = 0;
    for (round = 0; round < 6; round++) {
      var st = stats(lab, m, w, h), nb = [], r, parent = new Int32Array(m), changed = 0;
      for (r = 0; r < m; r++) { nb.push([]); parent[r] = r; }
      st.border.forEach(function (len, key) { var a = (key / m) | 0, b = key - a * m; nb[a].push([b, len]); nb[b].push([a, len]); });
      function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
      var cand = [];
      for (r = 0; r < m; r++) {
        if (!nb[r].length) continue;
        if (st.area[r] < minArea || (st.perim[r] > 0 && 2 * st.area[r] / st.perim[r] < minThick)) cand.push(r);
      }
      cand.sort(function (p, q) { return st.area[p] - st.area[q]; });
      cand.forEach(function (r) {
        var best = -1, bl = -1, k, o;
        for (k = 0; k < nb[r].length; k++) { o = nb[r][k]; if (find(o[0]) !== find(r) && o[1] > bl) { bl = o[1]; best = o[0]; } }
        if (best >= 0) { parent[find(r)] = find(best); changed++; }
      });
      if (!changed) break;
      var map = new Int32Array(m).fill(-1), cnt = 0;
      for (i = 0; i < n; i++) { r = find(lab[i]); if (map[r] < 0) map[r] = cnt++; lab[i] = map[r]; }
      m = cnt; merged += changed;
    }
    return { m: m, merged: merged };
  }

  // 走査順に 0.. へ振り直す（決定的）
  function compact(lab, m) {
    var map = new Int32Array(m).fill(-1), cnt = 0, i, n = lab.length;
    for (i = 0; i < n; i++) { var v = lab[i]; if (map[v] < 0) map[v] = cnt++; lab[i] = map[v]; }
    return cnt;
  }

  // ---------------------------------------------------------------- 領域の特徴量
  function describe(img, lab, m, ink, grad, L, w, h) {
    var d = img.data, n = w * h, i, x, y, k, a;
    var area = new Int32Array(m), sr = new Float64Array(m), sg = new Float64Array(m), sb = new Float64Array(m),
      sl = new Float64Array(m), sl2 = new Float64Array(m), sgr = new Float64Array(m), sx = new Float64Array(m), sy = new Float64Array(m),
      nOk = new Int32Array(m), x0 = new Int32Array(m).fill(w), y0 = new Int32Array(m).fill(h), x1 = new Int32Array(m).fill(-1), y1 = new Int32Array(m).fill(-1);
    var ink1 = rank(ink, w, h, 1, true);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; a = lab[i]; area[a]++; sx[a] += x; sy[a] += y;
      if (x < x0[a]) x0[a] = x; if (x > x1[a]) x1[a] = x; if (y < y0[a]) y0[a] = y; if (y > y1[a]) y1[a] = y;
      if (!ink1[i]) {
        var q = i * 4, al = d[q + 3] / 255, l = L[i];
        sr[a] += d[q] * al + 255 * (1 - al); sg[a] += d[q + 1] * al + 255 * (1 - al); sb[a] += d[q + 2] * al + 255 * (1 - al);
        sl[a] += l; sl2[a] += l * l; sgr[a] += grad[i]; nOk[a]++;
      }
    }
    var st = stats(lab, m, w, h), nb = [];
    for (k = 0; k < m; k++) nb.push([]);
    st.border.forEach(function (len, key) { var p = (key / m) | 0, r = key - p * m; nb[p].push({ id: r, len: len }); nb[r].push({ id: p, len: len }); });
    var regions = [], inkN = new Int32Array(m);
    for (i = 0; i < n; i++) if (ink[i]) inkN[lab[i]]++;
    for (k = 0; k < m; k++) {
      var c = nOk[k] || 1, bw = x1[k] - x0[k] + 1, bh = y1[k] - y0[k] + 1, r_ = sr[k] / c, g_ = sg[k] / c, b_ = sb[k] / c, lm = sl[k] / c;
      nb[k].sort(function (p, q) { return q.len - p.len; });
      var tot = 0, j; for (j = 0; j < nb[k].length; j++) tot += nb[k][j].len;
      var share = tot ? nb[k][0].len / tot : 0;
      var touchT = y0[k] <= 1, touchB = y1[k] >= h - 2, touchL = x0[k] <= 1, touchR = x1[k] >= w - 2;
      regions.push({
        id: k, area: area[k], areaFrac: area[k] / n,
        x0: x0[k], y0: y0[k], x1: x1[k], y1: y1[k], bw: bw, bh: bh,
        cx: sx[k] / area[k], cy: sy[k] / area[k],
        cxn: sx[k] / area[k] / w, cyn: sy[k] / area[k] / h, topn: y0[k] / h, botn: (y1[k] + 1) / h, leftn: x0[k] / w, rightn: (x1[k] + 1) / w,
        fill: area[k] / (bw * bh), aspect: bw / bh, wn: bw / w, hn: bh / h,
        perim: st.perim[k], thick: st.perim[k] ? 2 * area[k] / st.perim[k] : 0,
        round: st.perim[k] ? 4 * Math.PI * area[k] / (st.perim[k] * st.perim[k]) : 0,
        r: r_, g: g_, b: b_, lum: lm, lumStd: Math.sqrt(Math.max(0, sl2[k] / c - lm * lm)),
        chroma: Math.max(r_, g_, b_) - Math.min(r_, g_, b_), blueness: b_ - (r_ + g_) / 2, greenness: g_ - (r_ + b_) / 2,
        tex: sgr[k] / c, inkFrac: inkN[k] / area[k],
        touchT: touchT, touchB: touchB, touchL: touchL, touchR: touchR, touchN: (touchT ? 1 : 0) + (touchB ? 1 : 0) + (touchL ? 1 : 0) + (touchR ? 1 : 0),
        nbrs: nb[k], nbrCount: nb[k].length, innerBorder: tot,
        encl: nb[k].length ? nb[k][0].id : -1, enclShare: share
      });
    }
    return regions;
  }

  // ---------------------------------------------------------------- 入口
  /** img: {width, height, data(RGBA)} （ImageData 互換）。戻り値は labels（全画素の領域番号）と regions（特徴量）。 */
  function extract(img, o) {
    var t0 = Date.now(), op = opt(o), w = img.width, h = img.height, n = w * h;
    var L = lumOf(img), det = detectInk(L, w, h, op), ink = det.ink;
    // L0: インクだけで区切った成分（細い帯も残る）。L1: インクを closeR で閉じた（膨張→収縮した）成分（線の隙間が閉じ、細い帯は消えない）。
    // 既定は L0 の成分をそのまま領域にする。ただし一つの L0 成分が「太い」L1 領域を二つ以上またぐなら、
    // 隙間から漏れて別の領域がつながっているので、L1 で割る（割った後の細い帯は同じ成分の中から埋める）。
    var l0 = labelFree(ink, w, h), i, c, r;
    var dil = rank(rank(ink, w, h, op.closeR, true), w, h, op.closeR, false), l1 = labelFree(dil, w, h), lab = new Int32Array(n), c0 = l0.count, c1 = l1.count;
    var fat = fatFlags(l1, w, h, Math.max(8, 3 * op.closeR)), ov = Math.max(30, op.rescueMin), pair = new Map(), fatsOf = new Array(c0);
    var comp = l0.lab;
    for (i = 0; i < n; i++) if (comp[i] >= 0 && l0.area[comp[i]] < op.rescueMin) comp[i] = -1; // 微小な成分はインク扱い
    for (i = 0; i < n; i++) { c = comp[i]; r = l1.lab[i]; if (c >= 0 && r >= 0 && fat[r]) { var key = c * c1 + r; pair.set(key, (pair.get(key) || 0) + 1); } }
    pair.forEach(function (cnt, key) { if (cnt >= ov) { var cc = (key / c1) | 0, rr = key - cc * c1; (fatsOf[cc] || (fatsOf[cc] = [])).push(rr); } });
    var m = 0, compId = new Int32Array(c0).fill(-1), leakId = new Map(), leaks = 0;
    for (c = 0; c < c0; c++) {
      if (l0.area[c] < op.rescueMin) continue;
      var f = fatsOf[c];
      if (op.closeR <= 0 || !f || f.length < 2) compId[c] = m++;
      else { leaks++; f.forEach(function (rr) { leakId.set(c * c1 + rr, m++); }); }
    }
    for (i = 0; i < n; i++) {
      c = comp[i];
      if (c < 0) { lab[i] = -1; continue; }
      if (compId[c] >= 0) lab[i] = compId[c];
      else { r = l1.lab[i]; var id = r >= 0 ? leakId.get(c * c1 + r) : undefined; lab[i] = id !== undefined ? id : -1; }
    }
    var m0 = m;
    floodAssign(lab, w, h, comp);
    m = compact(lab, m);
    var minArea = Math.max(op.minAreaMin, Math.round(n * op.minAreaFrac));
    var mg = mergeSmall(lab, m, w, h, minArea, op.minThick);
    m = compact(lab, mg.m);
    var regions = describe(img, lab, m, ink, det.grad, L, w, h);
    var inkCount = 0, i2; for (i2 = 0; i2 < n; i2++) inkCount += ink[i2];
    return { w: w, h: h, n: m, labels: lab, ink: ink, grad: det.grad, lum: L, regions: regions, opts: op,
      info: { raw: m0, leaks: leaks, merged: mg.merged, minArea: minArea, inkFrac: inkCount / n, ms: Date.now() - t0 } };
  }

  // 領域ごとに一意の色（ID マップ用）。奇数倍は 2^24 上の全単射なので色は衝突しない。
  function idColor(k) { var v = (Math.imul(k + 1, 2654435761) >>> 0) & 0xFFFFFF; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }

  /** 領域番号ごとに一意の色で塗った RGBA（paint の passes.id へ渡す）。 */
  function idMap(res) {
    var n = res.w * res.h, out = new Uint8ClampedArray(n * 4), cols = [], k, i, c;
    for (k = 0; k < res.n; k++) cols.push(idColor(k));
    for (i = 0; i < n; i++) { c = cols[res.labels[i]]; out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255; }
    return { width: res.w, height: res.h, data: out };
  }

  return { extract: extract, idMap: idMap, idColor: idColor, defaults: DEFAULTS, _rank: rank, _lumOf: lumOf };
});
