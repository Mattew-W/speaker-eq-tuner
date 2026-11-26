/**
 * 【户部】10 段图形 EQ 模块
 * ---------------------------------------------------------------------------
 * 设备 / 播放器自带的「图形均衡器」只有 10 个固定中心频率
 * （32/64/125/250/500 Hz、1/2/4/8/16 kHz）与 ±10 dB 行程，
 * 无法承接任意中心频率 + 任意 Q 的参量 EQ 结果。
 *
 * 本模块把「目标 - 实测」偏差曲线投影到这条固定频率栅格上：
 *   1. 1/6 倍频程平滑，并把 30 Hz 以下 / 18 kHz 以上的目标权重平滑降为 0；
 *   2. 用 gain=6 的 peaking 滤波器求响应再除以 6，得到 10 条「单位增益响应形状」R_k(f)；
 *   3. 以加权最小二乘 + ridge 正则解正规方程 (RᵀWR + λI)·g = RᵀW·goal，
 *      用带部分主元的高斯消元求 10×10 线性系统；
 *   4. 按各段行程与「提升可靠性」限幅，并用 Lawson 投影法迭代 3 轮再平衡；
 *   5. 固定返回 10 个 Band（不做 0 dB 过滤），供 UI 渲染 10 条固定推子。
 *
 * 纯 ES module、具名导出、无全局副作用、无 console 输出；
 * 绝不修改入参数组 / 对象，所有返回值均为有限值（无 NaN / Infinity）。
 */
import { EQ_LIMITS, SAMPLE_RATE } from '../contracts.js';
import { biquadMagnitudeDb, clampBand, createBand } from './eq-solver.js';
import { smoothLogCurve } from './dsp.js';

/* ----------------------------- 对外常量 ----------------------------- */

/** 10 段图形 EQ 的中心频率（Hz），与主流系统「图形均衡器」一致 */
export const GRAPHIC_FREQS = Object.freeze([32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

/** 每段固定 Q：1 个倍频程带宽（相邻段正好相差约 1 octave，Q=1.41 为标准 octave 常数） */
export const GRAPHIC_Q = 1.41;

/** 图形 EQ 单段增益上限（dB），对应系统 EQ 的 ±10 dB 行程 */
export const GRAPHIC_GAIN_MAX = 10;

/** 段数（= 栅格长度），内部循环上限 */
const K = GRAPHIC_FREQS.length;

/** 实际可用的增益行程：与契约边界取交集，保证结果一定能被 clampBand 原样接受 */
const GAIN_LO = Math.max(-GRAPHIC_GAIN_MAX, EQ_LIMITS.gainMin);
const GAIN_HI = Math.min(GRAPHIC_GAIN_MAX, EQ_LIMITS.gainMax);

/** 边缘衰减区间（Hz）：低于 LO_EDGE_LO 或高于 HI_EDGE_HI 的目标权重为 0 */
const LO_EDGE_LO = 20;
const LO_EDGE_HI = 30;
const HI_EDGE_LO = 18000;
const HI_EDGE_HI = 20000;

/* ----------------------------- 内部工具 ----------------------------- */

/** 有限数保护；非有限值回退到 fallback。 */
function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** 数值钳制；非有限输入回退到下界，避免 NaN 扩散。 */
function clampNum(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : (v > hi ? hi : v);
}

/** smoothstep：把 [0,1] 映射为平滑 S 形过渡（超界自动截断）。 */
function smoothstep(t) {
  const x = t < 0 ? 0 : (t > 1 ? 1 : t);
  return x * x * (3 - 2 * x);
}

/**
 * 目标曲线在频带边缘的权重：30 Hz 以下、18 kHz 以上平滑渐降到 0。
 * 超出 20 Hz–20 kHz 的频点权重为 0。
 * @param {number} f 频率 Hz
 * @returns {number} 权重 0..1
 */
function edgeWeight(f) {
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (f < LO_EDGE_HI) return smoothstep((f - LO_EDGE_LO) / (LO_EDGE_HI - LO_EDGE_LO));
  if (f > HI_EDGE_LO) return smoothstep((HI_EDGE_HI - f) / (HI_EDGE_HI - HI_EDGE_LO));
  return 1;
}

/**
 * 第 k 段的提升上限（dB）。衰减方向统一允许到 -GRAPHIC_GAIN_MAX。
 *  - 32 Hz / 64 Hz：小扬声器补不回来，最多 min(maxBoost, 3) dB；
 *  - 16 kHz：麦克风与单元响应不可信，不允许提升；
 *  - 其余：maxBoost。
 * @param {number} k 段索引 0..9
 * @param {number} maxBoost 全局提升上限
 * @returns {number} 提升上限（>= 0）
 */
function boostCap(k, maxBoost) {
  if (k >= K - 1) return 0;
  if (k <= 1) return Math.min(maxBoost, 3);
  return maxBoost;
}

/**
 * 带部分主元的高斯-约当消元解 m×m 线性系统 A·x = b。
 * A / b 均为行优先的紧凑数组（A 长度 m*m），不修改入参。
 * @param {Float64Array} Ain 系数矩阵（行优先，m*m）
 * @param {Float64Array} bin 右端向量（m）
 * @param {number} m 维数
 * @returns {Float64Array|null} 解向量；奇异或出现非有限值时返回 null
 */
function solveLinearSystem(Ain, bin, m) {
  if (m <= 0) return new Float64Array(0);
  const w = m + 1;
  const M = new Float64Array(m * w);
  for (let r = 0; r < m; r++) {
    const src = r * m;
    const dst = r * w;
    for (let c = 0; c < m; c++) M[dst + c] = Ain[src + c];
    M[dst + m] = bin[r];
  }

  for (let col = 0; col < m; col++) {
    // 部分主元：选本列绝对值最大的行
    let piv = col;
    let best = Math.abs(M[col * w + col]);
    for (let r = col + 1; r < m; r++) {
      const v = Math.abs(M[r * w + col]);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (!(best > 1e-12)) return null; // 列近似为零 => 奇异
    if (piv !== col) {
      for (let c = col; c < w; c++) {
        const t = M[col * w + c];
        M[col * w + c] = M[piv * w + c];
        M[piv * w + c] = t;
      }
    }
    const d = M[col * w + col];
    if (!Number.isFinite(d) || Math.abs(d) < 1e-15) return null;
    for (let c = col; c < w; c++) M[col * w + c] /= d;
    // 消去其余各行的该列（Gauss-Jordan，便于直接读解）
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const factor = M[r * w + col];
      if (factor === 0) continue;
      for (let c = col; c < w; c++) M[r * w + c] -= factor * M[col * w + c];
    }
  }

  const x = new Float64Array(m);
  for (let r = 0; r < m; r++) {
    const v = M[r * w + m];
    if (!Number.isFinite(v)) return null;
    x[r] = v;
  }
  return x;
}

/**
 * 在给定「自由段集合」上求解加权最小二乘正规方程。
 * 目标为 residualGoal（已扣除已固定段的贡献），权重为 wgt。
 * ridge 系数 λ = 0.05 * mean(diag(A))，保证低频段共线性时不奇异。
 * @param {Float64Array[]} R 单位增益响应形状（K 条，每条长 n）
 * @param {Float64Array} wgt 逐频点权重（平方后进入正规方程）
 * @param {Float64Array} residualGoal 残差目标
 * @param {number[]} free 自由段索引
 * @returns {Float64Array|null} 自由段增益（长度 = free.length）；失败返回 null
 */
function solveNormalEquations(R, wgt, residualGoal, free) {
  const m = free.length;
  if (m === 0) return new Float64Array(0);
  const n = residualGoal.length;

  // A[a][c] = Σ w²·R_a·R_c    b[a] = Σ w²·R_a·residualGoal
  const A = new Float64Array(m * m);
  const b = new Float64Array(m);
  for (let a = 0; a < m; a++) {
    const Ra = R[free[a]];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const wa = wgt[i];
      if (wa === 0) continue;
      const ra = Ra[i] * wa;
      acc += ra * residualGoal[i] * wa;
      for (let c = a; c < m; c++) {
        A[a * m + c] += ra * R[free[c]][i] * wa;
      }
    }
    b[a] = acc;
  }
  // 利用对称性补齐下三角
  for (let a = 0; a < m; a++) {
    for (let c = 0; c < a; c++) A[a * m + c] = A[c * m + a];
  }

  // ridge 正则
  let diagSum = 0;
  for (let a = 0; a < m; a++) diagSum += A[a * m + a];
  const lambda = 0.05 * (diagSum / m);
  const reg = Number.isFinite(lambda) && lambda > 0 ? lambda : 1e-6;
  for (let a = 0; a < m; a++) A[a * m + a] += reg;

  return solveLinearSystem(A, b, m);
}

/**
 * 生成 10 个初始频段：全部 0 dB，按频率升序，type 全为 'peaking'。
 * @returns {Band[]} 长度恰为 10 的 Band 数组
 */
export function createGraphicBands() {
  const out = [];
  const seen = new Set();
  for (let k = 0; k < K; k++) {
    let band = createBand({
      type: 'peaking',
      freq: GRAPHIC_FREQS[k],
      gain: 0,
      q: GRAPHIC_Q,
      enabled: true,
    });
    while (!band.id || seen.has(band.id)) {
      band = createBand({
        type: 'peaking',
        freq: GRAPHIC_FREQS[k],
        gain: 0,
        q: GRAPHIC_Q,
        enabled: true,
      });
    }
    seen.add(band.id);
    out.push(band);
  }
  return out;
}

/**
 * 求与给定频率最接近的那一段的索引（对数频率距离）。
 * 非法输入（非有限数 / <= 0）返回 5，即 1 kHz 段，作为安全默认档位。
 * @param {number} freq 频率 Hz
 * @returns {number} 0..9
 */
export function snapGraphicIndex(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return 5;
  let best = 0;
  let bestDist = Infinity;
  for (let k = 0; k < K; k++) {
    const dist = Math.abs(Math.log2(freq) - Math.log2(GRAPHIC_FREQS[k]));
    if (dist < bestDist) {
      bestDist = dist;
      best = k;
    }
  }
  return best;
}

/**
 * 由「目标 - 实测」偏差曲线自动拟合 10 段固定频率的增益。
 *
 * 算法：1/6 倍频程平滑 → 边缘权重渐降 → 10 条单位增益响应形状基函数 →
 * 加权最小二乘 + ridge 正则（高斯消元）→ 逐段行程限幅 →
 * 3 轮 Lawson 投影再平衡（固定超限段、对残差目标重解）。
 *
 * 任何非法入参都安全退化为「10 段全 0 dB」，绝不抛异常；
 * 不修改 deltaDb / freqs。
 *
 * @param {Float64Array} deltaDb 目标 - 实测 偏差（dB），与 freqs 等长
 * @param {Float64Array} freqs 对数频率轴（约 20 Hz–20 kHz）
 * @param {{ sampleRate?: number, maxBoost?: number }} [opts] 默认 { sampleRate: 48000, maxBoost: 4 }
 * @returns {Band[]} 恰好 10 个 Band，freq/q 固定，gain 保留 1 位小数
 */
export function solveGraphicBands(deltaDb, freqs, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const sampleRate = (Number.isFinite(o.sampleRate) && o.sampleRate > 0) ? o.sampleRate : SAMPLE_RATE;
  const maxBoost = clampNum(finiteOr(o.maxBoost, 4), 0, GRAPHIC_GAIN_MAX);

  // ---- 入参校验：任何异常都退化为 10 段全 0 dB ----
  if (!deltaDb || !freqs || typeof deltaDb.length !== 'number' || typeof freqs.length !== 'number') {
    return createGraphicBands();
  }
  const n = Math.min(deltaDb.length, freqs.length);
  if (n < 4) return createGraphicBands();

  // ---- 工作副本：有限化，绝不改动入参 ----
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  let lastGood = LO_EDGE_LO;
  for (let i = 0; i < n; i++) {
    const fv = freqs[i];
    const ok = Number.isFinite(fv) && fv > 0;
    if (ok) lastGood = fv;
    f[i] = ok ? fv : lastGood;
    d[i] = Number.isFinite(deltaDb[i]) ? deltaDb[i] : 0;
  }

  // ---- 1) 平滑 + 边缘权重 → 有效目标 goal；wgt 标记参与拟合的频点 ----
  const smoothed = smoothLogCurve(f, d, 6);
  const goal = new Float64Array(n);
  const wgt = new Float64Array(n);
  const fNyq = sampleRate * 0.49;
  for (let i = 0; i < n; i++) {
    const fv = f[i];
    const w = edgeWeight(fv);
    const inRange = fv > 0 && fv < fNyq;
    goal[i] = Number.isFinite(smoothed[i]) ? smoothed[i] * w : 0;
    wgt[i] = inRange ? 1 : 0;
  }

  // ---- 2) 基函数矩阵：10 次 biquadMagnitudeDb，单位增益响应形状 ----
  const R = new Array(K);
  for (let k = 0; k < K; k++) {
    const probe = {
      id: 'probe_' + k,
      type: 'peaking',
      freq: GRAPHIC_FREQS[k],
      gain: 6,
      q: GRAPHIC_Q,
      enabled: true,
    };
    const raw = biquadMagnitudeDb(probe, f, sampleRate);
    const shape = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = raw[i] / 6;
      shape[i] = Number.isFinite(v) ? v : 0;
    }
    R[k] = shape;
  }

  // ---- 3) 迭代：全自由解一次，再做 3 轮 Lawson 投影再平衡 ----
  const g = new Float64Array(K);
  const fixed = new Uint8Array(K); // 0 = 自由，1 = 已固定在上/下限
  const contrib = new Float64Array(n); // 已固定段的总贡献
  let anySolved = false;

  const MAX_ROUNDS = 4; // 1 次初始解 + 3 次再平衡
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 残差目标 = goal - 已固定段贡献
    const residualGoal = new Float64Array(n);
    for (let i = 0; i < n; i++) residualGoal[i] = goal[i] - contrib[i];

    const free = [];
    for (let k = 0; k < K; k++) if (!fixed[k]) free.push(k);
    if (free.length === 0) break;

    const sol = solveNormalEquations(R, wgt, residualGoal, free);
    if (!sol || sol.length !== free.length) break; // 奇异 → 保留上一轮结果收尾
    anySolved = true;

    // 写回自由段，并检出越界
    let violation = false;
    const clipped = new Float64Array(free.length);
    for (let a = 0; a < free.length; a++) {
      const k = free[a];
      const up = boostCap(k, maxBoost);
      let val = Number.isFinite(sol[a]) ? sol[a] : 0;
      if (val > up) {
        val = up;
        violation = true;
      } else if (val < GAIN_LO) {
        val = GAIN_LO;
        violation = true;
      }
      clipped[a] = val;
    }

    // 提交本轮结果
    for (let a = 0; a < free.length; a++) g[free[a]] = clipped[a];

    if (!violation) break;

    // 把触界段固定，更新其贡献（其余段在下一轮对残差重解）
    contrib.fill(0);
    for (let a = 0; a < free.length; a++) {
      const k = free[a];
      const up = boostCap(k, maxBoost);
      if (g[k] >= up - 1e-9 || g[k] <= GAIN_LO + 1e-9) fixed[k] = 1;
    }
    for (let k = 0; k < K; k++) {
      if (!fixed[k]) continue;
      const Rk = R[k];
      const gk = g[k];
      if (gk === 0) continue;
      for (let i = 0; i < n; i++) contrib[i] += gk * Rk[i];
    }
  }

  // ---- 4) 收尾：未收敛则直接钳制；逐段限幅并保留 1 位小数 ----
  const bands = [];
  for (let k = 0; k < K; k++) {
    let v = anySolved ? g[k] : 0;
    if (!Number.isFinite(v)) v = 0;
    const up = boostCap(k, maxBoost);
    v = clampNum(v, GAIN_LO, up);
    let gain = Math.round(v * 10) / 10;
    if (!Number.isFinite(gain)) gain = 0;
    if (Object.is(gain, -0)) gain = 0;
    gain = clampNum(gain, GAIN_LO, up);

    bands.push(clampBand({
      type: 'peaking',
      freq: GRAPHIC_FREQS[k],
      gain,
      q: GRAPHIC_Q,
      enabled: true,
    }));
  }

  return bands;
}
