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
