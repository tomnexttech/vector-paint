/* VECTOR PAINT — 領域の面種別を判定する（ローカル規則版）。依存なし・ネットワークなし。
 *
 * 入力  : regions.extract() の結果（領域ごとの形・位置・隣接・色の特徴量）。
 * 出力  : 領域ごとの { cls, conf, scores }。信頼度が閾値に満たない領域は cls = 'unknown'（未判定）。
 * 種別  : wall 壁 / glass ガラス / ground 地面・床 / roof 屋根 / vegetation 植栽 / water 水 / sky 空
 *
 * これは学習済みの AI ではなく、手で決めた規則（形・位置・入れ子・繰り返し・隣の種別）に重みを掛けて
 * 点数化し、近傍の結果を二回ほど見直す方式。「線画の閉領域を種別に振る」ための土台であり、
 * labeler.js の差し込み口から、利用者の鍵で呼ぶ外部の推論や、ブラウザ内モデルに置き換えられる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VPClassify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CLASSES = ['wall', 'glass', 'ground', 'roof', 'vegetation', 'water', 'sky'];
  var WALL = 0, GLASS = 1, GROUND = 2, ROOF = 3, VEG = 4, WATER = 5, SKY = 6;
  var DEFAULTS = {
    view: 'auto',        // 'elevation'（立面・断面）/ 'plan'（平面）/ 'auto'
    threshold: 0.30,     // これ未満の信頼度は未判定
    passes: 3            // 近傍を見て点数を直す回数
  };

  function ramp(x, a, b) { var t = (x - a) / (b - a); return t < 0 ? 0 : t > 1 ? 1 : t; }
  function mx(a, b) { return a > b ? a : b; }

  // ---------------------------------------------------------------- 準備: 入れ子・繰り返しなどの派生特徴
  function prep(res) {
    var R = res.regions, n = R.length, i, j, r, q;
    for (i = 0; i < n; i++) { r = R[i]; r.kids = []; r.kidArea = 0; r.parent = -1; r.held = []; r.holder = -1; }
    for (i = 0; i < n; i++) {
      r = R[i];
      if (r.touchN === 0 && r.nbrCount && r.enclShare >= 0.85) { r.parent = r.encl; R[r.encl].kids.push(i); R[r.encl].kidArea += r.area; }
      // 窓らしい矩形（細長い帯ではない）が、より大きな領域に主に接していれば、その領域に「抱えられた」とみなす（複数ペインの窓は隣のペインにも接するので 0.45）
      if (r.touchN === 0 && r.nbrCount && r.fill > 0.88 && r.aspect > 0.25 && r.aspect < 4 && r.enclShare >= 0.45 && R[r.encl].area >= 3 * r.area) { r.holder = r.encl; R[r.encl].held.push(i); }
    }
    for (i = 0; i < n; i++) {
      r = R[i];
      r.fillK = (r.area + r.kidArea) / (r.bw * r.bh);
      r.rect = r.fill > 0.88;
      r.rectK = r.fillK > 0.85;
      r.band = r.hn < 0.12 && r.aspect > 4 && r.fill > 0.93;
      r.thinV = r.aspect < 0.28 && r.hn > 0.10 && r.fill > 0.7;
      r.twins = 0;
    }
    for (i = 0; i < n; i++) {
      r = R[i]; if (!r.rect) continue;
      for (j = i + 1; j < n; j++) {
        q = R[j]; if (!q.rect) continue;
        if (Math.abs(r.bw - q.bw) / mx(r.bw, q.bw) < 0.15 && Math.abs(r.bh - q.bh) / mx(r.bh, q.bh) < 0.15) { r.twins++; q.twins++; }
      }
    }
    return R;
  }

  /** 平面か立面かを推定する（小さい円形の領域が複数あれば平面＝樹木の円）。 */
  function detectView(R) {
    var k = 0;
    for (var i = 0; i < R.length; i++) {
      var r = R[i];
      if (r.touchN === 0 && r.areaFrac < 0.01 && r.areaFrac > 0.0004 && r.fill > 0.68 && r.fill < 0.86 && r.aspect > 0.8 && r.aspect < 1.25 && r.kids.length === 0) k++;
    }
    return k >= 3 ? 'plan' : 'elevation';
  }

  // ---------------------------------------------------------------- 色の手掛かり（着色版・粘土模型で効く。線画だけなら 0）
  function colourCue(r, s) {
    if (r.chroma < 12) return;
    if (r.greenness > 20) s[VEG] = mx(s[VEG], 0.6);
    if (r.blueness > 55) s[WATER] = mx(s[WATER], 0.6);
    else if (r.blueness > 20 && r.lum >= 195) s[SKY] = mx(s[SKY], 0.45);
    else if (r.blueness > 20 && r.lum < 190) s[GLASS] = mx(s[GLASS], 0.45);
  }

  // ---------------------------------------------------------------- 立面の初期点数
  function scoreElev(r) {
    var s = [0, 0, 0, 0, 0, 0, 0], interior = r.touchN === 0, kn = r.kids.length, hn = r.held.length;
    if (r.touchT) s[SKY] = 0.9 * ramp(r.areaFrac, 0.01, 0.06) * (1 - ramp(hn, 3, 8)) * (r.cyn < 0.6 ? 1 : 0.3);
    if (r.touchB) s[GROUND] = ramp(r.wn, 0.25, 0.6) * ramp(r.cyn, 0.55, 0.78);
    if (r.touchB) s[GROUND] = mx(s[GROUND], 0.5 * ramp(r.wn, 0.08, 0.25) * ramp(r.cyn, 0.7, 0.85));
    if (r.band && r.touchL && r.touchR && r.botn > 0.55) s[GROUND] = mx(s[GROUND], 0.55);       // 岸・舗装の帯
    // 壁: 窓を抱える本体・細い柱・低く長い帯（腰壁）・扉
    s[WALL] = mx(s[WALL], 0.9 * ramp(hn, 0, 2) * ramp(r.areaFrac, 0.005, 0.04) * (r.touchT && !r.touchL && !r.touchR ? 1 : 0.9));
    if (r.thinV) s[WALL] = mx(s[WALL], 0.75);
    if (r.band && !r.touchB) s[WALL] = mx(s[WALL], 0.35);
    if (r.rectK && interior && r.areaFrac > 0.003 && r.areaFrac < 0.08 && r.twins < 2) s[WALL] = mx(s[WALL], 0.4);
    // ガラス: 窓の矩形（繰り返し・壁の中・柱の間）
    if (r.rect && interior && r.areaFrac < 0.06 && r.aspect > 0.2 && r.aspect < 5 && !r.thinV) {
      s[GLASS] = 0.35 + 0.35 * ramp(r.twins, 0, 2);
    }
    // 屋根: 上にある帯・三角（隣の種別は見直しで効かせる）
    if (interior && r.band && r.cyn < 0.7 && r.wn > 0.1) s[ROOF] = 0.5;
    if (interior && r.fill > 0.35 && r.fill < 0.68 && r.aspect > 1.3 && r.cyn < 0.6 && r.areaFrac > 0.015) s[ROOF] = mx(s[ROOF], 0.65);
    // 植栽: 丸い塊（茂み・樹冠）、背景の林（地平の低い不規則な帯）
    if (!r.touchT && !r.touchB && r.touchN <= 1 && !r.rect && r.round > 0.45 && r.fillK > 0.5 && r.fillK < 0.88) s[VEG] = 0.7;
    if (r.touchL && r.touchR && !r.touchT && !r.touchB && r.aspect > 3 && r.fill < 0.93) s[VEG] = mx(s[VEG], 0.75);
    colourCue(r, s);
    return s;
  }

  // ---------------------------------------------------------------- 平面の初期点数
  function scorePlan(r) {
    var s = [0, 0, 0, 0, 0, 0, 0], interior = r.touchN === 0, kn = r.kids.length, i;
    if (r.touchN >= 2 && r.areaFrac > 0.08) s[GROUND] = 0.85;
    if (r.touchN >= 1 && r.touchB && r.wn > 0.5) s[GROUND] = mx(s[GROUND], 0.7);
    var tiny = interior && r.areaFrac < 0.01 && r.areaFrac > 0.0004 && r.fill > 0.68 && r.fill < 0.86 && r.aspect > 0.8 && r.aspect < 1.25 && kn === 0;
    if (tiny) s[VEG] = 0.85;
    if (interior && !r.rect && !tiny && r.fill < 0.76 && r.areaFrac > 0.004 && kn === 0 && r.aspect > 0.4 && r.aspect < 2.5) s[WATER] = 0.7;
    if (interior && r.rectK && r.areaFrac > 0.04) { var nr = 0, nd = 0; for (i = 0; i < kn; i++) { var q = r.kidsRef[i]; if (q.fill < 0.86) nd++; else if (q.rect) nr++; }
      if (nd >= 2) s[VEG] = 0.8; else if (nr >= 1) s[ROOF] = 0.75; else { s[ROOF] = 0.35; s[GROUND] = 0.3; } }
    if (interior && r.rect && r.areaFrac < 0.04 && r.twins >= 2) s[GROUND] = mx(s[GROUND], 0.7);
    colourCue(r, s);
    return s;
  }

  // ---------------------------------------------------------------- 隣の種別を見て点数を直す（立面）
  function refineElev(R, P) {
    var n = R.length, out = new Array(n), i, j, k, r, s, sh;
    for (i = 0; i < n; i++) {
      r = R[i]; s = P[i].slice(); sh = nbrShare(r, P);
      // 屋根: 上に空があり、下に壁・ガラスがあるほど屋根
      if (r.band || (r.fill > 0.35 && r.fill < 0.68)) {
        var roofy = ramp(sh[SKY], 0.1, 0.45) * 0.5 + ramp(sh[WALL] + sh[GLASS], 0.2, 0.6) * 0.4;
        if (s[ROOF] > 0) s[ROOF] = mx(s[ROOF], 0.3 + roofy);
        if (s[ROOF] > 0.5 && sh[SKY] < 0.08) s[ROOF] *= 0.5;
        if (r.band && sh[SKY] > 0.25) s[WALL] *= 0.4;
      }
      // 雲: 空に囲まれた塊は空
      if (r.parent >= 0 && P[r.parent][SKY] > 0.6 && !r.rect) { s[SKY] = 0.85; s[VEG] *= 0.3; }
      // 幹・細い柱: 上に丸い植栽がつながれば植栽
      if (r.thinV && sh[VEG] > 0.25) { s[VEG] = 0.85; s[WALL] *= 0.3; }
      // ガラス: 壁に囲まれていれば確からしい。柱の間も
      if (s[GLASS] > 0) {
        if (r.holder >= 0 && P[r.holder][WALL] > 0.5) s[GLASS] = mx(s[GLASS], 0.55 + 0.3 * ramp(r.twins, 0, 2));
        var cols = 0; for (j = 0; j < r.nbrs.length; j++) if (R[r.nbrs[j].id].thinV) cols++;
        if (cols >= 2) s[GLASS] = mx(s[GLASS], 0.8);
        if (r.parent >= 0 && P[r.parent][GROUND] > 0.6) s[GLASS] *= 0.2;
      }
      // 背景の林: 画面の左右どちらかの端に接し、空と接する、地平より上の大きな不規則領域
      if (r.touchN === 1 && (r.touchL || r.touchR) && r.cyn < 0.7 && r.areaFrac > 0.02 && sh[SKY] > 0.3) s[VEG] = mx(s[VEG], 0.65);
      // 地面に囲まれた足元の領域（園路）は地面
      if (r.touchB && r.parent < 0 && sh[GROUND] > 0.3) s[GROUND] = mx(s[GROUND], 0.8);
      if (r.parent >= 0 && P[r.parent][GROUND] > 0.6 && r.areaFrac > 0.004 && r.touchB) s[GROUND] = mx(s[GROUND], 0.8);
      out[i] = s;
    }
    stackWater(R, out);
    return out;
  }

  // 水面の約束: 地平より下の、画面幅いっぱいの水平な帯が三枚以上積み重なっていれば、一枚目は岸（地面）、残りは水。
  function stackWater(R, S) {
    var strips = [], i, j;
    for (i = 0; i < R.length; i++) { var r = R[i]; if (r.touchL && r.touchR && r.fill > 0.93 && r.hn < 0.2 && r.botn > 0.55 && r.wn > 0.9) strips.push(r); }
    strips.sort(function (a, b) { return a.topn - b.topn; });
    var chain = [];
    for (i = 0; i < strips.length; i++) {
      if (chain.length && Math.abs(strips[i].topn - chain[chain.length - 1].botn) > 0.02) { if (chain.length >= 3) apply(chain); chain = []; }
      chain.push(strips[i]);
    }
    if (chain.length >= 3) apply(chain);
    function apply(ch) {
      for (j = 0; j < ch.length; j++) { var s = S[ch[j].id]; if (j === 0) { s[GROUND] = 0.85; s[WATER] = 0; } else { s[WATER] = 0.85; s[GROUND] = 0; } }
    }
  }

  // ---------------------------------------------------------------- 隣の種別を見て点数を直す（平面）
  function refinePlan(R, P) {
    var n = R.length, out = new Array(n), i, r, s;
    for (i = 0; i < n; i++) {
      r = R[i]; s = P[i].slice();
      // 屋根の中の矩形（中庭）は地面
      if (r.parent >= 0 && P[r.parent][ROOF] > 0.5 && r.rect && r.areaFrac > 0.01) { s[GROUND] = 0.8; s[ROOF] *= 0.2; s[VEG] *= 0.3; }
      // 芝・植栽に囲まれた不定形の塊は水
      if (r.parent >= 0 && P[r.parent][VEG] > 0.5 && s[WATER] > 0.5) s[WATER] = 0.8;
      out[i] = s;
    }
    return out;
  }

  // 線の太さが作る極小・極細の領域は、いちばん長く接する隣の領域の点数を引き継ぐ。
  function adoptSlivers(R, P) {
    var i, j, r, best, bj, snap = P.map(function (p) { return p.slice(); });
    for (i = 0; i < R.length; i++) {
      r = R[i];
      if (!(r.areaFrac < 0.0016 && Math.min(r.wn, r.hn) < 0.016)) continue;
      best = -1; bj = -1;
      for (j = 0; j < r.nbrs.length; j++) { var q = R[r.nbrs[j].id]; if (q.areaFrac >= 0.0016 && r.nbrs[j].len > best) { best = r.nbrs[j].len; bj = q.id; } }
      if (bj >= 0) { var s2 = snap[bj].slice(); for (j = 0; j < 7; j++) s2[j] *= 0.9; P[i] = s2; }
    }
  }

  function nbrShare(r, P) {
    var sh = [0, 0, 0, 0, 0, 0, 0], tot = 0, i, j, e;
    for (i = 0; i < r.nbrs.length; i++) {
      e = r.nbrs[i]; tot += e.len; var p = P[e.id], best = 0, bj = -1;
      for (j = 0; j < 7; j++) if (p[j] > best) { best = p[j]; bj = j; }
      if (bj >= 0 && best >= 0.3) sh[bj] += e.len;
    }
    if (tot) for (j = 0; j < 7; j++) sh[j] /= tot;
    return sh;
  }

  // ---------------------------------------------------------------- 入口
  /** res: regions.extract() の戻り値。opts: { view, threshold, passes }。 */
  function classify(res, opts) {
    var op = {}, k; for (k in DEFAULTS) op[k] = DEFAULTS[k]; if (opts) for (k in opts) if (opts[k] !== undefined) op[k] = opts[k];
    var R = prep(res), n = R.length, i, view = op.view === 'auto' ? detectView(R) : op.view;
    for (i = 0; i < n; i++) { var kr = []; for (var j = 0; j < R[i].kids.length; j++) kr.push(R[R[i].kids[j]]); R[i].kidsRef = kr; }
    var P = new Array(n);
    for (i = 0; i < n; i++) P[i] = view === 'plan' ? scorePlan(R[i]) : scoreElev(R[i]);
    for (k = 0; k < op.passes; k++) P = view === 'plan' ? refinePlan(R, P) : refineElev(R, P);
    adoptSlivers(R, P);
    var out = new Array(n);
    for (i = 0; i < n; i++) {
      var s = P[i], a = -1, b = -1, bi = -1;
      for (k = 0; k < 7; k++) { if (s[k] > a) { b = a; a = s[k]; bi = k; } else if (s[k] > b) b = s[k]; }
      var conf = Math.max(0, Math.min(1, a - 0.6 * Math.max(b, 0)));
      out[i] = { id: i, cls: conf >= op.threshold ? CLASSES[bi] : 'unknown', best: CLASSES[bi], conf: conf, scores: s };
    }
    for (i = 0; i < n; i++) { delete R[i].kidsRef; }
    return { view: view, threshold: op.threshold, classes: CLASSES.slice(), regions: out };
  }

  /** 画素ごとの種別番号（CLASSES の添字。未判定は -1）。 */
  function classMap(res, cl) {
    var m = new Int8Array(res.labels.length), tab = new Int8Array(cl.regions.length), i;
    for (i = 0; i < tab.length; i++) tab[i] = CLASSES.indexOf(cl.regions[i].cls);
    for (i = 0; i < m.length; i++) m[i] = tab[res.labels[i]];
    return m;
  }

  return { CLASSES: CLASSES, defaults: DEFAULTS, classify: classify, classMap: classMap, detectView: detectView };
});
