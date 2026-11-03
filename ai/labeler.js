/* VECTOR PAINT: ラベラー（領域 → 面の種類）。差し替え可能な口。
 *   labeler = async (res, image, opts) => labels      labels[i] = { cls, best, conf, source, ... }  （i は領域の番号）
 * 既定は規則版（ai/classify.js）。ネットワークもモデルの取得も行わない。
 * 「自分のキー（BYOK）」は利用者が自分で入れたキーで Gemini / OpenAI を直接呼ぶ。VECTOR のサーバーは通らない。
 *   - 送るのは、領域の番号を書き込んだ線画（長辺 1024 画素まで）と領域の表（番号・外接矩形・面積・規則版の推定）だけ。
 *   - キーは HTTP ヘッダにだけ載せる（URL のクエリには入れない）。選んだ提供元の公式の宛先にしか送らない。
 *   - 返答は {regions:[{id,cls,conf}]}。確信度がしきい値以上なら AI、未満なら規則版の結果を使う。出どころは領域ごとに持つ。
 *   - 失敗（401/403/429/通信断/壊れた JSON/件数ちがい）は、起きたことと直し方を labels.ai に持たせ、規則版の結果へ戻す。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./classify.js'), require('./regions.js'));
  else root.VPLabeler = factory(root.VPClassify, root.VP && root.VP.regions);
})(typeof self !== 'undefined' ? self : this, function (CL, RG) {
  'use strict';

  var CLASSES = CL.CLASSES;

  // ---------------------------------------------------------------- 規則版
  /** 規則版。res は VP.regions.extract の戻り値。 */
  async function ruleLabeler(res, image, opts) {
    var o = opts || {}, cl = CL.classify(res, { threshold: o.threshold, view: o.view });
    var labels = cl.regions.map(function (r) { return { cls: r.cls, best: r.best, conf: r.conf, source: 'rule', ruleBest: r.best, ruleConf: r.conf }; });
    labels.view = cl.view; labels.threshold = cl.threshold;
    return labels;
  }

  // ---------------------------------------------------------------- 合成（AI か規則版かを領域ごとに選ぶ）
  /** 一件分。AI の確信度がしきい値以上で、種類が「未判定」でなければ AI。そうでなければ規則版（AI が答えを保留した時も規則版）。 */
  function mergeOne(l, thr) {
    var useAi = l.aiCls != null && l.aiCls !== 'unknown' && l.aiConf >= thr;
    var o = { ruleBest: l.ruleBest, ruleConf: l.ruleConf };
    if (l.aiCls != null) { o.aiCls = l.aiCls; o.aiConf = l.aiConf; }
    if (useAi) { o.cls = l.aiCls; o.best = l.aiCls; o.conf = l.aiConf; o.source = 'ai'; }
    else { o.cls = l.ruleConf >= thr ? l.ruleBest : 'unknown'; o.best = l.ruleBest; o.conf = l.ruleConf; o.source = 'rule'; }
    return o;
  }
  /** しきい値だけを変えて合成し直す（AI は呼ばない）。labels は byokLabeler か規則版の戻り値。 */
  function remerge(labels, thr) {
    var out = labels.map(function (l) { return mergeOne(l, thr); });
    out.view = labels.view; out.threshold = thr;
    if (labels.ai) { out.ai = Object.assign({}, labels.ai); if (out.ai.ok) out.ai.used = out.filter(function (l) { return l.source === 'ai'; }).length; }
    return out;
  }
  /** 出どころの数: { ai, rule }。 */
  function sourceCounts(labels) {
    var c = { ai: 0, rule: 0 };
    for (var i = 0; i < labels.length; i++) c[labels[i].source === 'ai' ? 'ai' : 'rule']++;
    return c;
  }

  // ---------------------------------------------------------------- 提供元
  var PROVIDERS = {
    gemini: { id: 'gemini', label: 'Gemini（Google）', model: 'gemini-3.6-flash', keyUrl: 'https://aistudio.google.com/apikey' },
    openai: { id: 'openai', label: 'ChatGPT（OpenAI）', model: 'gpt-6-luna', keyUrl: 'https://platform.openai.com/api-keys' }
  };
  var ENDPOINT = {
    gemini: function (model) { return 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent'; },
    openai: function () { return 'https://api.openai.com/v1/chat/completions'; }
  };
  var MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;     // URL や鍵を紛れ込ませられない形だけ
  var KEY_RE = /^[\x21-\x7e]{16,400}$/;                  // 空白・改行・日本語を含まない印字可能な ASCII
  var MAX_SIDE = 1024, MAX_REGIONS = 120, MIN_AREA_PX = 120, MIN_ANCHOR_PX = 3, TIMEOUT_MS = 90000;

  // ---------------------------------------------------------------- 失敗の言葉（起きたことと直し方。提供元の本文は載せない）
  function fail(code, extra) { var e = new Error(code); e.vpCode = code; e.vpExtra = extra || {}; return e; }
  function describeError(code, x) {
    var T = {
      nokey: ['キーが入力されていません。', 'キーの欄に、提供元の画面で発行したキーを貼り付けてください。'],
      badkey: ['キーの形式が読めません。', 'キーの前後の空白や改行を除き、キーだけを一つ貼り付けてください。'],
      badmodel: ['モデル名の形式が読めません。', '英数字と . _ - だけで書かれた、提供元のモデル名を入れてください。'],
      badprovider: ['提供元が選ばれていません。', 'Gemini か ChatGPT のどちらかを選んでください。'],
      http401: ['キーが受け付けられませんでした（401）。', 'キーが正しいか、選んだ提供元と発行元が合っているか確かめてください。'],
      http403: ['提供元がこのキーでの利用を許可していません（403）。', '提供元の画面で、キーの権限・利用できる地域・支払いの設定を確かめてください。'],
      http404: ['モデルが見つかりません（404）。', 'モデル名の欄を、画像を読めるモデルの名前に直してください。'],
      http400: ['提供元が要求を受け付けませんでした（400）。', 'モデル名が画像の入力に対応しているか確かめてください。'],
      http429: ['利用の上限に達しています（429）。', 'しばらく待つか、提供元の画面で利用枠と残高を確かめてください。'],
      http5xx: ['提供元の側で障害が出ています（HTTP ' + (x && x.status) + '）。', '時間をおいて、もう一度押してください。'],
      httpother: ['提供元が想定外の応答を返しました（HTTP ' + (x && x.status) + '）。', '時間をおいてもう一度押すか、モデル名を確かめてください。'],
      network: ['提供元に届きませんでした。', '回線と、広告やセキュリティの拡張機能がこの通信を止めていないか確かめてください。'],
      timeout: ['提供元から時間内に返答がありませんでした。', '回線を確かめてもう一度押すか、軽いモデルに変えてください。'],
      json: ['返答が JSON として読めませんでした。', 'もう一度押すか、モデルを変えてください。'],
      shape: ['返答の形が決めた形と違います。', 'もう一度押すか、モデルを変えてください。'],
      count: ['返答の領域数が送った数と合いません（送信 ' + (x && x.want) + ' 件 / 返答 ' + (x && x.got) + ' 件）。', 'もう一度押すか、モデルを変えてください。'],
      ids: ['返答の領域の番号が、送った番号と合いません。', 'もう一度押すか、モデルを変えてください。'],
      truncated: ['返答が途中で切れました。', 'もう一度押すか、領域の少ない図で試してください。'],
      blocked: ['提供元が画像の判定を行いませんでした。', '別の図で試すか、モデルを変えてください。'],
      render: ['図を送る形に変換できませんでした。', 'このブラウザでは画像の変換ができません。Chrome の最新版で開いてください。'],
      noregions: ['判定に出せる大きさの領域がありません。', '線で閉じた面のある図で試してください。'],
      unexpected: ['想定外の問題が起きました。', 'もう一度押してください。']
    };
    var t = T[code] || T.unexpected;
    return { code: T[code] ? code : 'unexpected', title: t[0], fix: t[1] };
  }
  function httpCode(status, bodyText) {
    if (status === 401) return 'http401';
    if (status === 403) return 'http403';
    if (status === 404) return 'http404';
    if (status === 429) return 'http429';
    if (status === 400) return /API.KEY.INVALID/.test(bodyText || '') ? 'http401' : 'http400';
    if (status >= 500 && status <= 599) return 'http5xx';
    return 'httpother';
  }

  // ---------------------------------------------------------------- 送るもの
  /** 領域の表。画像と同じ縮尺(k)の座標で出す。小さすぎる領域・番号を置けない領域は送らない（規則版の結果のまま）。 */
  function pickRegions(res, base, anc, k, maxRegions) {
    var cand = [], i, r, a, d;
    for (i = 0; i < res.n; i++) {
      r = res.regions[i]; a = r.area * k * k; d = anc ? anc.d[i] * k : MIN_ANCHOR_PX;
      if (a >= MIN_AREA_PX && d >= MIN_ANCHOR_PX) cand.push({ r: r, a: a });
    }
    cand.sort(function (p, q) { return q.a - p.a || p.r.id - q.r.id; });
    cand = cand.slice(0, maxRegions).sort(function (p, q) { return p.r.id - q.r.id; });
    return cand.map(function (c) {
      var r = c.r, b = base[r.id];
      return { id: r.id, bbox: [Math.round(r.x0 * k), Math.round(r.y0 * k), Math.max(1, Math.round(r.bw * k)), Math.max(1, Math.round(r.bh * k))],
        area: +r.areaFrac.toFixed(4), rule: { cls: b.ruleBest, conf: +b.ruleConf.toFixed(2) } };
    });
  }
  function buildPrompt(list, view) {
    return 'You label the surfaces of an architectural line drawing (' + (view === 'plan' ? 'a plan view, guessed by a rule-based pass' : 'an elevation or section, guessed by a rule-based pass') + ').\n' +
      'The attached image is the drawing with a number written inside each region. Classify every numbered region by what the surface is.\n' +
      'Classes: wall (opaque wall or facade surface), glass (window, glazing, curtain wall), ground (ground, floor, paving, road), roof (roof, canopy), vegetation (trees, plants, lawn), water (water surface), sky (sky), unknown (cannot tell).\n' +
      'The list gives each region: id (the number in the image), bbox [x, y, w, h] in pixels of the attached image, area as a fraction of the whole image, and a rule-based guess with its confidence. The guess can be wrong; decide from the picture.\n' +
      'Regions: ' + JSON.stringify(list) + '\n' +
      'Answer with JSON only, no other text, in exactly this shape: {"regions":[{"id":0,"cls":"wall","conf":0.9}]}\n' +
      'Return one entry for every region in the list, no more and no fewer. cls must be one of: ' + CLASSES.join(', ') + ', unknown. conf is your confidence from 0 to 1.';
  }
  /** 提供元ごとの要求。鍵はヘッダにだけ載せる。URL は固定（モデル名は形を検査済み）。 */
  function buildRequest(provider, p) {
    var body, headers = { 'content-type': 'application/json' };
    if (provider === 'gemini') {
      headers['x-goog-api-key'] = p.key;
      body = { contents: [{ role: 'user', parts: [{ text: p.prompt }, { inlineData: { mimeType: p.mime, data: p.base64 } }] }], generationConfig: { responseMimeType: 'application/json' } };
    } else if (provider === 'openai') {
      headers.authorization = 'Bearer ' + p.key;
      body = { model: p.model, messages: [{ role: 'user', content: [{ type: 'text', text: p.prompt }, { type: 'image_url', image_url: { url: 'data:' + p.mime + ';base64,' + p.base64, detail: 'high' } }] }], response_format: { type: 'json_object' } };
    } else throw fail('badprovider');
    return { url: ENDPOINT[provider](p.model), init: { method: 'POST', headers: headers, body: JSON.stringify(body) } };
  }

  // ---------------------------------------------------------------- 返答を読む
  function stripFence(s) {
    var t = String(s).trim(), m = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(t);
    return m ? m[1] : t;
  }
  function replyText(provider, outer) {
    var t = '', i, parts, c, m;
    if (provider === 'gemini') {
      if (outer && outer.promptFeedback && outer.promptFeedback.blockReason) throw fail('blocked');
      c = outer && outer.candidates && outer.candidates[0]; if (!c) throw fail('shape');
      if (/^MAX_/.test(c.finishReason || '')) throw fail('truncated');   // 長さの上限で切れた
      if (c.finishReason && !/^(STOP|FINISH_REASON_UNSPECIFIED)$/.test(c.finishReason)) throw fail('blocked');
      parts = c.content && c.content.parts; if (!Array.isArray(parts)) throw fail('shape');
      for (i = 0; i < parts.length; i++) if (parts[i] && typeof parts[i].text === 'string' && !parts[i].thought) t += parts[i].text;
    } else {
      c = outer && outer.choices && outer.choices[0]; if (!c) throw fail('shape');
      if (c.finish_reason === 'length') throw fail('truncated');
      if (c.finish_reason === 'content_filter') throw fail('blocked');
      m = c.message; if (!m) throw fail('shape'); if (m.refusal) throw fail('blocked');
      if (typeof m.content === 'string') t = m.content;
      else if (Array.isArray(m.content)) for (i = 0; i < m.content.length; i++) if (m.content[i] && typeof m.content[i].text === 'string') t += m.content[i].text;
    }
    if (!t.trim()) throw fail('shape');
    return t;
  }
  /** 提供元の返答（本文の文字列）→ [{id,cls,conf}]。送った番号の集合 ids と突き合わせる。 */
  function parseReply(provider, bodyText, ids) {
    var outer, inner, i, it, seen = {}, out = [], want = {};
    try { outer = JSON.parse(bodyText); } catch (e) { throw fail('json'); }
    try { inner = JSON.parse(stripFence(replyText(provider, outer))); } catch (e2) { if (e2 && e2.vpCode) throw e2; throw fail('json'); }
    if (!inner || !Array.isArray(inner.regions)) throw fail('shape');
    if (inner.regions.length !== ids.length) throw fail('count', { want: ids.length, got: inner.regions.length });
    for (i = 0; i < ids.length; i++) want[ids[i]] = 1;
    for (i = 0; i < inner.regions.length; i++) {
      it = inner.regions[i];
      if (!it || typeof it !== 'object' || typeof it.cls !== 'string' || typeof it.conf !== 'number' || !isFinite(it.conf)) throw fail('shape');
      if (typeof it.id !== 'number' || !want[it.id] || seen[it.id]) throw fail('ids');
      seen[it.id] = 1;
      var cls = it.cls.trim().toLowerCase();
      out.push({ id: it.id, cls: CLASSES.indexOf(cls) >= 0 ? cls : 'unknown', conf: Math.max(0, Math.min(1, it.conf)) });
    }
    return out;
  }

  // ---------------------------------------------------------------- 図に番号を書き込む（ブラウザ）
  function domRender(a) {
    if (typeof document === 'undefined') throw fail('render');
    var src = document.createElement('canvas'); src.width = a.image.width; src.height = a.image.height;
    var sg = src.getContext('2d'); if (!sg) throw fail('render'); sg.putImageData(a.image, 0, 0);
    var c = document.createElement('canvas'); c.width = a.outW; c.height = a.outH;
    var g = c.getContext('2d'); if (!g) throw fail('render');
    g.fillStyle = '#fff'; g.fillRect(0, 0, a.outW, a.outH); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, a.outW, a.outH);
    g.font = '700 13px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = 4;
    for (var i = 0; i < a.ids.length; i++) {
      var id = a.ids[i], x = a.anchors.x[id] * a.k, y = a.anchors.y[id] * a.k;
      g.strokeStyle = 'rgba(255,255,255,.95)'; g.strokeText(String(id), x, y); g.fillStyle = '#c62828'; g.fillText(String(id), x, y);
    }
    var url = c.toDataURL('image/png');
    return { mime: 'image/png', base64: url.slice(url.indexOf(',') + 1) };
  }

  // ---------------------------------------------------------------- BYOK
  /** cfg: { provider:'gemini'|'openai', key, model, fetch?, render?, timeoutMs?, maxRegions? }。返すのは labeler。
   *  fetch と render は試験のために差し替えられる（既定は fetch とブラウザの canvas）。 */
  function byokLabeler(cfg) {
    var c = cfg || {};
    return async function (res, image, opts) {
      var base = await ruleLabeler(res, image, opts || {});
      var prov = PROVIDERS[c.provider], model = String(c.model || (prov && prov.model) || '').trim();
      var meta = { provider: c.provider, model: model };
      try {
        var labels = await askAI(c, prov, model, res, image, base);
        labels.ai = Object.assign(meta, labels.ai); return labels;
      } catch (e) {
        var code = e && e.vpCode;
        if (!code) code = e && e.name === 'AbortError' ? 'timeout' : (e instanceof TypeError ? 'network' : 'unexpected');
        base.ai = Object.assign(meta, { ok: false }, describeError(code, e && e.vpExtra));
        return base;
      }
    };
  }
  async function askAI(c, prov, model, res, image, base) {
    if (!prov) throw fail('badprovider');
    var key = String(c.key == null ? '' : c.key).trim();
    if (!key) throw fail('nokey');
    if (!KEY_RE.test(key)) throw fail('badkey');
    if (!MODEL_RE.test(model)) throw fail('badmodel');
    var f = c.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    if (!f) throw fail('network');

    var k = Math.min(1, MAX_SIDE / Math.max(res.w, res.h)), outW = Math.max(1, Math.round(res.w * k)), outH = Math.max(1, Math.round(res.h * k));
    var anc = c.anchors || (RG && RG.anchors ? RG.anchors(res) : null);
    var list = pickRegions(res, base, anc, k, c.maxRegions || MAX_REGIONS);
    if (!list.length) throw fail('noregions');
    var ids = list.map(function (q) { return q.id; });
    var img = (c.render || domRender)({ res: res, image: image, anchors: anc, ids: ids, k: k, outW: outW, outH: outH });
    if (!img || !img.base64) throw fail('render');
    var rq = buildRequest(prov.id, { key: key, model: model, prompt: buildPrompt(list, base.view), mime: img.mime || 'image/png', base64: img.base64 });

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null, timer = null, timedOut = false, resp, text;
    if (ctrl) timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, c.timeoutMs || TIMEOUT_MS);
    try {
      // 転送先で別の宿主へ鍵が写らないよう redirect は追わない。Cookie・参照元・キャッシュも使わない。
      resp = await f(rq.url, Object.assign({}, rq.init, { mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }));
      text = await resp.text();
    } catch (e) {
      if (timedOut) throw fail('timeout');
      throw fail('network');
    } finally { if (timer) clearTimeout(timer); }
    if (!resp.ok) throw fail(httpCode(resp.status, text), { status: resp.status });

    var results = parseReply(prov.id, text, ids), out = base.map(function (l) { return Object.assign({}, l); });
    results.forEach(function (q) { out[q.id].aiCls = q.cls; out[q.id].aiConf = q.conf; });
    var thr = base.threshold, merged = out.map(function (l) { return mergeOne(l, thr); });
    merged.view = base.view; merged.threshold = thr;
    merged.ai = { ok: true, sent: ids.length, used: merged.filter(function (l) { return l.source === 'ai'; }).length, regions: res.n, imageW: outW, imageH: outH };
    return merged;
  }
  /** ブラウザ内の学習済みモデルを使う口（雛形）。重みの取得も実行もしない。画面の選択肢には出さない。 */
  function inBrowserLabeler(cfg) { void cfg; return async function () { throw new Error('ブラウザ内モデルは未実装です（口だけ用意しています。通信・取得・実行はしません）'); }; }

  var REGISTRY = {
    rule: { id: 'rule', label: '規則版（この端末内・通信なし）', stub: false, make: function () { return ruleLabeler; } },
    userKey: { id: 'userKey', label: '自分のキーで AI 判定（Gemini / ChatGPT）', stub: false, make: byokLabeler },
    inBrowser: { id: 'inBrowser', label: 'ブラウザ内モデル', stub: true, hidden: true, make: inBrowserLabeler }
  };

  /** 画面に出す選択肢。hidden のものは all を真にした時だけ。 */
  function list(all) { return Object.keys(REGISTRY).filter(function (k) { return all || !REGISTRY[k].hidden; }).map(function (k) { return { id: k, label: REGISTRY[k].label, stub: REGISTRY[k].stub }; }); }
  function create(id, cfg) { var e = REGISTRY[id || 'rule']; if (!e) throw new Error('unknown labeler: ' + id); return e.make(cfg || {}); }
  /** 外から差し込む: fn は async (res, image, opts) => labels。 */
  function register(id, label, fn) { REGISTRY[id] = { id: id, label: label, stub: false, make: function () { return fn; } }; }
  async function run(id, res, image, opts, cfg) {
    var labels = await create(id, cfg)(res, image, opts || {});
    if (!Array.isArray(labels) || labels.length !== res.n) throw new Error('labels の数が領域数と合いません');
    return labels;
  }

  return {
    list: list, create: create, register: register, run: run, ruleLabeler: ruleLabeler, byokLabeler: byokLabeler,
    remerge: remerge, sourceCounts: sourceCounts, buildRequest: buildRequest, buildPrompt: buildPrompt, parseReply: parseReply, describeError: describeError,
    PROVIDERS: PROVIDERS, CLASSES: CLASSES
  };
});
