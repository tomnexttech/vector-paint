/* VECTOR PAINT  ai/maskpsd.js
   面の判定を「面の種類ごとのマスク層」の PSD にする。色は付けない（着彩は別の製品の受け持ち）。
     - 層は種類ごとに一枚。その種類の画素だけを、ニュートラルな灰色（一種類）で塗る。層の名前 = 種類の名前。
     - いちばん上に元の線画の層（乗算）。下の灰色が線の内側に透けて見える。
   書き出しは paint 側の PSD 書き手（PaintPSD.writePSD）を使う。ここは層とレイヤー画像を組み立てるだけ。
   ブラウザ（window.VPMaskPSD）と node（require）の両方で動く。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VPMaskPSD = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GRAY = 128;                                  // 全層で共通の一色（R=G=B）
  var ORDER = ['wall', 'glass', 'ground', 'roof', 'vegetation', 'water', 'sky', 'unknown'];

  /** o: { width, height, labels(Int32Array 領域番号/画素), cls(領域ごとの種類 string[]), line(RGBA の Uint8ClampedArray), names({種類: 層の名前}) }
   *  戻り値: PaintPSD.writePSD にそのまま渡せる { width, height, layers, composite }。画素のある種類だけ層にする。 */
  function build(o) {
    var W = o.width, H = o.height, n = W * H, lab = o.labels, cls = o.cls, names = o.names || {}, i, c, k;
    if (!lab || lab.length !== n) throw new Error('labels の長さが画像と合いません');
    if (!o.line || o.line.length !== n * 4) throw new Error('線画の画素数が画像と合いません');
    var idx = {}; ORDER.forEach(function (c2, j) { idx[c2] = j; });
    var of = new Int8Array(cls.length); for (k = 0; k < cls.length; k++) of[k] = idx[cls[k]] == null ? idx.unknown : idx[cls[k]];
    var box = ORDER.map(function () { return { x0: W, y0: H, x1: -1, y1: -1, n: 0 }; });
    for (i = 0; i < n; i++) {
      c = of[lab[i]]; var b = box[c], x = i % W, y = (i / W) | 0;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; b.n++;
    }
    var layers = [];
    ORDER.forEach(function (cname, j) {
      var b = box[j]; if (!b.n) return;
      var w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, d = new Uint8ClampedArray(w * h * 4), yy, xx, p, q;
      for (yy = 0; yy < h; yy++) for (xx = 0; xx < w; xx++) {
        p = (b.y0 + yy) * W + b.x0 + xx;
        if (of[lab[p]] === j) { q = (yy * w + xx) * 4; d[q] = GRAY; d[q + 1] = GRAY; d[q + 2] = GRAY; d[q + 3] = 255; }
      }
      layers.push({ name: names[cname] || cname, x: b.x0, y: b.y0, w: w, h: h, data: d, opacity: 1, visible: true, blend: 'norm' });
    });
    // 一番上: 元の線画（不透明・乗算）。白い部分は下の灰色をそのまま通す。
    var line = new Uint8ClampedArray(o.line); for (i = 3; i < line.length; i += 4) line[i] = 255;
    layers.push({ name: names.line || 'line', x: 0, y: 0, w: W, h: H, data: line, opacity: 1, visible: true, blend: 'mul ' });
    // 合成: 全面が灰色（どの画素もいずれかの種類に入る）に線画を乗算
    var comp = new Uint8ClampedArray(n * 4);
    for (i = 0; i < n * 4; i += 4) {
      comp[i] = Math.round(GRAY * line[i] / 255); comp[i + 1] = Math.round(GRAY * line[i + 1] / 255); comp[i + 2] = Math.round(GRAY * line[i + 2] / 255); comp[i + 3] = 255;
    }
    return { width: W, height: H, layers: layers, composite: comp };
  }

  /** psd は PaintPSD（writePSD を持つ）。返すのは PSD のバイト列（Uint8Array）。 */
  function write(psd, o) { return psd.writePSD(build(o)); }

  return { build: build, write: write, GRAY: GRAY, ORDER: ORDER.slice() };
});
