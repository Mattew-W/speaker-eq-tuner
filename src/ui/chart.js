/**
 * ===========================================================================
 * 礼部 · 频响图表（纯手写 Canvas 2D，零第三方依赖）
 * 对数频率轴 / dB 轴、网格刻度、多曲线、可拖拽 EQ 控制点
 * 传入的 CurveSet 只读；所有绘制坐标均先校验有限值，绝不产生 NaN 指令
 * ===========================================================================
 */
import { COLORS, EQ_LIMITS } from '../contracts.js';

const F_MIN = 20;
const F_MAX = 20000;
const LOG_SPAN = Math.log(F_MAX / F_MIN);      // === Math.log(1000)
const LOG2_SPAN = Math.log2(F_MAX / F_MIN);

/** 竖向频率刻度 [Hz, 标注文字] */
const FREQ_TICKS = [
  [20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'],
  [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k'],
];

const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

/** 数值钳制 */
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/** 可信度色带高度（CSS 像素），紧贴绘图区下边界内侧 */
const RIBBON_H = 4;
/** 可信度色带量化档数：8 档足以表达 0..1 的分布，又能把 fill 调用压到 8 次 */
const CONF_BUCKETS = 8;
/** 可信度低于该阈值视为该频点数据不可用 */
const UNTRUSTED_THRESHOLD = 0.5;

/** 不可信区背景带填充色（COLORS.axis 的低透明度） */
const UNTRUSTED_FILL = 'rgba(143,163,184,0.13)';

/**
 * 可信度 0..1 线性插值为 rgba 填充色：0 -> 灰蓝 30%，1 -> 青绿 95%。
 * @param {number} t 可信度（会被钳制到 0..1）
 * @returns {string} 可直接赋给 ctx.fillStyle 的 rgba 字符串
 */
function confidenceFill(t) {
  const k = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  const r = Math.round(143 + (93 - 143) * k);
  const g = Math.round(163 + (202 - 163) * k);
  const b = Math.round(184 + (165 - 184) * k);
  const a = 0.30 + (0.95 - 0.30) * k;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * 校验可信度权重是否可用（只读取用，不复制、不修改）。
 * 缺失 / 非数组型 / 长度不足 freqs 时返回 null，调用方据此完全跳过绘制，
 * 保证无 weight 时的绘制路径与旧版逐字一致。
 * @param {ArrayLike<number>|null|undefined} weight
 * @param {ArrayLike<number>|null|undefined} freqs
 * @returns {ArrayLike<number>|null} 可用的权重数组
 */
function pickWeight(weight, freqs) {
  if (!weight || !freqs) return null;
  if (typeof weight.length !== 'number' || typeof freqs.length !== 'number') return null;
  if (freqs.length < 2 || weight.length < freqs.length) return null;
  return weight;
}

/**
 * 频响图表。构造后即监听容器尺寸并自动 HiDPI 重绘。
 */
export class ResponseChart {
  /**
   * @param {HTMLCanvasElement} canvas 画布；CSS 宽高由 .chart-wrap 决定
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this._data = null;                // CurveSet（只读）
    this._view = 'response';          // 'response' | 'delta'
    this._showRaw = false;
    this._dpr = 1;
    this._w = 0;                      // CSS 像素宽
    this._h = 0;                      // CSS 像素高
    this._pad = { l: 46, r: 14, t: 12, b: 26 };
    this._yRange = { lo: -24, hi: 24 };
    this._drag = null;                // { index, freq, gain, pointerId }

    // 绑定一次，保留同一引用
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);

    // 容器尺寸变化时自动重建位图并渲染
    this._ro = null;
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement || canvas);
    }

    this.resize();
  }

  /** 设置曲线数据并立即重绘；不修改传入对象 */
  setData(data) {
    this._data = data || null;
    this.render();
  }

  /** 切换视图：response 频响 / delta 偏差与 EQ，并立即重绘 */
  setView(view) {
    this._view = view === 'delta' ? 'delta' : 'response';
    this.render();
  }

  /** 是否显示未平滑的原始实测曲线 */
  setShowRaw(on) {
    this._showRaw = !!on;
    this.render();
  }

  /** 按容器 CSS 尺寸与 devicePixelRatio 重建位图并重绘 */
  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 4);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw) this.canvas.width = pw;
    if (this.canvas.height !== ph) this.canvas.height = ph;
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  /** 绘图区（CSS 像素） */
  _plot() {
    const p = this._pad;
    return { x: p.l, y: p.t, w: this._w - p.l - p.r, h: this._h - p.t - p.b };
  }

  /** 对数频率 Hz -> x：x(f)=padL + log(f/20)/log(1000) * plotW */
  _xOf(freq) {
    if (!Number.isFinite(freq) || freq <= 0) return NaN;
    const plot = this._plot();
    return plot.x + (Math.log(freq / F_MIN) / LOG_SPAN) * plot.w;
  }

  /**
   * 频率 -> x，并钳制到绘图区左右边界（供可信度层使用）。
   * 非有限或非正频率返回 NaN，由调用方跳过，避免产生 NaN 绘制指令。
   * @param {number} freq 频率 Hz
   * @returns {number} 绘图区内的 x 坐标
   */
  _clampedX(freq) {
    const x = this._xOf(freq);
    if (!Number.isFinite(x)) return NaN;
    const plot = this._plot();
    return clamp(x, plot.x, plot.x + plot.w);
  }

  /** dB -> y（按当前 Y 轴范围线性映射） */
  _yOf(db) {
    if (!Number.isFinite(db)) return NaN;
    const plot = this._plot();
    const { lo, hi } = this._yRange;
    return plot.y + ((hi - db) / (hi - lo)) * plot.h;
  }

  /** x -> 频率 Hz（拖拽反算）：f = 20 * 2^(t * log2(1000)) */
  _freqAt(x) {
    const plot = this._plot();
    const t = (x - plot.x) / plot.w;
    return F_MIN * Math.pow(2, t * LOG2_SPAN);
  }

  /** y -> dB（拖拽反算） */
  _dbAt(y) {
    const plot = this._plot();
    const { lo, hi } = this._yRange;
    return hi - ((y - plot.y) / plot.h) * (hi - lo);
  }

  /** 当前视图参与绘制的曲线 key */
  _curveKeys() {
    return this._view === 'delta'
      ? ['delta', 'eq']
      : ['measuredRaw', 'measured', 'target', 'verify'];
  }

  /**
   * 计算 Y 轴范围：以视图默认范围为下限，按数据自适应扩展，边界对齐 6 dB。
   * 只看曲线、不看控制点，避免拖拽时坐标轴抖动。
   */
  _computeYRange() {
    const base = this._view === 'delta' ? 18 : 24;
    let lo = -base;
    let hi = base;
    const data = this._data;
    if (data) {
      for (const key of this._curveKeys()) {
        if (key === 'measuredRaw' && !this._showRaw) continue;
        const arr = data[key];
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    lo = Math.floor(lo / 6) * 6;
    hi = Math.ceil(hi / 6) * 6;
    if (hi - lo < 12) hi = lo + 12;
    return { lo, hi };
  }

  /**
   * 绘制一条曲线：在 data.freqs 网格上逐点 lineTo（网格本身足够密，无需插值）。
   * 跳过非有限值；调用方已把画布 clip 到绘图区，线段越界由 clip 裁剪。
   */
  _strokeCurve(arr, freqs, color, width, dashed) {
    if (!arr || !freqs) return;
    const ctx = this.ctx;
    const n = Math.min(arr.length, freqs.length);
    ctx.save();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < n; i++) {
      const f = freqs[i];
      const v = arr[i];
      if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(v)) { drawing = false; continue; }
      const x = this._xOf(f);
      const y = this._yOf(v);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { drawing = false; continue; }
      if (drawing) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); drawing = true; }
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 绘制「不可信区背景带」：把 weight < 0.5 的连续下标合并成区间，
   * 在每个区间覆盖的频段上填满整高的竖直矩形。
   * 所有区间共用同一个 fillStyle 与同一条 path，只调用一次 fill，避免状态切换。
   * 权重不可用（缺失 / 长度不足）时直接返回，不产生任何绘制。
   * @param {ArrayLike<number>} freqs 频率轴
   * @param {ArrayLike<number>} weight 逐频点可信度 0..1
   */
  _drawUncertainBands(freqs, weight) {
    const n = Math.min(freqs.length, weight.length);
    if (n < 1) return;
    const ctx = this.ctx;
    const plot = this._plot();
    const right = plot.x + plot.w;

    ctx.save();
    ctx.beginPath();
    let any = false;
    let i = 0;
    while (i < n) {
      if (!(weight[i] < UNTRUSTED_THRESHOLD)) { i++; continue; }
      let end = i;
      while (end + 1 < n && weight[end + 1] < UNTRUSTED_THRESHOLD) end++;
      // 区间右沿取下一个可用频点的位置；一直延续到末点则补到绘图区右边界
      const xa = this._clampedX(freqs[i]);
      const xb = end + 1 < n ? this._clampedX(freqs[end + 1]) : right;
      if (Number.isFinite(xa) && Number.isFinite(xb) && xb > xa) {
        ctx.rect(xa, plot.y, xb - xa, plot.h);
        any = true;
      }
      i = end + 1;
    }
    if (any) {
      ctx.fillStyle = UNTRUSTED_FILL;
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 绘制「可信度色带」：绘图区底部内侧 4px 高、横贯全宽。
   * 每个频点占一个宽度为其频率间隔的小矩形；颜色按 weight 线性插值（0 灰蓝 / 1 青绿）。
   * 为限制状态切换，先把 weight 量化为 8 档，逐档合并 path 后各 fill 一次。
   * 权重不可用（缺失 / 长度不足）时直接返回。
   * @param {ArrayLike<number>} freqs 频率轴（对数、升序）
   * @param {ArrayLike<number>} weight 逐频点可信度 0..1
   */
  _drawConfidenceRibbon(freqs, weight) {
    const n = Math.min(freqs.length, weight.length);
    if (n < 1) return;
    const ctx = this.ctx;
    const plot = this._plot();
    const right = plot.x + plot.w;
    const top = plot.y + plot.h - RIBBON_H;

    // 每档取档位中点做颜色插值，保证同档共用一条 path 与一个 fillStyle
    const fills = new Array(CONF_BUCKETS);
    for (let k = 0; k < CONF_BUCKETS; k++) {
      fills[k] = confidenceFill((k + 0.5) / CONF_BUCKETS);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    for (let k = 0; k < CONF_BUCKETS; k++) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < n; i++) {
        const w = weight[i];
        if (!Number.isFinite(w)) continue;
        const bucket = Math.min(CONF_BUCKETS - 1, Math.floor(clamp(w, 0, 1) * CONF_BUCKETS));
        if (bucket !== k) continue;
        const xa = this._clampedX(freqs[i]);
        const xb = i + 1 < n ? this._clampedX(freqs[i + 1]) : right;
        if (!Number.isFinite(xa) || !Number.isFinite(xb)) continue;
        const dw = xb - xa;
        if (!(dw > 0)) continue;
        ctx.rect(xa, top, dw, RIBBON_H);
        any = true;
      }
      if (any) {
        ctx.fillStyle = fills[k];
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** 画网格（频率刻度 + 每 6 dB 横线，0 dB 加粗）、刻度文字与轴标签 */
  _drawGrid() {
    const ctx = this.ctx;
    const plot = this._plot();
    const { lo, hi } = this._yRange;
    ctx.save();
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';

    // 竖向频率刻度
    ctx.textAlign = 'center';
    for (const [f, label] of FREQ_TICKS) {
      const x = this._xOf(f);
      if (!Number.isFinite(x)) continue;
      const px = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.moveTo(px, plot.y);
      ctx.lineTo(px, plot.y + plot.h);
      ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(label, x, plot.y + plot.h + 12);
    }

    // 横向 dB 刻度
    ctx.textAlign = 'right';
    for (let db = lo; db <= hi; db += 6) {
      const y = this._yOf(db);
      if (!Number.isFinite(y)) continue;
      const py = Math.round(y) + 0.5;
      const isZero = db === 0;
      ctx.beginPath();
      ctx.strokeStyle = isZero ? COLORS.gridMajor : COLORS.grid;
      ctx.lineWidth = isZero ? 1.6 : 1;
      ctx.moveTo(plot.x, py);
      ctx.lineTo(plot.x + plot.w, py);
      ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(String(db), plot.x - 6, y);
    }

    // 轴标签（dB / Hz）
    ctx.fillStyle = COLORS.axis;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('dB', plot.x + 2, plot.y + 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Hz', plot.x + plot.w - 2, plot.y + plot.h - 2);

    // 绘图区边框
    ctx.beginPath();
    ctx.strokeStyle = COLORS.gridMajor;
    ctx.lineWidth = 1;
    ctx.rect(Math.round(plot.x) + 0.5, Math.round(plot.y) + 0.5, Math.round(plot.w), Math.round(plot.h));
    ctx.stroke();
    ctx.restore();
  }

  /** 画 EQ 频段控制点；拖拽中的段使用 _drag 实时坐标 */
  _drawBands() {
    const bands = this._data && this._data.bands;
    if (!Array.isArray(bands)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (!b) continue;
      const drag = this._drag;
      const active = drag && drag.index === i;
      const x = this._xOf(active ? drag.freq : Number(b.freq));
      const y = this._yOf(active ? drag.gain : Number(b.gain));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const enabled = b.enabled !== false;

      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      if (enabled) {
        ctx.fillStyle = COLORS.eq;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = active ? '#ffffff' : '#c8ffe9';
        ctx.stroke();
      } else {
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS.axis;
        ctx.stroke();
      }
      ctx.fillStyle = enabled ? '#06251a' : COLORS.axis;
      ctx.fillText(String(i + 1), x, y + 0.5);
    }
    ctx.restore();
  }

  /** 主绘制入口：无数据时仅画网格与坐标轴，不报错 */
  render() {
    if (this._w <= 0 || this._h <= 0) return;
    const plot = this._plot();
    if (plot.w <= 0 || plot.h <= 0) return;
    const ctx = this.ctx;

    // 拖拽期间冻结 Y 轴，保证反算与显示使用同一范围
    if (!this._drag) this._yRange = this._computeYRange();

    ctx.clearRect(0, 0, this._w, this._h);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this._w, this._h);

    this._drawGrid();

    const data = this._data;
    const freqs = data && data.freqs;
    const weight = pickWeight(data && data.weight, freqs);

    // 不可信频段背景带：网格之后、曲线之前，避免遮挡数据本身
    if (weight) this._drawUncertainBands(freqs, weight);

    // delta 视图额外画一条 0 dB 参考线
    if (this._view === 'delta') {
      const y0 = this._yOf(0);
      if (Number.isFinite(y0)) {
        ctx.save();
        ctx.strokeStyle = COLORS.zero;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(plot.x, Math.round(y0) + 0.5);
        ctx.lineTo(plot.x + plot.w, Math.round(y0) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 曲线统一裁剪在绘图区内
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (freqs) {
      if (this._view === 'delta') {
        this._strokeCurve(data.delta, freqs, COLORS.delta, 2, false);
        this._strokeCurve(data.eq, freqs, COLORS.eq, 2, false);
      } else {
        if (this._showRaw) this._strokeCurve(data.measuredRaw, freqs, COLORS.measuredRaw, 1.2, false);
        this._strokeCurve(data.measured, freqs, COLORS.measured, 2, false);
        this._strokeCurve(data.target, freqs, COLORS.target, 2, true);
        this._strokeCurve(data.verify, freqs, COLORS.verify, 2, false);
      }
    }
    ctx.restore();

    // 可信度色带：贴在绘图区底边内侧，画在曲线之后（不遮挡曲线主体）
    if (weight) this._drawConfidenceRibbon(freqs, weight);

    this._drawBands();
  }

  /** pointer 坐标 -> canvas 内部 CSS 像素坐标 */
  _localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? this._w / rect.width : 1;
    const sy = rect.height > 0 ? this._h / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  /** 命中测试：返回距指针 14px 内最近的控制点索引，未命中返回 -1 */
  _hitBand(x, y) {
    const bands = this._data && this._data.bands;
    if (!Array.isArray(bands)) return -1;
    let best = -1;
    let bestD2 = 14 * 14;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (!b) continue;
      const drag = this._drag;
      const active = drag && drag.index === i;
      const px = this._xOf(active ? drag.freq : Number(b.freq));
      const py = this._yOf(active ? drag.gain : Number(b.gain));
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const d2 = (px - x) * (px - x) + (py - y) * (py - y);
      if (d2 <= bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }

  /** 按下：命中控制点后捕获指针，进入拖拽态（鼠标 / 触摸统一走 pointer 事件） */
  _onPointerDown(e) {
    if (this._drag) return;
    const p = this._localPoint(e);
    const index = this._hitBand(p.x, p.y);
    if (index < 0) return;
    const b = this._data.bands[index];
    this._yRange = this._computeYRange();
    this._drag = {
      index,
      freq: clamp(Number(b.freq) || EQ_LIMITS.fMin, EQ_LIMITS.fMin, EQ_LIMITS.fMax),
      gain: clamp(Number(b.gain) || 0, EQ_LIMITS.gainMin, EQ_LIMITS.gainMax),
      pointerId: e.pointerId,
    };
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* 环境不支持时忽略 */ }
    e.preventDefault();
    this.render();
  }

  /** 移动：反算 freq / gain 并派发 banddrag，实时把该点画到新位置 */
  _onPointerMove(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = this._localPoint(e);
    const plot = this._plot();
    const x = clamp(p.x, plot.x, plot.x + plot.w);
    const y = clamp(p.y, plot.y, plot.y + plot.h);
    drag.freq = clamp(this._freqAt(x), EQ_LIMITS.fMin, EQ_LIMITS.fMax);
    drag.gain = clamp(this._dbAt(y), EQ_LIMITS.gainMin, EQ_LIMITS.gainMax);
    e.preventDefault();
    this.canvas.dispatchEvent(new CustomEvent('banddrag', {
      detail: { index: drag.index, freq: drag.freq, gain: drag.gain },
    }));
    this.render();
  }

  /** 松手：派发 bandchange 提交最终值并结束拖拽 */
  _onPointerUp(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.canvas.dispatchEvent(new CustomEvent('bandchange', {
      detail: { index: drag.index, freq: drag.freq, gain: drag.gain },
    }));
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    this._drag = null;
    this.render();
  }

  /** 触摸被系统中断时只清理拖拽态，不提交变更 */
  _onPointerCancel(e) {
    if (!this._drag || e.pointerId !== this._drag.pointerId) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    this._drag = null;
    this.render();
  }
}
