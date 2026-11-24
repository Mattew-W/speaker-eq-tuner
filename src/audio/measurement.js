/**
 * ============================================================================
 * 兵部 · 测量流程编排
 * ----------------------------------------------------------------------------
 * 职责：生成测试信号 → 播放并同步采集 → 等待 → 取回 PCM → DSP 分析 →
 *       映射到 GRID 频率轴并做 1/6 倍频程平滑 → 返回 MeasurementResult。
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

export class Measurement {
  constructor(engine) {
    if (!engine) {
      throw new Error('Measurement 需要一个已初始化的 AudioEngine 实例。');
    }
    this.engine = engine;
    this._cancelled = false;
    this._busy = false;
  }

  /** 请求取消当前测量；等待循环下一轮（≤100ms）即停止播放/采集并抛 AbortError。 */
  cancel() {
    this._cancelled = true;
  }

  /**
   * 粉噪测量：loop 播放粉红噪声，用 Welch 功率谱估计频响。
   * @param {{durationSec?:number, onProgress?:(p:number)=>void}} opts
   * @returns {Promise<MeasurementResult>}
   */
  async runPinkNoise(opts = {}) {
    const { durationSec = 6, onProgress, externalPlayback = false } = opts || {};
    const sr = this.engine.sampleRate;
    const signal = generatePinkNoise(sr, durationSec + 1, Date.now() & 0xffff);
    return this._runMeasurement({
      mode: 'pink',
      signal,
      loop: true,
      waitSec: durationSec,
      onProgress,
      externalPlayback,
      analyze: (recorded, sampleRate) => {
        // 裁掉开头 0.2s 的硬件启动瞬态
        const trim = Math.min(Math.floor(sampleRate * 0.2), recorded.length);
        const pcm = recorded.subarray(trim);
        const grid = createLogGrid(GRID.fMin, GRID.fMax, GRID.ppOct);

        if (pcm.length < 256) {
          const rawDb = new Float64Array(grid.n);
          const smoothDb = new Float64Array(grid.n);
          return {
            freqs: grid.freqs,
            rawDb,
            smoothDb,
            sampleRate,
            mode: 'pink',
            meta: { frames: pcm.length, peakDb: -100, method: 'welch', degraded: true },
          };
        }

        const psd = welchPSD(pcm, sampleRate, 8192, 0.5);
        const rawDb = mapToGrid(psd.freqs, psd.db, grid.freqs);
        const smoothDb = smoothLogCurve(grid.freqs, rawDb, 6);

        let peak = 0;
        for (let i = 0; i < pcm.length; i++) {
          const a = Math.abs(pcm[i]);
          if (a > peak) peak = a;
        }
        const peakDb = 20 * Math.log10(peak + 1e-12);

        return {
          freqs: grid.freqs,
          rawDb,
          smoothDb,
          sampleRate,
          mode: 'pink',
          meta: { frames: pcm.length, peakDb, method: 'welch' },
        };
      },
    });
  }

  /**
   * 对数扫频测量：单次播放 chirp，解卷积求冲激响应并取幅度谱。
   * 开头不做裁剪，对齐完全依赖 deconvolveIR 内部的互相关。
   * @param {{durationSec?:number, tailMs?:number, onProgress?:(p:number)=>void}} opts
   * @returns {Promise<MeasurementResult>}
   */
  async runSweep(opts = {}) {
    const { durationSec = 5, tailMs = 60, onProgress, externalPlayback = false, captureSec = null } = opts || {};
    const sr = this.engine.sampleRate;
    const chirp = generateLogChirp(sr, durationSec, 20, Math.min(20000, sr * 0.47));
    // 协同模式：播放端循环播放带间隔的扫频，采集窗口需覆盖至少两个完整周期
    const waitSec = Number.isFinite(captureSec) && captureSec > 0
      ? captureSec
      : durationSec + tailMs / 1000 + 0.7; // 给硬件延迟留余量
    return this._runMeasurement({
      mode: 'sweep',
      signal: chirp,
      loop: false,
      waitSec,
      onProgress,
      externalPlayback,
      analyze: (pcm, sampleRate) => {
        const grid = createLogGrid(GRID.fMin, GRID.fMax, GRID.ppOct);
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
            sampleRate,
            mode: 'sweep',
            meta: { delayMs: 0, tailMs, peakDb: -100, method: 'deconvolution', degraded: true },
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
        return {
          freqs: grid.freqs,
          rawDb,
          smoothDb,
          sampleRate,
          mode: 'sweep',
          meta: {
            delayMs: delaySamples / sampleRate * 1000,
            tailMs,
            peakDb,
            method: 'deconvolution',
          },
        };
      },
    });
  }

  /**
   * 公共测量流程：生成信号 → startCapture → playBuffer → 100ms 轮询等待 →
   * stopCapture → stopPlayback → DSP 分析 → 返回结果。try/finally 保证播放停止
   * 与 _busy 复位；取消时立即停止并抛 AbortError。
   */
  async _runMeasurement({ mode, signal, loop, waitSec, onProgress, analyze, externalPlayback = false }) {
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
      if (!externalPlayback) {
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
