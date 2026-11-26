/**
 * ============================================================================
 * 兵部 · 测量流程编排
 * ----------------------------------------------------------------------------
 * 职责：生成测试信号 → 播放并同步采集 → 等待 → 取回 PCM → DSP 分析 →
 *       映射到 GRID 频率轴并做 1/6 倍频程平滑 → 返回 MeasurementResult。
 * 抗干扰：支持静音测录本底噪声、K 次重复测量取逐点中值，并给出逐频点
 *       信噪比与可信度权重（质量数学由 core/quality.js 提供）。
 * 约定：不修改 engine 的 EQ / 增益设置（测量时的旁路由 main.js 负责）；
 *       采样率一律取 engine.sampleRate，不硬编码 48000。
 * ============================================================================
 */
import { GRID } from '../contracts.js';
import {
  generateLogChirp,
  generatePinkNoise,
  welchPSD,
  deconvolveIR,
  mapToGrid,
  smoothLogCurve,
  createLogGrid,
} from '../core/dsp.js';
import {
  medianAcrossRuns,
  spreadAcrossRuns,
  snrDb,
  reliabilityWeight,
} from '../core/quality.js';

/** 无效功率谱的下限值（dB 域），用于退化/缺失数据的填充 */
const DB_FLOOR = -120;

/**
 * 构造 GRID 频率轴（与 dsp.createLogGrid 同参数）。
 * @returns {{freqs:Float64Array, n:number}}
 */
function makeGrid() {
  return createLogGrid(GRID.fMin, GRID.fMax, GRID.ppOct);
}

/**
 * 生成一条长度为 n、全部为 DB_FLOOR 的功率谱曲线。
 * @param {number} n
 * @returns {Float64Array}
 */
function floorCurve(n) {
  const out = new Float64Array(n);
  out.fill(DB_FLOOR);
  return out;
}

/**
 * 把任意曲线规整为长度 n 的有限值数组：非有限值（NaN / Infinity）与缺失位置
 * 统一填 fill，避免污染后续的跨轮中值与对数插值。
 * @param {ArrayLike<number>|null|undefined} src 源曲线
 * @param {number} n 目标长度
 * @param {number} fill 非有限值 / 缺失位置的填充值
 * @returns {Float64Array}
 */
function normalizeCurve(src, n, fill) {
  const out = new Float64Array(n);
  if (!src || typeof src.length !== 'number') {
    out.fill(fill);
    return out;
  }
  const m = Math.min(n, src.length);
  for (let i = 0; i < m; i++) {
    out[i] = Number.isFinite(src[i]) ? src[i] : fill;
  }
  for (let i = m; i < n; i++) out[i] = fill;
  return out;
}

/**
 * 把数值钳制到 [0, 1]；非数值视为 0。
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 把数值取整并钳制到 [lo, hi]；非数值返回 lo。
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampInt(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  const x = Math.round(v);
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * 把数值钳制到 [lo, hi]；非数值返回 lo。
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampNumber(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 规整「本底噪声测录时长」：0 表示不测；>0 时钳制到 0.3..5 秒；非法值视为 0。
 * @param {number} v 用户传入的秒数
 * @returns {number}
 */
function normalizeNoiseFloorSec(v) {
  if (!Number.isFinite(v) || !(v > 0)) return 0;
  return clampNumber(v, 0.3, 5);
}

/**
 * 构造统一的取消异常。
 * @returns {DOMException}
 */
function abortError() {
  return new DOMException('测量已取消', 'AbortError');
}

/**
 * 只有「几乎全静音」才判失败。
 * 频响是相对量（对齐后按 300–3000 Hz 归零），绝对录音电平不参与计算，
 * 因此这里不设 -60 dBFS 之类的门槛：手机麦克风关闭 AGC 后常年只有 -45~-60 dBFS，
 * 按绝对电平判失败会误伤正常测量。能不能用，只看信噪比。
 */
const SILENCE_PEAK_DB = -85;

/**
 * 统计录音电平并只拦截「真静音 / 削波」两种硬故障。
 * @param {Float32Array|Float64Array} pcm
 * @returns {{peakDb:number, rmsDb:number}}
 */
function recordingLevel(pcm) {
  let peak = 0;
  let clipped = 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const amplitude = Math.abs(pcm[i]);
    if (amplitude > peak) peak = amplitude;
    if (amplitude >= 0.995) clipped++;
    sum += pcm[i] * pcm[i];
  }
  const peakDb = 20 * Math.log10(peak + 1e-12);
  const rmsDb = 20 * Math.log10(Math.sqrt(sum / Math.max(1, pcm.length)) + 1e-12);
  if (peakDb < SILENCE_PEAK_DB) {
    throw new Error('录音过弱：几乎没录到声音，请确认播放端真的在响、输出设备选的是扬声器、麦克风没有被系统静音');
  }
  if (clipped > pcm.length * 0.001) throw new Error('录音削波，请降低播放或麦克风输入音量');
  return { peakDb, rmsDb };
}

/** 一段 PCM 的 RMS（dBFS）；空数组返回 -120。 */
function rmsDbOf(pcm) {
  if (!pcm || !pcm.length) return -120;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return 20 * Math.log10(Math.sqrt(sum / pcm.length) + 1e-12);
}

/**
 * 扫频的处理增益（dB）。
 *
 * 解卷积本质是匹配滤波：与噪声比较时该用「扫频经过该频点那一刻的瞬时功率」，
 * 而不是「整段采集的时间平均功率」。对数扫频停留时间为
 *   dwell(f) = binHz · T / (f · ln(f2/f1))
 * 故增益 = 10·log10(T / dwell) = 10·log10(f · ln(f2/f1) / binHz)，与扫频时长无关。
 * 不做这项补偿，扫频模式的逐点 SNR 会被系统性低估 20~40 dB，导致误报「音量太小」。
 *
 * @param {Float64Array} freqs 频率轴
 * @param {number} sampleRate 采样率
 * @param {number} fftSize Welch FFT 长度
 * @param {number} f1 扫频起点
 * @param {number} f2 扫频终点
 * @param {number} [capDb] 上限，默认 40 dB
 * @returns {Float64Array}
 */
function sweepProcessingGainDb(freqs, sampleRate, fftSize, f1, f2, capDb = 40) {
  const span = Math.log(Math.max(f2, f1 * 1.001) / Math.max(f1, 1));
  const binHz = sampleRate / fftSize;
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const raw = 10 * Math.log10(Math.max(freqs[i], 1) * span / binHz);
    out[i] = Number.isFinite(raw) ? Math.min(capDb, Math.max(0, raw)) : 0;
  }
  return out;
}

export class Measurement {
  constructor(engine) {
    if (!engine) {
      throw new Error('Measurement 需要一个已初始化的 AudioEngine 实例。');
    }
    this.engine = engine;
    this._cancelled = false;
    /** 跨轮次取消标志：_runMeasurement 每轮开始会复位 _cancelled，轮间判断必须用它 */
    this._cancelRequested = false;
    this._busy = false;
  }

  /** 请求取消当前测量；等待循环下一轮（≤100ms）即停止播放/采集并抛 AbortError。 */
  cancel() {
    this._cancelled = true;
    this._cancelRequested = true;
  }

  /**
   * 粉噪测量：用录音与参考粉噪的 Welch 功率谱之差估计链路频响。
   *
   * 当 repeats === 1 且 noiseFloorSec === 0 时走单次路径，行为与旧版完全一致；
   * 否则进入抗干扰流程（静音测噪 + K 次重复 + 中值 / 标准差 / SNR / 权重）。
   *
   * @param {{durationSec?:number, onProgress?:(p:number)=>void, externalPlayback?:boolean,
   *          repeats?:number, noiseFloorSec?:number}} opts
   * @returns {Promise<MeasurementResult>}
   */
  async runPinkNoise(opts = {}) {
    const {
      durationSec = 6,
      onProgress,
      externalPlayback = false,
      repeats: repeatsRaw = 1,
      noiseFloorSec: noiseFloorRaw = 0,
    } = opts || {};

    this._cancelled = false;
    this._cancelRequested = false;

    const repeats = clampInt(repeatsRaw, 1, 5);
    const noiseFloorSec = normalizeNoiseFloorSec(noiseFloorRaw);
    const sr = this.engine.sampleRate;
    // 缓冲区长度与种子保持历史值，保证粉噪可复现
    const signal = generatePinkNoise(sr, Math.max(durationSec + 1, 10), 20261124);

    /**
     * 构造一次粉噪采集所需的 _runMeasurement 参数。
     * @param {(p:number)=>void|undefined} report 本轮内部 0..1 进度回调
     */
    const buildSingle = (report) => ({
      mode: 'pink',
      signal,
      loop: true,
      waitSec: durationSec,
      onProgress: report,
      externalPlayback,
      analyze: (recorded, sampleRate) => {
        // 裁掉开头 0.2s 的硬件启动瞬态
        const trim = Math.min(Math.floor(sampleRate * 0.2), recorded.length);
        const pcm = recorded.subarray(trim);
        const grid = makeGrid();

        if (pcm.length < 256) {
          const rawDb = new Float64Array(grid.n);
          const smoothDb = new Float64Array(grid.n);
          return {
            freqs: grid.freqs,
            rawDb,
            smoothDb,
            psdDb: floorCurve(grid.n),
            sampleRate,
            mode: 'pink',
            meta: { frames: pcm.length, peakDb: -100, method: 'welch', degraded: true },
          };
        }

        const level = recordingLevel(pcm);
        const psd = welchPSD(pcm, sampleRate, 8192, 0.5);
        const reference = welchPSD(signal, sampleRate, 8192, 0.5);
        const responseDb = new Float64Array(psd.db.length);
        for (let i = 0; i < responseDb.length; i++) {
          responseDb[i] = psd.db[i] - reference.db[i];
        }
        const rawDb = mapToGrid(psd.freqs, responseDb, grid.freqs);
        const smoothDb = smoothLogCurve(grid.freqs, rawDb, 6);
        // 麦克风实际接收到的功率谱（未扣除参考），用于本底噪声信噪比评估
        const psdDb = normalizeCurve(mapToGrid(psd.freqs, psd.db, grid.freqs), grid.n, DB_FLOOR);

        return {
          freqs: grid.freqs,
          rawDb,
          smoothDb,
          psdDb,
          sampleRate,
          mode: 'pink',
          // 粉噪是连续信号，无需处理增益补偿
          snrGainDb: null,
          meta: { frames: pcm.length, peakDb: level.peakDb, rmsDb: level.rmsDb, method: 'welch' },
        };
      },
    });

    if (repeats === 1 && noiseFloorSec === 0) {
      // 单次路径：只调一次 _runMeasurement 并原样返回，保持向后兼容
      return this._runMeasurement(buildSingle(onProgress));
    }

    return this._runAveraged({
      buildSingle,
      mode: 'pink',
      repeats,
      noiseFloorSec,
      onProgress,
    });
  }

  /**
   * 对数扫频测量：单次播放 chirp，解卷积求冲激响应并取幅度谱。
   * 开头不做裁剪，对齐完全依赖 deconvolveIR 内部的互相关。
   *
   * 当 repeats === 1 且 noiseFloorSec === 0 时走单次路径，行为与旧版完全一致；
   * 否则进入抗干扰流程。
   *
   * @param {{durationSec?:number, tailMs?:number, onProgress?:(p:number)=>void,
   *          externalPlayback?:boolean, captureSec?:number|null,
   *          repeats?:number, noiseFloorSec?:number}} opts
   * @returns {Promise<MeasurementResult>}
   */
  async runSweep(opts = {}) {
    const {
      durationSec = 5,
      tailMs = 60,
      onProgress,
      externalPlayback = false,
      captureSec = null,
      repeats: repeatsRaw = 1,
      noiseFloorSec: noiseFloorRaw = 0,
    } = opts || {};

    this._cancelled = false;
    this._cancelRequested = false;

    const repeats = clampInt(repeatsRaw, 1, 5);
    const noiseFloorSec = normalizeNoiseFloorSec(noiseFloorRaw);
    const sr = this.engine.sampleRate;
    const chirp = generateLogChirp(sr, durationSec, 20, Math.min(20000, sr * 0.47));
    // 协同模式：播放端循环播放带间隔的扫频，采集窗口需覆盖至少两个完整周期
    const waitSec = Number.isFinite(captureSec) && captureSec > 0
      ? captureSec
      : durationSec + tailMs / 1000 + 0.7; // 给硬件延迟留余量

    /**
     * 构造一次扫频采集所需的 _runMeasurement 参数；每轮共用同一采集窗口。
     * @param {(p:number)=>void|undefined} report 本轮内部 0..1 进度回调
     */
    const buildSingle = (report) => ({
      mode: 'sweep',
      signal: chirp,
      loop: false,
      waitSec,
      onProgress: report,
      externalPlayback,
      analyze: (pcm, sampleRate) => {
        const grid = makeGrid();
        const level = recordingLevel(pcm);
        const inputPeakDb = level.peakDb;
        let res = null;
        try {
          res = deconvolveIR(pcm, chirp, sampleRate, { tailMs });
        } catch (_) {
          res = null;
        }

        const db = res && res.db;
        let finite = 0;
        if (db) {
          for (let i = 0; i < db.length; i++) {
            if (Number.isFinite(db[i])) finite++;
          }
        }
        // 解卷积结果全 NaN / 缺失时安全退化为全 0 曲线
        if (!res || !db || !res.freqs || db.length === 0 || finite === 0) {
          const rawDb = new Float64Array(grid.n);
          const smoothDb = new Float64Array(grid.n);
          return {
            freqs: grid.freqs,
            rawDb,
            smoothDb,
            psdDb: floorCurve(grid.n),
            snrGainDb: null,
            sampleRate,
            mode: 'sweep',
            meta: { delayMs: 0, tailMs, peakDb: -100, inputPeakDb, method: 'deconvolution', degraded: true },
          };
        }

        // 个别非有限值清洗为 0，避免污染 mapToGrid 的对数插值
        const clean = new Float64Array(db.length);
        for (let i = 0; i < db.length; i++) {
          clean[i] = Number.isFinite(db[i]) ? db[i] : 0;
        }
        const rawDb = mapToGrid(res.freqs, clean, grid.freqs);
        const smoothDb = smoothLogCurve(grid.freqs, rawDb, 6);
        const delaySamples = Number.isFinite(res.delaySamples) ? res.delaySamples : 0;
        const peakDb = Number.isFinite(res.peakDb) ? res.peakDb : 0;

        // 麦克风功率谱只取「扫频正在播放」的那一段（时延 → 扫频 + 脉冲窗），
        // 否则采集窗口里的前后静音会把平均功率拉低，让 SNR 进一步虚低。
        const winStart = Math.min(Math.max(0, delaySamples), Math.max(0, pcm.length - 1));
        const winLen = Math.max(0, Math.min(chirp.length + Math.ceil(tailMs / 1000 * sampleRate), pcm.length - winStart));
        const winPcm = pcm.subarray(winStart, winStart + winLen);
        const micPsd = winLen >= 512
          ? welchPSD(winPcm, sampleRate, 8192, 0.5)
          : { freqs: new Float64Array([0]), db: new Float64Array([DB_FLOOR]) };
        const psdDb = normalizeCurve(mapToGrid(micPsd.freqs, micPsd.db, grid.freqs), grid.n, DB_FLOOR);

        const f2 = Math.min(20000, sampleRate * 0.47);
        return {
          freqs: grid.freqs,
          rawDb,
          smoothDb,
          psdDb,
          snrGainDb: sweepProcessingGainDb(grid.freqs, sampleRate, 8192, 20, f2),
          sampleRate,
          mode: 'sweep',
          meta: {
            delayMs: delaySamples / sampleRate * 1000,
            tailMs,
            peakDb,
            inputPeakDb,
            rmsDb: rmsDbOf(winPcm),
            method: 'deconvolution',
          },
        };
      },
    });

    if (repeats === 1 && noiseFloorSec === 0) {
      // 单次路径：只调一次 _runMeasurement 并原样返回，保持向后兼容
      return this._runMeasurement(buildSingle(onProgress));
    }

    return this._runAveraged({
      buildSingle,
      mode: 'sweep',
      repeats,
      noiseFloorSec,
      onProgress,
    });
  }

  /**
   * 抗干扰流程：静音测录本底噪声 → K 次重复采集 → 逐点中值 / 标准差 /
   * 逐频点信噪比 / 可信度权重。
   *
   * 进度按「本底噪声 + K 次采集」等分总工作量折算为整体 0..1。
   * 每轮开始前检查 _cancelRequested（_runMeasurement 会复位 _cancelled）。
   *
   * @param {Object} cfg
   * @param {(report:(p:number)=>void)=>(Object)} cfg.buildSingle 构造单次 _runMeasurement 参数
   * @param {'pink'|'sweep'} cfg.mode 测量模式
   * @param {number} cfg.repeats 重复次数（已钳制 1..5）
   * @param {number} cfg.noiseFloorSec 本底噪声测录时长（已钳制，0 表示不测）
   * @param {(p:number)=>void} [cfg.onProgress] 整体进度回调
   * @returns {Promise<MeasurementResult>}
   */
  async _runAveraged({ buildSingle, mode, repeats, noiseFloorSec, onProgress }) {
    const grid = makeGrid();
    const totalUnits = repeats + (noiseFloorSec > 0 ? 1 : 0);

    /**
     * 按「已完成工作量 + 当前轮内部进度」折算整体进度并回报。
     * @param {number} units 已完成（含当前轮内部）的工作量
     */
    const reportUnits = (units) => {
      if (typeof onProgress !== 'function') return;
      const p = totalUnits > 0 ? units / totalUnits : 1;
      try { onProgress(clamp01(p)); } catch (_) { /* 进度回调异常不影响结果 */ }
    };

    const sampleRate = this.engine.sampleRate;
    let noiseDb = null;
    let noiseRmsDb = null;
    let baseUnits = 0;

    // 步骤 1：静音测录本底噪声（不播放任何信号，只做 PSD）
    if (noiseFloorSec > 0) {
      if (this._cancelRequested) throw abortError();
      try {
        const pcm = await this._runMeasurement({
          mode,
          signal: null,
          loop: false,
          waitSec: noiseFloorSec,
          silent: true,
          onProgress: (p) => reportUnits(clamp01(p)),
          // 静音段不做录音电平校验（信号本来就极弱），直接把 PCM 原样取回
          analyze: (recorded) => recorded,
        });
        noiseDb = this._noisePsdToGrid(pcm, sampleRate);
        noiseRmsDb = rmsDbOf(pcm);
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        noiseDb = null; // 静音测录的任何异常都不影响主流程
        noiseRmsDb = null;
      }
      baseUnits = 1;
    }

    // 步骤 2：K 次重复采集，收集每次的 rawDb 与麦克风功率谱
    const rawRuns = [];
    const psdRuns = [];
    let gainArr = null;
    let degradedRuns = 0;
    let firstMeta = null;

    for (let k = 0; k < repeats; k++) {
      if (this._cancelRequested) throw abortError();
      const single = buildSingle((p) => reportUnits(baseUnits + k + clamp01(p)));
      const res = await this._runMeasurement(single);

      const normalizedRaw = normalizeCurve(res && res.rawDb, grid.n, 0);
      const normalizedPsd = normalizeCurve(res && res.psdDb, grid.n, DB_FLOOR);
      rawRuns.push(normalizedRaw);
      psdRuns.push(normalizedPsd);

      if (!gainArr && res && res.snrGainDb && res.snrGainDb.length === grid.n) {
        gainArr = Float64Array.from(res.snrGainDb);
      }

      if (!res || !res.meta || res.meta.degraded) {
        degradedRuns++;
      } else if (!firstMeta) {
        firstMeta = res.meta;
      }
    }

    const allDegraded = degradedRuns >= repeats;

    // 步骤 3：汇总——逐点中值、跨轮标准差、SNR 与可信度权重
    const rawDb = medianAcrossRuns(rawRuns);
    const psdMedian = medianAcrossRuns(psdRuns);
    const spreadDb = repeats > 1 ? spreadAcrossRuns(rawRuns) : null;
    const snrArr = noiseDb ? snrDb(psdMedian, noiseDb) : null;
    // 扫频模式补上匹配滤波的处理增益，否则逐点 SNR 会被低估 20~40 dB
    if (snrArr && gainArr) {
      for (let i = 0; i < snrArr.length; i++) {
        const v = snrArr[i] + gainArr[i];
        snrArr[i] = v < -20 ? -20 : v > 80 ? 80 : v;
      }
    }
    let weight = snrArr ? reliabilityWeight(snrArr, spreadDb, grid.freqs) : null;
    if (allDegraded) weight = new Float64Array(grid.n); // 全部退化时权重全 0
    const smoothDb = smoothLogCurve(grid.freqs, rawDb, 6);

    reportUnits(totalUnits);

    const peakDb = firstMeta && Number.isFinite(firstMeta.peakDb) ? firstMeta.peakDb : -100;
    const inputPeakDb = firstMeta && Number.isFinite(firstMeta.inputPeakDb)
      ? firstMeta.inputPeakDb
      : peakDb;
    const rmsDb = firstMeta && Number.isFinite(firstMeta.rmsDb) ? firstMeta.rmsDb : null;

    // 宽带信噪比：整段信号功率与本底噪声功率之比，用于判断「到底该调音量还是该降噪」
    let broadbandSnrDb = null;
    if (rmsDb !== null && noiseRmsDb !== null && Number.isFinite(rmsDb) && Number.isFinite(noiseRmsDb)) {
      const ps = Math.pow(10, rmsDb / 10);
      const pn = Math.pow(10, noiseRmsDb / 10);
      broadbandSnrDb = pn > 0 && ps > pn ? Math.min(80, 10 * Math.log10((ps - pn) / pn)) : -20;
    }

    // 扫频处理增益在 200 Hz–5 kHz 的均值，仅用于界面展示
    let snrGainDb = null;
    if (gainArr) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < gainArr.length; i++) {
        const f = grid.freqs[i];
        if (f >= 200 && f <= 5000) { sum += gainArr[i]; count++; }
      }
      snrGainDb = count ? sum / count : null;
    }

    return {
      freqs: grid.freqs,
      rawDb,
      smoothDb,
      sampleRate,
      mode,
      noiseDb,
      snrDb: snrArr,
      spreadDb,
      weight,
      meta: {
        method: mode === 'pink' ? 'welch' : 'deconvolution',
        repeats,
        runs: rawRuns.length,
        noiseFloorSec,
        tailMs: firstMeta && Number.isFinite(firstMeta.tailMs) ? firstMeta.tailMs : 0,
        delayMs: firstMeta && Number.isFinite(firstMeta.delayMs) ? firstMeta.delayMs : 0,
        peakDb,
        inputPeakDb,
        rmsDb,
        noiseFloorDb: noiseRmsDb,
        broadbandSnrDb,
        snrGainDb,
        degraded: allDegraded,
      },
    };
  }

  /**
   * 把静音段 PCM 转成映射到 GRID 的噪声功率谱（dB 域）。
   * 数据过短或异常时返回 null，由调用方按「无本底噪声」处理。
   * @param {Float32Array|Float64Array} pcm 静音段录音
   * @param {number} sampleRate 采样率
   * @returns {Float64Array|null}
   */
  _noisePsdToGrid(pcm, sampleRate) {
    if (!pcm || typeof pcm.length !== 'number' || pcm.length < 256) return null;
    const grid = makeGrid();
    const psd = welchPSD(pcm, sampleRate, 8192, 0.5);
    if (!psd || !psd.freqs || !psd.db) return null;
    return normalizeCurve(mapToGrid(psd.freqs, psd.db, grid.freqs), grid.n, DB_FLOOR);
  }

  /**
   * 公共测量流程：生成信号 → startCapture → playBuffer → 100ms 轮询等待 →
   * stopCapture → stopPlayback → DSP 分析 → 返回结果。try/finally 保证播放停止
   * 与 _busy 复位；取消时立即停止并抛 AbortError。
   *
   * silent 为 true 时只开采集、等待、取回 PCM，不播放任何信号（本底噪声测录）。
   *
   * @param {Object} cfg
   * @param {'pink'|'sweep'} cfg.mode 模式标识（用于错误文案）
   * @param {Float32Array|null} cfg.signal 待播放信号（silent 时可为 null）
   * @param {boolean} cfg.loop 是否循环播放
   * @param {number} cfg.waitSec 采集等待时长（秒）
   * @param {(p:number)=>void} [cfg.onProgress] 进度回调
   * @param {(pcm:Float32Array, sampleRate:number)=>any} cfg.analyze 分析函数
   * @param {boolean} [cfg.externalPlayback] 是否由对端播放（本机只采集）
   * @param {boolean} [cfg.silent] 静音模式：不播放信号
   */
  async _runMeasurement({ mode, signal, loop, waitSec, onProgress, analyze, externalPlayback = false, silent = false }) {
    if (this._busy) {
      throw new Error('已有测量正在进行，请等待其结束或先取消。');
    }
    if (!this.engine.ready) {
      throw new Error('音频引擎尚未就绪，请先完成初始化。');
    }
    if (!this.engine.micReady) {
      throw new Error('麦克风尚未就绪，请先授权并连接麦克风后再开始测量。');
    }

    this._busy = true;
    this._cancelled = false;
    let captureActive = false;
    try {
      const sr = this.engine.sampleRate;
      await this.engine.startCapture();
      captureActive = true;
      // 双端协同的测量端：测试信号由另一端（播放端）发出，本机只采集、不发声
      if (!silent && !externalPlayback) {
        await this.engine.playBuffer(this.engine.createBuffer(signal), loop);
      }
      await this._waitWithProgress(waitSec, onProgress);
      const pcm = await this.engine.stopCapture();
      captureActive = false;
      this.engine.stopPlayback();

      if (this._cancelled) {
        throw new DOMException('测量已取消', 'AbortError');
      }
      const result = analyze(pcm, sr);
      if (typeof onProgress === 'function') {
        try { onProgress(1); } catch (_) { /* 进度回调异常不影响结果 */ }
      }
      return result;
    } catch (err) {
      if (this._cancelled || (err && err.name === 'AbortError')) {
        try { this.engine.stopPlayback(); } catch (_) { /* 忽略 */ }
        if (captureActive) {
          try { await this.engine.stopCapture(); } catch (_) { /* 忽略 */ }
          captureActive = false;
        }
        throw new DOMException('测量已取消', 'AbortError');
      }
      if (captureActive) {
        try { await this.engine.stopCapture(); } catch (_) { /* 忽略 */ }
      }
      const text = err && err.message ? err.message : String(err);
      throw new Error('测量失败（' + mode + '）：' + text);
    } finally {
      try { this.engine.stopPlayback(); } catch (_) { /* 忽略 */ }
      this._busy = false;
    }
  }

  /**
   * 按约 100ms 间隔轮询等待并回报进度 p∈[0,1]；每轮检查取消标志。
   * 使用 setTimeout 链而非 setInterval，退出后不再留下任何定时器。
   * @param {number} totalSec 等待总时长（秒）
   * @param {(p:number)=>void} [onProgress] 本轮内部 0..1 进度回调
   * @returns {Promise<void>}
   */
  _waitWithProgress(totalSec, onProgress) {
    const start = performance.now();
    const totalMs = Math.max(1, totalSec * 1000);
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this._cancelled) {
          reject(new DOMException('测量已取消', 'AbortError'));
          return;
        }
        const elapsed = performance.now() - start;
        const p = Math.min(1, elapsed / totalMs);
        if (typeof onProgress === 'function') {
          try { onProgress(p); } catch (_) { /* 忽略回调异常 */ }
        }
        if (elapsed >= totalMs) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }
}
