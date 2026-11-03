/* VECTOR PAINT: 画面の薄い橋渡し。
 *   線画 → 領域分割(ai/regions.js) → 面の種類の判定(ai/labeler.js 経由) → ID 画像として paint に渡し、判定を文字で重ねて示す。
 *   色は持たない（着彩は paint 本体の受け持ち）。ここが返すのは「どの面が何か」だけ。
 *   修正: paint の魔法の杖(ID 画像で領域ぴったり選択)で選び、種類のチップを押す。 */
(function () {
  'use strict';
  var P = window.paint, T = P._t, CL = window.VPClassify, RG = window.VP.regions, LB = window.VPLabeler;
  var CLASSES = CL.CLASSES.slice();
  var JA = { wall: '壁', glass: 'ガラス', ground: '地面・床', roof: '屋根', vegetation: '植栽', water: '水', sky: '空', unknown: '未判定' };
  var SHORT = { wall: '壁', glass: 'ガ', ground: '地', roof: '屋', vegetation: '植', water: '水', sky: '空', unknown: '?' };   // 狭い領域用の一字
  var INK = { done: '#0a7290', unknown: '#c62828', halo: 'rgba(255,255,255,.92)' };
  var FONT = 'Bahnschrift, "Segoe UI", "Yu Gothic UI", system-ui, sans-serif';
  var S = { res: null, img: null, labels: null, fix: {}, sources: null, name: '', threshold: 0.30, labeler: 'rule', view: '', busy: false, areas: null, anc: null, ver: 0, stats: null };
  var $ = function (s) { return document.querySelector(s); };

  function say(text, err) { var m = $('#vp-msg'); m.textContent = text || ''; m.classList.toggle('err', !!err); }
  function effCls(r) { return S.fix[r] || S.labels[r].cls; }
  function effSrc(r) { return S.fix[r] ? 'manual' : (S.labels[r].source || 'rule'); }
  var SRC = { ai: 'AI', rule: '規則版', manual: '手で修正' };

  // BYOK: キーはこの閉じた関数の中だけに置く（S や window には出さない）。既定はメモリのみ。
  // 「このタブを閉じるまで覚える」を選んだ時だけ sessionStorage（localStorage には書かない）。
  var KEY = '', SKEY = 'vp-session-key', MODELS = {};
  function ssGet() { try { return window.sessionStorage.getItem(SKEY) || ''; } catch (e) { return ''; } }
  function ssSet(v) { try { if (v) window.sessionStorage.setItem(SKEY, v); else window.sessionStorage.removeItem(SKEY); } catch (e) { /* 使えない環境ではメモリのみ */ } }
  function provider() { var el = $('#vp-prov'); return el && el.value || 'gemini'; }
  function modelName() { var p = provider(); return (MODELS[p] != null ? MODELS[p] : LB.PROVIDERS[p].model); }

  function drawToData(el, maxDim) {
    var w = el.naturalWidth || el.width, h = el.naturalHeight || el.height, k = Math.min(1, maxDim / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    var g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(el, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height);
  }
  function loadImageEl(src) { return new Promise(function (ok, ng) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = function () { ng(new Error('画像を読めません')); }; im.src = src; }); }

  /** 判定の文字を描く。s,ox,oy は画像→画面の写し（画面 = 画像 * s + o）。fs は文字の大きさ（描く先の画素）。
   *  収まる順に「名前」→「一字」→「点」。点も置けない細い領域は出さない（指を乗せれば読み上げ欄に出る）。 */
  function drawLabels(g, s, ox, oy, fs, w, h) {
    if (!S.res || !S.labels || !S.anc) return 0;
    var a = S.anc, r, c, t, x, y, d, mk, cnt = 0;
    g.font = '500 ' + fs + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    for (r = 0; r < S.res.n; r++) {
      d = a.d[r] * s; if (d < 2) continue;
      x = a.x[r] * s + ox; y = a.y[r] * s + oy; if (x < -60 || y < -20 || x > w + 60 || y > h + 20) continue;
      c = effCls(r); mk = S.fix[r] ? '*' : ''; t = JA[c] + mk;
      if (d < fs * 0.6 || g.measureText(t).width > 2.4 * d) { t = SHORT[c] + mk; if (d < fs * 0.45 || g.measureText(t).width > 2.4 * d) t = ''; }
      g.fillStyle = c === 'unknown' ? INK.unknown : INK.done;
      if (!t) { g.beginPath(); g.arc(x, y, Math.min(2.5, d * 0.6), 0, 6.2832); g.fill(); cnt++; continue; }
      g.lineWidth = Math.max(2, fs * 0.28); g.strokeStyle = INK.halo; g.strokeText(t, x, y);
      g.fillText(t, x, y); cnt++;
    }
    return cnt;
  }

  // 画面の上の重ね（paint の拡大・移動に合わせて描き直す。押せない）
  var OV = { cv: null, key: '', count: 0 };
  function overlayFrame() {
    var cv = OV.cv, st = cv.parentNode, w = st.clientWidth, h = st.clientHeight, dpr = window.devicePixelRatio || 1, v = T.view();
    var key = [w, h, dpr, v.s, v.ox, v.oy, S.ver, !!P.state].join();
    if (key !== OV.key) {
      OV.key = key;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
      var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      OV.count = P.state ? drawLabels(g, v.s, v.ox, v.oy, 11, w, h) : 0;
    }
    requestAnimationFrame(overlayFrame);
  }
  function setupOverlay() {
    var st = $('#stage'), cv = document.createElement('canvas'); cv.id = 'vp-over'; cv.setAttribute('aria-hidden', 'true');
    st.insertBefore(cv, $('#drop')); OV.cv = cv; requestAnimationFrame(overlayFrame);
    // 指の下の領域の判定を一行で示す
    $('#view').addEventListener('pointermove', function (e) {
      var o = $('#vp-at'); if (!S.res || !S.labels) { o.textContent = ''; return; }
      var b = e.currentTarget.getBoundingClientRect(), v = T.view(), x = Math.floor((e.clientX - b.left - v.ox) / v.s), y = Math.floor((e.clientY - b.top - v.oy) / v.s);
      if (x < 0 || y < 0 || x >= S.res.w || y >= S.res.h) { o.textContent = ''; return; }
      var r = S.res.labels[y * S.res.w + x], L = S.labels[r], c = effCls(r);
      o.textContent = 'この領域: ' + JA[c] + (S.fix[r] ? '（手で修正）' : '（確度 ' + L.conf.toFixed(2) + ' / 出どころ ' + SRC[effSrc(r)] + (c === 'unknown' ? ' / 候補 ' + JA[L.best] : '') + '）');
    });
  }

  async function openImageData(imd, name) {
    S.busy = true; say('領域を分けています…');
    await new Promise(function (r) { setTimeout(r, 10); });
    S.img = imd; S.name = name; S.fix = {}; S.labels = null;
    var t0 = performance.now();
    S.res = RG.extract({ width: imd.width, height: imd.height, data: imd.data });
    var idm = RG.idMap(S.res), idImg = new ImageData(idm.data, idm.width, idm.height);
    var area = new Float64Array(S.res.n); for (var i = 0; i < S.res.labels.length; i++) area[S.res.labels[i]]++;
    S.areas = area; S.anc = RG.anchors(S.res);
    await P.open({ image: imd, passes: { id: idImg }, name: name });
    S.segMs = Math.round(performance.now() - t0);
    await relabel(); showResult(); S.busy = false;
  }

  /** 判定をやり直す。AI（userKey）は opts.ai を真にした操作（「AI で判定」「自動分類」）のときだけ呼ぶ。
   *  画像を開いた時・しきい値を動かした時・方式を切り替えた時は、通信せず規則版で判定する。 */
  async function relabel(opts) {
    var useAi = S.labeler === 'userKey' && !!(opts && opts.ai), cfg = useAi ? { provider: provider(), model: modelName(), key: KEY } : undefined;
    say(useAi ? 'AI に判定を問い合わせています…' : '面の種類を判定しています…');
    S.labels = await LB.run(useAi ? 'userKey' : (S.labeler === 'userKey' ? 'rule' : S.labeler), S.res, S.img, { threshold: S.threshold }, cfg);
    S.view = S.labels.view || '';
    showAiNote();
  }

  /** AI の結果・失敗・案内を一か所に出す。失敗は「何が起きたか」と「直し方」を分けて示し、規則版に戻したことも書く。 */
  function showAiNote() {
    var box = $('#vp-ainote'); if (!box) return; box.textContent = ''; box.classList.remove('err');
    var a = S.labels && S.labels.ai, add = function (head, text) {
      var d = document.createElement('div'), b = document.createElement('b'); b.textContent = head; d.appendChild(b); d.appendChild(document.createTextNode(' ' + text)); box.appendChild(d);
    };
    if (!a) { if (S.labeler === 'userKey') add('案内', 'キーを入れて「AI で判定」を押してください。いまは規則版の判定です。'); return; }
    if (a.ok) { add('AI', a.model + ' が ' + a.sent + ' 件を判定。確度がしきい値以上の ' + a.used + ' 件を採用し、残りは規則版の結果です。'); return; }
    box.classList.add('err'); add('何が起きたか', a.title); add('直し方', a.fix); add('いまの表示', '規則版の判定です。');
  }

  /** 判定＋修正の結果を数え、凡例と画面の文字を描き直す。paint の層には触らない。 */
  function showResult() {
    if (!S.res || !S.labels) return;
    var n = S.res.labels.length, lab = S.res.labels, by = {}, i, c;
    CLASSES.concat(['unknown']).forEach(function (k) { by[k] = 0; });
    var cls = new Array(S.res.n); for (i = 0; i < S.res.n; i++) cls[i] = effCls(i);
    for (i = 0; i < n; i++) { c = cls[lab[i]]; by[c]++; }
    S.stats = by; S.ver++; renderLegend();
    var sc = { ai: 0, rule: 0, manual: 0 }; for (i = 0; i < S.res.n; i++) sc[effSrc(i)]++;
    var so = $('#vp-src'); if (so) so.textContent = '判定の出どころ: ' + ['ai', 'rule', 'manual'].map(function (k) { return SRC[k] + ' ' + sc[k] + ' 件'; }).join(' / ');
    S.sources = sc;
    var undecided = 0; for (i = 0; i < S.res.n; i++) if (cls[i] === 'unknown') undecided++;
    say('領域 ' + S.res.n + ' 件 / 未判定 ' + undecided + ' 件 / 手で修正 ' + Object.keys(S.fix).length + ' 件 / 図の種類: ' + (S.view === 'plan' ? '平面' : '立面'));
  }

  function renderLegend() {
    var box = $('#vp-legend'); box.textContent = '';
    CLASSES.concat(['unknown']).forEach(function (c) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'vp-chip' + (c === 'unknown' ? ' un' : ''); b.dataset.cls = c;
      var nm = document.createElement('span'); nm.textContent = JA[c];
      var ct = document.createElement('b'); ct.textContent = S.stats && S.stats[c] ? Math.round(100 * S.stats[c] / S.res.labels.length) + '%' : '';
      b.appendChild(nm); b.appendChild(ct);
      b.title = '選択中の領域を「' + JA[c] + '」にする';
      b.onclick = function () { setClassForSelection(c); };
      box.appendChild(b);
    });
  }

  /** paint の選択（魔法の杖）に半分以上かかる領域を、指定の種類にする。 */
  async function setClassForSelection(cls) {
    var D = P.state; if (!D || !S.res) return say('先に画像を読み込んでください', true);
    if (!D.sel) return say('先に魔法の杖で領域を選んでください', true);
    var sel = D.sel, lab = S.res.labels, cnt = new Float64Array(S.res.n), i, changed = 0;
    for (i = 0; i < lab.length; i++) if (sel[i]) cnt[lab[i]]++;
    for (i = 0; i < S.res.n; i++) if (cnt[i] > 0 && cnt[i] >= 0.5 * S.areas[i]) { S.fix[i] = cls; changed++; }
    if (!changed) return say('選択が領域の半分に届きません。魔法の杖で領域をそのまま選んでください', true);
    T.deselect(); showResult();
  }
  /** 画像上の座標(x,y)の領域を選び、種類を変える（魔法の杖と同じ処理）。 */
  async function fixAt(x, y, cls) { T.wandAt({ x: x, y: y }, 'replace'); await setClassForSelection(cls); }

  /** 線画に判定の文字を重ねた PNG（元画像と同じ寸法）を作る。 */
  function judgedCanvas() {
    var W = S.img.width, H = S.img.height, c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'); g.putImageData(S.img, 0, 0);
    drawLabels(g, 1, 0, 0, Math.max(11, Math.round(Math.max(W, H) / 110)), W, H);
    return c;
  }
  function exportJudged() {
    if (!S.res || !S.labels) return Promise.resolve(say('先に画像を読み込んでください', true));
    return new Promise(function (ok) {
      judgedCanvas().toBlob(function (b) {
        var u = URL.createObjectURL(b), a = document.createElement('a');
        a.href = u; a.download = (S.name || 'image').replace(/\.[a-z0-9]+$/i, '') + '_判定.png'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 4000); ok(b);
      }, 'image/png');
    });
  }

  /** 面の種類ごとのマスク層の PSD（灰色一色・層の名前 = 種類の名前・一番上に元の線画）。色は付けない。 */
  function exportMaskPSD() {
    if (!S.res || !S.labels) return Promise.resolve(say('先に画像を読み込んでください', true));
    var cls = new Array(S.res.n), i, names = { line: '線画' }; for (i = 0; i < S.res.n; i++) cls[i] = effCls(i);
    Object.keys(JA).forEach(function (k) { names[k] = JA[k]; });
    var bytes = window.VPMaskPSD.write(window.PaintPSD, { width: S.res.w, height: S.res.h, labels: S.res.labels, cls: cls, line: S.img.data, names: names });
    var u = URL.createObjectURL(new Blob([bytes], { type: 'image/vnd.adobe.photoshop' })), a = document.createElement('a');
    a.href = u; a.download = (S.name || 'image').replace(/\.[a-z0-9]+$/i, '') + '_面マスク.psd'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
    say('面ごとの PSD を書き出しました（' + bytes.length + ' バイト）');
    return Promise.resolve(bytes);
  }

  async function loadSample(id) {
    var it = (window.VPSamples && window.VPSamples.items || []).filter(function (s) { return s.id === id; })[0];
    if (!it) return say('サンプルが見つかりません', true);
    var im = await loadImageEl(it.line); await openImageData(drawToData(im, 1600), it.name);
  }
  async function loadFile(file) {
    var url = URL.createObjectURL(file);
    try { var im = await loadImageEl(url); await openImageData(drawToData(im, 1600), file.name || 'image'); } finally { URL.revokeObjectURL(url); }
  }

  /** 「自動分類」「AI で判定」: いまの方式で判定し直す。方式が AI なら、ここで初めて通信する。 */
  async function runLabel() {
    if (!S.res) return say('先に画像を読み込んでください', true);
    if (S.busy) return;
    S.busy = true; S.fix = {};
    try { await relabel({ ai: true }); showResult(); } catch (e) { say(String(e && e.message || e), true); } finally { S.busy = false; }
  }

  function setupByok() {
    var pv = $('#vp-prov'), md = $('#vp-model'), ky = $('#vp-key'), rm = $('#vp-remember');
    Object.keys(LB.PROVIDERS).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = LB.PROVIDERS[k].label; pv.appendChild(o); });
    md.value = modelName();
    pv.onchange = function () { md.value = modelName(); };
    md.oninput = function () { MODELS[provider()] = md.value; };
    var saved = ssGet(); if (saved) { KEY = saved; ky.value = saved; rm.checked = true; }
    ky.oninput = function () { KEY = ky.value; if (rm.checked) ssSet(KEY); };
    rm.onchange = function () { ssSet(rm.checked ? KEY : ''); };
    $('#vp-byok').hidden = S.labeler !== 'userKey';
  }

  function init() {
    var sel = $('#vp-sample'), items = (window.VPSamples && window.VPSamples.items) || [];
    items.forEach(function (s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
    var ls = $('#vp-labeler'); LB.list().forEach(function (e) { var o = document.createElement('option'); o.value = e.id; o.textContent = e.label; if (e.stub) o.disabled = true; ls.appendChild(o); });
    ls.onchange = async function () { S.labeler = ls.value; $('#vp-byok').hidden = S.labeler !== 'userKey'; if (S.res) { await relabel(); showResult(); } else showAiNote(); };
    setupByok();
    $('#vp-load').onclick = function () { loadSample(sel.value).catch(function (e) { say(String(e.message || e), true); }); };
    $('#vp-file').onclick = function () { $('#f-image').click(); };
    $('#f-image').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) { e.stopImmediatePropagation(); loadFile(f).catch(function (er) { say(String(er.message || er), true); }); } }, true);
    $('#vp-run').onclick = function () { return runLabel(); };
    $('#vp-ai').onclick = function () { return runLabel(); };
    $('#vp-mask').onclick = function () { exportMaskPSD(); };
    $('#vp-reset').onclick = function () { if (!S.res) return; S.fix = {}; showResult(); };
    $('#vp-export').onclick = function () { exportJudged(); };
    var thr = $('#vp-thr'), out = $('#vp-thr-v');
    thr.oninput = function () { out.textContent = (thr.value / 100).toFixed(2); };
    // しきい値は通信せずに合成し直す（AI の答えは持っている）。AI を使っていない時は規則版を判定し直す。
    thr.onchange = async function () {
      S.threshold = thr.value / 100; if (!S.res) return;
      if (S.labels && S.labels.ai && S.labels.ai.ok) { S.labels = LB.remerge(S.labels, S.threshold); showAiNote(); } else await relabel();
      showResult();
    };
    renderLegend(); setupOverlay();
    // 左上の「開く」でも同じ流れに入れる（画像を開くと paint が単独で開くため、こちらで差し替える）
    var bo = $('#b-open'); if (bo) bo.onclick = function () { bo.blur(); $('#f-image').click(); };
    say('サンプルを選んで「読み込む」、または画像を開いてください');
  }

  window.VPApp = { state: S, JA: JA, overlay: OV, loadSample: loadSample, loadFile: loadFile, openImageData: openImageData, relabel: relabel, showResult: showResult, fixAt: fixAt, setClassForSelection: setClassForSelection, exportJudged: exportJudged, exportMaskPSD: exportMaskPSD, runLabel: runLabel };
  init();
})();
