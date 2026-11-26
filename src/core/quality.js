/**
 * ============================================================================
 * 测量质量评估（纯数学）—— 吏部 · 量曹
 * ----------------------------------------------------------------------------
 * 职责：对「多次重复测量」做聚合，结合信噪比与重复一致性给出逐点可信度权重，
 *       并把不可信的频段从偏差曲线中掩蔽掉，供自动 EQ 求解器与界面文案使用。
 *
 * 约束：纯函数；不触碰音频、DOM、全局状态；不修改入参；不抛异常；
 *       所有输出为有限数值（禁止 NaN / Infinity）。
 * ============================================================================
 */

/**
 * 质量评估默认参数（冻结对象，禁止外部修改）
 * @type {Readonly<{snrMinDb:number, snrFullDb:number, spreadMaxDb:number, weightThreshold:number, loHz:number, hiHz:number}>}
 */
export const QUALITY_DEFAULTS = Object.freeze({
  snrMinDb: 20,
  snrFullDb: 30,
  spreadMaxDb: 3,
  weightThreshold: 0.5,
  loHz: 25,
  hiHz: 18000,
});

/* --------------------------------------------------------------------------
 * 内部工具（不导出）
 * ----------------------------------------------------------------------- */

/** 把数值钳制到 [0, 1]；非数值一律视为 0 */
function clamp01(v) {
  return v > 1 ? 1 : v > 0 ? v : 0;
}

/** 标准 smoothstep：3t² - 2t³，输入先钳制到 [0, 1] */
function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** 若为有限数值则返回自身，否则返回默认值 */
function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

/** 从 options 对象中安全读取数值字段 */
function optNum(opts, key, dflt) {
  if (!opts || typeof opts !== 'object') return dflt;
  const v = opts[key];
  return Number.isFinite(v) ? v : dflt;
}

/** 判断是否为可索引的数值序列（Array / TypedArray 等） */
function isSeq(x) {
  return !!x && typeof x === 'object' && typeof x.length === 'number';
}

/** 取若干序列的最短长度；无可用序列返回 0 */
function shortestLength(list) {
  let n = Infinity;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (isSeq(a)) n = Math.min(n, a.length);
  }
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 频率边缘渐降权重：频带两端平滑收敛到 0。
 * f <= lo 或 f >= hi 时为 0；[lo, 2lo] 与 [hi/2, hi] 用 smoothstep 过渡；中间为 1。
 */
function edgeWeight(f, lo, hi) {
  if (!Number.isFinite(f) || !(hi > lo) || !(lo > 0)) return 0;
  if (f <= lo || f >= hi) return 0;
  if (f < lo * 2) return smoothstep((f - lo) / lo);
  if (f > hi / 2) return smoothstep((hi - f) / (hi / 2));
  return 1;
}

/** 频率格式化：< 1 kHz 用整数 Hz，否则用 kHz（最多一位小数） */
function formatHz(f) {
  if (!Number.isFinite(f) || f <= 0) return '—';
  if (f >= 1000) {
    const k = Math.round((f / 1000) * 10) / 10;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)} kHz`;
  }
  return `${Math.round(f)} Hz`;
}

/* --------------------------------------------------------------------------
 * 对外接口
 * ----------------------------------------------------------------------- */

/**
 * 逐点中值（跨多次重复测量）。
 *
 * 单次突发噪声（空调启停、说话、通知音）只会污染其中一次重复，
 * 取中值天然免疫；偶数个有效值时取中间两个的算术平均。
 * 非有限值（NaN / Infinity）不参与中值；某点全部非有限时返回 -120。
 *
 * 时间复杂度 O(n · k log k)，k 为重复次数（通常 3）。
 *
 * @param {Float64Array[]} runs 每次测量映射到同一频率轴的 dB 曲线
 * @returns {Float64Array} 长度 = 最短输入长度
 */
export function medianAcrossRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return new Float64Array(0);

  const valid = [];
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (isSeq(run) && run.length > 0) valid.push(run);
  }
  if (valid.length === 0) return new Float64Array(0);

  const n = shortestLength(valid);
  if (n === 0) return new Float64Array(0);

  const out = new Float64Array(n);
  const buf = [];

  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let k = 0; k < valid.length; k++) {
      const v = valid[k][i];
      if (Number.isFinite(v)) buf.push(v);
    }
    const m = buf.length;
    if (m === 0) {
      out[i] = -120;
      continue;
    }
    buf.sort((a, b) => a - b);
    out[i] = m % 2 === 1 ? buf[(m - 1) >> 1] : (buf[m / 2 - 1] + buf[m / 2]) / 2;
  }
  return out;
}

/**
 * 逐点总体标准差（dB 域），衡量多次重复测量的一致性。
 *
 * 方差按参与计算的有限值个数 k 做除法（总体标准差，非样本标准差）；
 * k <= 1 时该点返回 0。
 *
 * @param {Float64Array[]} runs 每次测量映射到同一频率轴的 dB 曲线
 * @returns {Float64Array} 长度 = 最短输入长度；单次输入返回全 0
 */
export function spreadAcrossRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return new Float64Array(0);

  const valid = [];
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (isSeq(run) && run.length > 0) valid.push(run);
  }
  if (valid.length === 0) return new Float64Array(0);

  const n = shortestLength(valid);
  if (n === 0) return new Float64Array(0);

  const out = new Float64Array(n);
  const buf = [];

  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let k = 0; k < valid.length; k++) {
      const v = valid[k][i];
      if (Number.isFinite(v)) buf.push(v);
    }
    const k = buf.length;
    if (k <= 1) {
      out[i] = 0;
      continue;
    }
    let sum = 0;
    for (let j = 0; j < k; j++) sum += buf[j];
    const mean = sum / k;
    let acc = 0;
    for (let j = 0; j < k; j++) {
      const d = buf[j] - mean;
      acc += d * d;
    }
    const sd = Math.sqrt(acc / k);
    out[i] = Number.isFinite(sd) ? sd : 0;
  }
  return out;
}

/** 单点功率域 SNR（内部实现） */
function snrAt(measuredDb, noiseDb) {
  if (!Number.isFinite(measuredDb) || !Number.isFinite(noiseDb)) return -20;

  const pm = Math.pow(10, measuredDb / 10);
  const pn = Math.pow(10, noiseDb / 10);

  // 噪声功率非正、或信号不高于噪声 => 信号被淹没
  if (!(pn > 0) || !(pm > pn)) return -20;

  const ratio = (pm - pn) / pn;
  if (!(ratio > 0)) return -20;

  const v = 10 * Math.log10(ratio);
  if (!Number.isFinite(v)) return 80; // 只会是 +Infinity（极大功率比）
  return v < -20 ? -20 : v > 80 ? 80 : v;
}

/**
 * 功率域信噪比：SNR = 10·log10( (Pm − Pn) / Pn )，
 * 其中 Pm = 10^(measuredDb/10)，Pn = 10^(noiseDb/10)。
 *
 * 结果钳制到 [-20, 80] dB；Pm <= Pn（信号被噪声淹没）或输入非有限时返回 -20。
 *
 * @param {Float64Array} measuredDb 测量（信号 + 噪声）功率 dB
 * @param {Float64Array} noiseDb    静默期（纯噪声）功率 dB
 * @returns {Float64Array} 长度 = 最短输入长度
 */
export function snrDb(measuredDb, noiseDb) {
  if (!isSeq(measuredDb) || !isSeq(noiseDb)) return new Float64Array(0);
  const n = Math.min(measuredDb.length, noiseDb.length);
  if (n <= 0) return new Float64Array(0);

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = snrAt(measuredDb[i], noiseDb[i]);
  }
  return out;
}

/**
 * 综合可信度权重，值域 0..1。
 *
 *   wSnr    = clamp((snr − snrMinDb) / (snrFullDb − snrMinDb), 0, 1)
 *   wSpread = clamp(1 − spreadDb / spreadMaxDb, 0, 1)
 *   wEdge   = 频带边缘渐降（<= loHz 或 >= hiHz 为 0，两端各用一倍频程 smoothstep 过渡）
 *   weight  = sqrt(wSnr · wSpread) · wEdge
 *
 * 长度取 min(snrArr.length, freqs.length)；spreadArr 较短时缺失位置按 0 dB 处理。
 *
 * @param {Float64Array} snrArr    逐点信噪比 dB
 * @param {Float64Array} spreadArr 逐点重复测量标准差 dB（可为 null / 较短）
 * @param {Float64Array} freqs     频率轴 Hz
 * @param {object} [opts] 可覆盖 QUALITY_DEFAULTS 中任意字段
 * @returns {Float64Array} 长度 = min(snrArr.length, freqs.length)
 */
export function reliabilityWeight(snrArr, spreadArr, freqs, opts) {
  if (!isSeq(snrArr) || !isSeq(freqs)) return new Float64Array(0);
  const n = Math.min(snrArr.length, freqs.length);
  if (n <= 0) return new Float64Array(0);

  const spreadOk = isSeq(spreadArr);
  const snrMin = optNum(opts, 'snrMinDb', QUALITY_DEFAULTS.snrMinDb);
  const snrFull = optNum(opts, 'snrFullDb', QUALITY_DEFAULTS.snrFullDb);
  const spreadMax = optNum(opts, 'spreadMaxDb', QUALITY_DEFAULTS.spreadMaxDb);
  const lo = optNum(opts, 'loHz', QUALITY_DEFAULTS.loHz);
  const hi = optNum(opts, 'hiHz', QUALITY_DEFAULTS.hiHz);

  const snrSpan = snrFull - snrMin;
  const out = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const s = snrArr[i];
    let wSnr = 0;
    if (Number.isFinite(s)) {
      wSnr = snrSpan > 0 ? clamp01((s - snrMin) / snrSpan) : s >= snrFull ? 1 : 0;
    }

    const spRaw = spreadOk ? spreadArr[i] : 0;
    const sp = Number.isFinite(spRaw) ? Math.abs(spRaw) : 0;
    const wSpread = spreadMax > 0 ? clamp01(1 - sp / spreadMax) : sp <= 0 ? 1 : 0;

    const wEdge = edgeWeight(freqs[i], lo, hi);
    const v = Math.sqrt(wSnr * wSpread) * wEdge;
    out[i] = Number.isFinite(v) ? clamp01(v) : 0;
  }
  return out;
}

/**
 * 按权重掩蔽偏差曲线，供自动 EQ 求解使用。
 *
 * 返回新数组，out[i] = delta[i] · weight[i]；权重低于 weightThreshold 的频段
 * 再乘一个 smoothstep 衰减（权重越低衰减越狠，权重 0 时严格为 0），
 * 使其基本不参与拟合；权重为 1 的频段原样保留。
 * 不修改入参；非有限值输出 0。
 *
 * @param {Float64Array} deltaDb 偏差曲线（target − measured）
 * @param {Float64Array} weight  可信度权重
 * @param {object} [opts] 可覆盖 weightThreshold
 * @returns {Float64Array} 长度 = min(deltaDb.length, weight.length)
 */
export function maskDelta(deltaDb, weight, opts) {
  if (!isSeq(deltaDb) || !isSeq(weight)) return new Float64Array(0);
  const n = Math.min(deltaDb.length, weight.length);
  if (n <= 0) return new Float64Array(0);

  const th = optNum(opts, 'weightThreshold', QUALITY_DEFAULTS.weightThreshold);
  const out = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const d = deltaDb[i];
    const w = weight[i];
    if (!Number.isFinite(d) || !Number.isFinite(w) || !(w > 0)) {
      out[i] = 0;
      continue;
    }
    const gate = w >= th ? 1 : smoothstep(th > 0 ? w / th : 0);
    const v = d * w * gate;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * 求连续可信频段，用于界面文案（如「可信 60 Hz–14 kHz」）。
 *
 * weight >= threshold 的频点视为可信；数组下标连续即可信段连续（不判断频率间隔）。
 * 返回频率升序的区间数组，lo/hi 为该段首、末频点的频率（Hz）。
 *
 * @param {Float64Array} weight 可信度权重
 * @param {Float64Array} freqs  频率轴 Hz
 * @param {number} [threshold]  默认 QUALITY_DEFAULTS.weightThreshold
 * @returns {Array<{lo:number, hi:number}>} 无满足条件的频段时返回 []
 */
export function reliableRanges(weight, freqs, threshold) {
  if (!isSeq(weight) || !isSeq(freqs)) return [];
  const n = Math.min(weight.length, freqs.length);
  if (n <= 0) return [];

  const th = numOr(threshold, QUALITY_DEFAULTS.weightThreshold);
  const ranges = [];
  let start = -1;

  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(weight[i]) && weight[i] >= th && Number.isFinite(freqs[i]);
    if (ok) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      ranges.push({ lo: freqs[start], hi: freqs[i - 1] });
      start = -1;
    }
  }
  if (start >= 0) ranges.push({ lo: freqs[start], hi: freqs[n - 1] });

  return ranges;
}

/**
 * 一句话中文质量结论，供界面直接显示。
 *
 * 判定：可信频点占比 >= 60% 且最长可信段跨度 >= 2 倍频程（log2(hi/lo)）为「良好」，
 * 否则给出改善建议。良好示例：「可信 63 Hz–16 kHz（3 次重复，最小 SNR 24 dB）」。
 *
 * @param {Float64Array} weight 可信度权重
 * @param {Float64Array} freqs  频率轴 Hz
 * @param {Float64Array} snrArr 逐点信噪比 dB
 * @param {{repeats?:number}} meta 附加信息（重复次数）
 * @returns {string} 中文结论，永不为空、永不抛异常
 */
export function describeQuality(weight, freqs, snrArr, meta) {
  if (!isSeq(weight) || !isSeq(freqs)) return '数据不足，无法评估测量质量';

  const n = Math.min(weight.length, freqs.length);
  if (n <= 0) return '数据不足，无法评估测量质量';

  const th = QUALITY_DEFAULTS.weightThreshold;
  const repeats =
    meta && Number.isFinite(meta.repeats) && meta.repeats > 0 ? Math.round(meta.repeats) : 1;
  const snrOk = isSeq(snrArr);

  let reliableCount = 0;
  let minSnrReliable = Infinity;
  let minSnrAll = Infinity;

  for (let i = 0; i < n; i++) {
    const w = weight[i];
    const ok = Number.isFinite(w) && w >= th && Number.isFinite(freqs[i]);
    if (ok) reliableCount++;
    if (snrOk && i < snrArr.length && Number.isFinite(snrArr[i])) {
      if (snrArr[i] < minSnrAll) minSnrAll = snrArr[i];
      if (ok && snrArr[i] < minSnrReliable) minSnrReliable = snrArr[i];
    }
  }

  const ranges = reliableRanges(weight, freqs, th);
  const coverage = reliableCount / n;

  let longestSpan = 0;
  let longest = null;
  for (let r = 0; r < ranges.length; r++) {
    const { lo, hi } = ranges[r];
    const span = lo > 0 && hi > 0 ? Math.log2(hi / lo) : 0;
    if (span > longestSpan || longest === null) {
      longestSpan = span;
      longest = ranges[r];
    }
  }

  const good = coverage >= 0.6 && longestSpan >= 2 && longest !== null;
  const minSnr = minSnrReliable === Infinity ? minSnrAll : minSnrReliable;
  const snrText = Number.isFinite(minSnr) ? `，最小 SNR ${Math.round(minSnr)} dB` : '';

  if (good) {
    return `可信 ${formatHz(longest.lo)}–${formatHz(longest.hi)}（${repeats} 次重复${snrText}）`;
  }

  if (reliableCount === 0) {
    const hint =
      Number.isFinite(minSnrAll) && minSnrAll < QUALITY_DEFAULTS.snrMinDb
        ? '整体信噪比不足，建议提高音量或关闭环境噪声源'
        : '重复测量差异过大或环境噪声过强，建议提高音量、关闭噪声源后重测';
    return hint;
  }

  const pct = Math.round(coverage * 100);
  return `可信频段仅占 ${pct}%（可信 ${formatHz(longest.lo)}–${formatHz(longest.hi)}${snrText}），建议提高音量或关闭环境噪声源后重测`;
}
