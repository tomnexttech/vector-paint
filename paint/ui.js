/* zumen-kit paint: 画面と操作。core.js（純粋な計算）と psd.js の上に載る。
 * 入口: window.paint.open({ image, passes:{ id, shadow, ao, line }, name })
 * image / 各 pass は URL 文字列・data URL・Blob/File・Image・Canvas・ImageBitmap・ImageData のいずれか。
 * window 以外への依存なし。読み込みはすべて相対パス（Electron の殻からもそのまま index.html を開ける）。 */
(function () {
  'use strict';
  window.__errs = window.__errs || []; // 試験用: 捕まえた例外の控え（画面には出さない）
  window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason)));
  const C = window.PaintCore, PSD = window.PaintPSD, I = window.PaintI18n, t = I.t;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const clamp = C.clamp;
  const jclone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const ru = (a, b) => (a && b ? C.rectUnion(a, b) : (a || b || null));
  const irect = (x0, y0, x1, y1) => { x0 = Math.floor(x0); y0 = Math.floor(y0); return { x: x0, y: y0, w: Math.ceil(x1) - x0 + 1, h: Math.ceil(y1) - y0 + 1 }; };

  // ------------------------------------------------------------------ 設定（書体・テーマ・言語）
  const PREF_KEY = 'zumen-paint.prefs';
  const prefs = { lang: /^ja/i.test(navigator.language || '') ? 'ja' : 'en', theme: 'light', font: '' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* 保存先が無くても動く */ }
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* 無視 */ } };
  function applyFont() {
    const f = (prefs.font || '').trim().replace(/["\\;{}]/g, '');
    const first = f ? (/^(system-ui|sans-serif|serif|monospace)$/i.test(f) ? f + ', ' : '"' + f + '", ') : '';
    document.documentElement.style.setProperty('--ui-font', first + 'Bahnschrift, "DIN Alternate", "Yu Gothic UI", "Segoe UI", Meiryo, sans-serif');
  }
  let CV = {};
  function cssVars() { const cs = getComputedStyle(document.documentElement); CV = { line: cs.getPropertyValue('--line').trim(), accent: cs.getPropertyValue('--accent').trim(), red: cs.getPropertyValue('--red').trim(), ink: cs.getPropertyValue('--ink').trim() }; }
  function applyTheme() { document.documentElement.dataset.theme = prefs.theme; cssVars(); needView = true; requestFrame(); }

  // ------------------------------------------------------------------ 状態
  const DEFAULTS = { shadeMode: 'multiply', refMul: 1, lineOpacity: 1, idUse: true, idContig: false, idTol: 0, tol: 24, lineThr: 90, gap: 2, brush: 28, pbrush: 44, phard: 0.7 };
  const set = Object.assign({}, DEFAULTS);
  const M = { kind: 'solid', color: '#c9d4d9', color2: '#eef4f8', mid: null, midPos: 0.5, shape: 'linear', contrast: 1, scale: 1, rot: 0, tex: null };
  let D = null, tool = 'wand', space = false, mouse = null, pan = null, stroke = null;
  let poly = [], perspPts = null, perspPrev = 'wand';
  const V = { s: 1, ox: 0, oy: 0 };
  let vw = 0, vh = 0, dpr = 1;
  const view = $('#view'), vctx = view.getContext('2d');

  function curMaterial() {
    const m = { kind: M.kind, color: M.color, contrast: M.contrast, scale: M.scale, rot: M.rot };
    if (M.kind === 'gradient') { m.color2 = M.color2; if (M.mid) m.mid = M.mid; m.midPos = M.midPos; if (M.shape === 'radial') m.shape = 'radial'; }
    if (M.kind === 'user') m.tex = M.tex;
    return m;
  }
  const loadMaterial = m => {
    Object.assign(M, { kind: m.kind, color: m.color || '#cccccc', color2: m.color2 || '#eef4f8', mid: m.mid || null, midPos: m.midPos == null ? 0.5 : m.midPos,
      shape: m.shape === 'radial' ? 'radial' : 'linear', contrast: m.contrast == null ? 1 : m.contrast, scale: m.scale || 1, rot: m.rot || 0, tex: m.tex || null });
  };

  // ------------------------------------------------------------------ メッセージ
  let msgTimer = 0;
  function msg(key, err, params) {
    const m = $('#msg'); m.textContent = key == null ? '' : t(key, params); m.classList.toggle('err', !!err);
    clearTimeout(msgTimer); if (err) msgTimer = setTimeout(() => m.classList.remove('err'), 7000);
  }

  // ------------------------------------------------------------------ 画像の読み込み
  function blobToDataURL(b) { return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(b); }); }
  async function loadSource(src, opaque, maxDim) {
    if (src && src.width != null && src.data && src.constructor && src.constructor.name === 'ImageData') return { w: src.width, h: src.height, data: new Uint8ClampedArray(src.data), url: null, blob: null };
    let img, url = null, blob = null, revoke = null;
    if (typeof src === 'string') url = src;
    else if (src instanceof Blob) { blob = src; url = URL.createObjectURL(src); revoke = url; }
    if (url != null) img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image load failed')); i.src = url; });
    else img = src;
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, dw = w, dh = h;
    if (maxDim && Math.max(w, h) > maxDim) { const k = maxDim / Math.max(w, h); dw = Math.round(w * k); dh = Math.round(h * k); }
    const c = document.createElement('canvas'); c.width = dw; c.height = dh;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (opaque) { g.fillStyle = '#fff'; g.fillRect(0, 0, dw, dh); }
    g.drawImage(img, 0, 0, dw, dh);
    const data = g.getImageData(0, 0, dw, dh).data;
    if (revoke) URL.revokeObjectURL(revoke);
    return { w: dw, h: dh, data, url: typeof src === 'string' && src.slice(0, 5) === 'data:' ? src : null, blob };
  }
  async function entryDataURL(e) {
    if (e.url && e.url.slice(0, 5) === 'data:') return e.url;
    if (e.blob) return blobToDataURL(e.blob);
    const c = document.createElement('canvas'); c.width = e.w; c.height = e.h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(e.data), e.w, e.h), 0, 0);
    return c.toDataURL('image/png');
  }

  // ------------------------------------------------------------------ 書類
  function buildDoc(base, passes, name) {
    const W = base.w, H = base.h;
    const d = { W, H, name: name || 'untitled', base: base.data, baseSrc: base, passes: { id: null, shadow: null, ao: null, line: null }, passErr: {},
      layers: [], activeId: null, pendingId: null, nextId: 1, counters: {}, textures: [], sel: null, selBox: null, selCount: 0, selOn: false,
      histDirty: false };
    for (const k of ['id', 'shadow', 'ao', 'line']) { const p = passes && passes[k]; if (p) { if (p.w === W && p.h === H) d.passes[k] = p; else d.passErr[k] = true; } }
    d.ctx = C.createContext({ w: W, h: H, base: base.data, id: d.passes.id && d.passes.id.data, shadow: d.passes.shadow && d.passes.shadow.data,
      ao: d.passes.ao && d.passes.ao.data, line: d.passes.line && d.passes.line.data, refMul: set.refMul, lineOpacity: set.lineOpacity });
    d.comp = new Uint8ClampedArray(W * H * 4);
    d.compCanvas = document.createElement('canvas'); d.compCanvas.width = W; d.compCanvas.height = H;
    d.compCtx = d.compCanvas.getContext('2d'); d.compImg = new ImageData(d.comp, W, H);
    d.selCanvas = null;
    return d;
  }
  function installDoc(d) {
    D = d; pend = null; stroke = null; poly = []; perspPts = null;
    hist.stack = []; hist.pos = -1;
    C.compositeRegion(D.ctx, D.layers, { x: 0, y: 0, w: D.W, h: D.H }, D.comp);
    D.compCtx.putImageData(D.compImg, 0, 0);
    $('#drop').classList.add('hidden');
    fitView(); pushHist(); buildShelf(); renderLayers(); syncPanels(); updatePassStatus(); updateStatus();
    needView = true; requestFrame();
  }
  async function openBase(src, passes, name) {
    msg('m_busy');
    try {
      const base = await loadSource(src, true);
      const ps = {};
      if (passes) for (const k of ['id', 'shadow', 'ao', 'line']) if (passes[k]) { try { ps[k] = await loadSource(passes[k], false); } catch (e) { /* 次へ */ } }
      installDoc(buildDoc(base, ps, name));
      msg('m_loaded', false, { w: base.w, h: base.h });
      for (const k of Object.keys(D.passErr)) msg('m_pass_bad', true, { n: t('p_' + k) });
    } catch (e) { msg(String(e && e.name) === 'SecurityError' ? 'm_taint' : 'm_open_fail', true); throw e; }
  }

  // ------------------------------------------------------------------ 描画の要求
  let needView = true, pend = null, raf = 0;
  const requestFrame = () => { if (!raf) raf = requestAnimationFrame(frame); };
  function frame() {
    raf = 0;
    if (pend && D) { const r = pend; pend = null; recomposeNow(r); }
    if (needView) { needView = false; draw(); updateStatus(); }
  }
  function queueRect(r) { if (!r || !D) return; pend = ru(pend, r); requestFrame(); }
  function recomposeNow(r) {
    const rr = C.compositeRegion(D.ctx, D.layers, r, D.comp); if (!rr) return;
    D.compCtx.putImageData(D.compImg, 0, 0, rr.x, rr.y, rr.w, rr.h); needView = true;
  }
  function flushNow() { if (pend && D) { const r = pend; pend = null; recomposeNow(r); } }
  const fullRect = () => ({ x: 0, y: 0, w: D.W, h: D.H });

  // ------------------------------------------------------------------ 表示（拡大・移動）
  function resize() {
    const st = $('#stage'); dpr = window.devicePixelRatio || 1;
    vw = st.clientWidth; vh = st.clientHeight;
    view.width = Math.max(1, Math.round(vw * dpr)); view.height = Math.max(1, Math.round(vh * dpr));
    needView = true; requestFrame();
  }
  function fitView() {
    if (!D) return; const m = 30;
    const s = Math.min((vw - m * 2) / D.W, (vh - m * 2) / D.H);
    V.s = Math.max(0.02, s); V.ox = (vw - D.W * V.s) / 2; V.oy = (vh - D.H * V.s) / 2; needView = true; requestFrame();
  }
  function zoomAt(sx, sy, ns) {
    ns = clamp(ns, 0.02, 40); const ix = (sx - V.ox) / V.s, iy = (sy - V.oy) / V.s;
    V.s = ns; V.ox = sx - ix * ns; V.oy = sy - iy * ns; needView = true; requestFrame();
  }
  function toImg(e) {
    const r = view.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { x: (sx - V.ox) / V.s, y: (sy - V.oy) / V.s, sx, sy };
  }
  function draw() {
    const g = vctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, vw, vh);
    if (!D) return;
    g.save(); g.translate(V.ox, V.oy); g.scale(V.s, V.s);
    g.imageSmoothingEnabled = V.s < 1.5; g.imageSmoothingQuality = 'high';
    g.drawImage(D.compCanvas, 0, 0);
    if (D.selOn && D.selCanvas) g.drawImage(D.selCanvas, 0, 0);
    g.restore();
    // 製図の枠と四隅の L 字
    const x0 = V.ox, y0 = V.oy, x1 = V.ox + D.W * V.s, y1 = V.oy + D.H * V.s, L = 14, o = 6;
    g.lineWidth = 1; g.strokeStyle = CV.line; g.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
    g.strokeStyle = CV.accent; g.lineWidth = 2; g.beginPath();
    g.moveTo(x0 - o, y0 - o + L); g.lineTo(x0 - o, y0 - o); g.lineTo(x0 - o + L, y0 - o);
    g.moveTo(x1 + o - L, y0 - o); g.lineTo(x1 + o, y0 - o); g.lineTo(x1 + o, y0 - o + L);
    g.moveTo(x1 + o, y1 + o - L); g.lineTo(x1 + o, y1 + o); g.lineTo(x1 + o - L, y1 + o);
    g.moveTo(x0 - o + L, y1 + o); g.lineTo(x0 - o, y1 + o); g.lineTo(x0 - o, y1 + o - L); g.stroke();
    // 多角形（作図中）
    if (poly.length) {
      g.lineWidth = 1.2; g.strokeStyle = CV.accent; g.beginPath();
      poly.forEach((p, i) => { const X = V.ox + p.x * V.s, Y = V.oy + p.y * V.s; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      if (mouse && tool === 'poly') g.lineTo(mouse.sx, mouse.sy);
      g.stroke();
      poly.forEach((p, i) => { const X = V.ox + p.x * V.s, Y = V.oy + p.y * V.s; g.fillStyle = i === 0 ? CV.red : CV.accent; g.fillRect(X - 3, Y - 3, 6, 6); });
    }
    if (perspPts) {
      g.lineWidth = 1.2; g.strokeStyle = CV.red; g.beginPath();
      perspPts.forEach((p, i) => { const X = V.ox + p.x * V.s, Y = V.oy + p.y * V.s; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      if (perspPts.length === 4) g.closePath(); g.stroke();
      perspPts.forEach((p, i) => { const X = V.ox + p.x * V.s, Y = V.oy + p.y * V.s; g.fillStyle = CV.red; g.fillRect(X - 3, Y - 3, 6, 6); g.fillText(String(i + 1), X + 6, Y - 6); });
    }
    // ブラシの輪
    if (mouse && !pan && !space && (tool === 'brush' || tool === 'eraser' || tool === 'paint')) {
      const r = (tool === 'paint' ? set.pbrush : set.brush) / 2 * V.s;
      g.lineWidth = 1; g.strokeStyle = tool === 'eraser' ? CV.red : CV.accent; g.beginPath(); g.arc(mouse.sx, mouse.sy, Math.max(1.5, r), 0, Math.PI * 2); g.stroke();
    }
  }
  function updateStatus() {
    $('#st-zoom').textContent = D ? Math.round(V.s * 100) + '%' : '';
    $('#st-size').textContent = D ? D.W + ' x ' + D.H : '';
    $('#st-sel').textContent = D && D.selCount ? t('m_sel', { n: D.selCount.toLocaleString() }) : '';
    $('#st-pos').textContent = D && mouse ? Math.round(mouse.x) + ', ' + Math.round(mouse.y) : '';
  }

  // ------------------------------------------------------------------ 選択
  function ensureSelCanvas() {
    if (D.selCanvas) return;
    D.selCanvas = document.createElement('canvas'); D.selCanvas.width = D.W; D.selCanvas.height = D.H;
    D.selCtx = D.selCanvas.getContext('2d'); D.selImg = new ImageData(D.W, D.H);
  }
  function updateSelOverlay(r) {
    if (!D) return;
    D.selOn = !!D.sel;
    if (!r || (!D.sel && !D.selCanvas)) { needView = true; requestFrame(); return; }
    ensureSelCanvas(); r = C.rectClamp(r, D.W, D.H); if (!r) return;
    const W = D.W, d = D.selImg.data, s = D.sel;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * W + x, p = i * 4, v = s ? s[i] : 0;
        if (v) { d[p] = 0; d[p + 1] = 188; d[p + 2] = 230; d[p + 3] = v * 0.4; } else d[p + 3] = 0;
      }
    }
    D.selCtx.putImageData(D.selImg, 0, 0, r.x, r.y, r.w, r.h); needView = true; requestFrame();
  }
  function recountSel() {
    if (!D.sel) { D.selBox = null; D.selCount = 0; return; }
    const bb = C.maskBBox(D.sel, D.W, D.H);
    if (!bb) { D.sel = null; D.selBox = null; D.selCount = 0; return; }
    D.selBox = bb; D.selCount = C.maskCount(D.sel);
  }
  function setSelection(mask) { // 全消し・置換（履歴なし）
    const old = D.selBox; D.sel = mask; recountSel(); updateSelOverlay(ru(old, D.selBox));
  }
  function applySelection(m, mode) {
    const old = D.selBox;
    if (mode === 'replace' || !D.sel) { D.sel = mode === 'sub' ? null : m; if (mode === 'replace') D.pendingId = null; }
    else if (mode === 'add') C.maskUnion(D.sel, m);
    else C.maskSubtract(D.sel, m);
    recountSel(); updateSelOverlay(ru(old, D.selBox)); syncPending();
    if (D.selCount) msg('m_sel', false, { n: D.selCount.toLocaleString() }); else msg('m_sel_none');
    pushHist(); renderLayers();
  }
  function deselect() { if (!D || !D.sel) return; D.pendingId = null; setSelection(null); pushHist(); renderLayers(); msg('m_sel_none'); }
  function invertSel() {
    if (!D) return; const old = D.selBox;
    const m = D.sel ? C.maskInvert(D.sel) : new Uint8Array(D.W * D.H).fill(255);
    D.sel = m; D.pendingId = null; recountSel(); updateSelOverlay(fullRect()); pushHist(); renderLayers();
  }
  function wandAt(p, mode) {
    const x = clamp(Math.floor(p.x), 0, D.W - 1), y = clamp(Math.floor(p.y), 0, D.H - 1);
    let m;
    if (D.passes.id && set.idUse) m = C.selectByID(D.ctx.id, D.W, D.H, x, y, { contiguous: set.idContig, tol: set.idTol });
    else m = C.floodSelect(D.base, D.W, D.H, x, y, { tol: set.tol, lineThr: set.lineThr, gap: set.gap, lineRGBA: D.passes.line ? D.passes.line.data : null });
    applySelection(m, mode);
  }

  // ------------------------------------------------------------------ レイヤー
  const layerById = id => D && D.layers.find(l => l.id === id);
  const cov = l => C.layerCoverageRect(l, D.W, D.H);
  function layerLabel(mat) {
    if (mat.kind === 'user') { const tx = D.textures.find(x => x.id === mat.tex); return tx ? tx.name : t('k_user'); }
    return t('k_' + mat.kind);
  }
  function newLayer(kind, mask, mat) {
    const base = kind === 'paint' ? t('k_paint') : layerLabel(mat);
    const n = (D.counters[base] = (D.counters[base] || 0) + 1);
    return { id: D.nextId++, name: base + ' ' + n, kind, visible: true, mode: set.shadeMode, opacity: 1, amount: 1, style: 'flat', wc: null,
      material: mat, persp: null, gbox: null, rev: 0, mask };
  }
  function fillSelection() {
    if (!D) { msg('m_need_image', true); return null; }
    if (!D.sel) { msg('m_need_sel', true); return null; }
    let L = D.pendingId && layerById(D.pendingId);
    if (L) { L.material = curMaterial(); queueRect(cov(L)); msg('m_changed', false, { n: L.name }); }
    else {
      const mask = C.cropMask(D.sel, D.W, D.H); if (!mask) return null;
      L = newLayer('fill', mask, curMaterial()); D.layers.push(L); D.activeId = L.id; D.pendingId = L.id;
      queueRect(cov(L)); msg('m_filled', false, { n: L.name });
    }
    renderLayers(); syncLayerCtl(); pushHist(); return L;
  }
  function syncPending() { // 選択の増減を、結び付いた層へ写す
    if (!D.pendingId) return;
    const L = layerById(D.pendingId);
    if (!L) { D.pendingId = null; return; }
    const old = cov(L);
    if (!D.sel) { D.layers = D.layers.filter(x => x !== L); D.pendingId = null; if (D.activeId === L.id) D.activeId = null; queueRect(old); }
    else { L.mask = C.cropMask(D.sel, D.W, D.H); L.rev++; queueRect(ru(old, cov(L))); }
    renderLayers(); syncLayerCtl();
  }
  function selectLayer(id) {
    const L = layerById(id); if (!L) return;
    D.activeId = id; D.pendingId = id;
    if (L.mask) { const old = D.selBox; D.sel = C.expandMask(L.mask, D.W, D.H); recountSel(); updateSelOverlay(ru(old, D.selBox)); }
    loadMaterial(L.material); syncPanels(); renderLayers(); syncLayerCtl();
  }
  function removeLayer(id) {
    const L = layerById(id); if (!L) return; const r = cov(L);
    D.layers = D.layers.filter(x => x !== L);
    if (D.activeId === id) D.activeId = D.layers.length ? D.layers[D.layers.length - 1].id : null;
    if (D.pendingId === id) { D.pendingId = null; }
    queueRect(r); renderLayers(); syncLayerCtl(); pushHist();
  }
  function moveLayer(id, dir) {
    const i = D.layers.findIndex(l => l.id === id), j = i + dir; if (i < 0 || j < 0 || j >= D.layers.length) return;
    const a = D.layers[i], b = D.layers[j]; D.layers[i] = b; D.layers[j] = a;
    queueRect(ru(cov(a), cov(b))); renderLayers(); pushHist();
  }
  function toggleLayer(id) { const L = layerById(id); if (!L) return; L.visible = !L.visible; queueRect(cov(L)); renderLayers(); pushHist(); }
  function touchLayer(L, final) { if (!L) return; L.rev = L.rev || 0; queueRect(ru(cov(L), L._lastCov)); L._lastCov = cov(L); D.histDirty = true; if (final) commitHist(); }

  // ------------------------------------------------------------------ 履歴（元に戻す／やり直し）
  const hist = { stack: [], pos: -1, max: 100 };
  const cloneLayer = l => Object.assign({}, l, { material: jclone(l.material), wc: jclone(l.wc), persp: jclone(l.persp), gbox: jclone(l.gbox), _lastCov: undefined });
  function snapshot() {
    return { layers: D.layers.map(cloneLayer), active: D.activeId, pending: D.pendingId, sel: D.sel ? C.cropMask(D.sel, D.W, D.H) : null, nextId: D.nextId };
  }
  function pushHist() {
    if (!D) return; D.histDirty = false;
    hist.stack.length = hist.pos + 1; hist.stack.push(snapshot());
    if (hist.stack.length > hist.max) hist.stack.shift();
    hist.pos = hist.stack.length - 1; syncUndoButtons();
  }
  function commitHist() { if (D && D.histDirty) pushHist(); }
  function diffRect(a, b) {
    const ma = new Map(a.map(l => [l.id, l])), mb = new Map(b.map(l => [l.id, l]));
    let r = null; const add = l => { const c = cov(l); r = ru(r, c); };
    for (const l of a) { const m = mb.get(l.id); if (!m || C.layerFullKey(l) !== C.layerFullKey(m)) { add(l); if (m) add(m); } }
    for (const l of b) if (!ma.has(l.id)) add(l);
    const idx = new Map(b.map((l, i) => [l.id, i]));
    a.forEach((l, i) => { if (idx.has(l.id) && idx.get(l.id) !== i) { add(l); add(mb.get(l.id)); } });
    return r;
  }
  function restore(s) {
    const old = D.layers, next = s.layers.map(cloneLayer);
    const r = diffRect(old, next);
    D.layers = next; D.activeId = s.active; D.pendingId = s.pending; D.nextId = Math.max(D.nextId, s.nextId);
    const ob = D.selBox; D.sel = s.sel ? C.expandMask(s.sel, D.W, D.H) : null; recountSel(); updateSelOverlay(ru(ob, D.selBox));
    queueRect(r); renderLayers(); syncLayerCtl(); syncUndoButtons();
    const L = layerById(D.activeId); if (L) { loadMaterial(L.material); syncPanels(); }
  }
  function undo() { if (!D) return; commitHist(); if (hist.pos <= 0) return; hist.pos--; restore(hist.stack[hist.pos]); }
  function redo() { if (!D || hist.pos >= hist.stack.length - 1) return; hist.pos++; restore(hist.stack[hist.pos]); }
  function syncUndoButtons() { $('#b-undo').disabled = !(D && hist.pos > 0); $('#b-redo').disabled = !(D && hist.pos < hist.stack.length - 1); }

  // ------------------------------------------------------------------ 描く（選択ブラシ・着色ブラシ）
  function beginStroke(p, kind, erase) {
    if (kind === 'sel') {
      if (!D.sel) { if (erase) return; D.sel = new Uint8Array(D.W * D.H); }
      stroke = { kind, buf: D.sel, erase, r: Math.max(0.5, set.brush / 2), hard: 0.9, rect: null, oldBox: D.selBox };
    } else {
      const mat = curMaterial();
      let L = layerById(D.activeId);
      if (!(L && L.kind === 'paint' && JSON.stringify(L.material) === JSON.stringify(mat) && L.style === 'flat' && !L.persp)) {
        L = newLayer('paint', null, mat); D.layers.push(L); D.activeId = L.id; L.isNew = true;
      }
      const buf = C.expandMask(L.mask, D.W, D.H);
      if (mat.kind === 'gradient') L.gbox = { x: 0, y: 0, w: D.W, h: D.H };
      L.mask = { x: 0, y: 0, w: D.W, h: D.H, data: buf }; L.rev++;
      D.pendingId = null;
      stroke = { kind, L, buf, erase: false, r: Math.max(0.5, set.pbrush / 2), hard: set.phard, rect: null };
    }
    strokeTo(p, true);
  }
  function strokeTo(p, first) {
    const st = stroke; if (!st) return;
    const W = D.W, H = D.H, x = p.x, y = p.y, r = st.r;
    if (first || Math.hypot(x - st.lx, y - st.ly) < 0.01) C.stampCircle(st.buf, W, H, x, y, r, st.hard, st.erase);
    else C.strokeSegment(st.buf, W, H, st.lx, st.ly, x, y, r, st.hard, st.erase);
    const lx = first ? x : st.lx, ly = first ? y : st.ly;
    const seg = C.rectClamp(irect(Math.min(x, lx) - r - 2, Math.min(y, ly) - r - 2, Math.max(x, lx) + r + 2, Math.max(y, ly) + r + 2), W, H);
    st.lx = x; st.ly = y; if (!seg) return;
    st.rect = ru(st.rect, seg);
    if (st.kind === 'sel') updateSelOverlay(seg); else { st.L.rev++; queueRect(seg); }
  }
  function endStroke() {
    const st = stroke; stroke = null; if (!st) return;
    if (st.kind === 'sel') {
      recountSel(); updateSelOverlay(ru(st.oldBox, D.selBox)); syncPending();
      if (D.selCount) msg('m_sel', false, { n: D.selCount.toLocaleString() }); else msg('m_sel_none');
      pushHist(); renderLayers();
    } else {
      const L = st.L, m = C.cropMask(st.buf, D.W, D.H);
      if (!m) { D.layers = D.layers.filter(x => x !== L); D.activeId = D.layers.length ? D.layers[D.layers.length - 1].id : null; }
      else { L.mask = m; L.rev++; delete L.isNew; }
      queueRect(st.rect); renderLayers(); syncLayerCtl(); pushHist();
    }
  }

  // ------------------------------------------------------------------ 多角形・遠近
  function polyClick(p, mode) {
    if (poly.length >= 3) { const f = poly[0]; if (Math.hypot((f.x - p.x) * V.s, (f.y - p.y) * V.s) < 9) return polyClose(); }
    const last = poly[poly.length - 1];
    if (last && Math.hypot((last.x - p.x) * V.s, (last.y - p.y) * V.s) < 3) return;
    if (!poly.length) poly.mode = mode;
    poly.push({ x: p.x, y: p.y }); msg('m_poly'); needView = true; requestFrame();
  }
  function polyClose() {
    const pts = poly.map(p => [p.x, p.y]), mode = poly.mode || 'replace'; poly = [];
    needView = true; requestFrame();
    if (pts.length < 3) return;
    applySelection(C.rasterPolygon(pts, D.W, D.H), mode);
  }
  function polyCancel() { poly = []; needView = true; requestFrame(); }
  function perspStart() {
    const L = layerById(D.activeId);
    if (!L || !L.mask) { msg('m_persp_need', true); return; }
    perspPrev = tool === 'persp' ? 'wand' : tool; perspPts = []; setTool('persp'); msg('m_persp1', false, { n: 0 });
  }
  function perspClick(p) {
    if (!perspPts) return perspStart();
    perspPts.push({ x: p.x, y: p.y }); msg('m_persp1', false, { n: perspPts.length });
    if (perspPts.length < 4) { needView = true; requestFrame(); return; }
    const L = layerById(D.activeId);
    if (L) {
      L.persp = { quad: perspPts.map(q => [q.x, q.y]), reps: (L.persp && L.persp.reps) || 4, aspectMul: (L.persp && L.persp.aspectMul) || 1 };
      L.rev++; queueRect(cov(L)); pushHist(); msg('m_persp_ok');
    }
    perspPts = null; setTool(perspPrev); syncLayerCtl();
  }

  // ------------------------------------------------------------------ ポインタ
  function onDown(e) {
    view.focus && view.focus();
    if (!D) return;
    view.setPointerCapture(e.pointerId);
    const p = toImg(e); mouse = p;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) { pan = { sx: e.clientX, sy: e.clientY, ox: V.ox, oy: V.oy }; updateCursor(); return; }
    if (e.button !== 0) return;
    const mode = e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace';
    if (tool === 'persp') return perspClick(p);
    if (p.x < 0 || p.y < 0 || p.x >= D.W || p.y >= D.H) { if (tool !== 'poly') return; }
    if (tool === 'wand') wandAt(p, mode);
    else if (tool === 'brush' || tool === 'eraser') beginStroke(p, 'sel', tool === 'eraser' || e.altKey);
    else if (tool === 'paint') beginStroke(p, 'paint');
    else if (tool === 'poly') polyClick(p, mode);
  }
  function onMove(e) {
    const p = toImg(e); mouse = p;
    if (pan) { V.ox = pan.ox + (e.clientX - pan.sx); V.oy = pan.oy + (e.clientY - pan.sy); needView = true; requestFrame(); return; }
    if (stroke) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) strokeTo(toImg(ev), false);
    }
    needView = true; requestFrame();
  }
  function onUp(e) {
    if (pan) { pan = null; updateCursor(); }
    if (stroke) endStroke();
    try { view.releasePointerCapture(e.pointerId); } catch (err) { /* 既に外れている */ }
  }
  function onWheel(e) {
    e.preventDefault(); if (!D) return;
    const r = view.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, V.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
  }
  function updateCursor() { view.style.cursor = pan ? 'grabbing' : space ? 'grab' : (tool === 'brush' || tool === 'eraser' || tool === 'paint') ? 'none' : 'crosshair'; }

  // ------------------------------------------------------------------ 道具
  const ICONS = {
    wand: '<circle cx="12" cy="12" r="3"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>',
    brush: '<circle cx="12" cy="12" r="7"/><path d="M12 9v6M9 12h6"/>',
    eraser: '<circle cx="12" cy="12" r="7"/><path d="M9 12h6"/>',
    poly: '<path d="M5 18L4 8l8-4 8 5-3 10z"/>',
    paint: '<circle cx="14" cy="10" r="6" style="fill:currentColor;fill-opacity:.22"/><path d="M3.5 20.5L9 15"/>',
    persp: '<path d="M5 6l14-2 2 16H3z"/><path d="M12 5v14M4 12h16" style="opacity:.5"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  };
  const TOOLS = [['wand', 'W'], ['brush', 'B'], ['eraser', 'E'], ['poly', 'P'], ['paint', 'C'], ['persp', 'T']];
  function buildTools() {
    const nav = $('#tools'); nav.innerHTML = '';
    for (const [k, key] of TOOLS) {
      const b = el('button'); b.dataset.tool = k; b.setAttribute('data-ti', 'tool_' + k);
      b.innerHTML = '<svg viewBox="0 0 24 24">' + ICONS[k] + '</svg><kbd>' + key + '</kbd>';
      b.onclick = () => { b.blur(); if (k === 'persp') perspStart(); else setTool(k); };
      nav.appendChild(b);
    }
    nav.appendChild(el('div', 'sp'));
    const f = el('button'); f.setAttribute('data-ti', 'tool_fit'); f.innerHTML = '<svg viewBox="0 0 24 24">' + ICONS.fit + '</svg><kbd>F</kbd>';
    f.onclick = () => { f.blur(); fitView(); }; nav.appendChild(f);
  }
  function setTool(k) {
    if (tool === 'poly' && k !== 'poly') poly = [];
    if (k !== 'persp') perspPts = null;
    tool = k; $$('#tools button[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === k));
    if (k === 'poly') msg('m_poly');
    updateCursor(); needView = true; requestFrame();
  }

  // ------------------------------------------------------------------ 素材の棚
  const PALETTE = ['#ffffff', '#f1ede4', '#d9d3c3', '#b7ae9b', '#8c8576', '#5d584c', '#2f2d28', '#c9a27a', '#a0703f',
    '#8d4a3b', '#c4573f', '#7d8f69', '#4f6b4a', '#93b7c9', '#5e8bb0', '#2d4f78', '#d8c46a', '#e0e6ea'];
  const thumbCache = new Map();
  function thumbURL(kind, color, contrast, size) {
    const key = kind + color + contrast + size; let u = thumbCache.get(key); if (u) return u;
    const tile = C.makeTile(kind, color, contrast, size), c = document.createElement('canvas'); c.width = c.height = size;
    c.getContext('2d').putImageData(new ImageData(tile.data, size, size), 0, 0);
    u = c.toDataURL('image/png'); thumbCache.set(key, u); return u;
  }
  function matCSS(m, size) {
    if (m.kind === 'raster') return 'linear-gradient(#cfd4d6,#cfd4d6)';
    if (m.kind === 'solid') return 'linear-gradient(' + m.color + ',' + m.color + ')';
    if (m.kind === 'gradient') return 'linear-gradient(to bottom,' + m.color + (m.mid ? ',' + m.mid : '') + ',' + (m.color2 || m.color) + ')';
    if (m.kind === 'user') { const tx = D && D.textures.find(x => x.id === m.tex); return tx ? 'url(' + tx.data + ')' : 'none'; }
    return 'url(' + thumbURL(m.kind, m.color, m.contrast == null ? 1 : m.contrast, size || 32) + ')';
  }
  function buildShelf() {
    const sh = $('#shelf'); if (!sh) return; sh.innerHTML = '';
    const mk = (kind, tx) => {
      const b = el('button'); b.dataset.kind = kind; if (tx) b.dataset.tex = tx.id;
      const def = kind === 'solid' ? { kind, color: M.color } : kind === 'gradient' ? { kind, color: '#6f9fc6', color2: '#eef4f8' } : kind === 'user' ? { kind, tex: tx.id } : { kind, color: C.materialDefaultColor(kind), contrast: 1 };
      b.style.backgroundImage = matCSS(def, 72); b.appendChild(el('span', '', tx ? tx.name : t('k_' + kind)));
      b.onclick = () => { b.blur(); chooseKind(kind, tx); };
      sh.appendChild(b); return b;
    };
    ['solid'].concat(C.MATERIAL_KINDS, ['gradient']).forEach(k => mk(k));
    if (D) D.textures.forEach(tx => mk('user', tx));
    const add = el('button', 'add', '+'); add.setAttribute('data-ti', 'import_texture'); add.onclick = () => { add.blur(); $('#f-tex').click(); };
    sh.appendChild(add); I.apply(sh); markShelf();
  }
  function markShelf() {
    $$('#shelf button[data-kind]').forEach(b => b.classList.toggle('on', b.dataset.kind === M.kind && (M.kind !== 'user' || b.dataset.tex === M.tex)));
    const s = $('#shelf button[data-kind="solid"]'); if (s) s.style.backgroundImage = matCSS({ kind: 'solid', color: M.color });
  }
  function chooseKind(kind, tx) {
    const prev = M.kind; M.kind = kind;
    if (kind === 'user') { M.tex = tx.id; if (prev !== 'user') M.color = '#ffffff'; }
    else if (kind === 'gradient') { M.color = '#6f9fc6'; M.color2 = '#eef4f8'; M.rot = 0; M.mid = null; M.shape = 'linear'; M.scale = 1; }
    else if (kind !== 'solid') M.color = C.materialDefaultColor(kind);
    if (prev === 'gradient' && kind !== 'gradient') { M.rot = 0; M.scale = 1; }
    syncPanels(); applyMaterialChoice();
  }
  function applyMaterialChoice() {
    if (!D) return;
    if (tool === 'paint') return;
    if (D.pendingId || D.sel) fillSelection();
  }
  function materialChanged(final) {
    markShelf(); if (!D || tool === 'paint') return;
    const L = D.pendingId && layerById(D.pendingId);
    if (L) { L.material = curMaterial(); queueRect(cov(L)); D.histDirty = true; renderLayers(); if (final) commitHist(); }
  }

  // ------------------------------------------------------------------ パネル
  const syncers = [];
  const rng = (id, key, min, max, step) => '<label class="row"><span data-i="' + key + '"></span><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '"><output id="' + id + '-o"></output></label>';
  function bindRange(id, get, put, onEnd) {
    const e = $('#' + id), out = $('#' + id + '-o'), stp = String(e.step), dec = stp.indexOf('.') >= 0 ? stp.split('.')[1].length : 0;
    const show = v => { out.textContent = (+v).toFixed(dec); };
    const sync = () => { const v = get(); e.value = v; show(e.value); };
    e.addEventListener('input', () => { const v = parseFloat(e.value); show(v); put(v); });
    e.addEventListener('change', () => { e.blur(); if (onEnd) onEnd(); });
    syncers.push(sync);
  }
  function bindCheck(id, get, put) { const e = $('#' + id); e.addEventListener('change', () => { put(e.checked); e.blur(); }); syncers.push(() => { e.checked = !!get(); }); }
  function bindColor(id, get, put, final) {
    const e = $('#' + id); e.addEventListener('input', () => put(e.value)); e.addEventListener('change', () => final && final());
    syncers.push(() => { e.value = get() || '#ffffff'; });
  }
  function sideHTML() {
    return '<details class="sec" open><summary data-i="passes"></summary>' +
      ['id', 'shadow', 'ao', 'line'].map(k => '<div class="pass"><span data-i="p_' + k + '"></span><em class="st" id="ps-' + k + '"></em><button data-load="' + k + '" data-i="load"></button><button class="x" data-clear="' + k + '" data-ti="clear">&times;</button></div>').join('') +
      '<label class="chk"><input type="checkbox" id="c-iduse"><span data-i="use_id"></span></label>' +
      '<label class="chk"><input type="checkbox" id="c-idcontig"><span data-i="contiguous"></span></label>' + rng('r-idtol', 'id_tol', 0, 24, 1) +
      '<div class="sub-h" data-i="shading"></div><div class="seg"><button id="m-multiply" data-i="mode_multiply"></button><button id="m-solid" data-i="mode_solid"></button></div>' +
      rng('r-ref', 'brightness', 0.6, 1.6, 0.02) + rng('r-lineop', 'line_opacity', 0, 1, 0.05) + '</details>' +
      '<details class="sec" open><summary data-i="selection"></summary>' + rng('r-tol', 'tol', 0, 80, 1) + rng('r-lthr', 'line_thr', 0, 255, 1) + rng('r-gap', 'gap', 0, 12, 1) + rng('r-brush', 'brush_size', 1, 300, 1) +
      '<div class="btns"><button id="b-inv" data-i="invert"></button><button id="b-desel" data-i="deselect"></button></div></details>' +
      '<details class="sec" open><summary data-i="material"></summary><div class="swatches" id="swatches"></div><div class="shelf" id="shelf"></div>' +
      '<div class="colorrow"><span data-i="color"></span><input type="color" id="i-color"></div>' +
      '<div id="g-extra" class="hide"><div class="colorrow"><span data-i="color2"></span><input type="color" id="i-color2"></div>' +
      '<label class="chk"><input type="checkbox" id="c-mid"><span data-i="mid_color"></span><input type="color" id="i-mid"></label>' +
      '<label class="chk"><input type="checkbox" id="c-radial"><span data-i="radial"></span></label></div>' +
      '<div id="g-rows">' + rng('r-scale', 'size', 0.25, 4, 0.05) + '<div id="rot-row">' + rng('r-rot', 'rotation', 0, 360, 1) + '</div><div id="con-row">' + rng('r-contrast', 'contrast', 0.3, 2, 0.05) + '</div></div>' +
      '<div class="btns"><button id="b-fill" data-i="fill_sel"></button></div>' +
      '<div class="sub-h" data-i="paint_brush"></div>' + rng('r-psize', 'paint_size', 2, 400, 1) + rng('r-phard', 'paint_hard', 0, 1, 0.05) + '</details>' +
      '<details class="sec" open><summary data-i="layers"></summary><div id="layers"></div><div id="lctl" class="hide">' +
      '<div class="sub-h" data-i="layer_mode"></div><div class="seg"><button id="lm-multiply" data-i="mode_multiply"></button><button id="lm-solid" data-i="mode_solid"></button></div>' +
      rng('r-opacity', 'opacity', 0, 1, 0.01) + rng('r-amount', 'amount', 0, 1, 0.01) +
      '<label class="chk"><input type="checkbox" id="c-wc"><span data-i="watercolor"></span></label>' +
      '<div id="wc-box" class="hide">' + rng('r-bleed', 'bleed', 1, 30, 1) + rng('r-edge', 'edge', 0, 1, 0.05) + rng('r-grain', 'grain', 0, 1, 0.05) + '</div>' +
      '<div class="btns"><button id="b-persp" data-i="persp_fit"></button><button id="b-pclear" data-i="persp_clear"></button></div>' +
      '<div id="pp-box" class="hide">' + rng('r-reps', 'persp_reps', 1, 20, 0.5) + rng('r-aspect', 'persp_aspect', 0.25, 4, 0.05) + '</div></div></details>';
  }
  function buildSide() {
    $('#side').innerHTML = sideHTML();
    const sw = $('#swatches');
    PALETTE.forEach(c => { const i = el('i'); i.style.background = c; i.title = c; i.onclick = () => { M.kind = 'solid'; M.color = c; syncPanels(); applyMaterialChoice(); }; sw.appendChild(i); });
    // 読み込みボタン
    let passKind = null;
    $$('[data-load]').forEach(b => b.onclick = () => { b.blur(); if (!D) return msg('m_need_image', true); passKind = b.dataset.load; $('#f-pass').click(); });
    $$('[data-clear]').forEach(b => b.onclick = () => { b.blur(); if (D) setPass(b.dataset.clear, null); });
    $('#f-pass').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f && passKind) await loadPass(passKind, f); });
    // 範囲・チェック
    bindCheck('c-iduse', () => set.idUse, v => { set.idUse = v; });
    bindCheck('c-idcontig', () => set.idContig, v => { set.idContig = v; });
    bindRange('r-idtol', () => set.idTol, v => { set.idTol = v; });
    bindRange('r-ref', () => set.refMul, v => { set.refMul = v; if (D) { D.ctx.refMul = v; queueRect(fullRect()); } });
    bindRange('r-lineop', () => set.lineOpacity, v => { set.lineOpacity = v; if (D) { D.ctx.lineOpacity = v; queueRect(fullRect()); } });
    bindRange('r-tol', () => set.tol, v => { set.tol = v; });
    bindRange('r-lthr', () => set.lineThr, v => { set.lineThr = v; });
    bindRange('r-gap', () => set.gap, v => { set.gap = v; });
    bindRange('r-brush', () => set.brush, v => { set.brush = v; needView = true; requestFrame(); });
    bindRange('r-psize', () => set.pbrush, v => { set.pbrush = v; needView = true; requestFrame(); });
    bindRange('r-phard', () => set.phard, v => { set.phard = v; });
    bindColor('i-color', () => M.color, v => { M.color = v; materialChanged(); }, () => commitHist());
    bindColor('i-color2', () => M.color2, v => { M.color2 = v; materialChanged(); }, () => commitHist());
    bindColor('i-mid', () => M.mid || '#ffffff', v => { M.mid = v; $('#c-mid').checked = true; materialChanged(); }, () => commitHist());
    bindCheck('c-mid', () => !!M.mid, v => { M.mid = v ? ($('#i-mid').value || '#ffffff') : null; materialChanged(true); });
    bindCheck('c-radial', () => M.shape === 'radial', v => { M.shape = v ? 'radial' : 'linear'; materialChanged(true); });
    bindRange('r-scale', () => M.scale, v => { M.scale = v; materialChanged(); }, () => commitHist());
    bindRange('r-rot', () => M.rot, v => { M.rot = v; materialChanged(); }, () => commitHist());
    bindRange('r-contrast', () => M.contrast, v => { M.contrast = v; materialChanged(); }, () => commitHist());
    // 陰影の既定
    const seg = (a, b, get, put) => {
      const A = $('#' + a), B = $('#' + b);
      A.onclick = () => { A.blur(); put('multiply'); }; B.onclick = () => { B.blur(); put('solid'); };
      syncers.push(() => { A.classList.toggle('on', get() === 'multiply'); B.classList.toggle('on', get() === 'solid'); });
    };
    seg('m-multiply', 'm-solid', () => set.shadeMode, v => { set.shadeMode = v; syncPanels(); });
    seg('lm-multiply', 'lm-solid', () => { const L = D && layerById(D.activeId); return L ? L.mode : set.shadeMode; }, v => {
      const L = D && layerById(D.activeId); if (!L) { set.shadeMode = v; return syncPanels(); } L.mode = v; queueRect(cov(L)); syncPanels(); pushHist(); });
    // 層の調整
    const lay = (get, put, fin) => [() => { const L = D && layerById(D.activeId); return L ? get(L) : 0; }, v => { const L = D && layerById(D.activeId); if (L) { put(L, v); queueRect(cov(L)); D.histDirty = true; } }, () => commitHist()];
    bindRange('r-opacity', ...lay(L => L.opacity, (L, v) => { L.opacity = v; }));
    bindRange('r-amount', ...lay(L => L.amount, (L, v) => { L.amount = v; }));
    bindRange('r-bleed', ...lay(L => L.wc ? L.wc.bleed : 5, (L, v) => { L.wc = Object.assign({ bleed: 5, edge: 0.7, grain: 0.5, seed: 1 }, L.wc, { bleed: v }); L.rev++; }));
    bindRange('r-edge', ...lay(L => L.wc ? L.wc.edge : 0.7, (L, v) => { L.wc = Object.assign({ bleed: 5, edge: 0.7, grain: 0.5, seed: 1 }, L.wc, { edge: v }); L.rev++; }));
    bindRange('r-grain', ...lay(L => L.wc ? L.wc.grain : 0.5, (L, v) => { L.wc = Object.assign({ bleed: 5, edge: 0.7, grain: 0.5, seed: 1 }, L.wc, { grain: v }); L.rev++; }));
    bindRange('r-reps', ...lay(L => L.persp ? L.persp.reps : 4, (L, v) => { if (L.persp) { L.persp.reps = v; L.rev++; } }));
    bindRange('r-aspect', ...lay(L => L.persp ? L.persp.aspectMul : 1, (L, v) => { if (L.persp) { L.persp.aspectMul = v; L.rev++; } }));
    bindCheck('c-wc', () => { const L = D && layerById(D.activeId); return L && L.style === 'watercolor'; }, v => {
      const L = D && layerById(D.activeId); if (!L) return; const r = cov(L);
      L.style = v ? 'watercolor' : 'flat'; if (v && !L.wc) L.wc = { bleed: 5, edge: 0.7, grain: 0.5, seed: 1 }; L.rev++; queueRect(ru(r, cov(L))); syncLayerCtl(); pushHist(); });
    $('#b-persp').onclick = () => { $('#b-persp').blur(); if (D) perspStart(); };
    $('#b-pclear').onclick = () => { $('#b-pclear').blur(); const L = D && layerById(D.activeId); if (L && L.persp) { L.persp = null; L.rev++; queueRect(cov(L)); syncLayerCtl(); pushHist(); } };
    $('#b-fill').onclick = () => { $('#b-fill').blur(); fillSelection(); };
    $('#b-inv').onclick = () => { $('#b-inv').blur(); invertSel(); };
    $('#b-desel').onclick = () => { $('#b-desel').blur(); deselect(); };
    I.apply($('#side'));
  }
  function syncMaterialPanel() {
    const k = M.kind;
    $('#g-extra').classList.toggle('hide', k !== 'gradient');
    $('#g-rows').classList.toggle('hide', k === 'solid');
    $('#con-row').classList.toggle('hide', k === 'gradient');
    $('#rot-row').classList.toggle('hide', k === 'user' ? false : false);
    const lab = $('#rot-row span'); if (lab) lab.setAttribute('data-i', k === 'gradient' ? 'angle' : 'rotation');
    I.apply($('#rot-row'));
  }
  function syncLayerCtl() {
    const L = D && layerById(D.activeId);
    $('#lctl').classList.toggle('hide', !L);
    if (!L) return;
    $('#wc-box').classList.toggle('hide', L.style !== 'watercolor');
    $('#pp-box').classList.toggle('hide', !L.persp);
    $('#b-pclear').classList.toggle('hide', !L.persp);
    syncPanels(true);
  }
  function syncPanels(skipMat) {
    syncers.forEach(f => f()); if (!skipMat) syncMaterialPanel(); markShelf();
    syncUndoButtons();
  }
  function renderLayers() {
    const box = $('#layers'); if (!box) return; box.innerHTML = '';
    if (!D || !D.layers.length) { box.appendChild(el('div', 'empty', t('layer_none'))); return; }
    for (let i = D.layers.length - 1; i >= 0; i--) {
      const L = D.layers[i], row = el('div', 'lyr' + (L.id === D.activeId ? ' act' : '') + (L.visible ? '' : ' off'));
      const eye = el('button', 'eye'); eye.title = t('layer_eye'); eye.onclick = ev => { ev.stopPropagation(); toggleLayer(L.id); };
      const sw = el('div', 'sw'); sw.style.backgroundImage = matCSS(L.material, 24);
      const nm = el('div', 'nm', L.name);
      nm.ondblclick = ev => {
        ev.stopPropagation(); const inp = el('input'); inp.type = 'text'; inp.value = L.name; nm.textContent = ''; nm.appendChild(inp); inp.focus(); inp.select();
        const done = ok => { if (ok && inp.value.trim()) { L.name = inp.value.trim(); pushHist(); } renderLayers(); };
        inp.onkeydown = k => { if (k.key === 'Enter') done(true); else if (k.key === 'Escape') done(false); k.stopPropagation(); };
        inp.onblur = () => done(true); inp.onclick = k => k.stopPropagation();
      };
      const mk = (txt, ttl, fn) => { const b = el('button', '', txt); b.title = t(ttl); b.onclick = ev => { ev.stopPropagation(); fn(); }; return b; };
      row.append(eye, sw, nm, mk('\u25B2', 'layer_up', () => moveLayer(L.id, 1)), mk('\u25BC', 'layer_down', () => moveLayer(L.id, -1)), mk('\u00D7', 'layer_del', () => removeLayer(L.id)));
      row.onclick = () => selectLayer(L.id);
      box.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ パスの読み込み
  const PASS_RE = { id: /(^|[^a-z])(id|idmap|id_map)([^a-z]|$)/i, shadow: /shadow/i, ao: /(^|[^a-z])ao([^a-z]|$)|occlusion/i, line: /(^|[^a-z])(line|lines|edge)([^a-z]|$)/i };
  const passKindOf = name => { for (const k of ['id', 'shadow', 'ao', 'line']) if (PASS_RE[k].test(name)) return k; return null; };
  async function loadPass(kind, file) {
    try { const e = await loadSource(file, false); e.name = file.name || kind; setPass(kind, e); }
    catch (err) { msg(String(err && err.name) === 'SecurityError' ? 'm_taint' : 'm_open_fail', true); }
  }
  function setPass(kind, entry) {
    if (!D) return msg('m_need_image', true);
    D.passErr[kind] = false;
    if (entry && (entry.w !== D.W || entry.h !== D.H)) { D.passErr[kind] = true; updatePassStatus(); return msg('m_pass_bad', true, { n: t('p_' + kind) }); }
    D.passes[kind] = entry || null;
    D.ctx[kind] = entry ? entry.data : null;
    C.setShadeSources(D.ctx);
    queueRect(fullRect()); updatePassStatus(); if (entry) msg('m_pass_ok', false, { n: t('p_' + kind) });
  }
  function updatePassStatus() {
    for (const k of ['id', 'shadow', 'ao', 'line']) {
      const s = $('#ps-' + k); if (!s) continue;
      const p = D && D.passes[k], bad = D && D.passErr[k];
      s.textContent = bad ? '!' : p ? (p.name || 'OK') : ''; s.className = 'st' + (bad ? ' bad' : p ? ' ok' : '');
    }
  }

  // ------------------------------------------------------------------ 保存・書き出し
  function downloadBlob(blob, name) {
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function saveAs(name, mime, ext, produce) {
    let handle = null;
    if (window.showSaveFilePicker) {
      try { handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.slice(1).toUpperCase(), accept: { [mime]: [ext] } }] }); }
      catch (e) { if (e && e.name === 'AbortError') return false; handle = null; }
    }
    const blob = await produce();
    if (handle) { const w = await handle.createWritable(); await w.write(blob); await w.close(); } else downloadBlob(blob, name);
    return true;
  }
  const stem = () => (D.name || 'untitled').replace(/\.paint\.json$|\.[a-z0-9]+$/i, '');
  async function exportPNG() {
    if (!D) return msg('m_need_image', true);
    flushNow(); msg('m_busy');
    const ok = await saveAs(stem() + '.png', 'image/png', '.png', () => new Promise(res => D.compCanvas.toBlob(res, 'image/png')));
    if (ok) msg('m_exported', false, { n: 'PNG' });
  }
  async function exportPSD() {
    if (!D) return msg('m_need_image', true);
    msg('m_busy');
    const ok = await saveAs(stem() + '.psd', 'image/vnd.adobe.photoshop', '.psd', async () => {
      await new Promise(r => setTimeout(r, 20));
      return new Blob([PSD.buildDocPSD(C, D.ctx, D.layers, {})], { type: 'image/vnd.adobe.photoshop' });
    });
    if (ok) msg('m_exported', false, { n: 'PSD' });
  }
  async function docText() {
    const images = { base: await entryDataURL(D.baseSrc) };
    for (const k of ['id', 'shadow', 'ao', 'line']) if (D.passes[k]) images[k] = await entryDataURL(D.passes[k]);
    return C.serializeDoc({ width: D.W, height: D.H, images, textures: D.textures.map(x => ({ id: x.id, name: x.name, data: x.data })), layers: D.layers,
      settings: Object.assign({}, set, { mat: curMaterial(), active: D.activeId, name: D.name }) });
  }
  async function saveProject() {
    if (!D) return msg('m_need_image', true);
    msg('m_busy');
    const ok = await saveAs(stem() + '.paint.json', 'application/json', '.json', async () => new Blob([await docText()], { type: 'application/json' }));
    if (ok) msg('m_saved');
  }
  async function openProjectText(text) {
    const doc = C.parseDoc(text);
    const base = await loadSource(doc.images.base, true), ps = {};
    for (const k of ['id', 'shadow', 'ao', 'line']) if (doc.images[k]) ps[k] = await loadSource(doc.images[k], false);
    const s = doc.settings || {};
    for (const k of Object.keys(DEFAULTS)) if (s[k] != null) set[k] = s[k];
    const d = buildDoc(base, ps, s.name || 'project');
    for (const tx of doc.textures) { try { const e = await loadSource(tx.data, true, 1024); d.textures.push({ id: tx.id, name: tx.name, data: tx.data, img: { w: e.w, h: e.h, data: e.data } }); d.ctx.userTex[tx.id] = { w: e.w, h: e.h, data: e.data }; } catch (e) { /* 読めない素材は飛ばす */ } }
    d.layers = doc.layers; d.nextId = d.layers.reduce((m, l) => Math.max(m, l.id), 0) + 1; d.activeId = s.active && d.layers.some(l => l.id === s.active) ? s.active : null;
    d.layers.forEach(l => { const b = l.kind === 'paint' ? t('k_paint') : layerLabel2(d, l.material); const m = /^(.*) (\d+)$/.exec(l.name); if (m) d.counters[m[1]] = Math.max(d.counters[m[1]] || 0, +m[2]); });
    if (s.mat) loadMaterial(s.mat);
    installDoc(d); msg('m_doc_opened', false, { n: d.layers.length });
  }
  function layerLabel2(d, mat) { if (mat.kind === 'user') { const tx = d.textures.find(x => x.id === mat.tex); return tx ? tx.name : t('k_user'); } return t('k_' + mat.kind); }
  async function addTextureFile(file) {
    if (!D) return msg('m_need_image', true);
    try {
      const url = await blobToDataURL(file), e = await loadSource(url, true, 1024);
      const id = 't' + (D.textures.length + 1) + '_' + Date.now().toString(36), name = (file.name || 'texture').replace(/\.[a-z0-9]+$/i, '');
      D.textures.push({ id, name, data: url, img: { w: e.w, h: e.h, data: e.data } }); D.ctx.userTex[id] = { w: e.w, h: e.h, data: e.data };
      M.kind = 'user'; M.tex = id; M.color = '#ffffff'; buildShelf(); syncPanels(); msg('m_tex_ok', false, { n: name }); applyMaterialChoice();
    } catch (err) { msg('m_open_fail', true); }
  }

  // ------------------------------------------------------------------ ファイルの受け口
  async function handleFiles(files) {
    files = Array.from(files || []); if (!files.length) return;
    const docs = files.filter(f => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (docs.length) { try { await openProjectText(await docs[0].text()); } catch (e) { msg('m_open_fail', true); } return; }
    const imgs = files.filter(f => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
    const plain = imgs.filter(f => !passKindOf(f.name)), named = imgs.filter(f => passKindOf(f.name));
    if (plain.length || !D) {
      const base = plain[0] || imgs[0]; if (!base) return;
      const ps = {}; for (const f of named) if (f !== base) ps[passKindOf(f.name)] = f;
      if (D && D.layers.length && !confirm(t('m_replace'))) return;
      try { await openBase(base, ps, base.name); } catch (e) { /* msg は openBase 内 */ }
    } else for (const f of named) await loadPass(passKindOf(f.name), f);
  }

  // ------------------------------------------------------------------ キー
  function onKey(e) {
    const tg = e.target, inText = tg && ((tg.tagName === 'INPUT' && /^(text|search)$/.test(tg.type)) || tg.tagName === 'SELECT' || tg.isContentEditable);
    if (e.key === ' ') { if (!inText) { e.preventDefault(); if (!space) { space = true; updateCursor(); } } return; }
    if (e.key === 'Alt') { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); saveProject(); }
      else if (k === 'e') { e.preventDefault(); e.shiftKey ? exportPSD() : exportPNG(); }
      else if (k === 'o') { e.preventDefault(); (e.shiftKey ? $('#f-doc') : $('#f-image')).click(); }
      else if (k === 'i' && !inText) { e.preventDefault(); if (D) invertSel(); }
      else if (k === 'd' && !inText) { e.preventDefault(); deselect(); }
      return;
    }
    if (inText) return;
    switch (e.key.toLowerCase()) {
      case 'w': setTool('wand'); break; case 'b': setTool('brush'); break; case 'e': setTool('eraser'); break;
      case 'p': setTool('poly'); break; case 'c': setTool('paint'); break; case 't': if (D) perspStart(); break; case 'f': fitView(); break;
      case 'enter': if (poly.length) polyClose(); else if (D) fillSelection(); break;
      case 'escape': if (poly.length) polyCancel(); else if (perspPts) { perspPts = null; setTool(perspPrev); } else deselect(); break;
      case 'backspace': if (poly.length) { poly.pop(); needView = true; requestFrame(); } break;
      case 'delete': if (D && D.activeId != null) removeLayer(D.activeId); break;
      case '[': case ']': {
        const k = e.key === ']' ? 1.15 : 1 / 1.15, key = tool === 'paint' ? 'pbrush' : 'brush';
        set[key] = clamp(Math.round(set[key] * k + (e.key === ']' ? 1 : -1)), 1, 400); syncPanels(true); needView = true; requestFrame(); break;
      }
      default: return;
    }
    e.preventDefault();
  }

  // ------------------------------------------------------------------ 初期化
  function init() {
    I.setLang(prefs.lang); applyFont(); document.documentElement.dataset.theme = prefs.theme; cssVars();
    buildTools(); buildSide(); buildShelf(); setTool('wand'); I.apply(document);
    $('#s-lang').value = prefs.lang; $('#i-font').value = prefs.font || '';
    $('#s-lang').onchange = e => { prefs.lang = e.target.value; savePrefs(); I.setLang(prefs.lang); I.apply(document); syncMaterialPanel(); buildShelf(); renderLayers(); msg(null); };
    $('#b-theme').onclick = () => { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); $('#b-theme').blur(); };
    $('#i-font').addEventListener('change', e => { prefs.font = e.target.value; savePrefs(); applyFont(); });
    $('#b-open').onclick = () => { $('#b-open').blur(); $('#f-image').click(); };
    if (window.PaintSamples) for (const [id, k] of [['b-sample', 'plan'], ['b-sample-e', 'elev'], ['b-sample-s', 'section']]) { const bs = $('#' + id); bs.hidden = false; bs.onclick = () => { bs.blur(); openSample(k); }; }
    $('#b-opendoc').onclick = () => { $('#b-opendoc').blur(); $('#f-doc').click(); };
    $('#b-save').onclick = () => { $('#b-save').blur(); saveProject(); };
    $('#b-png').onclick = () => { $('#b-png').blur(); exportPNG(); };
    $('#b-psd').onclick = () => { $('#b-psd').blur(); exportPSD(); };
    $('#b-undo').onclick = () => { $('#b-undo').blur(); undo(); };
    $('#b-redo').onclick = () => { $('#b-redo').blur(); redo(); };
    $('#f-image').onchange = e => { const f = e.target.files; handleFiles(f).then(() => { e.target.value = ''; }); };
    $('#f-doc').onchange = e => { const f = e.target.files; handleFiles(f).then(() => { e.target.value = ''; }); };
    $('#f-tex').onchange = async e => { const fs = Array.from(e.target.files); e.target.value = ''; for (const f of fs) await addTextureFile(f); };
    const st = $('#stage');
    ['dragenter', 'dragover'].forEach(n => st.addEventListener(n, e => { e.preventDefault(); st.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(n => st.addEventListener(n, e => { e.preventDefault(); st.classList.remove('dragover'); }));
    st.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
    view.tabIndex = 0;
    view.addEventListener('pointerdown', onDown); view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp); view.addEventListener('pointercancel', onUp);
    view.addEventListener('pointerleave', () => { mouse = null; needView = true; requestFrame(); });
    view.addEventListener('wheel', onWheel, { passive: false });
    view.addEventListener('dblclick', () => { if (tool === 'poly' && poly.length >= 3) polyClose(); });
    view.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', e => { if (e.key === ' ') { space = false; updateCursor(); } });
    window.addEventListener('blur', () => { space = false; updateCursor(); });
    window.addEventListener('beforeunload', e => { if (D && D.layers.length) { e.preventDefault(); e.returnValue = ''; } });
    if (window.ResizeObserver) new ResizeObserver(() => { resize(); if (D && V.s <= 0.0201) fitView(); }).observe(st); else window.addEventListener('resize', resize);
    resize(); syncPanels(); renderLayers(); msg('m_ready'); requestFrame();
  }

  // ------------------------------------------------------------------ 公開
  const api = {
    version: '1.0.0',
    /** paint.open({ image, passes:{ id, shadow, ao, line }, name }) */
    async open(o) { o = o || {}; if (!o.image) throw new Error('image required'); await openBase(o.image, o.passes || null, o.name || 'untitled'); return api; },
    openProjectText, exportPNG, exportPSD, saveProject, undo, redo,
    get state() { return D; }, get settings() { return set; }, get material() { return M; },
    // 試験・自動操作用（画面を触らずに同じ処理を通す）
    _t: {
      wandAt, applySelection, fillSelection, chooseKind, selectLayer, removeLayer, moveLayer, toggleLayer, deselect, invertSel, setTool, flushNow, layerById,
      polySelect: (pts, mode) => { poly = pts.map(p => ({ x: p[0], y: p[1] })); poly.mode = mode || 'replace'; polyClose(); },
      paintStroke: (pts, opt) => { if (opt) Object.assign(set, opt); const q = pts.map(p => ({ x: p[0], y: p[1] })); beginStroke(q[0], 'paint'); for (let i = 1; i < q.length; i++) strokeTo(q[i], false); endStroke(); },
      selStroke: (pts, erase) => { const q = pts.map(p => ({ x: p[0], y: p[1] })); beginStroke(q[0], 'sel', !!erase); for (let i = 1; i < q.length; i++) strokeTo(q[i], false); endStroke(); },
      setMaterial: m => { loadMaterial(m); syncPanels(); }, curMaterial, setPass, loadSource, addTexture: addTextureFile, docText, historyLen: () => hist.stack.length, get pos() { return hist.pos; },
      layerRTKey: l => C.layerRTKey(l), fitView, view: () => ({ s: V.s, ox: V.ox, oy: V.oy }),
    },
  };
  window.paint = api;
  init();

  // ------------------------------------------------------------------ 図面の自動着彩（core.js の autoPaint。AI も通信も使わない）
  let assetsReady = null;
  function loadAssets() {
    if (assetsReady) return assetsReady;
    const A = window.PaintAssets || {};
    assetsReady = Promise.all(Object.keys(A).map(k => new Promise(res => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(im, 0, 0);
        const o = { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
        if (k === 'concrete' || k === 'planks') C.registerPhoto(k, o); else C.registerSprite(k, o);
        res(true);
      };
      im.onerror = () => res(false); im.src = A[k];
    })));
    return assetsReady;
  }
  const syncKindUI = () => { $('#l-depth').hidden = $('#s-kind').value !== 'section'; };
  async function applyAutoPaint() {
    if (!D) { msg('m_need_image', true); return; }
    msg('m_busy'); await loadAssets(); await new Promise(r => setTimeout(r, 20));
    const orig = D.origSrc || D.baseSrc, kind = $('#s-kind').value, same = D.autoKind === kind, v0 = { s: V.s, ox: V.ox, oy: V.oy }, name = D.name;
    let res;
    try { res = C.autoPaint(kind, { w: orig.w, h: orig.h, data: orig.data }, { ppm: 39.4, depth: +$('#r-depth').value / 100 }); } catch (e) { msg('m_auto_fail', true); throw e; }
    const nd = buildDoc({ w: orig.w, h: orig.h, data: res.paper.data || res.paper }, { line: { w: orig.w, h: orig.h, data: res.line.data || res.line } }, name);
    nd.origSrc = orig; nd.autoKind = kind; nd.autoInfo = res.info;
    for (const l of res.layers) { l.id = nd.nextId++; nd.layers.push(l); }
    const proto = res.layers.find(l => l.raster);
    if (proto) {   // 仕上げ用の空の手描き層（透明・全面）
      const r = proto.raster, Mk = proto.mask.data.constructor;
      nd.layers.push(Object.assign({}, proto, { id: nd.nextId++, name: t('k_handpaint'), mode: 'solid', opacity: 1,
        raster: { x: r.x, y: r.y, w: r.w, h: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) },
        mask: { x: r.x, y: r.y, w: r.w, h: r.h, data: new Mk(r.w * r.h).fill(255) } }));
    }
    nd.activeId = nd.layers.length ? nd.layers[nd.layers.length - 1].id : null;
    installDoc(nd);
    if (same) { V.s = v0.s; V.ox = v0.ox; V.oy = v0.oy; needView = true; requestFrame(); }
    msg('m_auto_done');
  }
  $('#s-kind').onchange = syncKindUI;
  $('#r-depth').onchange = () => { if (D && D.autoKind === 'section') applyAutoPaint(); };
  $('#b-auto').onclick = () => { $('#b-auto').blur(); applyAutoPaint(); };

  // 試験・見本表示（アドレスの # で起動。通常の利用には影響しない）
  const SAMPLES = window.PaintSamples;
  async function openSample(kind) {
    kind = kind || 'plan';
    await api.open({ image: SAMPLES.items[kind].base, name: 'library-' + kind });
    $('#s-kind').value = kind; syncKindUI(); await applyAutoPaint();
  }
  async function runSelfTest() {
    const out = []; const ok = (name, cond, info) => out.push((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + (info == null ? '' : info)));
    const sum = d => { let s = 0; for (let i = 0; i < d.W * d.H * 4; i += 13) s += d.comp[i]; return s; };
    try {
      const T = api._t; await openSample('plan'); let d = api.state;
      ok('open: size', d.W === SAMPLES.items.plan.w && d.H === SAMPLES.items.plan.h, d.W + 'x' + d.H);
      ok('autoPaint made layers', d.layers.length >= 4, d.layers.length);
      ok('line pass is set', !!d.passes.line);
      T.flushNow(); let n = 0; const step = 7;
      for (let i = 0; i < d.W * d.H; i += step) { const p = i * 4; if (Math.abs(d.comp[p] - d.base[p]) + Math.abs(d.comp[p + 1] - d.base[p + 1]) + Math.abs(d.comp[p + 2] - d.base[p + 2]) > 12) n++; }
      ok('composite is coloured', n > d.W * d.H / step * 0.05, n);
      await openSample('elev'); ok('elevation paints', api.state.layers.length >= 3, api.state.layers.length);
      await openSample('section'); $('#r-depth').value = 0; await applyAutoPaint(); T.flushNow(); const s0 = sum(api.state);
      $('#r-depth').value = 100; await applyAutoPaint(); T.flushNow(); const s1 = sum(api.state);
      ok('section depth changes the picture', s0 !== s1, s0 + ' vs ' + s1);
      d = api.state; const c0 = d.layers.length;
      ok('empty hand-paint layer exists', d.layers.some(l => l.raster && l.name === t('k_handpaint')));
      const bytes = PSD.buildDocPSD(C, d.ctx, d.layers, {}); const back = PSD.readPSD(bytes);
      ok('PSD layers = base + layers + line', back.layers.length === d.layers.filter(l => l.mask).length + 2, back.layers.length);
      const text = await T.docText(); await api.openProjectText(text);
      ok('save/reopen keeps layers', api.state.layers.length === c0 && api.state.layers.some(l => l.raster), api.state.layers.length + ' vs ' + c0);
    } catch (e) { ok('exception', false, e && e.stack); }
    const pre = document.createElement('pre'); pre.id = 'selftest-out'; pre.textContent = out.join('\n') + '\n' + out.filter(x => x.indexOf('ok ') === 0).length + ' passed of ' + out.length;
    document.body.appendChild(pre); document.title = 'SELFTEST ' + (out.some(x => x.indexOf('FAIL') === 0) ? 'FAIL' : 'OK');
  }
  const HSMP = { '#sample': 'plan', '#sample-elev': 'elev', '#sample-section': 'section' };
  if (SAMPLES && HSMP[location.hash]) openSample(HSMP[location.hash]).then(() => { document.title = 'SAMPLE READY'; }).catch(e => { document.title = 'SAMPLE ERR ' + e; });
  if (location.hash === '#selftest' && SAMPLES) runSelfTest();
})();
