/**
 * ============================================================================
 * 模块契约 v1.0 —— 所有子模块必须严格遵守
 * ----------------------------------------------------------------------------
 * 本文件只定义「常量 + JSDoc 类型 + 接口签名」，不含任何业务逻辑。
 * 六部并行开发时，以本文件为唯一依据；禁止修改本文件。
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
 * 1. 全局常量
 * ------------------------------------------------------------------------- */

/** 统一对数频率网格。所有曲线数组长度必须 === createLogGrid(...).n */
export const GRID = Object.freeze({ fMin: 20, fMax: 20000, ppOct: 24 });

/** 参量 EQ 参数边界 */
export const EQ_LIMITS = Object.freeze({
  fMin: 30,
  fMax: 18000,
  gainMin: -12,
  gainMax: 12,
  qMin: 0.4,
  qMax: 8,
  maxBands: 12,
});

/** 图表配色（暗色主题，与 styles.css 保持一致） */
export const COLORS = Object.freeze({
  bg: '#0b1017',
  grid: '#1e3247',
  gridMajor: '#2f4a66',
  axis: '#8fa3b8',
  text: '#e8f0f8',
  measured: '#5aa9ff',
  measuredRaw: '#2b5a8c',
  target: '#ffb454',
  delta: '#ff7a6b',
  eq: '#45d6a0',
  verify: '#c58cff',
  zero: '#4a5a6b',
});

/** 音频引擎固定采样率。AudioContext 与采集链共用，保证播放/录制时钟一致。 */
export const SAMPLE_RATE = 48000;

/** 参考对齐频带（Hz）：在此带内把实测均值对齐到目标均值 */
export const REF_BAND = Object.freeze({ lo: 300, hi: 3000 });

/* ---------------------------------------------------------------------------
 * 2. 数据结构
 * ------------------------------------------------------------------------- */

/**
 * @typedef {Object} Band 单个参量 EQ 频段
 * @property {string}  id       唯一标识（字符串）
 * @property {'peaking'|'lowshelf'|'highshelf'} type
 * @property {number}  freq     Hz，中心/转折频率
 * @property {number}  gain     dB
 * @property {number}  q        品质因数（shelf 类型可忽略，但必须存在）
 * @property {boolean} enabled  是否启用
 */

/**
 * @typedef {Object} CurveSet 图表数据集合；每个曲线均为长度 GRID.n 的 Float64Array，单位 dB
 * @property {Float64Array}        freqs       GRID 频率轴
 * @property {Float64Array|null}  measured    平滑后的实测曲线（已做参考带对齐）
 * @property {Float64Array|null}  measuredRaw 未平滑实测曲线
 * @property {Float64Array|null}  target      目标曲线
 * @property {Float64Array|null}  delta       target - measured
 * @property {Float64Array|null}  eq          EQ 总响应
 * @property {Float64Array|null}  verify      二次验证实测曲线
 * @property {Band[]}             bands       EQ 频段（用于绘制可拖拽控制点）
 */

/**
 * @typedef {Object} MeasurementResult
 * @property {Float64Array} freqs      GRID 频率轴
 * @property {Float64Array} rawDb      未平滑曲线 dB（已映射到 GRID；粉噪已扣除参考信号功率谱，参考带对齐由 main.js 完成）
 * @property {Float64Array} smoothDb   按用户平滑档处理后的曲线 dB
 * @property {number}       sampleRate 实际采样率
 * @property {'pink'|'sweep'} mode
 * @property {Object}       meta       附加信息（delayMs / snrDb / tailMs / frames 等，可为 {}）
 */

/* ---------------------------------------------------------------------------
 * 3. 模块接口签名（必须逐字实现，不得改名）
 * ------------------------------------------------------------------------- */

/*
 * 【吏部】src/core/dsp.js
 *
 *   export function nextPow2(n: number): number
 *   export function createLogGrid(fMin?: number, fMax?: number, ppOct?: number): { freqs: Float64Array, n: number }
 *   export function hann(n: number): Float64Array
 *   export function tukey(n: number, r: number): Float64Array
 *   export function generateLogChirp(sampleRate: number, durationSec: number, f1?: number, f2?: number, fadeSec?: number): Float32Array
 *   export function generatePinkNoise(sampleRate: number, durationSec: number, seed?: number): Float32Array
 *   export class FFT { constructor(n: number); forward(re: Float64Array, im: Float64Array): void; inverse(re: Float64Array, im: Float64Array): void; }
 *       // 原地复数 FFT / IFFT；n 必须为 2 的幂；inverse 结果不做 1/n 缩放（由调用方处理）
 *   export function welchPSD(signal: Float32Array|Float64Array, sampleRate: number, fftSize?: number, overlap?: number): { freqs: Float64Array, db: Float64Array }
 *       // 返回单边功率谱 dB；db 允许含任意直流偏置，调用方会做参考带对齐
 *   export function deconvolveIR(recorded: Float32Array, chirp: Float32Array, sampleRate: number, opts?: { tailMs?: number, reg?: number }):
 *       { ir: Float32Array, delaySamples: number, freqs: Float64Array, db: Float64Array, peakDb: number }
 *       // 内部完成：互相关对齐 -> 频域正则化解卷积 -> IFFT -> 主峰定位 -> 加窗(tailMs) -> FFT -> 幅度 dB
 *       // freqs/db 为单边线性频率轴（0..Nyquist，长度 fftSize/2+1），调用方负责映射到 GRID
 *   export function smoothLogCurve(freqs: Float64Array, db: Float64Array, divisor: number): Float64Array
 *       // divisor: 3 => 1/3 倍频程，6 => 1/6，12 => 1/12，1 => 1 倍频程；在 log2(f) 域做高斯/三角加权平滑
 *   export function mapToGrid(srcFreqs: Float64Array, srcDb: Float64Array, gridFreqs: Float64Array): Float64Array
 *       // 对数频率域线性插值；带外做常数外推并做轻量衰减，禁止产生 NaN/Infinity
 *   export function alignLevel(measuredDb: Float64Array, targetDb: Float64Array, freqs: Float64Array, refLo?: number, refHi?: number): Float64Array
 *       // 返回新的 Float64Array：整体平移 measuredDb，使参考带均值 == targetDb 参考带均值
 *   export function rmsDb(x: Float32Array|Float64Array): number
 *   export function clamp(v: number, lo: number, hi: number): number
 *
 * 【户部】src/core/targets.js
 *
 *   export const TARGETS: Array<{ id: string, name: string, description: string, points: Array<[number, number]> }>
 *       // 包含：flat / small-speaker / harman-speaker / harman-headphone / warm / vocal
 *       // points 为 [频率Hz, 相对dB] 控制点，按频率升序
 *   export function getTargetMeta(id: string): { id, name, description, points }
 *   export function sampleTarget(id: string, freqs: Float64Array, opts?: { tiltDbPerOct?: number, bassDb?: number }): Float64Array
 *       // 对数频率插值；tiltDbPerOct 以 1kHz 为轴；bassDb 为 200Hz 以下的 shelf 抬升/衰减
 *   export function normalizeTarget(db: Float64Array, freqs: Float64Array): Float64Array
 *       // 把目标整体平移，使 300–3000Hz 参考带均值为 0 dB
 *
 * 【户部】src/core/eq-solver.js
 *
 *   export function createBand(partial?: Partial<Band>): Band
 *   export function clampBand(band: Band): Band            // 按 EQ_LIMITS 钳制，返回新对象
 *   export function biquadMagnitudeDb(band: Band, freqs: Float64Array, sampleRate?: number): Float64Array
 *       // RBJ cookbook 解析式求 |H(f)| dB；band.enabled === false 时返回全 0
 *   export function totalEqResponseDb(bands: Band[], freqs: Float64Array, sampleRate?: number): Float64Array
 *   export function solveEqBands(deltaDb: Float64Array, freqs: Float64Array, opts?: { bandCount?: number, maxGain?: number, maxBoost?: number, sampleRate?: number }): Band[]
 *       // 贪心迭代：平滑 delta -> 反复找出最大偏差处放置 peaking 滤波器并减去其理论响应
 *       // 末尾做一次增益最小二乘微调；返回结果按 freq 升序，长度 <= EQ_LIMITS.maxBands
 *   export function eqErrorRms(deltaDb: Float64Array, eqDb: Float64Array, freqs: Float64Array): number
 *       // 返回参考带/全带内 (delta - eq) 的加权 RMS，供 UI 显示「拟合误差」
 *
 * 【兵部】src/audio/engine.js
 *
 *   export class AudioEngine extends EventTarget
 *     constructor()
 *     async init(): Promise<void>
 *         // new AudioContext({sampleRate:48000, latencyHint:'interactive'})；建立播放链与静音采集链；
 *         // worklet 模块地址用 new URL(`${import.meta.env.BASE_URL}capture-worklet.js`, location.href).href
 *         // 不支持 AudioWorklet 时回退 ScriptProcessorNode
 *     async requestMic(): Promise<{ ok: boolean, settings: Object, error?: string }>
 *         // getUserMedia({ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1 } })
 *         // 返回 track.getSettings() 的实际值；失败时 ok=false 且 error 为中文说明
 *     get sampleRate(): number
 *     get ready(): boolean
 *     get micReady(): boolean
 *     async resume(): Promise<void>
 *     setMasterGainDb(db: number): void
 *     setBands(bands: Band[]): void       // 重建 EQ biquad 链；空数组 => 直通
 *     setBypass(on: boolean): void        // 旁路 EQ（不改变 bands 数据）
 *     async playBuffer(buffer: AudioBuffer, loop?: boolean): Promise<void>  // 经 EQ 链播放；返回立即 resolve
 *     async playFile(file: File): Promise<AudioBuffer>                     // decodeAudioData
 *     stopPlayback(): void
 *     async startCapture(): Promise<void>
 *     async stopCapture(): Promise<Float32Array>   // 拼接所有片段，返回单声道 PCM
 *     getLiveSpectrum(): { freqs: Float64Array, db: Float64Array } | null  // AnalyserNode 实时谱
 *     getInputLevelDb(): number
 *     async close(): void
 *     // 事件：'level'（每 ~100ms）、'error'
 *
 * 【兵部】src/audio/measurement.js
 *
 *   export class Measurement
 *     constructor(engine: AudioEngine)
 *     cancel(): void
 *     async runPinkNoise(opts: { durationSec: number, onProgress?: (p:number)=>void }): Promise<MeasurementResult>
 *     async runSweep(opts: { durationSec: number, tailMs: number, onProgress?: (p:number)=>void }): Promise<MeasurementResult>
 *     // 两者内部：生成信号 -> engine.startCapture() -> engine.playBuffer() -> 等待 -> engine.stopCapture()
 *     // -> DSP 分析 -> mapToGrid -> smoothLogCurve(divisor=6) -> 返回结果
 *     // 测量期间不得修改 engine 的 EQ 设置（由 main.js 负责旁路）
 *     // 取消时抛出 DOMException('已取消','AbortError') 或返回 null；main.js 需兼容
 *
 * 【礼部】src/ui/chart.js
 *
 *   export class ResponseChart
 *     constructor(canvas: HTMLCanvasElement)
 *     setData(data: CurveSet): void
 *     setView(view: 'response'|'delta'): void
 *     setShowRaw(on: boolean): void
 *     resize(): void
 *     render(): void
 *     // 拖拽交互：在 canvas 上按下 band 控制点后拖动，移动时派发 CustomEvent('banddrag', {detail:{index,freq,gain}})
 *     //           松手时派发 CustomEvent('bandchange', {detail:{index,freq,gain}})
 *     // 触摸事件同样支持（pointer events）
 *
 * 【礼部】src/ui/controls.js
 *
 *   export function renderBandList(container: HTMLElement, bands: Band[], handlers: {
 *     onChange: (index: number, patch: Partial<Band>) => void,
 *     onRemove: (index: number) => void,
 *     onAdd: () => void
 *   }): void
 *   // 生成每段 band 的 DOM（class 见 styles.css 的 .band / .band__* 约定），绑定 input/change 事件
 *   // 每次调用整体重绘；不得直接修改 bands 数组，只通过 handlers 回调通知 main.js
 *
 * 【礼部】src/styles.css
 *   // 依据 index.html 的 DOM 结构编写完整暗色响应式样式，类名严格对应 index.html 与 .band__* 约定
 *
 * 【尚书省 / 主入口】src/main.js  —— 由主代理编写，负责：
 *   - 状态机、DOM 绑定、模块装配、Toast / 帮助弹窗、导出 JSON、进度与电平刷新
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * 4. DOM id 清单（index.html 已定义，main.js / 礼部按此取用）
 * ------------------------------------------------------------------------- */
export const DOM_IDS = Object.freeze([
  'statusCtx', 'statusMic', 'statusRate', 'btnHelp', 'noticeBar',
  'chartLegend', 'viewTabs', 'chartCanvas', 'chartHint', 'levelBar', 'levelText', 'curveStats', 'qualityStats',
  'measureMode', 'duration', 'durationOut', 'tailMs', 'tailOut', 'outputGain', 'outputGainOut',
  'smoothing', 'bypassOnMeasure', 'showRaw', 'antiInterference', 'btnMeasure', 'btnCancel', 'measureProgress', 'measureNote',
  'targetSelect', 'targetDesc', 'targetTilt', 'tiltOut', 'targetBass', 'bassOut',
  'btnAutoEq', 'autoBands',
  'btnAddBand', 'btnResetEq', 'btnBypass', 'btnExport', 'bandList',
  'eqModeSeg', 'eqGraphic', 'eqGraphicTools', 'btnCopyGraphic', 'graphicHint', 'eqNote',
  'sourceSelect', 'fileInput', 'btnPlay', 'btnStop', 'btnVerify', 'playerNote',
  'footerInfo', 'helpModal', 'btnHelpClose', 'toast',
  'roleSwitch', 'roleHint', 'externalHint', 'syncDesc', 'adviceText', 'importText',
  'btnCopyAdvice', 'btnImportAdvice', 'syncNote', 'btnBeaconPink', 'btnBeaconSweep',
]);
