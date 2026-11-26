/**
 * ===========================================================================
 * 礼部 · 参量 EQ 频段列表
 * 每次调用整体重绘；所有变更仅通过 handlers 回调上报，绝不修改 bands 数组。
 * 数值一律用 value / textContent 赋值，不把任何字符串拼进 innerHTML。
 * ===========================================================================
 */
import { EQ_LIMITS } from '../contracts.js';
import { GRAPHIC_GAIN_MAX } from '../core/graphic-eq.js';

/** 滤波器类型下拉项（固定枚举，非用户输入） */
const BAND_TYPES = [
  ['peaking', '峰值'],
  ['lowshelf', '低架'],
  ['highshelf', '高架'],
];

/** 数值钳制 */
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/** 任意输入安全转有限数值，失败回退默认值 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 增益文本：+3.0 dB / -3.0 dB */
function gainText(v) {
  return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
}

/** Q 文本 */
function qText(v) {
  return v.toFixed(1);
}

/**
 * 构建单段频段卡片
 * @param {Object} band 只读频段数据
 * @param {number} index 段索引
 * @param {Function} onChange 变更回调 (index, patch)
 * @param {Function} onRemove 删除回调 (index)
 * @returns {HTMLElement} .band 卡片
 */
function createBandCard(band, index, onChange, onRemove) {
  const b = band || {};
  const freq = clamp(num(b.freq, 1000), EQ_LIMITS.fMin, EQ_LIMITS.fMax);
  const gain = clamp(num(b.gain, 0), EQ_LIMITS.gainMin, EQ_LIMITS.gainMax);
  const q = clamp(num(b.q, 1), EQ_LIMITS.qMin, EQ_LIMITS.qMax);
  const type = BAND_TYPES.some(([v]) => v === b.type) ? b.type : 'peaking';
  const enabled = b.enabled !== false;

  const card = document.createElement('div');
  card.className = 'band';
  card.dataset.index = String(index);

  /* ---- 头部：序号 / 类型 / 启用 / 删除 ---- */
  const head = document.createElement('div');
  head.className = 'band__head';

  const idx = document.createElement('span');
  idx.className = 'band__idx';
  idx.textContent = String(index + 1);

  const typeSel = document.createElement('select');
  typeSel.className = 'band__type';
  for (const [value, label] of BAND_TYPES) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    typeSel.appendChild(opt);
  }
  typeSel.value = type;
  typeSel.addEventListener('change', () => onChange(index, { type: typeSel.value }));

  const enableLabel = document.createElement('label');
  enableLabel.className = 'check band__enable';
  const enableInput = document.createElement('input');
  enableInput.type = 'checkbox';
  enableInput.checked = enabled;
  enableInput.addEventListener('change', () => onChange(index, { enabled: enableInput.checked }));
  enableLabel.appendChild(enableInput);
  enableLabel.appendChild(document.createTextNode(' 启用'));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'band__del';
  del.textContent = '×';
  del.title = '删除该频段';
  del.addEventListener('click', () => onRemove(index));

  head.append(idx, typeSel, enableLabel, del);
  card.appendChild(head);

  /* ---- 频率：number + Hz 单位 ---- */
  const freqRow = document.createElement('div');
  freqRow.className = 'band__row';
  const freqLabel = document.createElement('span');
  freqLabel.className = 'band__label';
  freqLabel.textContent = '频率';
  const freqInput = document.createElement('input');
  freqInput.type = 'number';
  freqInput.className = 'band__freq';
  freqInput.min = String(EQ_LIMITS.fMin);
  freqInput.max = String(EQ_LIMITS.fMax);
  freqInput.step = '1';
  freqInput.value = String(Math.round(freq));
  freqInput.addEventListener('change', () => {
    const v = Number(freqInput.value);
    if (!Number.isFinite(v)) { freqInput.value = String(Math.round(freq)); return; }
    const f = clamp(Math.round(v), EQ_LIMITS.fMin, EQ_LIMITS.fMax);
    freqInput.value = String(f);
    onChange(index, { freq: f });
  });
  const unit = document.createElement('span');
  unit.className = 'band__unit';
  unit.textContent = 'Hz';
  freqRow.append(freqLabel, freqInput, unit);
  card.appendChild(freqRow);

  /* ---- 增益：range + 数值显示（input 事件实时更新，不重建 DOM） ---- */
  const gainRow = document.createElement('div');
  gainRow.className = 'band__row';
  const gainLabel = document.createElement('span');
  gainLabel.className = 'band__label';
  gainLabel.textContent = '增益';
  const gainInput = document.createElement('input');
  gainInput.type = 'range';
  gainInput.className = 'band__gain';
  gainInput.min = String(EQ_LIMITS.gainMin);
  gainInput.max = String(EQ_LIMITS.gainMax);
  gainInput.step = '0.5';
  gainInput.value = String(gain);
  const gainVal = document.createElement('output');
  gainVal.className = 'band__val';
  gainVal.textContent = gainText(gain);
  gainInput.addEventListener('input', () => {
    const v = clamp(num(gainInput.value, 0), EQ_LIMITS.gainMin, EQ_LIMITS.gainMax);
    gainVal.textContent = gainText(v);
    onChange(index, { gain: v });
  });
  gainRow.append(gainLabel, gainInput, gainVal);
  card.appendChild(gainRow);

  /* ---- Q：range + 数值显示 ---- */
  const qRow = document.createElement('div');
  qRow.className = 'band__row';
  const qLabel = document.createElement('span');
  qLabel.className = 'band__label';
  qLabel.textContent = 'Q';
  const qInput = document.createElement('input');
  qInput.type = 'range';
  qInput.className = 'band__q';
  qInput.min = String(EQ_LIMITS.qMin);
  qInput.max = String(EQ_LIMITS.qMax);
  qInput.step = '0.1';
  qInput.value = String(q);
  const qVal = document.createElement('output');
  qVal.className = 'band__val';
  qVal.textContent = qText(q);
  qInput.addEventListener('input', () => {
    const v = clamp(num(qInput.value, 1), EQ_LIMITS.qMin, EQ_LIMITS.qMax);
    qVal.textContent = qText(v);
    onChange(index, { q: v });
  });
  qRow.append(qLabel, qInput, qVal);
  card.appendChild(qRow);

  return card;
}

/**
 * 渲染 EQ 频段列表（整体重绘；结构变化时才由主入口调用）
 * @param {HTMLElement} container 列表容器（#bandList）
 * @param {Array} bands 频段数组（只读）
 * @param {{onChange?:Function,onRemove?:Function,onAdd?:Function}} handlers 变更回调
 */
export function renderBandList(container, bands, handlers) {
  const list = Array.isArray(bands) ? bands : [];
  const h = handlers || {};
  const onChange = typeof h.onChange === 'function' ? h.onChange : () => {};
  const onRemove = typeof h.onRemove === 'function' ? h.onRemove : () => {};
  const onAdd = typeof h.onAdd === 'function' ? h.onAdd : () => {};

  container.replaceChildren();

  // 空数组占位提示
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'band__empty';
    empty.appendChild(document.createTextNode('暂无 EQ 频段，点击 '));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'band__add';
    add.textContent = '+ 添加频段';
    add.addEventListener('click', () => onAdd());
    empty.appendChild(add);
    empty.appendChild(document.createTextNode(' 或「自动计算 EQ」'));
    container.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < list.length; i++) {
    frag.appendChild(createBandCard(list[i], i, onChange, onRemove));
  }
  container.appendChild(frag);
}

/** 频率标签：1000 -> 1k、16000 -> 16k，与设备均衡器面板一致 */
function freqLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

/**
 * 渲染 10 段图形 EQ 推子。中心频率固定（32/64/125/250/500 Hz、1/2/4/8/16 kHz），
 * 与手机、播放器自带的图形均衡器同频段，算出的数值可原样照抄。
 * 只在结构变化时整体重绘；拖拽过程中的数值同步由 main.js 做元素级更新。
 * @param {HTMLElement} container 容器（#eqGraphic）
 * @param {Array} bands 频段数组（仅读取，绝不修改）
 * @param {{ onChange: (index:number, patch:Object)=>void }} handlers 变更回调
 */
export function renderGraphicEq(container, bands, handlers) {
  if (!container) return;
  const onChange = (handlers && typeof handlers.onChange === 'function') ? handlers.onChange : () => {};
  const list = Array.isArray(bands) ? bands : [];
  const max = GRAPHIC_GAIN_MAX;

  container.textContent = '';

  const yAxis = document.createElement('div');
  yAxis.className = 'geq__yaxis';
  yAxis.setAttribute('aria-hidden', 'true');
  ['+' + max, '0', '-' + max].forEach((text, k) => {
    const mark = document.createElement('span');
    mark.className = `geq__ymark geq__ymark--${['top', 'mid', 'bottom'][k]}`;
    mark.textContent = text;
    yAxis.appendChild(mark);
  });
  container.appendChild(yAxis);

  const bank = document.createElement('div');
  bank.className = 'geq__bank';
  bank.setAttribute('role', 'group');
  bank.setAttribute('aria-label', '10 段图形均衡器');

  for (let i = 0; i < list.length; i++) {
    const b = list[i] || {};
    const freq = num(b.freq, 1000);
    const gain = clamp(num(b.gain, 0), -max, max);
    const enabled = b.enabled !== false;

    const col = document.createElement('div');
    col.className = 'geq__col' + (enabled ? '' : ' is-off');
    col.dataset.index = String(i);

    const numInput = document.createElement('input');
    numInput.className = 'geq__num';
    numInput.id = `geq-${i}`;
    numInput.type = 'number';
    numInput.min = String(-max);
    numInput.max = String(max);
    numInput.step = '0.5';
    numInput.value = gain.toFixed(1);
    numInput.setAttribute('aria-label', `${freqLabel(freq)}Hz 增益`);

    const rail = document.createElement('div');
    rail.className = 'geq__rail';

    const slider = document.createElement('input');
    slider.className = 'geq__slider';
    slider.type = 'range';
    slider.min = String(-max);
    slider.max = String(max);
    slider.step = '0.5';
    slider.value = String(gain);
    slider.setAttribute('orient', 'vertical');
    slider.setAttribute('aria-label', `${freqLabel(freq)}Hz 增益推子`);

    slider.addEventListener('input', () => {
      const v = clamp(num(slider.value, 0), -max, max);
      numInput.value = v.toFixed(1);
      onChange(i, { gain: v });
    });
    numInput.addEventListener('change', () => {
      const v = clamp(num(numInput.value, 0), -max, max);
      numInput.value = v.toFixed(1);
      slider.value = String(v);
      onChange(i, { gain: v });
    });
    // 双击任一控件归零，便于快速复位单段
    slider.addEventListener('dblclick', () => {
      slider.value = '0';
      numInput.value = '0.0';
      onChange(i, { gain: 0 });
    });

    rail.appendChild(slider);

    const freqTag = document.createElement('span');
    freqTag.className = 'geq__freq';
    freqTag.textContent = freqLabel(freq);

    col.appendChild(numInput);
    col.appendChild(rail);
    col.appendChild(freqTag);
    bank.appendChild(col);
  }

  container.appendChild(bank);
}
