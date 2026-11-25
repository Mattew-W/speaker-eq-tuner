/**
 * 吏部 · DSP 核心模块
 * 纯原生 ES module + TypedArray 实现：FFT / 对数网格 / 窗函数 / 测试信号 /
 * Welch 功率谱 / 扫频解卷积 IR / 曲线平滑与映射 / 电平对齐。
 * 所有 TypedArray 输出保证为有限值（无 NaN / Infinity）。
 */
import { GRID, REF_BAND, SAMPLE_RATE } from '../contracts.js';

/** FFT / 相关 / 解卷积的点数上限（2^21），用于控制内存占用。 */
const MAX_FFT = 1 << 21;

/** 把任意数值收敛为有限值，非法输入（NaN/Inf/undefined）一律归零。 */
function _finite(v) {
  return Number.isFinite(v) ? v : 0;
}

/** 在非降序数组 arr 上二分，返回第一个满足 arr[i] >= v 的下标。 */
function _lowerBound(arr, n, v) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 构造长度不足 / 参数非法时的安全退化结果，所有字段均为有限值。 */
function _degenerate(sr) {
  const m = 1024;
  const bins = (m >> 1) + 1;
  const freqs = new Float64Array(bins);
  const db = new Float64Array(bins);
  for (let k = 0; k < bins; k++) freqs[k] = k * sr / m;
  const ir = new Float32Array(m);
  ir[0] = 1;
  return { ir, delaySamples: 0, freqs, db, peakDb: 0 };
}

/** 互相关求时延：R = IFFT(FFT(rec) * conj(FFT(chirp)))，取 |R| 峰值。 */
function _estimateDelay(recorded, chirp, recLen, chirpLen) {
  const need = recLen + chirpLen - 1;
  let n = Math.min(nextPow2(need), MAX_FFT);
  if (n < 2) n = 2;
  const fft = new FFT(n);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  const copyR = Math.min(recLen, n);
  const copyC = Math.min(chirpLen, n);
  for (let i = 0; i < copyR; i++) ar[i] = _finite(recorded[i]);
  for (let i = 0; i < copyC; i++) br[i] = _finite(chirp[i]);
  fft.forward(ar, ai);
  fft.forward(br, bi);
  // ar * conj(br)：(a+bi)(c-di) = (ac+bd) + i(bc-ad)
  for (let k = 0; k < n; k++) {
    const a = ar[k], b = ai[k], c = br[k], d = bi[k];
    ar[k] = a * c + b * d;
    ai[k] = b * c - a * d;
  }
  fft.inverse(ar, ai); // 未缩放，不影响峰值位置
  let best = 0;
  let bestMag = -1;
  for (let k = 0; k < n; k++) {
    const mag = ar[k] * ar[k] + ai[k] * ai[k];
    if (mag > bestMag) { bestMag = mag; best = k; }
  }
  return clamp(best, 0, Math.max(0, recLen - 1));
}

/** 返回 >= n 的最小 2 的幂；n<=1 或非有限值返回 1。 */
export function nextPow2(n) {
  if (!Number.isFinite(n) || n <= 1) return 1;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** 生成对数频率网格 freqs[i]=fMin*2^(i/ppOct)，保留所有 <= fMax 的点，默认取 GRID。 */
export function createLogGrid(fMin = GRID.fMin, fMax = GRID.fMax, ppOct = GRID.ppOct) {
  const lo = (Number.isFinite(fMin) && fMin > 0) ? fMin : GRID.fMin;
  const hi = (Number.isFinite(fMax) && fMax > lo) ? fMax : lo * 2;
  const ppo = (Number.isFinite(ppOct) && ppOct > 0) ? ppOct : GRID.ppOct;
  const eps = 1 + 1e-12;
  const maxPts = 1 << 20;
  let n = 0;
  for (let i = 0; i < maxPts; i++) {
    if (lo * Math.pow(2, i / ppo) > hi * eps) break;
    n++;
  }
  if (n < 1) n = 1;
  const freqs = new Float64Array(n);
  for (let i = 0; i < n; i++) freqs[i] = lo * Math.pow(2, i / ppo);
  return { freqs, n };
}

/** 周期 Hann 窗 w[i]=0.5-0.5*cos(2πi/n)。 */
export function hann(n) {
  const N = (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
  const w = new Float64Array(N);
  if (N === 0) return w;
  const c = 2 * Math.PI / N;
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(c * i);
  return w;
}

/** Tukey 窗：前后各 r/2 比例用 raised-cosine 渐变，中间恒为 1。 */
export function tukey(n, r) {
  const N = (Number.isFinite(n) && n > 0) ? Math.floor(n) : 0;
  const w = new Float64Array(N);
  if (N === 0) return w;
  const alpha = clamp(Number.isFinite(r) ? r : 0, 0, 1);
  const p = alpha * N / 2;
  if (p <= 0) { w.fill(1); return w; }
  for (let i = 0; i < N; i++) {
    if (i < p) {
      w[i] = 0.5 * (1 - Math.cos(Math.PI * i / p));
    } else if (i > N - 1 - p) {
      w[i] = 0.5 * (1 - Math.cos(Math.PI * (N - 1 - i) / p));
    } else {
      w[i] = 1;
    }
  }
  return w;
}

/** Farina 对数扫频 x(t)=sin(K*(exp(L*t/T)-1))，f2 clamp 到 <0.48*sr，首尾 raised-cosine 淡入淡出。 */
export function generateLogChirp(sampleRate, durationSec, f1 = 20, f2 = 20000, fadeSec = 0.02) {
  const sr = (Number.isFinite(sampleRate) && sampleRate > 0) ? sampleRate : SAMPLE_RATE;
  const T = (Number.isFinite(durationSec) && durationSec > 0) ? durationSec : 0;
  const N = Math.max(0, Math.floor(T * sr));
  const out = new Float32Array(N);
  if (N === 0) return out;
  const lo = (Number.isFinite(f1) && f1 > 0) ? f1 : 20;
  const maxF2 = sr * 0.48;
  let hi = (Number.isFinite(f2) && f2 > 0) ? f2 : 20000;
  if (hi >= maxF2) hi = maxF2 * (1 - 1e-6); // 严格小于 0.48*sr
  if (hi <= lo) hi = lo * 1.001;             // 保证 L>0，避免除零
  const L = Math.log(hi / lo);
  const K = 2 * Math.PI * lo * T / L;
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    out[i] = Math.sin(K * (Math.exp(L * t / T) - 1));
  }
  const fadeN = Math.min(
    Math.max(0, Math.floor((Number.isFinite(fadeSec) ? fadeSec : 0.02) * sr)),
    N >> 1,
  );
  for (let i = 0; i < fadeN; i++) {
    const w = 0.5 * (1 - Math.cos(Math.PI * i / fadeN));
    out[i] *= w;
    out[N - 1 - i] *= w;
  }
  return out;
}

/** Paul Kellet 一阶滤波器组近似粉噪，白噪声源为可复现 xorshift32，峰值归一化到 ±0.9。 */
export function generatePinkNoise(sampleRate, durationSec, seed = 1) {
  const sr = (Number.isFinite(sampleRate) && sampleRate > 0) ? sampleRate : SAMPLE_RATE;
  const T = (Number.isFinite(durationSec) && durationSec > 0) ? durationSec : 0;
  const N = Math.max(0, Math.floor(T * sr));
  const out = new Float32Array(N);
  if (N === 0) return out;
  let s = (Number.isFinite(seed) ? (seed >>> 0) : 1) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let peak = 0;
  for (let i = 0; i < N; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    const white = s / 2147483648 - 1; // [-1, 1)
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    out[i] = _finite(p);
    const a = Math.abs(p);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = 0.9 / peak;
    for (let i = 0; i < N; i++) out[i] *= g;
  }
  return out;
}

/** 迭代基-2 Cooley-Tukey FFT；forward 为标准 DFT，inverse 用 twiddle 符号取反且不缩放 1/n。 */
export class FFT {
  /** 构造 n 点 FFT，预计算位反转表与 twiddle 表；n 必须为 2 的幂且 >=2。 */
  constructor(n) {
    if (!Number.isInteger(n) || n < 2 || !Number.isInteger(Math.log2(n))) {
      throw new Error('FFT size must be a power of two >= 2');
    }
    this.n = n;
    const bits = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>>= 1; }
      rev[i] = r;
    }
    this.rev = rev;
    const half = n >> 1;
    const cosT = new Float64Array(half);
    const sinT = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const ang = 2 * Math.PI * k / n;
      cosT[k] = Math.cos(ang);
      sinT[k] = Math.sin(ang);
    }
    this.cosT = cosT;
    this.sinT = sinT;
  }

  /** 原地复数变换：dir=-1 为 forward，dir=+1 为 inverse（符号取反，不做 1/n 缩放）。 */
  _transform(re, im, dir) {
    const n = this.n;
    const rev = this.rev;
    const cosT = this.cosT;
    const sinT = this.sinT;
    if (!re || !im || re.length !== n || im.length !== n) {
      throw new Error('FFT buffers must be length-n Float64Array pairs');
    }
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const halfSize = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const k = j * step;
          const wr = cosT[k];
          const wi = dir * sinT[k];
          const a = i + j;
          const b = a + halfSize;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] = re[a] + tr;
          im[a] = im[a] + ti;
        }
      }
    }
  }

  /** 原地正向 DFT（未缩放）。 */
  forward(re, im) {
    this._transform(re, im, -1);
  }

  /** 原地逆向 DFT（未缩放，调用方需自行除以 n）。 */
  inverse(re, im) {
    this._transform(re, im, +1);
  }
}

/** Welch 平均功率谱：Hann 窗 + 分段 FFT + |X|² 平均，返回单边 0..Nyquist 的 dB。 */
export function welchPSD(signal, sampleRate, fftSize = 8192, overlap = 0.5) {
  const sr = (Number.isFinite(sampleRate) && sampleRate > 0) ? sampleRate : SAMPLE_RATE;
  const len = (signal && signal.length) ? signal.length : 0;
  let n = Math.max(1024, nextPow2(Number.isFinite(fftSize) ? fftSize : 8192));
  let singleSegment = false;
  if (len < n) {
    n = Math.max(1024, nextPow2(Math.max(1, len)));
    singleSegment = true;
  }
  const win = hann(n);
  const bins = (n >> 1) + 1;
  const power = new Float64Array(bins);
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const ov = clamp(Number.isFinite(overlap) ? overlap : 0.5, 0, 0.9);
  const hop = Math.max(1, Math.floor(n * (1 - ov)));
  let segCount = 0;
  let start = 0;
  while (true) {
    re.fill(0);
    im.fill(0);
    const copyLen = Math.min(n, Math.max(0, len - start));
    for (let i = 0; i < copyLen; i++) re[i] = _finite(signal[start + i]) * win[i];
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    segCount++;
    if (singleSegment) break;
    start += hop;
    if (start + n > len) break;
  }
  if (segCount === 0) segCount = 1;
  const inv = 1 / segCount;
  const freqs = new Float64Array(bins);
  const db = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const p = power[k] * inv;
    const safe = Number.isFinite(p) ? Math.max(0, p) : 0;
    freqs[k] = k * sr / n;
    db[k] = 10 * Math.log10(safe + 1e-20);
  }
  return { freqs, db };
}

/** 扫频解卷积：互相关对齐 → 正则化频域解卷积 → IFFT → 主峰加窗 → FFT → 单边幅度 dB。 */
export function deconvolveIR(recorded, chirp, sampleRate, opts = {}) {
  const sr = (Number.isFinite(sampleRate) && sampleRate > 0) ? sampleRate : SAMPLE_RATE;
  const recLen = recorded ? recorded.length : 0;
  const chirpLen = chirp ? chirp.length : 0;
  if (recLen < 2 || chirpLen < 2 || !Number.isFinite(sr) || sr <= 0) {
    return _degenerate(Number.isFinite(sr) && sr > 0 ? sr : SAMPLE_RATE);
  }
  const tailMs = (opts && Number.isFinite(opts.tailMs) && opts.tailMs > 0) ? opts.tailMs : 60;
  const reg = (opts && Number.isFinite(opts.reg) && opts.reg >= 0) ? opts.reg : 1e-4;

  // a. 互相关求时延
  const delay = _estimateDelay(recorded, chirp, recLen, chirpLen);

  // b. 从时延处截取 chirp.length + tail 长度，不足补零
  const tailLen = Math.max(0, Math.ceil(tailMs / 1000 * sr));
  const segLen = Math.min(chirpLen + tailLen, MAX_FFT);
  const seg = new Float64Array(segLen);
  for (let i = 0; i < segLen; i++) {
    const idx = delay + i;
    seg[i] = (idx < recLen) ? _finite(recorded[idx]) : 0;
  }

  // c. 频域正则化解卷积 H = Y*conj(X) / (|X|² + λ)
  let m = Math.min(nextPow2(segLen + chirpLen), MAX_FFT);
  if (m < 2) m = 2;
  const fftM = new FFT(m);
  const reX = new Float64Array(m);
  const imX = new Float64Array(m);
  const reY = new Float64Array(m);
  const imY = new Float64Array(m);
  const copyX = Math.min(chirpLen, m);
  const copyY = Math.min(segLen, m);
  for (let i = 0; i < copyX; i++) reX[i] = _finite(chirp[i]);
  for (let i = 0; i < copyY; i++) reY[i] = seg[i];
  fftM.forward(reX, imX);
  fftM.forward(reY, imY);
  let meanX2 = 0;
  for (let k = 0; k < m; k++) meanX2 += reX[k] * reX[k] + imX[k] * imX[k];
  meanX2 /= m;
  let lambda = reg * meanX2 + 1e-12;
  if (!Number.isFinite(lambda) || lambda <= 0) lambda = 1e-12;
  for (let k = 0; k < m; k++) {
    const xr = reX[k], xi = imX[k];
    const yr = reY[k], yi = imY[k];
    const denom = xr * xr + xi * xi + lambda; // >= lambda > 0，杜绝除零
    reY[k] = (yr * xr + yi * xi) / denom;
    imY[k] = (yi * xr - yr * xi) / denom;
  }

  // d. h = real(IFFT(H)) / m（inverse 未缩放）
  fftM.inverse(reY, imY);
  const invM = 1 / m;
  for (let k = 0; k < m; k++) reY[k] = _finite(reY[k]) * invM;

  // e. 主峰定位 + 起点短 raised-cosine 淡入、主峰后半 Hann 递减的加窗
  let peakIdx = 0;
  let peakAbs = -1;
  for (let k = 0; k < m; k++) {
    const a = Math.abs(reY[k]);
    if (a > peakAbs) { peakAbs = a; peakIdx = k; }
  }
  const preSamples = Math.max(1, Math.ceil(5 / 1000 * sr)); // max(1ms,5ms) → 5ms
  const tailSamples = Math.max(1, Math.ceil(tailMs / 1000 * sr));
  const winStart = Math.max(0, peakIdx - preSamples);
  const winEnd = Math.min(m, peakIdx + tailSamples);
  const fadeIn = Math.max(1, peakIdx - winStart);
  const decSpan = Math.max(1, winEnd - peakIdx);
  const ir = new Float32Array(m);
  for (let i = winStart; i < winEnd; i++) {
    let w;
    if (i < peakIdx) {
      w = 0.5 * (1 - Math.cos(Math.PI * (i - winStart) / fadeIn));
    } else {
      w = 0.5 * (1 + Math.cos(Math.PI * (i - peakIdx) / decSpan));
    }
    ir[i] = _finite(reY[i]) * w;
  }
  let peakVal = 0;
  for (let k = 0; k < m; k++) {
    const a = Math.abs(ir[k]);
    if (a > peakVal) peakVal = a;
  }
  const peakDb = 20 * Math.log10(_finite(peakVal) + 1e-12);

  // f. 对加窗 IR 再做 m 点 FFT，取单边 0..Nyquist 幅度 dB
  const reH = new Float64Array(m);
  const imH = new Float64Array(m);
  for (let k = 0; k < m; k++) reH[k] = ir[k];
  fftM.forward(reH, imH);
  const bins = (m >> 1) + 1;
  const freqs = new Float64Array(bins);
  const db = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const mag = Math.sqrt(reH[k] * reH[k] + imH[k] * imH[k]);
    const safe = Number.isFinite(mag) ? mag : 0;
    freqs[k] = k * sr / m;
    db[k] = 20 * Math.log10(safe + 1e-12);
  }
  return { ir, delaySamples: delay, freqs, db, peakDb };
}

/** 在 log2(f) 域用高斯核平滑，窗口总宽 = 1/divisor 倍频程，边界按有效权重归一化。 */
export function smoothLogCurve(freqs, db, divisor) {
  const n = freqs ? freqs.length : 0;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const dLen = db ? db.length : 0;
  const d = (Number.isFinite(divisor) && divisor > 0) ? divisor : 3;
  const half = (1 / d) / 2;          // 窗口半宽（倍频程）
  const sigma = half / 3 || 1e-6;    // ±3σ 覆盖窗口
  const inv2s2 = 1 / (2 * sigma * sigma);

  const xs = new Array(n);
  const valid = new Uint8Array(n);
  let last = -1e300;
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    if (Number.isFinite(f) && f > 0) {
      xs[i] = Math.log2(f);
      valid[i] = 1;
      last = xs[i];
    } else {
      xs[i] = last; // 保持非降序，便于二分
      valid[i] = 0;
    }
  }
  // 频率轴通常为升序；若非升序则按 x 排序索引以维持非降序
  let order = null;
  let ordered = true;
  for (let i = 1; i < n; i++) {
    if (xs[i] < xs[i - 1]) { ordered = false; break; }
  }
  const xArr = new Float64Array(n);
  if (ordered) {
    for (let i = 0; i < n; i++) xArr[i] = xs[i];
  } else {
    order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => xs[a] - xs[b]);
    for (let i = 0; i < n; i++) xArr[i] = xs[order[i]];
  }
  const srcOf = (i) => (order ? order[i] : i);
  const maxPts = 512; // 限制单窗口采样点数，保证整体复杂度优于 O(n²)

  for (let i = 0; i < n; i++) {
    const base = (i < dLen) ? _finite(db[i]) : 0;
    if (!valid[i]) { out[i] = base; continue; }
    const center = xs[i];
    const lo = _lowerBound(xArr, n, center - half);
    const hi = _lowerBound(xArr, n, center + half + 1e-12) - 1;
    if (hi < lo) { out[i] = base; continue; }
    const count = hi - lo + 1;
    const step = count > maxPts ? Math.ceil(count / maxPts) : 1;
    let acc = 0;
    let wsum = 0;
    for (let j = lo; j <= hi; j += step) {
      const src = srcOf(j);
      if (!valid[src]) continue;
      const dx = xArr[j] - center;
      const w = Math.exp(-inv2s2 * dx * dx);
      const v = (src < dLen) ? _finite(db[src]) : 0;
      acc += w * v;
      wsum += w;
    }
    let v = wsum > 0 ? acc / wsum : base;
    if (!Number.isFinite(v)) v = base;
    out[i] = _finite(v);
  }
  return out;
}

/** 在 log(f) 域线性插值到 gridFreqs，跳过非法源点，带外做端点常数外推。 */
export function mapToGrid(srcFreqs, srcDb, gridFreqs) {
  const nOut = gridFreqs ? gridFreqs.length : 0;
  const out = new Float64Array(nOut);
  const m = (srcFreqs && srcDb) ? Math.min(srcFreqs.length, srcDb.length) : 0;
  if (m === 0 || nOut === 0) return out;
  const lx = [];
  const ly = [];
  for (let i = 0; i < m; i++) {
    const f = srcFreqs[i];
    const v = srcDb[i];
    if (Number.isFinite(f) && f > 0 && Number.isFinite(v)) {
      lx.push(Math.log(f));
      ly.push(v);
    }
  }
  let cnt = lx.length;
  if (cnt === 0) return out;
  let xs = lx;
  let ys = ly;
  let sorted = true;
  for (let i = 1; i < cnt; i++) {
    if (lx[i] < lx[i - 1]) { sorted = false; break; }
  }
  if (!sorted) {
    const idx = new Array(cnt);
    for (let i = 0; i < cnt; i++) idx[i] = i;
    idx.sort((a, b) => lx[a] - lx[b]);
    xs = new Array(cnt);
    ys = new Array(cnt);
    for (let i = 0; i < cnt; i++) { xs[i] = lx[idx[i]]; ys[i] = ly[idx[i]]; }
  }
  for (let i = 0; i < nOut; i++) {
    const g = gridFreqs[i];
    if (!Number.isFinite(g) || g <= 0) { out[i] = 0; continue; }
    const gx = Math.log(g);
    const lo = _lowerBound(xs, cnt, gx);
    let v;
    if (lo === 0) {
      v = ys[0];
    } else if (lo >= cnt) {
      v = ys[cnt - 1];
    } else {
      const x0 = xs[lo - 1], x1 = xs[lo];
      const y0 = ys[lo - 1], y1 = ys[lo];
      const denom = x1 - x0;
      const t = denom > 0 ? (gx - x0) / denom : 0;
      v = y0 + t * (y1 - y0);
    }
    out[i] = _finite(v);
  }
  return out;
}

/** 参考带内整体平移 measuredDb，使带内均值等于 targetDb 带内均值，返回新数组。 */
export function alignLevel(measuredDb, targetDb, freqs, refLo = REF_BAND.lo, refHi = REF_BAND.hi) {
  const n = measuredDb ? measuredDb.length : 0;
  const out = new Float64Array(n);
  const a = Math.min(Number.isFinite(refLo) ? refLo : REF_BAND.lo,
                     Number.isFinite(refHi) ? refHi : REF_BAND.hi);
  const b = Math.max(Number.isFinite(refLo) ? refLo : REF_BAND.lo,
                     Number.isFinite(refHi) ? refHi : REF_BAND.hi);
  const tLen = targetDb ? targetDb.length : 0;
  let sm = 0, cm = 0, st = 0, ct = 0;
  for (let i = 0; i < n; i++) {
    const f = freqs ? freqs[i] : NaN;
    if (Number.isFinite(f) && f >= a && f <= b) {
      const mv = measuredDb[i];
      const tv = i < tLen ? targetDb[i] : NaN;
      if (Number.isFinite(mv)) { sm += mv; cm++; }
      if (Number.isFinite(tv)) { st += tv; ct++; }
    }
  }
  const meanM = cm > 0 ? sm / cm : 0;
  const meanT = ct > 0 ? st / ct : 0;
  const diff = meanT - meanM;
  for (let i = 0; i < n; i++) {
    out[i] = _finite(_finite(measuredDb[i]) + diff);
  }
  return out;
}

/** RMS 电平（dB）：20*log10(sqrt(mean(x²)) + 1e-12)。 */
export function rmsDb(x) {
  const n = x ? x.length : 0;
  if (n === 0) return -240;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) s += v * v;
  }
  const rms = Math.sqrt(s / n);
  return 20 * Math.log10(rms + 1e-12);
}

/** 常规钳制，把 v 限制在 [lo, hi]；非有限 v 退化为 lo，保证结果有限。 */
export function clamp(v, lo, hi) {
  let a = Number.isFinite(lo) ? lo : -Infinity;
  let b = Number.isFinite(hi) ? hi : Infinity;
  if (a > b) { const t = a; a = b; b = t; }
  if (!Number.isFinite(v)) return Number.isFinite(a) ? a : 0;
  if (v < a) return a;
  if (v > b) return b;
  return v;
}
