/**
 * AudioWorklet 采集处理器：收集原始单声道 PCM，不做任何 DSP。
 * 协议（port.postMessage）：
 *   main -> worklet : { type:'start' } | { type:'stop' }
 *   worklet -> main : { type:'chunk', buffer: Float32Array }（transfer buffer）
 *                   | { type:'done' }
 * engine.startCapture/stopCapture 负责把所有 chunk 拼接成一条 Float32Array。
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._recording = false;
    this._pending = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'start') {
        this._recording = true;
        this._pending = 0;
      } else if (msg.type === 'stop') {
        this._recording = false;
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    // 输出必须保持静音，避免把麦克风回放到扬声器造成啸叫
    if (output && output[0]) output[0].fill(0);

    if (this._recording && input && input[0] && input[0].length) {
      const frame = new Float32Array(input[0]);
      this.port.postMessage({ type: 'chunk', buffer: frame }, [frame.buffer]);
      this._pending++;
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
