/**
 * ============================================================================
 * 尚书省 · 主入口（装配 / 状态机 / UI 绑定）
 * ----------------------------------------------------------------------------
 * 六部模块：
 *   吏部 core/dsp.js          频域数学
 *   户部 core/targets.js      目标曲线
 *        core/eq-solver.js    EQ 求解与双二阶响应
 *   兵部 audio/engine.js      音频 I/O
 *        audio/measurement.js 测量编排
 *   礼部 ui/chart.js          频响图表
 *        ui/controls.js       频段编辑器
 *        styles.css           样式
 * 本文件不实现任何 DSP，只负责数据流转与交互。
 * ============================================================================
 */
import { EQ_LIMITS, SAMPLE_RATE, DOM_IDS } from './contracts.js';
import {
  createLogGrid, alignLevel, smoothLogCurve, mapToGrid,
  generatePinkNoise, generateLogChirp, clamp,
} from './core/dsp.js';
import { TARGETS, getTargetMeta, sampleTarget } from './core/targets.js';
import {
  createBand, clampBand, totalEqResponseDb, solveEqBands, eqErrorRms,
} from './core/eq-solver.js';
import {
  SYNC_SWEEP_SEC, SYNC_GAP_SEC, SYNC_PINK_SEC, SYNC_F1, SYNC_F2,
  encodeAdvice, decodeAdvice, extractAdviceCode, buildTransferText,
} from './core/sync-code.js';
import { AudioEngine } from './audio/engine.js';
import { Measurement } from './audio/measurement.js';
import { ResponseChart } from './ui/chart.js';
import { renderBandList } from './ui/controls.js';

const $ = (id) => document.getElementById(id);
const dom = Object.create(null);
for (const id of DOM_IDS) dom[id] = $(id);

/* -------------------------------------------------------------------------- */
/* 状态                                                                        */
/* -------------------------------------------------------------------------- */
const state = {
  engine: null,
  measurement: null,
  chart: null,
  grid: createLogGrid(),

  bands: [],
  bypass: false,

  measuredRaw: null,   // 未平滑实测（GRID 上，dB）
  measured: null,      // 对齐 + 平滑后
  verifyRaw: null,
  verify: null,
  target: null,
  delta: null,
  eq: null,

  hasMeasurement: false,
  lastMeta: null,
  busy: false,

  mode: 'pink',
  role: 'standalone',
  beaconActive: false,
  smoothing: 3,
  targetId: 'harman-speaker',
  tilt: 0,
  bass: 0,
  view: 'response',
  showRaw: false,
  fileBuffer: null,
};

let toastTimer = 0;
let levelTimer = 0;

/* -------------------------------------------------------------------------- */
/* 通用工具                                                                    */
/* -------------------------------------------------------------------------- */

/** 把曲线限制在有限且可读的范围，避免图表被极端值拉坏 */
function clampCurve(arr, lo = -60, hi = 40) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]);
    out[i] = Number.isFinite(v) ? clamp(v, lo, hi) : lo;
  }
  return out;
}

function fmtDb(v) {
  if (!Number.isFinite(v)) return '−∞ dB';
  const s = v.toFixed(1).replace('-', '−');
  return (v > 0 ? '+' : '') + s + ' dB';
}

function toast(message, kind = 'info') {
  const el = dom.toast;
  if (!el) return;
  el.textContent = message;
  el.className = 'toast toast--' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function setPill(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = 'pill pill--' + kind;
}

function notice(message, kind = 'warn') {
  const el = dom.noticeBar;
  if (!el) return;
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.className = 'notice-bar notice-bar--' + kind;
  el.hidden = false;
}

function setHint(text, visible = true) {
  if (!dom.chartHint) return;
  dom.chartHint.textContent = text || '';
  dom.chartHint.hidden = !visible || !text;
}

function setBusy(on, label) {
  state.busy = on;
  const isPlayer = state.role === 'player';
  const isProbe = state.role === 'probe';
  dom.btnMeasure.disabled = on || isPlayer;
  dom.btnCancel.disabled = !on;
  dom.btnVerify.disabled = on || isPlayer || !state.hasMeasurement;
  dom.btnPlay.disabled = on || isProbe;
  dom.btnStop.disabled = isProbe;
  dom.btnBeaconPink.disabled = isProbe;
  dom.btnBeaconSweep.disabled = isProbe;
  dom.btnAutoEq.disabled = on || !state.hasMeasurement;
  if (label) dom.btnMeasure.textContent = label;
  if (!on) {
    dom.btnMeasure.textContent = isProbe
      ? '开始采集（外部播放）'
      : (state.mode === 'sweep' ? '开始扫频测量' : '开始测量');
  }
  if (!on) dom.measureProgress.style.width = '0%';
}

/* -------------------------------------------------------------------------- */
/* 引擎装配                                                                    */
/* -------------------------------------------------------------------------- */

function updateStatus() {
  const e = state.engine;
  setPill(dom.statusCtx, e && e.ready ? '音频引擎 就绪' : '音频引擎 未启动',
    e && e.ready ? 'on' : 'off');
  setPill(dom.statusMic, e && e.micReady ? '麦克风 已连接' : '麦克风 未授权',
    e && e.micReady ? 'on' : 'off');
  if (dom.statusRate) dom.statusRate.textContent = e && e.ready ? `${e.sampleRate} Hz` : '— Hz';
  if (dom.footerInfo) {
    dom.footerInfo.textContent = e && e.ready
      ? `采样率 ${e.sampleRate} Hz · 麦克风${e.micReady ? '已连接' : '未连接'}`
      : '采样率 — · 麦克风 —';
  }
}

/**
 * 惰性初始化。必须在用户手势调用链内执行（iOS / Chrome 自动播放策略）。
 * @param {boolean} needMic 是否需要麦克风权限
 * @returns {Promise<boolean>} 是否满足前置条件
 */
async function ensureEngine(needMic) {
  if (!state.engine) {
    state.engine = new AudioEngine();
    state.measurement = new Measurement(state.engine);
    state.engine.addEventListener('error', (ev) => {
      const msg = ev && ev.detail && ev.detail.message;
      if (msg) toast(msg, 'warn');
    });
  }
  const eng = state.engine;

  if (!eng.ready) {
    setPill(dom.statusCtx, '正在启动音频引擎…', 'warn');
    try {
      await eng.init();
    } catch (err) {
      updateStatus();
      toast('音频引擎启动失败：' + (err && err.message ? err.message : String(err)), 'error');
      return false;
    }
  }

  try { await eng.resume(); } catch (_) { /* 某些浏览器已处于 running，忽略 */ }
  eng.setMasterGainDb(Number(dom.outputGain.value));
  eng.setBands(state.bands);
  eng.setBypass(state.bypass);

  if (needMic && !eng.micReady) {
    setPill(dom.statusMic, '等待麦克风授权…', 'warn');
    const r = await eng.requestMic();
    if (!r.ok) {
      updateStatus();
      toast('麦克风不可用：' + (r.error || '未知原因'), 'error');
      return false;
    }
    // 实际生效的约束若与请求不符，必须显式警告（AEC/AGC/NS 会毁掉测量）
    const s = r.settings || {};
    const bad = [];
    if (s.echoCancellation === true) bad.push('回声消除(AEC)');
    if (s.autoGainControl === true) bad.push('自动增益(AGC)');
    if (s.noiseSuppression === true) bad.push('噪声抑制(NS)');
    const unknown = [];
    if (s.echoCancellation !== true && s.echoCancellation !== false) unknown.push('AEC');
    if (s.autoGainControl !== true && s.autoGainControl !== false) unknown.push('AGC');
    if (s.noiseSuppression !== true && s.noiseSuppression !== false) unknown.push('NS');
    if (bad.length) {
      notice('检测到浏览器仍强制开启了 ' + bad.join('、') +
        '，这些处理会显著扭曲频响测量结果。建议更换浏览器（桌面 Chrome/Edge 表现最佳）或忽略曲线的绝对形状。', 'warn');
    } else if (unknown.length) {
      notice('浏览器未报告 ' + unknown.join('、') + ' 的实际状态，无法确认它们已关闭。测量结果可能包含麦克风处理。', 'warn');
    } else {
      notice('', 'warn');
    }
  }
  updateStatus();
  return !needMic || eng.micReady;
}

/* -------------------------------------------------------------------------- */
/* 曲线计算                                                                    */
/* -------------------------------------------------------------------------- */

function applyTarget() {
  state.target = sampleTarget(state.targetId, state.grid.freqs, {
    tiltDbPerOct: state.tilt,
    bassDb: state.bass,
  });
}

function recomputeCurves() {
  const f = state.grid.freqs;
  if (!state.target) applyTarget();

  if (state.measuredRaw) {
    const sm = smoothLogCurve(f, state.measuredRaw, state.smoothing);
    state.measured = alignLevel(sm, state.target, f);
    const d = new Float64Array(f.length);
    for (let i = 0; i < f.length; i++) {
      d[i] = clamp(state.target[i] - state.measured[i], -40, 40);
    }
    state.delta = d;
  } else {
    state.measured = null;
    state.delta = null;
  }

  state.verify = state.verifyRaw
    ? alignLevel(smoothLogCurve(f, state.verifyRaw, state.smoothing), state.target, f)
    : null;

  state.eq = totalEqResponseDb(state.bands, f, state.engine?.sampleRate || SAMPLE_RATE);
}

function updateChart() {
  if (!state.chart) return;
  const f = state.grid.freqs;
  state.chart.setData({
    freqs: f,
    measured: state.measured,
    measuredRaw: (state.showRaw && state.measuredRaw)
      ? alignLevel(state.measuredRaw, state.target, f)
      : null,
    target: state.target,
    delta: state.delta,
    eq: state.eq,
    verify: state.verify,
    bands: state.bands,
  });
}

function updateStats() {
  const el = dom.curveStats;
  if (!el) return;
  const f = state.grid.freqs;
  const parts = [];

  if (state.delta && state.eq) {
    const zero = new Float64Array(f.length);
    const before = eqErrorRms(state.delta, zero, f);
    const after = eqErrorRms(state.delta, state.eq, f);
    parts.push(state.bypass
      ? `初测偏差 ${before.toFixed(1)} dB · EQ 已旁通`
      : `初测偏差 ${before.toFixed(1)} dB → 预测残差 ${after.toFixed(1)} dB`);
    if (state.verify && state.target) {
      const verifyDelta = Float64Array.from(f, (_, i) => state.target[i] - state.verify[i]);
      parts.push(`复测偏差 ${eqErrorRms(verifyDelta, zero, f).toFixed(1)} dB`);
    }
    parts.push(`${state.bands.length} 段 EQ${state.bypass ? '（已旁通）' : ''}`);
  } else {
    parts.push('等待测量');
  }

  if (state.lastMeta) {
    const m = state.lastMeta;
    if (m.method === 'deconvolution' && Number.isFinite(m.delayMs)) {
      parts.push(`对齐时延 ${m.delayMs.toFixed(1)} ms`);
    }
    if (m.degraded) parts.push('（信号质量偏低，结果已降级）');
  }
  if (state.hasMeasurement && state.mode) {
    parts.push(state.mode === 'sweep' ? '对数扫频' : '粉红噪声');
  }
  el.textContent = parts.join(' · ');
}

function updateEqOverview() {
  const enabled = state.bands.filter((band) => band.enabled !== false).length;
  $('eqConfigured').textContent = `${state.bands.length} / ${EQ_LIMITS.maxBands}`;
  $('eqEnabled').textContent = String(enabled);
  $('eqOutput').textContent = state.bypass ? '已旁通' : enabled ? 'EQ 生效' : '直通';
  $('eqOutput').classList.toggle('is-bypassed', state.bypass);
  dom.btnBypass.setAttribute('aria-pressed', String(state.bypass));
}

/** 数据变更后统一刷新：EQ 链 → 曲线 → 图表 → 统计 */
function refreshAll() {
  recomputeCurves();
  updateChart();
  updateStats();
  updateEqOverview();
  updateAdvice();
}

function applyEqToEngine() {
  if (state.engine && state.engine.ready) {
    state.engine.setBands(state.bands);
    // 信标播放期间强制旁路 EQ，保证手机测到的是未经校正的原始响应；
    // 但不改动 state.bypass（用户在界面上的旁通开关保持不变）
    state.engine.setBypass(state.beaconActive ? true : state.bypass);
  }
}

function renderBands() {
  renderBandList(dom.bandList, state.bands, {
    onChange: (index, patch) => {
      const b = state.bands[index];
      if (!b) return;
      state.bands[index] = clampBand({ ...b, ...patch });
      applyEqToEngine();
      refreshAll();
      // 类型变化会改变卡片控件语义，需要重绘；其余参数变化不重绘以免丢失输入焦点
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'type')) renderBands();
    },
    onRemove: (index) => {
      state.bands.splice(index, 1);
      applyEqToEngine();
      renderBands();
      refreshAll();
    },
    onAdd: () => {
      addBand();
    },
  });
}

function addBand() {
  if (state.bands.length >= EQ_LIMITS.maxBands) {
    toast(`最多 ${EQ_LIMITS.maxBands} 段 EQ`, 'warn');
    return;
  }
  // 在偏差最大的频段附近放置一个新段，默认 0 dB
  let f0 = 1000;
  if (state.delta) {
    let best = 0;
    for (let i = 0; i < state.delta.length; i++) {
      const f = state.grid.freqs[i];
      if (f < EQ_LIMITS.fMin || f > EQ_LIMITS.fMax) continue;
      if (Math.abs(state.delta[i]) > best) { best = Math.abs(state.delta[i]); f0 = f; }
    }
  }
  state.bands.push(createBand({ freq: f0, gain: 0, q: 1.2, type: 'peaking' }));
  state.bands.sort((a, b) => a.freq - b.freq);
  applyEqToEngine();
  renderBands();
  refreshAll();
}

/* -------------------------------------------------------------------------- */
/* 测量                                                                        */
/* -------------------------------------------------------------------------- */

function onProgress(p) {
  dom.measureProgress.style.width = Math.round(p * 100) + '%';
  if (p < 0.985 && state.engine && state.engine.micReady) {
    // 实时预览：把 AnalyserNode 的实时谱映射到 GRID 后立即刷新图表
    const live = state.engine.getLiveSpectrum();
    if (live && live.freqs && live.freqs.length > 2) {
      state.measuredRaw = clampCurve(mapToGrid(live.freqs, live.db, state.grid.freqs));
      refreshAll();
      setHint('实时采集中… ' + Math.round(p * 100) + '%');
    }
  }
}

async function startMeasure(isVerify = false) {
  if (state.busy) return;
  if (state.role === 'player') {
    toast('播放端不负责采集，请切换到「测量端 · 手机」或「一体式」', 'warn');
    return;
  }
  const ok = await ensureEngine(true);
  if (!ok) return;

  const eng = state.engine;
  const external = state.role === 'probe';
  const uiDuration = Number(dom.duration.value);
  const tailMs = Number(dom.tailMs.value);
  // 协同模式下扫频参数两端硬编码一致，避免解卷积参考信号失配
  const durationSec = external && state.mode === 'sweep' ? SYNC_SWEEP_SEC : uiDuration;
  const bypassForMeasure = !external && !isVerify && dom.bypassOnMeasure.checked;
  const savedBypass = state.bypass;
  const prevRaw = state.measuredRaw;
  const prevVerify = state.verifyRaw;
  if (bypassForMeasure) eng.setBypass(true);

  setBusy(true, '采集中…');
  dom.measureNote.textContent = external
    ? '本机只采集、不发声。请确认电脑端正在循环播放对应的测试信号；手机放到听音位并保持静止。'
    : (isVerify
      ? '正在验证：EQ 保持生效，请勿移动设备或改变音量。'
      : (state.mode === 'sweep'
        ? '正在播放对数扫频… 请保持安静，不要移动设备。'
        : '正在播放粉红噪声… 请保持安静，不要移动设备。'));
  setHint('准备采集…');

  let result = null;
  try {
    const opts = { durationSec, onProgress, externalPlayback: external };
    result = state.mode === 'sweep'
      ? await state.measurement.runSweep({
        ...opts,
        tailMs,
        // 循环信标周期 = 扫频 + 间隔；采两个周期保证覆盖至少一次完整扫频
        captureSec: external ? 2 * (SYNC_SWEEP_SEC + SYNC_GAP_SEC) + 0.8 : null,
      })
      : await state.measurement.runPinkNoise(opts);
  } catch (err) {
    if (err && (err.name === 'AbortError' || /取消/.test(String(err.message)))) {
      toast('测量已取消', 'info');
    } else {
      toast('测量失败：' + (err && err.message ? err.message : String(err)), 'error');
    }
  } finally {
    if (bypassForMeasure) eng.setBypass(savedBypass);
    setBusy(false);
  }

  if (!result || result.meta?.degraded) {
    // 失败或取消时回滚实时预览曲线，避免留下不可用于计算 EQ 的临时数据
    state.measuredRaw = prevRaw;
    state.verifyRaw = prevVerify;
    refreshAll();
    setHint(state.hasMeasurement ? '' : '完成一次测量后显示频响曲线', !state.hasMeasurement);
    if (result?.meta?.degraded) {
      toast('录音信号不足或解算失败，未用于自动 EQ；请检查播放、麦克风和系统音效后重测', 'warn');
    }
    return;
  }

  const raw = clampCurve(result.rawDb || result.smoothDb);
  state.lastMeta = result.meta || {};

  if (isVerify && state.hasMeasurement) {
    state.verifyRaw = raw;
    toast('验证完成：紫色曲线为施加 EQ 后的实测结果', 'ok');
  } else {
    state.measuredRaw = raw;
    state.verifyRaw = null;
    state.hasMeasurement = true;
    dom.btnAutoEq.disabled = false;
    dom.btnVerify.disabled = false;
    toast('测量完成，可自动计算 EQ 或手动微调', 'ok');
  }

  refreshAll();
  setHint('');
  dom.measureNote.textContent = '测量完成。保持设备位置不变，可继续调 EQ 并二次测量验证。';
  updateStats();
}

/* -------------------------------------------------------------------------- */
/* 自动 EQ / 播放 / 导出                                                       */
/* -------------------------------------------------------------------------- */

function autoEq() {
  if (!state.hasMeasurement || !state.delta) {
    toast('请先完成一次测量', 'warn');
    return;
  }
  const count = clamp(Number(dom.autoBands.value) || 7, 3, EQ_LIMITS.maxBands);
  const bands = solveEqBands(state.delta, state.grid.freqs, {
    bandCount: count,
    maxGain: 9,
    maxBoost: 4,
    sampleRate: state.engine?.sampleRate || SAMPLE_RATE,
  });
  if (!bands.length) {
    toast('当前偏差很小，无需额外 EQ 调整', 'info');
    return;
  }
  state.bands = bands;
  applyEqToEngine();
  renderBands();
  refreshAll();
  setView('delta');
  toast(`已生成 ${bands.length} 段 EQ 建议，可继续手动微调`, 'ok');
}

async function playSource() {
  const ok = await ensureEngine(false);
  if (!ok) return;
  endBeacon();
  const eng = state.engine;
  const sr = eng.sampleRate;
  const kind = dom.sourceSelect.value;

  try {
    if (kind === 'file') {
      if (!dom.fileInput.files || !dom.fileInput.files[0]) {
        toast('请先选择一个本地音频文件', 'warn');
        return;
      }
      if (!state.fileBuffer || state.fileBuffer.name !== dom.fileInput.files[0].name) {
        dom.playerNote.textContent = '正在解码音频文件…';
        const file = dom.fileInput.files[0];
        const buf = await eng.playFile(file);
        state.fileBuffer = { name: file.name, buffer: buf };
      }
      eng.setBypass(state.bypass);
      await eng.playBuffer(state.fileBuffer.buffer, true);
      dom.playerNote.textContent = `正在播放：${state.fileBuffer.name}（已应用 EQ，循环播放）`;
    } else if (kind === 'sweep') {
      const sig = generateLogChirp(sr, 8, 20, Math.min(20000, sr * 0.47));
      eng.setBypass(state.bypass);
      await eng.playBuffer(eng.createBuffer(sig), true);
      dom.playerNote.textContent = '正在播放对数扫频（已应用 EQ）。';
    } else {
      const sig = generatePinkNoise(sr, 8, 20261124);
      eng.setBypass(state.bypass);
      await eng.playBuffer(eng.createBuffer(sig), true);
      dom.playerNote.textContent = '正在播放粉红噪声（已应用 EQ）。';
    }
  } catch (err) {
    toast('播放失败：' + (err && err.message ? err.message : String(err)), 'error');
  }
}

function exportJson() {
  const f = state.grid.freqs;
  const toArr = (a) => a ? Array.from(a, (v) => Number(Number(v).toFixed(3))) : null;
  const payload = {
    app: 'Speaker EQ Tuner',
    version: 1,
    createdAt: new Date().toISOString(),
    sampleRate: state.engine && state.engine.ready ? state.engine.sampleRate : null,
    target: {
      id: state.targetId,
      tiltDbPerOct: state.tilt,
      bassDb: state.bass,
      smoothing: `1/${state.smoothing} oct`,
    },
    measurement: state.hasMeasurement
      ? { mode: state.mode, meta: state.lastMeta || {} }
      : null,
    bands: state.bands.map((b) => ({ ...b })),
    curves: {
      freqsHz: toArr(f),
      targetDb: toArr(state.target),
      measuredDb: toArr(state.measured),
      deltaDb: toArr(state.delta),
      eqDb: toArr(state.eq),
      verifyDb: toArr(state.verify),
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `speaker-eq-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('EQ 参数与曲线已导出为 JSON', 'ok');
}

/* -------------------------------------------------------------------------- */
/* 双端协同：角色 / 标准信标 / 建议码                                          */
/* -------------------------------------------------------------------------- */

function setRoleHint(label, text) {
  dom.roleHint.replaceChildren();
  const b = document.createElement('b');
  b.textContent = label;
  dom.roleHint.appendChild(b);
  dom.roleHint.appendChild(document.createTextNode(' ' + text));
}

/** 切换三种工作角色，同步提示文案与按钮约束 */
function setRole(role) {
  state.role = ['standalone', 'probe', 'player'].includes(role) ? role : 'standalone';
  for (const btn of dom.roleSwitch.querySelectorAll('button')) {
    btn.classList.toggle('is-active', btn.dataset.role === state.role);
  }
  const isProbe = state.role === 'probe';
  const isPlayer = state.role === 'player';

  dom.externalHint.hidden = !isProbe;
  dom.roleHint.hidden = state.role === 'standalone';
  if (isProbe) {
    setRoleHint('测量端 · 手机',
      '本机只录音分析、不发声。请先在电脑端点「循环粉噪 / 循环扫频」，再点本页「开始采集（外部播放）」。');
  } else if (isPlayer) {
    setRoleHint('播放端 · 电脑',
      '本机负责播放测试信号并承载 EQ。先循环播放信标，再把手机端的建议码粘贴到下方导入框。');
  }

  dom.syncDesc.textContent = isProbe
    ? '测量端：完成测量并计算 EQ 后，点「复制建议码」，在电脑端粘贴导入。'
    : (isPlayer
      ? '播放端：把手机复制的建议码粘贴到右侧输入框，点「导入并应用 EQ」即可自动填好全部频段。'
      : '一体式 = 本机自放自录；双端协同 = 手机当测量端只录音分析，电脑当播放端放信号并按建议调 EQ，两端无需网络对时。');

  setBusy(false);
  updateStatus();
}

function adviceMeta() {
  const f = state.grid.freqs;
  return {
    targetId: state.targetId,
    tilt: state.tilt,
    bass: state.bass,
    mode: state.mode,
    fitRms: state.delta && state.eq ? eqErrorRms(state.delta, state.eq, f) : null,
  };
}

/** 刷新建议清单；文本未变化时不写 DOM，避免采集过程中打断用户选中复制 */
function updateAdvice() {
  if (!dom.adviceText) return;
  const text = state.bands.length
    ? buildTransferText(state.bands, adviceMeta())
    : '暂无 EQ 频段。完成测量后点「自动计算 EQ」，或手动添加频段。';
  if (dom.adviceText.textContent !== text) dom.adviceText.textContent = text;
}

async function copyAdvice() {
  if (!state.bands.length) {
    toast('当前没有可复制的 EQ 建议，请先完成测量并计算 EQ', 'warn');
    return;
  }
  const text = buildTransferText(state.bands, adviceMeta());
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    dom.syncNote.textContent = '已复制，去电脑端粘贴导入。';
    toast('建议清单与建议码已复制到剪贴板', 'ok');
  } catch (err) {
    dom.syncNote.textContent = '复制失败，请手动选中上方文本复制。';
    toast('复制失败：' + (err && err.message ? err.message : String(err)), 'warn');
  }
}

function importAdvice() {
  const code = extractAdviceCode(dom.importText.value || '');
  if (!code) {
    toast('未找到建议码（应以 SEQ1| 开头）', 'warn');
    return;
  }
  const parsed = decodeAdvice(code);
  if (!parsed.ok) {
    toast('建议码无效：' + (parsed.error || '格式错误'), 'error');
    return;
  }
  state.bands = parsed.bands.map((b) => createBand({
    type: b.type, freq: b.freq, gain: b.gain, q: b.q, enabled: b.enabled,
  }));
  // 同步目标曲线口径，保证电脑端与测量端用同一条参考曲线
  const m = parsed.meta || {};
  if (m.targetId && TARGETS.some((t) => t.id === m.targetId)) {
    state.targetId = m.targetId;
    dom.targetSelect.value = m.targetId;
    dom.targetDesc.textContent = getTargetMeta(m.targetId).description;
  }
  if (Number.isFinite(m.tilt)) {
    state.tilt = m.tilt;
    dom.targetTilt.value = String(m.tilt);
    dom.tiltOut.textContent = (m.tilt > 0 ? '+' : '') + m.tilt.toFixed(1) + ' dB/oct';
  }
  if (Number.isFinite(m.bass)) {
    state.bass = m.bass;
    dom.targetBass.value = String(m.bass);
    dom.bassOut.textContent = (m.bass > 0 ? '+' : '') + m.bass.toFixed(1) + ' dB';
  }
  applyTarget();
  applyEqToEngine();
  renderBands();
  refreshAll();
  dom.syncNote.textContent = `已导入 ${state.bands.length} 段 EQ，可直接试听。`;
  toast(`已导入 ${state.bands.length} 段 EQ 并应用到播放链`, 'ok');
}

/** 播放端标准信标：循环播放未经 EQ 的测试信号，手机端可随时开始采集 */
async function playBeacon(kind) {
  const ok = await ensureEngine(false);
  if (!ok) return;
  const eng = state.engine;
  const sr = eng.sampleRate;
  if (state.role === 'standalone') {
    toast('循环信标用于双端协同；一体式请直接点「开始测量」', 'info');
  }
  try {
    let sig;
    if (kind === 'sweep') {
      const chirp = generateLogChirp(sr, SYNC_SWEEP_SEC, SYNC_F1, Math.min(SYNC_F2, sr * 0.47));
      // 「扫频 — 静音」循环：间隔段全零，避免相邻周期污染手机端的解卷积窗口
      sig = new Float32Array(chirp.length + Math.round(sr * SYNC_GAP_SEC));
      sig.set(chirp, 0);
    } else {
      sig = generatePinkNoise(sr, SYNC_PINK_SEC, 20261124);
    }
    state.beaconActive = true;
    applyEqToEngine(); // 信标期间强制旁路 EQ，但不改动界面上的旁通开关
    await eng.playBuffer(eng.createBuffer(sig), true);
    dom.playerNote.textContent = kind === 'sweep'
      ? `正在循环播放标准扫频（${SYNC_SWEEP_SEC} s + ${SYNC_GAP_SEC} s 间隔，已旁路 EQ）。手机端请选择「对数扫频」并点开始采集。`
      : '正在循环播放粉红噪声（已旁路 EQ）。手机端请选择「粉红噪声」并点开始采集。';
  } catch (err) {
    state.beaconActive = false;
    applyEqToEngine();
    toast('信标播放失败：' + (err && err.message ? err.message : String(err)), 'error');
  }
}

/** 结束信标态并恢复 EQ 链路 */
function endBeacon() {
  if (!state.beaconActive) return;
  state.beaconActive = false;
  applyEqToEngine();
}

/* -------------------------------------------------------------------------- */
/* 视图 / 事件绑定                                                             */
/* -------------------------------------------------------------------------- */

function setView(view) {
  state.view = view === 'delta' ? 'delta' : 'response';
  if (state.chart) state.chart.setView(state.view);
  for (const btn of dom.viewTabs.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.view === state.view);
  }
  // delta 视图弱化无关图例
  const items = dom.chartLegend.querySelectorAll('.legend__item');
  if (items.length >= 4) {
    items[0].style.opacity = state.view === 'delta' ? '0.35' : '1';
    items[1].style.opacity = state.view === 'delta' ? '0.35' : '1';
    items[2].style.opacity = '1';
    items[3].style.opacity = state.view === 'delta' ? '0.35' : '1';
  }
}

function bindEvents() {
  // 视图切换
  dom.viewTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setView(btn.dataset.view);
  });

  // 测量模式
  dom.measureMode.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    for (const b of dom.measureMode.querySelectorAll('button')) {
      b.classList.toggle('is-active', b === btn);
    }
    dom.btnMeasure.textContent = state.mode === 'sweep' ? '开始扫频测量' : '开始测量';
    dom.measureNote.textContent = state.mode === 'sweep'
      ? '精密模式：扫频 + 互相关对齐 + 解卷积，可抑制环境噪声与房间反射。'
      : '请先把设备音量调到常用档位，保持手机/麦克风与扬声器相对位置固定。';
  });

  // 数值控件
  dom.duration.addEventListener('input', () => { dom.durationOut.textContent = dom.duration.value + ' s'; });
  dom.tailMs.addEventListener('input', () => { dom.tailOut.textContent = dom.tailMs.value + ' ms'; });
  dom.outputGain.addEventListener('input', () => {
    const v = Number(dom.outputGain.value);
    dom.outputGainOut.textContent = fmtDb(v);
    if (state.engine && state.engine.ready) state.engine.setMasterGainDb(v);
  });
  dom.smoothing.addEventListener('change', () => {
    state.smoothing = Number(dom.smoothing.value);
    refreshAll();
  });
  dom.targetTilt.addEventListener('input', () => {
    state.tilt = Number(dom.targetTilt.value);
    dom.tiltOut.textContent = (state.tilt > 0 ? '+' : '') + state.tilt.toFixed(1) + ' dB/oct';
    applyTarget();
    refreshAll();
  });
  dom.targetBass.addEventListener('input', () => {
    state.bass = Number(dom.targetBass.value);
    dom.bassOut.textContent = (state.bass > 0 ? '+' : '') + state.bass.toFixed(1) + ' dB';
    applyTarget();
    refreshAll();
  });
  dom.targetSelect.addEventListener('change', () => {
    state.targetId = dom.targetSelect.value;
    const meta = getTargetMeta(state.targetId);
    dom.targetDesc.textContent = meta.description;
    applyTarget();
    refreshAll();
  });
  dom.showRaw.addEventListener('change', () => {
    state.showRaw = dom.showRaw.checked;
    if (state.chart) state.chart.setShowRaw(state.showRaw);
    updateChart();
  });

  // 测量
  dom.btnMeasure.addEventListener('click', () => startMeasure(false));
  dom.btnCancel.addEventListener('click', () => {
    if (state.measurement) state.measurement.cancel();
  });
  dom.btnVerify.addEventListener('click', () => startMeasure(true));

  // EQ
  dom.btnAutoEq.addEventListener('click', autoEq);
  dom.btnAddBand.addEventListener('click', addBand);
  dom.btnResetEq.addEventListener('click', () => {
    state.bands = [];
    applyEqToEngine();
    renderBands();
    refreshAll();
    toast('EQ 已重置', 'info');
  });
  dom.btnBypass.addEventListener('click', () => {
    state.bypass = !state.bypass;
    dom.btnBypass.textContent = '旁通：' + (state.bypass ? '开' : '关');
    dom.btnBypass.classList.toggle('btn--accent', state.bypass);
    applyEqToEngine();
    refreshAll();
  });
  dom.btnExport.addEventListener('click', exportJson);

  // 图表拖拽（礼部派发到 canvas 上的自定义事件）
  dom.chartCanvas.addEventListener('banddrag', (e) => {
    const { index, freq, gain } = e.detail;
    const b = state.bands[index];
    if (!b) return;
    state.bands[index] = clampBand({ ...b, freq, gain });
    applyEqToEngine();
    refreshAll();
  });
  dom.chartCanvas.addEventListener('bandchange', (e) => {
    const { index, freq, gain } = e.detail;
    const b = state.bands[index];
    if (!b) return;
    state.bands[index] = clampBand({ ...b, freq, gain });
    applyEqToEngine();
    renderBands();
    refreshAll();
  });

  // 播放
  dom.btnPlay.addEventListener('click', playSource);
  dom.btnStop.addEventListener('click', () => {
    if (state.engine) state.engine.stopPlayback();
    endBeacon();
    dom.playerNote.textContent = '已停止播放。';
  });
  dom.fileInput.addEventListener('change', () => {
    state.fileBuffer = null;
    if (dom.fileInput.files && dom.fileInput.files[0]) {
      dom.sourceSelect.value = 'file';
      dom.playerNote.textContent = `已选择：${dom.fileInput.files[0].name}，点击「试听」开始播放。`;
    }
  });

  // 双端协同
  dom.roleSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-role]');
    if (btn) setRole(btn.dataset.role);
  });
  dom.btnBeaconPink.addEventListener('click', () => playBeacon('pink'));
  dom.btnBeaconSweep.addEventListener('click', () => playBeacon('sweep'));
  dom.btnCopyAdvice.addEventListener('click', copyAdvice);
  dom.btnImportAdvice.addEventListener('click', importAdvice);

  // 帮助弹窗
  const openHelp = () => { dom.helpModal.hidden = false; };
  const closeHelp = () => { dom.helpModal.hidden = true; };
  dom.btnHelp.addEventListener('click', openHelp);
  dom.btnHelpClose.addEventListener('click', closeHelp);
  dom.helpModal.addEventListener('click', (e) => {
    if (e.target.dataset.close) closeHelp();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.helpModal.hidden) closeHelp();
  });

  // 尺寸与页面生命周期
  window.addEventListener('resize', () => { if (state.chart) state.chart.resize(); });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (state.chart) state.chart.resize(); }, 250);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.busy && state.measurement) {
      state.measurement.cancel();
      toast('页面切到后台，测量已自动取消', 'warn');
    }
  });
}

function startLevelMeter() {
  clearInterval(levelTimer);
  levelTimer = setInterval(() => {
    const e = state.engine;
    if (!e || !e.micReady) return;
    let db = -100;
    try { db = e.getInputLevelDb(); } catch (_) { return; }
    const pct = clamp((db + 60) / 60 * 100, 0, 100);
    dom.levelBar.style.width = pct.toFixed(1) + '%';
    dom.levelBar.style.background = db > -6 ? '#ff6b6b' : (db > -18 ? '#ffb454' : '#45d6a0');
    dom.levelText.textContent = fmtDb(db);
  }, 120);
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

function bootstrap() {
  // 目标曲线下拉
  for (const t of TARGETS) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    dom.targetSelect.appendChild(opt);
  }
  dom.targetSelect.value = state.targetId;
  dom.targetDesc.textContent = getTargetMeta(state.targetId).description;

  // 初始数值显示
  dom.durationOut.textContent = dom.duration.value + ' s';
  dom.tailOut.textContent = dom.tailMs.value + ' ms';
  dom.outputGainOut.textContent = fmtDb(Number(dom.outputGain.value));
  dom.tiltOut.textContent = '0.0 dB/oct';
  dom.bassOut.textContent = '0.0 dB';

  state.chart = new ResponseChart(dom.chartCanvas);
  applyTarget();
  refreshAll();
  renderBands();
  setView('response');
  setHint('完成一次测量后显示频响曲线');

  bindEvents();
  setRole('standalone');
  updateStatus();
  startLevelMeter();

  if (!window.isSecureContext) {
    notice('当前页面不是安全上下文（需 HTTPS 或 localhost），麦克风将被浏览器拒绝。桌面端请用 localhost 访问；手机端请部署到 HTTPS 站点。', 'warn');
  } else if (/iPhone|iPad|Android/i.test(navigator.userAgent)) {
    notice('移动端提示：请关闭系统静音开关、保持浏览器在前台、设备平放且远离墙面；测量期间不要移动设备。', 'info');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
