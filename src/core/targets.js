/**
 * 【户部】目标曲线数据模块
 * ---------------------------------------------------------------------------
 * 提供若干「近似参考形状」的目标频响控制点，以及采样 / 归一化工具。
 * 所有曲线均为相对 dB，未经官方数据校准，仅用于形状对比与调音参考。
 * 纯 ES module、具名导出、无副作用；不修改任何入参数组，返回值均为新数组。
 */
import { GRID, REF_BAND } from '../contracts.js';

/**
 * 目标曲线清单。points 为 [频率Hz, 相对dB] 控制点，按频率升序；
 * 采样时带外以端点值做常数外推。全部为近似参考形状，非官方精确数据。
 * @type {Array<{ id: string, name: string, description: string, points: Array<[number, number]> }>}
 */
export const TARGETS = [
  {
    id: 'flat',
    name: '平直 Flat',
    description: '全频段 0 dB 的理想平直参考线。近似参考形状，非官方精确数据；适用于追求中性无染色的监听对比与测量基准。',
    points: [
      [GRID.fMin, 0], [50, 0], [200, 0], [1000, 0], [5000, 0], [GRID.fMax, 0],
    ],
  },
  {
    id: 'harman-speaker',
    name: 'Harman 室内音箱',
    description: 'Harman 室内音箱优选频响的近似形状：低频轻微抬升、高频平缓滚降。近似参考形状，非官方精确数据；适用于书架箱 / 落地箱在普通房间的外放调音参考。',
    points: [
      [20, 3], [60, 2.6], [120, 1.8], [250, 0.8], [500, 0.15], [1000, 0],
      [2000, -0.5], [4000, -1.5], [8000, -3.2], [12000, -4.5], [16000, -5.6], [20000, -6.5],
    ],
  },
  {
    id: 'harman-headphone',
    name: 'Harman OE 2018 耳机',
    description: 'Harman OE 2018 头戴耳机目标的近似形状：低频 shelf 抬升、3kHz 附近抬升、高频滚降。近似参考形状，非官方精确数据；仅作听感形状对比参考，并非音箱外放测量基准。',
    points: [
      [20, 5.5], [40, 5.6], [80, 5.2], [150, 3.6], [300, 1.2], [600, 0], [1000, 0],
      [1800, 0.6], [3000, 3.0], [4200, 1.6], [6000, 0], [9000, -1.2], [12000, -3],
      [16000, -5], [20000, -7],
    ],
  },
  {
    id: 'warm',
    name: '暖声 Warm',
    description: '低频温和抬升约 +2.5dB、2kHz 以上缓慢衰减约 -2dB 的暖声倾向。近似参考形状，非官方精确数据；适用于人声 / 流行乐的耐听调音。',
    points: [
      [20, 2.5], [60, 2.5], [120, 2.3], [250, 1.3], [500, 0.5], [1000, 0],
      [2000, -0.3], [4000, -1.0], [8000, -1.7], [16000, -2.0], [20000, -2.0],
    ],
  },
  {
    id: 'vocal',
    name: '人声 Vocal',
    description: '1–4kHz 中频抬升约 +2dB、两端轻微下降的清晰度倾向。近似参考形状，非官方精确数据；适用于语音播客 / 人声为主的场景。',
    points: [
      [20, -1.0], [60, -0.8], [200, -0.5], [500, -0.2], [1000, 0.8], [2000, 2.0],
      [3000, 2.0], [4000, 1.2], [6000, 0], [10000, -0.6], [16000, -1.0], [20000, -1.2],
    ],
  },
];

/** 有限数保护：非有限值回退到 fallback。 */
function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 低频 shelf 权重 w(f)：f<=80Hz 为 1、f>=500Hz 为 0，中间用 smoothstep 平滑过渡。
 * 过渡在 log10(频率) 域进行，与整体对数插值保持一致。
 */
function bassWeight(f) {
  if (f <= 80) return 1;
  if (f >= 500) return 0;
  const lo = Math.log10(80);
  const hi = Math.log10(500);
  const t = (Math.log10(f) - lo) / (hi - lo);
  const s = t * t * (3 - 2 * t);
  return 1 - s;
}

/**
 * 按 id 取目标元数据；未知 id 回退到 flat。
 * 返回浅拷贝对象，避免外部改动污染全局清单。
 * @param {string} id 目标 id
 * @returns {{ id: string, name: string, description: string, points: Array<[number, number]> }}
 */
export function getTargetMeta(id) {
  const t = TARGETS.find((item) => item.id === id) || TARGETS[0];
  return { id: t.id, name: t.name, description: t.description, points: t.points };
}

/**
 * 采样目标曲线：在 log10(频率) 域对控制点做线性插值（带外端点常数外推），
 * 再叠加两项修饰：
 *   - tilt: db += tiltDbPerOct * log2(f/1000)，以 1kHz 为轴；
 *   - bass: db += bassDb * w(f)，w(f) 见 bassWeight。
 * 最后调用 normalizeTarget 整体平移到参考带均值 0 dB。不修改任何入参。
 * @param {string} id 目标 id，未知时回退 flat
 * @param {Float64Array} freqs 频率轴
 * @param {{ tiltDbPerOct?: number, bassDb?: number }} [opts] 倾斜与低频修饰
 * @returns {Float64Array} 新的目标曲线（dB）
 */
export function sampleTarget(id, freqs, opts = {}) {
  const meta = getTargetMeta(id);
  const points = meta.points;
  const o = (opts && typeof opts === 'object') ? opts : {};
  const tilt = finiteOr(o.tiltDbPerOct, 0);
  const bass = finiteOr(o.bassDb, 0);

  const m = points.length;
  const lf = new Float64Array(m);
  const lv = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    lf[k] = Math.log10(Math.max(finiteOr(points[k][0], 1), 1e-6));
    lv[k] = finiteOr(points[k][1], 0);
  }

  const n = freqs.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = Math.max(finiteOr(freqs[i], 1), 1e-6);
    const x = Math.log10(f);
    let base;
    if (m === 0) {
      base = 0;
    } else if (x <= lf[0]) {
      base = lv[0];
    } else if (x >= lf[m - 1]) {
      base = lv[m - 1];
    } else {
      let lo = 0;
      let hi = m - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (lf[mid] <= x) lo = mid; else hi = mid;
      }
      const span = lf[hi] - lf[lo];
      const t = span > 0 ? (x - lf[lo]) / span : 0;
      base = lv[lo] + t * (lv[hi] - lv[lo]);
    }
    const v = base + tilt * Math.log2(f / 1000) + bass * bassWeight(f);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return normalizeTarget(out, freqs);
}

/**
 * 把目标曲线整体平移，使 300–3000Hz 参考带（REF_BAND）内均值为 0 dB。
 * 不修改入参，返回新的 Float64Array；无有效参考点时按 0 偏移处理。
 * @param {Float64Array} db 原始曲线 dB
 * @param {Float64Array} freqs 频率轴
 * @returns {Float64Array} 归一化后的新曲线（dB）
 */
export function normalizeTarget(db, freqs) {
  const n = Math.min(db.length, freqs.length);
  const out = new Float64Array(db.length);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    if (Number.isFinite(f) && f >= REF_BAND.lo && f <= REF_BAND.hi && Number.isFinite(db[i])) {
      sum += db[i];
      cnt++;
    }
  }
  const offset = cnt > 0 ? sum / cnt : 0;
  for (let i = 0; i < out.length; i++) {
    const v = Number.isFinite(db[i]) ? db[i] - offset : 0;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}
