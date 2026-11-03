/* zumen-kit paint: 表示文言（日本語 / English）。英語の文言に和訳は添えない。 */
(function (root) {
  'use strict';
  const en = {
    app: 'ZUMEN PAINT',
    open_image: 'Open image', open_project: 'Open project', save: 'Save', export_png: 'Export PNG', export_psd: 'Export PSD',
    undo: 'Undo', redo: 'Redo', theme: 'Theme', font: 'Font', font_ph: 'font name',
    tool_wand: 'Auto select (W)', tool_brush: 'Selection brush (B)', tool_eraser: 'Selection eraser (E)',
    tool_poly: 'Polygon select (P)', tool_paint: 'Paint brush (C)', tool_persp: 'Perspective fit (T)', tool_fit: 'Fit view (F)',
    passes: 'Passes', p_id: 'ID map', p_shadow: 'Shadow', p_ao: 'AO', p_line: 'Line', load: 'Load', clear: 'Clear',
    use_id: 'Select by ID', contiguous: 'Contiguous only', id_tol: 'ID tolerance',
    shading: 'Shading', mode_multiply: 'Multiply', mode_solid: 'Solid', brightness: 'Base brightness', line_opacity: 'Line opacity',
    selection: 'Selection', tol: 'Tolerance', line_thr: 'Line threshold', gap: 'Gap closing', brush_size: 'Brush size',
    invert: 'Invert', deselect: 'Deselect',
    material: 'Material', color: 'Color', size: 'Size', rotation: 'Rotation', contrast: 'Contrast',
    k_solid: 'Solid', k_gradient: 'Gradient', k_user: 'Texture',
    k_concrete: 'Concrete', k_wood: 'Wood', k_brick: 'Brick', k_tile: 'Tile', k_stone: 'Stone', k_grass: 'Grass',
    k_water: 'Water', k_glass: 'Glass', k_metal: 'Metal', k_plaster: 'Plaster', k_asphalt: 'Asphalt', k_gravel: 'Gravel',
    k_fill: 'Fill', k_paint: 'Paint',
    import_texture: 'Import texture', color2: 'Color 2', mid_color: 'Mid color', radial: 'Radial', angle: 'Angle',
    fill_sel: 'Fill selection', paint_brush: 'Paint brush', paint_size: 'Size', paint_hard: 'Hardness',
    layers: 'Layers', layer_mode: 'Shading', opacity: 'Opacity', amount: 'Shading amount',
    watercolor: 'Watercolor', bleed: 'Bleed', edge: 'Edge pooling', grain: 'Grain',
    persp_fit: 'Fit perspective', persp_clear: 'Clear fit', persp_reps: 'Repeats', persp_aspect: 'Aspect',
    layer_up: 'Move up', layer_down: 'Move down', layer_del: 'Delete', layer_eye: 'Show / hide', layer_none: 'No layers yet',
    b_sample: 'Try the sample (plan)', b_sample_elev: 'Sample: elevation', b_sample_sec: 'Sample: section',
    auto_paint: 'Auto colour', kind_plan: 'Plan', kind_elev: 'Elevation', kind_section: 'Section', kind_tip: 'Drawing kind', depth: 'Depth',
    k_raster: 'Image', k_handpaint: 'Hand paint (empty)', m_auto_fail: 'Auto colour failed', m_auto_done: 'Auto colour applied. Finish by layers.', drop_hint: 'Drop an image here, or press Open image', drop_sub: 'PNG / JPG   -   .paint.json',
    m_ready: 'Ready', m_loaded: 'Loaded {w} x {h}', m_pass_ok: '{n} loaded', m_pass_bad: 'Size mismatch: {n}', m_need_image: 'Open an image first',
    m_sel: 'Selected {n} px', m_sel_none: 'Nothing selected', m_need_sel: 'Select an area first',
    m_filled: 'Layer added: {n}', m_changed: 'Material changed: {n}', m_saved: 'Saved', m_exported: 'Exported {n}',
    m_open_fail: 'Could not open this file', m_taint: 'The browser blocked reading this image. Drop the file instead.',
    m_persp1: 'Perspective: click 4 corners (top-left, top-right, bottom-right, bottom-left) - {n}/4',
    m_persp_ok: 'Perspective applied', m_persp_need: 'Select a layer first', m_poly: 'Polygon: click points, Enter or first point to close',
    m_busy: 'Working...', m_doc_opened: 'Project opened: {n} layers', m_tex_ok: 'Texture added: {n}',
  };
  const ja = {
    app: 'ZUMEN PAINT',
    open_image: '画像を開く', open_project: 'プロジェクトを開く', save: '保存', export_png: 'PNG 書き出し', export_psd: 'PSD 書き出し',
    undo: '元に戻す', redo: 'やり直し', theme: 'テーマ', font: '書体', font_ph: '書体名',
    tool_wand: '自動選択 (W)', tool_brush: '選択ブラシ (B)', tool_eraser: '選択消しゴム (E)',
    tool_poly: '多角形選択 (P)', tool_paint: '着色ブラシ (C)', tool_persp: '遠近合わせ (T)', tool_fit: '全体表示 (F)',
    passes: 'パス', p_id: 'ID マップ', p_shadow: '影', p_ao: 'AO', p_line: '線', load: '読込', clear: '外す',
    use_id: 'ID で選ぶ', contiguous: '連続した所だけ', id_tol: 'ID 許容差',
    shading: '陰影', mode_multiply: '乗算', mode_solid: 'べた', brightness: '明るさの基準', line_opacity: '線の濃さ',
    selection: '選択', tol: '許容差', line_thr: '線のしきい値', gap: '隙間を閉じる', brush_size: 'ブラシ径',
    invert: '反転', deselect: '選択解除',
    material: '素材', color: '色', size: 'サイズ', rotation: '回転', contrast: 'コントラスト',
    k_solid: '単色', k_gradient: 'グラデーション', k_user: 'テクスチャ',
    k_concrete: 'コンクリート', k_wood: '木', k_brick: 'レンガ', k_tile: 'タイル', k_stone: '石', k_grass: '草',
    k_water: '水', k_glass: 'ガラス', k_metal: '金属', k_plaster: '漆喰', k_asphalt: 'アスファルト', k_gravel: '砂利',
    k_fill: '塗り', k_paint: '着色',
    import_texture: 'テクスチャを読み込む', color2: '色 2', mid_color: '中間色', radial: '放射状', angle: '角度',
    fill_sel: '選択範囲を塗る', paint_brush: '着色ブラシ', paint_size: '太さ', paint_hard: '硬さ',
    layers: 'レイヤー', layer_mode: '陰影', opacity: '不透明度', amount: '陰影の強さ',
    watercolor: '水彩', bleed: 'にじみ', edge: '縁の溜まり', grain: '粒',
    persp_fit: '遠近を合わせる', persp_clear: '遠近を外す', persp_reps: '繰り返し', persp_aspect: '縦横比',
    layer_up: '上へ', layer_down: '下へ', layer_del: '削除', layer_eye: '表示 / 非表示', layer_none: 'レイヤーはまだありません',
    b_sample: '見本で試す（平面）', b_sample_elev: '見本：立面', b_sample_sec: '見本：断面',
    auto_paint: '自動着彩', kind_plan: '平面', kind_elev: '立面', kind_section: '断面', kind_tip: '図面の種類', depth: '奥行き',
    k_raster: '画像', k_handpaint: '手描き（空）', m_auto_fail: '自動着彩に失敗しました', m_auto_done: '自動着彩しました。レイヤーで仕上げられます。', drop_hint: '画像をここへドロップ、または「画像を開く」', drop_sub: 'PNG / JPG   -   .paint.json',
    m_ready: '準備完了', m_loaded: '読み込み {w} x {h}', m_pass_ok: '{n} を読み込みました', m_pass_bad: '大きさが一致しません: {n}', m_need_image: '先に画像を開いてください',
    m_sel: '選択 {n} 画素', m_sel_none: '選択はありません', m_need_sel: '先に範囲を選んでください',
    m_filled: 'レイヤーを追加: {n}', m_changed: '素材を変更: {n}', m_saved: '保存しました', m_exported: '書き出しました: {n}',
    m_open_fail: 'このファイルは開けません', m_taint: 'ブラウザがこの画像の読み取りを止めました。ファイルをドロップしてください。',
    m_persp1: '遠近: 4 隅を順にクリック（左上・右上・右下・左下） - {n}/4',
    m_persp_ok: '遠近を適用しました', m_persp_need: '先にレイヤーを選んでください', m_poly: '多角形: 点をクリック、Enter か最初の点で閉じる',
    m_busy: '処理中...', m_doc_opened: 'プロジェクトを開きました: {n} レイヤー', m_tex_ok: 'テクスチャを追加: {n}',
  };
  const dict = { en, ja };
  let lang = 'ja';
  function t(key, params) {
    let s = (dict[lang] && dict[lang][key]) || en[key] || key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : params[k]));
    return s;
  }
  function apply(rootEl) {
    const r = rootEl || document;
    r.querySelectorAll('[data-i]').forEach(e => { e.textContent = t(e.getAttribute('data-i')); });
    r.querySelectorAll('[data-ti]').forEach(e => { const v = t(e.getAttribute('data-ti')); e.title = v; e.setAttribute('aria-label', v); });
    r.querySelectorAll('[data-pi]').forEach(e => { e.placeholder = t(e.getAttribute('data-pi')); });
  }
  function setLang(l) { lang = dict[l] ? l : 'ja'; document.documentElement.lang = lang; }
  const api = { t, apply, setLang, get lang() { return lang; }, dict };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.PaintI18n = api;
})(typeof window !== 'undefined' ? window : globalThis);
