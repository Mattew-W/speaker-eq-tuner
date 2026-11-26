import test from 'node:test';
import assert from 'node:assert/strict';
import { Measurement } from '../src/audio/measurement.js';
import { createLogGrid, deconvolveIR, generateLogChirp, mapToGrid } from '../src/core/dsp.js';
import { biquadMagnitudeDb, eqErrorRms, solveEqBands, totalEqResponseDb } from '../src/core/eq-solver.js';

const sampleRate = 48000;

function nearest(curve, frequencies, target) {
  let best = 0;
  for (let i = 1; i < frequencies.length; i++) {
    if (Math.abs(frequencies[i] - target) < Math.abs(frequencies[best] - target)) best = i;
  }
  return curve[best];
}

test('a flat playback and capture path stays flat after pink-noise reference correction', async () => {
  const measurement = new Measurement({ sampleRate });
  measurement._runMeasurement = async ({ signal, analyze }) => {
    const recorded = new Float32Array(sampleRate * 6);
    const delay = sampleRate / 5;
    for (let i = delay; i < recorded.length; i++) recorded[i] = signal[i - delay] * 0.2;
    return analyze(recorded, sampleRate);
  };
  const result = await measurement.runPinkNoise({ durationSec: 6 });
  const levels = [100, 1000, 10000].map((hz) => nearest(result.rawDb, result.freqs, hz));
  assert.ok(Math.max(...levels) - Math.min(...levels) < 2, `frequency spread: ${levels}`);
});

test('silence cannot become a usable measurement', async () => {
  const measurement = new Measurement({ sampleRate });
  measurement._runMeasurement = async ({ analyze }) => analyze(new Float32Array(sampleRate), sampleRate);
  await assert.rejects(measurement.runPinkNoise({ durationSec: 3 }), /录音过弱/);
});

test('sweep deconvolution recovers a delayed flat path', () => {
  const chirp = generateLogChirp(sampleRate, 1, 20, 20000);
  const delay = 5000;
  const recorded = new Float32Array(chirp.length + sampleRate / 2);
  for (let i = 0; i < chirp.length; i++) recorded[i + delay] = chirp[i] * 0.2;
  const result = deconvolveIR(recorded, chirp, sampleRate, { tailMs: 60 });
  assert.equal(result.delaySamples, delay);
  const levels = mapToGrid(result.freqs, result.db, new Float64Array([100, 1000, 10000]));
  assert.ok(Math.max(...levels) - Math.min(...levels) < 1, `frequency spread: ${levels}`);
});

test('automatic EQ improves a broad error while respecting boost and cut limits', () => {
  const freqs = createLogGrid().freqs;
  const delta = Float64Array.from(freqs, (f) => {
    const x = Math.log2(f / 1000);
    return 6 * Math.exp(-0.5 * (x / 0.7) ** 2);
  });
  const bands = solveEqBands(delta, freqs, { bandCount: 7, maxGain: 9, maxBoost: 4 });
  assert.ok(bands.length > 0);
  assert.ok(bands.every((band) => band.gain <= 4 && band.gain >= -9));
  assert.ok(bands.every((band) => band.type === 'peaking' || band.gain <= 0));
  assert.ok(bands.every((band) => band.gain <= 0 || band.q <= 2));
  const before = eqErrorRms(delta, new Float64Array(freqs.length), freqs);
  const after = eqErrorRms(delta, totalEqResponseDb(bands, freqs), freqs);
  assert.ok(after < before, `${before} -> ${after}`);
});

test('automatic EQ does not boost missing deep bass or the extreme treble', () => {
  const freqs = createLogGrid().freqs;
  for (const missing of [
    (f) => f < 100,
    (f) => f > 16000,
  ]) {
    const delta = Float64Array.from(freqs, (f) => missing(f) ? 18 : 0);
    const bands = solveEqBands(delta, freqs, { bandCount: 7, maxGain: 9, maxBoost: 4 });
    assert.ok(bands.every((band) => band.gain <= 0), JSON.stringify(bands));
  }
});

test('filter prediction uses the actual audio sample rate', () => {
  const band = { type: 'peaking', freq: 15000, gain: 6, q: 2, enabled: true };
  const frequencies = new Float64Array([12000, 15000, 19000]);
  const a = biquadMagnitudeDb(band, frequencies, 44100);
  const b = biquadMagnitudeDb(band, frequencies, 48000);
  assert.ok(a.every(Number.isFinite) && b.every(Number.isFinite));
  assert.ok(Math.abs(a[2] - b[2]) > 0.1);
});

/* ------------------------------------------------------------------------- */
/* 电平与信噪比：回归「音量已开满却提示声音小」的误判                          */
/* ------------------------------------------------------------------------- */

function noiseArray(n, rms, seed = 9951) {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = (s / 2147483648 - 1) * Math.sqrt(3);
  }
  const k = rms;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

test('a quiet but clean recording is accepted: absolute level must not gate the result', async () => {
  const measurement = new Measurement({ sampleRate });
  measurement._runMeasurement = async ({ signal, analyze }) => {
    // 峰值约 -50 dBFS：手机麦克风关闭 AGC 后的常见电平，旧版会被判「录音过弱」
    const recorded = new Float32Array(sampleRate * 6);
    const delay = sampleRate / 5;
    for (let i = delay; i < recorded.length; i++) recorded[i] = signal[i - delay] * 0.003;
    return analyze(recorded, sampleRate);
  };
  const result = await measurement.runPinkNoise({ durationSec: 6 });
  const levels = [200, 1000, 4000].map((hz) => nearest(result.rawDb, result.freqs, hz));
  assert.ok(Math.max(...levels) - Math.min(...levels) < 2, `frequency spread: ${levels}`);
  assert.ok(result.meta.peakDb < -45 && result.meta.peakDb > -60, `peak: ${result.meta.peakDb}`);
});

test('sweep SNR includes matched-filter processing gain instead of under-reporting by ~30 dB', async () => {
  const measurement = new Measurement({ sampleRate });
  const amplitude = 0.2;
  const signalRms = amplitude / Math.SQRT2;
  const noiseRms = signalRms / Math.sqrt(10); // 功率比 10 倍 = 宽带 SNR 10 dB
  measurement._runMeasurement = async ({ signal, silent, analyze, waitSec }) => {
    if (silent) {
      return analyze(noiseArray(Math.round(sampleRate * waitSec), noiseRms), sampleRate);
    }
    const recorded = new Float32Array(Math.round(sampleRate * 5.76));
    const delay = 1200;
    for (let i = 0; i < signal.length && i + delay < recorded.length; i++) {
      recorded[i + delay] = signal[i] * amplitude;
    }
    const noise = noiseArray(recorded.length, noiseRms, 4242);
    for (let i = 0; i < recorded.length; i++) recorded[i] += noise[i];
    return analyze(recorded, sampleRate);
  };

  const result = await measurement.runSweep({ durationSec: 5, repeats: 2, noiseFloorSec: 1 });
  const snrMid = [500, 1000, 2000].map((hz) => nearest(result.snrDb, result.freqs, hz));
  // 未补偿时逐点 SNR 只有 ~20 dB；补上约 30 dB 的处理增益后应显著更高
  assert.ok(Math.min(...snrMid) > 30, `mid-band SNR: ${snrMid}`);
  assert.ok(result.meta.snrGainDb > 20, `processing gain: ${result.meta.snrGainDb}`);
  assert.ok(Math.abs(result.meta.broadbandSnrDb - 10) < 4, `broadband SNR: ${result.meta.broadbandSnrDb}`);

  const reliable = result.weight.filter((w) => w >= 0.5).length / result.weight.length;
  assert.ok(reliable > 0.5, `reliable coverage: ${reliable}`);

  // 界面最终展示的结论不应再出现「提高音量」这类误导文案
  const { describeQuality } = await import('../src/core/quality.js');
  const text = describeQuality(result.weight, result.freqs, result.snrDb, result.meta);
  assert.ok(/^可信/.test(text), text);
  assert.ok(!/提高音量/.test(text), text);
});

test('quality verdict points at the real cause instead of always blaming the volume', async () => {
  const { describeQuality, reliabilityWeight, snrDb } = await import('../src/core/quality.js');
  const n = 24;
  const freqs = Float64Array.from({ length: n }, (_, i) => 100 * Math.pow(2, i / 6));
  const flat = new Float64Array(n).fill(-70);
  const buried = snrDb(flat, new Float64Array(n).fill(-70));
  const weight = reliabilityWeight(buried, null, freqs);
  const text = describeQuality(weight, freqs, buried, {
    repeats: 3,
    noiseFloorDb: -42,
    broadbandSnrDb: -5,
  });
  assert.ok(/环境噪声|播放端/.test(text), text);
  assert.ok(!/提高音量/.test(text), text);
});
