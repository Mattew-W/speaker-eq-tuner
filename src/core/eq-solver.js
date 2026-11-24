/**
 * 【户部】参量 EQ 求解模块
 * ---------------------------------------------------------------------------
 * 提供 Band 构造 / 钳制、RBJ 双二阶幅频解析、总响应求和，
 * 以及由「目标 - 实测」偏差曲线自动拟合 EQ 的贪心 + 最小二乘算法。
 * 纯 ES module、具名导出、无副作用；不修改任何入参数组 / 对象，
 * 所有返回值均为新对象，数值结果保证为有限值（无 NaN / Infinity）。
 */
import { EQ_LIMITS, SAMPLE_RATE, GRID } from '../contracts.js';

/* ----------------------------- 内部工具 ----------------------------- */

/** 有限数保护：非有限值回退到 fallback。 */
function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** 数值钳制；非有限输入回退到下界，避免把 NaN 传播出去。 */
function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

/** 生成随机唯一 id（无模块级可变状态）。 */
function makeId() {
  return 'b_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** smoothstep：把 [0,1] 输入映射为平滑的 S 形过渡。 */
function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * 与 dsp.smoothLogCurve(divisor) 等价的本地 1/divisor 倍频程平滑：
 * 在 log2(f) 域做三角加权移动平均（divisor=6 即 1/6 倍频程）。
 * 自包含实现，避免并行开发阶段对尚未生成的模块产生运行时依赖。
 * @param {Float64Array} freqs
 * @param {Float64Array} db
 * @param {number} divisor
 * @returns {Float64Array}
 */
function smoothLogLocal(freqs, db, divisor) {
  const n = db.length;
  const out = new Float64Array(n);
  const half = 1 / Math.max(finiteOr(divisor, 6), 1e-6);
  const lf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lf[i] = Math.log2(Math.max(finiteOr(freqs[i], 1), 1e-6));
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wsum = 0;
    for (let j = 0; j < n; j++) {
      const d = Math.abs(lf[j] - lf[i]);
      if (d >= half) continue;
      const w = 1 - d / half;
      sum += w * (Number.isFinite(db[j]) ? db[j] : 0);
      wsum += w;
    }
    out[i] = wsum > 0 ? sum / wsum : (Number.isFinite(db[i]) ? db[i] : 0);
  }
  return out;
}

/** 频段边缘权重：30Hz 以下、18kHz 以上平滑渐降到 0，中间恒为 1（避免不可控频段的荒谬补偿）。 */
function bandEdgeWeight(f) {
  if (f < EQ_LIMITS.fMin) {
    const span = EQ_LIMITS.fMin - GRID.fMin;
    return span > 0 ? smoothstep((f - GRID.fMin) / span) : 1;
  }
  if (f > EQ_LIMITS.fMax) {
    const span = GRID.fMax - EQ_LIMITS.fMax;
    return span > 0 ? smoothstep((GRID.fMax - f) / span) : 1;
  }
  return 1;
}

/** 求 (lo, hi) 频率区间内的算术平均偏差。 */
function avgInRange(arr, f, lo, hi) {
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] > lo && f[i] < hi) {
      sum += arr[i];
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 0;
}

/** 原地从 arr 减去 r（仅用于内部工作副本）。 */
function subtract(arr, r) {
  for (let i = 0; i < arr.length; i++) arr[i] -= r[i];
}

/** 判断 idx 是否与已用的峰值点过近（距离 < dist）。 */
function isNearUsed(i, used, dist) {
  for (let k = 0; k < used.length; k++) {
    if (Math.abs(i - used[k]) < dist) return true;
  }
  return false;
}

/* ----------------------------- 导出 API ----------------------------- */

/**
 * 创建一个 EQ 频段：生成唯一 id，套用默认值后合并 partial，最后按 EQ_LIMITS 钳制。
 * @param {Partial<Band>} [partial] 覆盖字段
 * @returns {Band} 全新的 Band 对象
 */
export function createBand(partial = {}) {
  const p = (partial && typeof partial === 'object') ? partial : {};
  const defaults = {
    id: makeId(),
    type: 'peaking',
    freq: 1000,
    gain: 0,
    q: 1.0,
    enabled: true,
  };
  return clampBand(Object.assign({}, defaults, p));
}

/**
 * 按 EQ_LIMITS 钳制 freq / gain / q，并规范 type、enabled、id。
 * 返回新对象，绝不修改入参。
 * @param {Band} band
 * @returns {Band} 钳制后的新对象
 */
export function clampBand(band) {
  const b = (band && typeof band === 'object') ? band : {};
  const type = (b.type === 'lowshelf' || b.type === 'highshelf') ? b.type : 'peaking';
  return {
    id: (typeof b.id === 'string' && b.id) ? b.id : makeId(),
    type,
    freq: clamp(finiteOr(b.freq, 1000), EQ_LIMITS.fMin, EQ_LIMITS.fMax),
    gain: clamp(finiteOr(b.gain, 0), EQ_LIMITS.gainMin, EQ_LIMITS.gainMax),
    q: clamp(finiteOr(b.q, 1.0), EQ_LIMITS.qMin, EQ_LIMITS.qMax),
    enabled: b.enabled === undefined ? true : !!b.enabled,
  };
}

/**
 * 用 RBJ Audio EQ Cookbook 的双二阶系数，在数字域 z=e^{jω}（ω=2πf/fs，fs=SAMPLE_RATE）
 * 求 |H(f)| 并转 dB。支持 peaking / lowshelf / highshelf 三类；
 * b0..b2 / a0..a2 统一先除以 a0 归一化，再以 cos/sin 展开复数比值（避免复数对象）。
 * band.enabled===false 或 gain≈0 时返回全 0 数组；结果全部为有限值；不修改入参。
 * @param {Band} band
 * @param {Float64Array} freqs 频率轴
 * @returns {Float64Array} 每个频点的幅频响应（dB）
 */
export function biquadMagnitudeDb(band, freqs) {
  const n = freqs.length;
  const out = new Float64Array(n);
  if (!band || band.enabled === false) return out;
  const g = finiteOr(band.gain, 0);
  if (Math.abs(g) < 1e-9) return out;

  const f0 = clamp(finiteOr(band.freq, 1000), 1, SAMPLE_RATE * 0.49);
  const w0 = 2 * Math.PI * f0 / SAMPLE_RATE;
  const c = Math.cos(w0);
  const s = Math.sin(w0);
  const A = Math.pow(10, g / 40);
  const sqrtA = Math.sqrt(A);
  const type = band.type;

  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowshelf' || type === 'highshelf') {
    // S=1 简化：alpha = sin(w0)/2 * sqrt((A + 1/A) + 2)
    const alpha = s / 2 * Math.sqrt((A + 1 / A) + 2);
    const beta = 2 * sqrtA * alpha;
    if (type === 'lowshelf') {
      b0 = A * ((A + 1) - (A - 1) * c + beta);
      b1 = 2 * A * ((A - 1) - (A + 1) * c);
      b2 = A * ((A + 1) - (A - 1) * c - beta);
      a0 = (A + 1) + (A - 1) * c + beta;
      a1 = -2 * ((A - 1) + (A + 1) * c);
      a2 = (A + 1) + (A - 1) * c - beta;
    } else {
      b0 = A * ((A + 1) + (A - 1) * c + beta);
      b1 = -2 * A * ((A - 1) + (A + 1) * c);
      b2 = A * ((A + 1) + (A - 1) * c - beta);
      a0 = (A + 1) - (A - 1) * c + beta;
      a1 = 2 * ((A - 1) - (A + 1) * c);
      a2 = (A + 1) - (A - 1) * c - beta;
    }
  } else {
    // peaking
    const q = clamp(finiteOr(band.q, 1.0), EQ_LIMITS.qMin, EQ_LIMITS.qMax);
    const alpha = s / (2 * q);
    b0 = 1 + alpha * A;
    b1 = -2 * c;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * c;
    a2 = 1 - alpha / A;
  }

  if (!Number.isFinite(a0) || Math.abs(a0) < 1e-15) return out;
  const B0 = b0 / a0;
  const B1 = b1 / a0;
  const B2 = b2 / a0;
  const A1 = a1 / a0;
  const A2 = a2 / a0;
  if (![B0, B1, B2, A1, A2].every(Number.isFinite)) return out;

  for (let i = 0; i < n; i++) {
    const f = finiteOr(freqs[i], 0);
    const w = 2 * Math.PI * f / SAMPLE_RATE;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const c2w = Math.cos(2 * w);
    const s2w = Math.sin(2 * w);
    // H(w) = (B0 + B1*e^{-jw} + B2*e^{-j2w}) / (1 + A1*e^{-jw} + A2*e^{-j2w})
    const nr = B0 + B1 * cw + B2 * c2w;
    const ni = -(B1 * sw + B2 * s2w);
    const dr = 1 + A1 * cw + A2 * c2w;
    const di = -(A1 * sw + A2 * s2w);
    const num = Math.sqrt(nr * nr + ni * ni);
    const den = Math.max(Math.sqrt(dr * dr + di * di), 1e-12);
    const mag = num / den;
    const v = 20 * Math.log10(mag + 1e-12);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * 各频段 dB 响应逐点相加，得到 EQ 总响应；不修改入参，结果保证有限。
 * @param {Band[]} bands
 * @param {Float64Array} freqs
 * @returns {Float64Array} 总响应（dB）
 */
export function totalEqResponseDb(bands, freqs) {
  const out = new Float64Array(freqs.length);
  if (!Array.isArray(bands)) return out;
  for (let k = 0; k < bands.length; k++) {
    const r = biquadMagnitudeDb(bands[k], freqs);
    for (let i = 0; i < out.length; i++) out[i] += r[i];
  }
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) out[i] = 0;
  }
  return out;
}

/**
 * 由「目标 - 实测」偏差曲线自动拟合参量 EQ。算法要点：
 *   1. 1/6 倍频程平滑，并把 30Hz 以下 / 18kHz 以上权重渐降到 0，得到有效目标 goal；
 *   2. 低(<120Hz)/高(>10kHz)端整体偏置超 2dB 时各放一个 shelf，减去其理论响应并占用名额；
 *   3. 剩余名额贪心放 peaking：找 |residual| 最大点 → 半高宽估 Q → gain 取 0.8 倍 → 减去响应；
 *      峰值 <0.4dB 提前停止，且与已用峰值点 idx 距离 <2 的候选跳过，避免重复堆叠；
 *   4. 4 轮增益最小二乘微调：s = Σ(e·r)/Σ(r²+1e-9)，gain += s*0.5，逐段后重算总响应；
 *   5. 过滤 |gain|<0.25dB 的弱段，按 freq 升序、限量 EQ_LIMITS.maxBands、保证 id 唯一。
 * 不修改 deltaDb / freqs，返回全新的 Band[]。
 * @param {Float64Array} deltaDb 已做参考带对齐的「目标 - 实测」偏差（dB）
 * @param {Float64Array} freqs 频率轴
 * @param {{ bandCount?: number, maxGain?: number }} [opts] 默认 { bandCount: 7, maxGain: 9 }
 * @returns {Band[]} 拟合得到的 EQ 频段列表
 */
export function solveEqBands(deltaDb, freqs, opts = {}) {
  const n = Math.min(deltaDb.length, freqs.length);
  // 工作副本：有限化，绝不改动入参
  const delta = new Float64Array(n);
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    delta[i] = Number.isFinite(deltaDb[i]) ? deltaDb[i] : 0;
    const fv = freqs[i];
    f[i] = (Number.isFinite(fv) && fv > 0) ? fv : 1;
  }

  const o = (opts && typeof opts === 'object') ? opts : {};
  const bandCount = clamp(Math.round(finiteOr(o.bandCount, 7)), 0, EQ_LIMITS.maxBands);
  const maxGain = clamp(finiteOr(o.maxGain, 9), 0, EQ_LIMITS.gainMax);
  if (n === 0 || bandCount === 0) return [];

  // 1) 平滑 + 边缘权重 → 有效目标 goal；residual 为其工作副本
  const smoothed = smoothLogLocal(f, delta, 6);
  const goal = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    goal[i] = smoothed[i] * bandEdgeWeight(f[i]);
  }
  const residual = new Float64Array(goal);
  const bands = [];
  let slots = bandCount;

  // 2) 低 / 高频端整体偏置 → shelf
  const lowAvg = avgInRange(residual, f, -Infinity, 120);
  const highAvg = avgInRange(residual, f, 10000, Infinity);
  if (Math.abs(lowAvg) > 2 && slots > 0) {
    const band = clampBand({
      type: 'lowshelf',
      freq: 80,
      gain: clamp(lowAvg * 0.7, -maxGain, maxGain),
      q: 0.7,
      enabled: true,
    });
    bands.push(band);
    slots--;
    subtract(residual, biquadMagnitudeDb(band, f));
  }
  if (Math.abs(highAvg) > 2 && slots > 0) {
    const band = clampBand({
      type: 'highshelf',
      freq: 10000,
      gain: clamp(highAvg * 0.7, -maxGain, maxGain),
      q: 0.7,
      enabled: true,
    });
    bands.push(band);
    slots--;
    subtract(residual, biquadMagnitudeDb(band, f));
  }

  // 3) 贪心放置 peaking
  const usedIdx = [];
  for (let iter = 0; iter < slots; iter++) {
    let bestIdx = -1;
    let bestAbs = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(residual[i]);
      if (a > bestAbs && !isNearUsed(i, usedIdx, 2)) {
        bestAbs = a;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestAbs < 0.4) break;
    usedIdx.push(bestIdx);

    // 向左右走到 residual 降到峰值一半处，得到 fLo / fHi
    const peakVal = residual[bestIdx];
    const halfAbs = Math.abs(peakVal) * 0.5;
    let lo = bestIdx;
    let hi = bestIdx;
    while (lo > 0 && residual[lo - 1] * peakVal > 0 && Math.abs(residual[lo - 1]) >= halfAbs) lo--;
    while (hi < n - 1 && residual[hi + 1] * peakVal > 0 && Math.abs(residual[hi + 1]) >= halfAbs) hi++;

    const fc = f[bestIdx];
    const bw = Math.max(f[hi] - f[lo], 1e-6);
    const q = clamp(fc / bw, 0.6, 5);
    const band = clampBand({
      type: 'peaking',
      freq: fc,
      gain: clamp(peakVal * 0.8, -maxGain, maxGain),
      q,
      enabled: true,
    });
    bands.push(band);
    subtract(residual, biquadMagnitudeDb(band, f));
  }

  // 4) 4 轮增益最小二乘微调
  for (let round = 0; round < 4; round++) {
    let totalEq = totalEqResponseDb(bands, f);
    for (let k = 0; k < bands.length; k++) {
      const band = bands[k];
      const r = biquadMagnitudeDb(band, f);
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        const e = goal[i] - totalEq[i];
        num += e * r[i];
        den += r[i] * r[i] + 1e-9;
      }
      const sRaw = den > 0 ? num / den : 0;
      const s = Number.isFinite(sRaw) ? clamp(sRaw, -2, 2) : 0;
      bands[k] = clampBand(Object.assign({}, band, {
        gain: clamp(band.gain + s * 0.5, -EQ_LIMITS.gainMax, EQ_LIMITS.gainMax),
      }));
      totalEq = totalEqResponseDb(bands, f);
    }
  }

  // 5) 过滤弱段、按频率升序、限量、保证 id 唯一
  const seen = new Set();
  return bands
    .filter((b) => Math.abs(b.gain) >= 0.25)
    .sort((a, b) => a.freq - b.freq)
    .slice(0, EQ_LIMITS.maxBands)
    .map((b) => {
      let id = b.id;
      while (!id || seen.has(id)) id = makeId();
      seen.add(id);
      return id === b.id ? b : Object.assign({}, b, { id });
    });
}

/**
 * 在 100Hz–12kHz 内计算 (delta - eq) 的 RMS（dB），供 UI 显示「拟合误差」。
 * 不修改入参；区间内无有效频点时返回 0。
 * @param {Float64Array} deltaDb 目标 - 实测 偏差
 * @param {Float64Array} eqDb EQ 总响应
 * @param {Float64Array} freqs 频率轴
 * @returns {number} 加权 RMS 误差（dB），恒为有限值
 */
export function eqErrorRms(deltaDb, eqDb, freqs) {
  const n = Math.min(deltaDb.length, eqDb.length, freqs.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    if (!Number.isFinite(f) || f < 100 || f > 12000) continue;
    const d = Number.isFinite(deltaDb[i]) ? deltaDb[i] : 0;
    const e = Number.isFinite(eqDb[i]) ? eqDb[i] : 0;
    const r = d - e;
    sum += r * r;
    cnt++;
  }
  const v = cnt > 0 ? Math.sqrt(sum / cnt) : 0;
  return Number.isFinite(v) ? v : 0;
}
