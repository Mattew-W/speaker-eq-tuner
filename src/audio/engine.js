/**
 * ============================================================================
 * 兵部 · 音频 I/O 引擎
 * ----------------------------------------------------------------------------
 * 职责：管理 AudioContext、播放链（含参量 EQ）、麦克风采集链、实时电平/频谱，
 *       并为 measurement.js 提供原始 PCM 录制能力。
 * 设计要点：
 *   - 播放与采集共用同一个 AudioContext，保证播放/录制时钟一致；
 *   - 采集链末端经 gain 恒为 0 的 silentGain 连到 destination：Web Audio 只渲染
 *     「连到 destination」的图，同时绝不把麦克风回放到扬声器（避免啸叫）；
 *   - 优先 AudioWorklet，缺失或加载失败时回退 ScriptProcessorNode。
 * ============================================================================
 */
import { SAMPLE_RATE } from '../contracts.js';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;

    // 播放链：eqIn → [biquad...] → eqOut → masterGain → destination
    this.eqIn = null;
    this.eqOut = null;
    this.masterGain = null;
    this._biquads = [];
    this._bands = [];
    this._bypass = false;
    this._source = null;

    // 采集链：micSource → analyser → captureNode → silentGain → destination
    this.micSource = null;
    this.analyser = null;
    this.captureNode = null;
    this.silentGain = null;
    this._stream = null;
    this._useWorklet = false;
    this._recording = false;
    this._chunks = [];
    this._doneWaiter = null;

    // 状态与定时器
    this._ready = false;
    this._micReady = false;
    this._levelTimer = null;
  }

  /**
   * 初始化音频引擎：创建 AudioContext、播放链、静音汇点，并加载采集处理器。
   * 构造参数指定采样率失败时回退无参构造，之后一律以 ctx.sampleRate 为准。
   */
  async init() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      throw new Error('当前浏览器不支持 Web Audio API（AudioContext），无法启动音频引擎。');
    }
    try {
      this.ctx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    } catch (err) {
      // 部分浏览器（尤其旧版 Safari）不支持在构造参数里指定采样率
      try {
        this.ctx = new Ctor();
      } catch (err2) {
        throw new Error('无法创建 AudioContext：' + this._errText(err2));
      }
    }
    const ctx = this.ctx;

    // ---- 播放链：初始无 EQ，eqIn 直连 eqOut ----
    this.eqIn = ctx.createGain();
    this.eqOut = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.eqOut.gain.value = 1;
    this.masterGain.gain.value = 1; // 0 dB
    this.eqIn.connect(this.eqOut);
    this.eqOut.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // ---- 采集链静音汇点：gain 必须为 0，且必须连到 destination 才会被渲染 ----
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.6;

    // ---- 采集节点：优先 AudioWorklet，失败回退 ScriptProcessorNode ----
    try {
      if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
        throw new Error('当前浏览器不支持 AudioWorklet');
      }
      const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
      const url = new URL(`${base}capture-worklet.js`, location.href).href;
      await ctx.audioWorklet.addModule(url);
      this.captureNode = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this._useWorklet = true;
      this.captureNode.port.onmessage = (e) => this._onCaptureMessage(e);
    } catch (err) {
      this._useWorklet = false;
      if (typeof ctx.createScriptProcessor !== 'function') {
        throw new Error('当前浏览器既不支持 AudioWorklet，也不支持 ScriptProcessorNode，无法采集音频。');
      }
      this._emitError('AudioWorklet 采集不可用，已回退 ScriptProcessorNode：' + this._errText(err));
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => {
        // 输出通道显式清零，保持静音，杜绝麦克风回放啸叫
        e.outputBuffer.getChannelData(0).fill(0);
        if (this._recording) {
          this._chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        }
      };
      this.captureNode = sp;
    }

    // 电平事件（约 100ms 一次），close() 中清除
    this._levelTimer = setInterval(() => {
      this.dispatchEvent(new CustomEvent('level', { detail: { db: this.getInputLevelDb() } }));
    }, 100);

    this._ready = true;
  }

  /**
   * 申请麦克风权限并建立采集链。AEC/AGC/NS 必须显式关闭，否则会破坏频响测量。
   * @returns {Promise<{ok:boolean, settings:Object, error?:string}>}
   */
  async requestMic() {
    if (!this.ctx || !this._ready) {
      return { ok: false, settings: {}, error: '音频引擎尚未初始化，请先完成初始化。' };
    }
    if (!window.isSecureContext) {
      return { ok: false, settings: {}, error: '当前页面不是安全上下文（需要 HTTPS 或 localhost），浏览器禁止访问麦克风。' };
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return { ok: false, settings: {}, error: '当前浏览器不支持 getUserMedia，无法采集麦克风。' };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      return { ok: false, settings: {}, error: this._micError(err) };
    }

    if (this._stream && this._stream !== stream) {
      for (const t of this._stream.getTracks()) {
        try { t.stop(); } catch (_) { /* 忽略释放异常 */ }
      }
    }
    this._stream = stream;

    const track = stream.getAudioTracks()[0];
    const actual = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
    // 实际生效值优先，缺失字段用请求值与上下文采样率补齐
    const settings = Object.assign({
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      sampleRate: this.ctx.sampleRate,
      channelCount: 1,
    }, actual);

    try {
      if (this.micSource) {
        try { this.micSource.disconnect(); } catch (_) { /* 忽略 */ }
      }
      try { this.analyser.disconnect(); } catch (_) { /* 忽略 */ }
      try { this.captureNode.disconnect(); } catch (_) { /* 忽略 */ }
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.analyser);
      this.analyser.connect(this.captureNode);
      this.captureNode.connect(this.silentGain);
      // silentGain 已在 init() 连接到 ctx.destination
    } catch (err) {
      for (const t of stream.getTracks()) {
        try { t.stop(); } catch (_) { /* 忽略 */ }
      }
      this._stream = null;
      this._micReady = false;
      const message = '建立麦克风采集链路失败：' + this._errText(err);
      this._emitError(message);
      return { ok: false, settings: {}, error: message };
    }

    this._micReady = true;
    return { ok: true, settings };
  }

  /** 实际采样率（可能被浏览器忽略构造参数，以 AudioContext 为准）。 */
  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : SAMPLE_RATE;
  }

  /** 播放链是否已就绪。 */
  get ready() {
    return !!(this._ready && this.ctx && this.ctx.state !== 'closed');
  }

  /** 麦克风采集链是否已建立。 */
  get micReady() {
    return !!(this._micReady && this._stream && this.ctx && this.ctx.state !== 'closed');
  }

  /** 恢复被浏览器挂起的 AudioContext（iOS 必须在用户手势中调用）。 */
  async resume() {
    if (!this.ctx) {
      throw new Error('音频上下文尚未初始化，无法恢复播放。');
    }
    try {
      if (this.ctx.state !== 'running') {
        await this.ctx.resume();
      }
    } catch (err) {
      const message = '恢复音频上下文失败（iOS 需在用户手势中调用）：' + this._errText(err);
      this._emitError(message);
      throw new Error(message);
    }
  }

  /** 设置总输出增益（dB），用 setTargetAtTime 平滑过渡避免爆音。 */
  setMasterGainDb(db) {
    if (!this.ctx || !this.masterGain) return;
    const gain = Math.pow(10, db / 20);
    this.masterGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
  }

  /** 更新参量 EQ 频段数据并重建 biquad 链；空数组或全禁用即直通。 */
  setBands(bands) {
    this._bands = Array.isArray(bands) ? bands.slice() : [];
    this._rebuildChain();
  }

  /** 旁路 EQ（eqIn 直连 eqOut），不改变 _bands 数据。 */
  setBypass(on) {
    this._bypass = !!on;
    this._rebuildChain();
  }

  /**
   * 统一重建 EQ 链路：断开旧连接、销毁旧 biquad、按启用且有效增益的频段串联。
   * 重建前后对 eqOut.gain 做短暂淡出/淡入，播放进行中不产生爆音；异常时兜底直通。
   */
  _rebuildChain() {
    if (!this.ctx || !this.eqIn || !this.eqOut) return;
    const now = this.ctx.currentTime;
    const g = this.eqOut.gain;

    // 快路径：仅参数变化（拖拽 EQ 控制点 / 滑杆）时直接更新已有 BiquadFilterNode
    // 的 AudioParam，不重建链路、不做淡出淡入，避免高频重建导致的音量抖动与节点泄漏。
    const pending = this._bypass
      ? []
      : this._bands.filter((b) => b && b.enabled && Math.abs(b.gain) > 0.01);
    const sameTopology = this._biquads.length === pending.length &&
      this._biquads.every((node, i) => {
        const wanted = pending[i].type === 'peaking' ? 'peaking' : pending[i].type;
        return node.type === wanted;
      });
    if (sameTopology) {
      const nyquist = this.ctx.sampleRate / 2;
      for (let i = 0; i < pending.length; i++) {
        const b = pending[i];
        const f = this._biquads[i];
        try {
          f.frequency.setTargetAtTime(Math.min(Math.max(b.freq, 10), nyquist * 0.99), now, 0.012);
          f.gain.setTargetAtTime(b.gain, now, 0.012);
          if (f.type === 'peaking') f.Q.setTargetAtTime(b.q, now, 0.012);
        } catch (_) { /* 单个参数更新失败不影响其它段 */ }
      }
      return;
    }

    try {
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.004); // 短暂淡出

      try { this.eqIn.disconnect(); } catch (_) { /* 忽略 */ }
      for (const node of this._biquads) {
        try { node.disconnect(); } catch (_) { /* 忽略 */ }
      }
      this._biquads = [];

      const active = this._bypass
        ? []
        : this._bands.filter((b) => b && b.enabled && Math.abs(b.gain) > 0.01);

      const nyquist = this.ctx.sampleRate / 2;
      let prev = this.eqIn;
      for (const band of active) {
        const f = this.ctx.createBiquadFilter();
        f.type = band.type === 'lowshelf' || band.type === 'highshelf' ? band.type : 'peaking';
        f.frequency.value = Math.min(Math.max(band.freq, 10), nyquist * 0.99);
        f.gain.value = band.gain;
        if (f.type === 'peaking') {
          f.Q.value = band.q; // shelf 类型没有 Q，跳过
        }
        prev.connect(f);
        prev = f;
        this._biquads.push(f);
      }
      prev.connect(this.eqOut); // active 为空时即 eqIn → eqOut 直通
    } catch (err) {
      this._emitError('重建 EQ 链路失败：' + this._errText(err));
      try { this.eqIn.disconnect(); } catch (_) { /* 忽略 */ }
      try { this.eqIn.connect(this.eqOut); } catch (_) { /* 忽略 */ }
    } finally {
      g.setTargetAtTime(1, now + 0.015, 0.008); // 淡入，最终稳定在 0 dB
    }
  }

  /** 经 EQ 链播放 AudioBuffer；多次调用先停掉上一个源，返回立即 resolve。 */
  async playBuffer(buffer, loop = false) {
    if (!this.ctx || !this.eqIn) {
      throw new Error('音频引擎尚未初始化，无法播放音频。');
    }
    this.stopPlayback();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!loop;
    src.connect(this.eqIn);
    src.onended = () => {
      if (this._source === src) this._source = null;
      try { src.disconnect(); } catch (_) { /* 忽略 */ }
    };
    src.start();
    this._source = src;
  }

  /** 解码用户选择的音频文件为 AudioBuffer（自动重采样到上下文采样率）。 */
  async playFile(file) {
    if (!this.ctx) {
      throw new Error('音频引擎尚未初始化，无法解码音频文件。');
    }
    try {
      const raw = await file.arrayBuffer();
      return await this.ctx.decodeAudioData(raw);
    } catch (err) {
      const message = '音频文件解码失败（请确认格式受浏览器支持）：' + this._errText(err);
      this._emitError(message);
      throw new Error(message);
    }
  }

  /** 把单声道 PCM 包装成 AudioBuffer，供 measurement.js 播放测试信号。 */
  createBuffer(data) {
    if (!this.ctx) {
      throw new Error('音频引擎尚未初始化，无法创建音频缓冲区。');
    }
    const src = data instanceof Float32Array ? data : new Float32Array(data);
    const buffer = this.ctx.createBuffer(1, src.length, this.ctx.sampleRate);
    buffer.copyToChannel(src, 0);
    return buffer;
  }

  /** 停止当前播放源并断开，异常一律吞掉。 */
  stopPlayback() {
    const src = this._source;
    this._source = null;
    if (!src) return;
    try { src.onended = null; } catch (_) { /* 忽略 */ }
    try { src.stop(); } catch (_) { /* 忽略 */ }
    try { src.disconnect(); } catch (_) { /* 忽略 */ }
  }

  /** 清空片段缓冲、置录制标志，并向 worklet 发送 {type:'start'}。 */
  async startCapture() {
    if (!this.ctx || !this.captureNode) {
      throw new Error('采集节点尚未就绪，无法开始录音（请确认已完成 init 与 requestMic）。');
    }
    this._chunks = [];
    this._doneWaiter = null;
    this._recording = true;
    if (this._useWorklet && this.captureNode.port) {
      try {
        this.captureNode.port.postMessage({ type: 'start' });
      } catch (err) {
        this._recording = false;
        const message = '开始采集失败：' + this._errText(err);
        this._emitError(message);
        throw new Error(message);
      }
    }
  }

  /**
   * 发送 {type:'stop'}，等待 worklet 的 done（1200ms 超时兜底），随后把所有
   * chunk 一次分配、循环 set 拼成单条 Float32Array；ScriptProcessor 回退直接拼接。
   * @returns {Promise<Float32Array>}
   */
  async stopCapture() {
    if (!this.captureNode) return new Float32Array(0);
    if (this._useWorklet && this.captureNode.port) {
      await new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (this._doneWaiter === finish) this._doneWaiter = null;
          resolve();
        };
        timer = setTimeout(finish, 1200); // done 未到达也继续，避免卡死
        this._doneWaiter = finish;
        try {
          this.captureNode.port.postMessage({ type: 'stop' });
        } catch (err) {
          this._emitError('停止采集指令发送失败：' + this._errText(err));
          finish();
        }
      });
    }
    this._recording = false;
    return this._concatChunks();
  }

  /** AnalyserNode 实时谱：频率轴 i*sr/fftSize，dB 为 getFloatFrequencyData 结果。 */
  getLiveSpectrum() {
    if (!this.ctx || !this.analyser || !this._micReady) return null;
    const n = this.analyser.frequencyBinCount;
    const buf = new Float32Array(n);
    this.analyser.getFloatFrequencyData(buf);
    const freqs = new Float64Array(n);
    const db = new Float64Array(n);
    const step = this.ctx.sampleRate / this.analyser.fftSize;
    for (let i = 0; i < n; i++) {
      freqs[i] = i * step;
      db[i] = buf[i];
    }
    return { freqs, db };
  }

  /** 输入时域 RMS 换算 dB，clamp 到 [-100, 0]；未就绪返回 -100。 */
  getInputLevelDb() {
    if (!this.ctx || !this.analyser || !this._micReady) return -100;
    const n = this.analyser.fftSize;
    const buf = new Float32Array(n);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / n);
    const db = 20 * Math.log10(rms + 1e-12);
    return Math.min(0, Math.max(-100, db));
  }

  /** 释放全部资源：停播放、停麦克风轨道、清定时器、断开节点、关闭上下文。 */
  async close() {
    this.stopPlayback();
    if (this._levelTimer !== null) {
      clearInterval(this._levelTimer);
      this._levelTimer = null;
    }
    this._recording = false;
    if (this._doneWaiter) {
      try { this._doneWaiter(); } catch (_) { /* 忽略 */ }
      this._doneWaiter = null;
    }
    if (this._stream) {
      for (const t of this._stream.getTracks()) {
        try { t.stop(); } catch (_) { /* 忽略 */ }
      }
      this._stream = null;
    }
    const nodes = [
      this.micSource, this.analyser, this.captureNode, this.silentGain,
      this.eqIn, this.eqOut, this.masterGain,
    ].concat(this._biquads);
    for (const node of nodes) {
      if (node) {
        try { node.disconnect(); } catch (_) { /* 忽略 */ }
      }
    }
    if (this.captureNode) {
      try { this.captureNode.port.onmessage = null; } catch (_) { /* 忽略 */ }
      try { this.captureNode.onaudioprocess = null; } catch (_) { /* 忽略 */ }
    }
    this._biquads = [];
    this._chunks = [];
    this._micReady = false;
    this._ready = false;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch (err) {
        this._emitError('关闭音频上下文失败：' + this._errText(err));
      }
    }
  }

  /** worklet 消息：收集 chunk（Float32Array），done 时唤醒 stopCapture 的等待。 */
  _onCaptureMessage(e) {
    const msg = e.data || {};
    if (msg.type === 'chunk') {
      const raw = msg.buffer;
      if (!raw) return;
      const chunk = raw instanceof Float32Array ? raw : new Float32Array(raw);
      if (chunk.length) this._chunks.push(chunk);
    } else if (msg.type === 'done') {
      if (this._doneWaiter) {
        const done = this._doneWaiter;
        this._doneWaiter = null;
        done();
      }
    }
  }

  /** 拼接录制片段：一次分配总长，循环 set，避免 O(n²)。 */
  _concatChunks() {
    let total = 0;
    for (let i = 0; i < this._chunks.length; i++) total += this._chunks[i].length;
    const out = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < this._chunks.length; i++) {
      out.set(this._chunks[i], offset);
      offset += this._chunks[i].length;
    }
    this._chunks = [];
    return out;
  }

  /** 派发 'error' 事件（中文说明放在 detail.message）。 */
  _emitError(message) {
    try {
      this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
    } catch (_) { /* 事件派发失败不影响主流程 */ }
  }

  /** 把 getUserMedia 的常见错误名翻译成中文可读提示。 */
  _micError(err) {
    const name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝：请在浏览器地址栏的权限设置中允许访问麦克风后重试。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '未找到可用的麦克风设备：请确认已连接麦克风且未被系统禁用。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麦克风无法读取：设备可能被其他程序占用或驱动异常，请关闭占用程序后重试。';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return '麦克风不支持所请求的约束（单声道 / 关闭回声消除），请更换设备后重试。';
    }
    return '麦克风采集失败：' + this._errText(err);
  }

  /** 统一提取错误文本。 */
  _errText(err) {
    return err && err.message ? err.message : String(err);
  }
}
