/* VECTOR PAINT: ラベラー（領域 → 面の種類）。差し替え可能な口。
 *   labeler = async (res, image, opts) => labels      labels[i] = { cls, best, conf }  （i は領域の番号）
 * 既定は規則版（ai/classify.js）。ネットワークもモデルの取得も行わない。
 * 「自分のキー（BYOK）」と「ブラウザ内モデル」の口は雛形だけで、呼ぶと未実装の例外を返す。通信・ダウンロード・実行はしない。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./classify.js'));
  else root.VPLabeler = factory(root.VPClassify);
})(typeof self !== 'undefined' ? self : this, function (CL) {
  'use strict';

  /** 規則版。res は VP.regions.extract の戻り値。 */
  async function ruleLabeler(res, image, opts) {
    var o = opts || {}, cl = CL.classify(res, { threshold: o.threshold, view: o.view });
    var labels = cl.regions.map(function (r) { return { cls: r.cls, best: r.best, conf: r.conf }; });
    labels.view = cl.view; labels.threshold = cl.threshold;
    return labels;
  }

  function notReady(what) {
    return async function () { throw new Error(what + ' は未実装です（口だけ用意しています。通信・取得・実行はしません）'); };
  }

  /** 自分のキーで外部の推論を呼ぶ口（雛形）。userKey は保持せず、呼び出しも行わない。 */
  function byokLabeler(cfg) { void cfg; return notReady('BYOK'); }
  /** ブラウザ内の学習済みモデルを使う口（雛形）。重みの取得も実行もしない。 */
  function inBrowserLabeler(cfg) { void cfg; return notReady('ブラウザ内モデル'); }

  var REGISTRY = {
    rule: { id: 'rule', label: '規則版（この端末内・通信なし）', stub: false, make: function () { return ruleLabeler; } },
    userKey: { id: 'userKey', label: '自分のキー（BYOK）— 未実装', stub: true, make: byokLabeler },
    inBrowser: { id: 'inBrowser', label: 'ブラウザ内モデル — 未実装', stub: true, make: inBrowserLabeler }
  };

  function list() { return Object.keys(REGISTRY).map(function (k) { return { id: k, label: REGISTRY[k].label, stub: REGISTRY[k].stub }; }); }
  function create(id, cfg) { var e = REGISTRY[id || 'rule']; if (!e) throw new Error('unknown labeler: ' + id); return e.make(cfg || {}); }
  /** 外から差し込む: fn は async (res, image, opts) => labels。 */
  function register(id, label, fn) { REGISTRY[id] = { id: id, label: label, stub: false, make: function () { return fn; } }; }
  async function run(id, res, image, opts, cfg) {
    var labels = await create(id, cfg)(res, image, opts || {});
    if (!Array.isArray(labels) || labels.length !== res.n) throw new Error('labels の数が領域数と合いません');
    return labels;
  }

  return { list: list, create: create, register: register, run: run, ruleLabeler: ruleLabeler, CLASSES: CL.CLASSES };
});
