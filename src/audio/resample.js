import { spawnSync } from 'child_process';

// Lightweight PCM16 resampler using linear interpolation.
// Accepts Buffer or ArrayBuffer views containing 16-bit little-endian samples.

function toInt16View(pcmBuffer) {
  if (!pcmBuffer) return null;
  if (pcmBuffer instanceof Int16Array) {
    return pcmBuffer;
  }
  if (Buffer.isBuffer(pcmBuffer)) {
    return new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      Math.floor(pcmBuffer.length / 2)
    );
  }
  if (ArrayBuffer.isView(pcmBuffer)) {
    return new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      Math.floor(pcmBuffer.byteLength / 2)
    );
  }
  if (pcmBuffer instanceof ArrayBuffer) {
    return new Int16Array(pcmBuffer);
  }
  return null;
}

// Resample PCM16 buffer from `fromRate` to `toRate` with simple linear interpolation.
export function resamplePcm16Linear(pcmBuffer, fromRate, toRate) {
  const byteLength = pcmBuffer?.length ?? pcmBuffer?.byteLength ?? 0;
  if (!pcmBuffer || !byteLength) return Buffer.alloc(0);
  if (!fromRate || !toRate || fromRate <= 0 || toRate <= 0) return Buffer.from(pcmBuffer);
  if (fromRate === toRate) return Buffer.from(pcmBuffer);

  const inView = toInt16View(pcmBuffer);
  if (!inView || !inView.length) return Buffer.alloc(0);

  const outSamples = Math.max(1, Math.round((inView.length * toRate) / fromRate));
  const outView = new Int16Array(outSamples);

  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s1 = inView[idx] || 0;
    const s2 = inView[Math.min(idx + 1, inView.length - 1)] || 0;
    outView[i] = Math.round(s1 + (s2 - s1) * frac);
  }

  return Buffer.from(outView.buffer, outView.byteOffset, outView.byteLength);
}

// Windowed-sinc bandlimited resampler (fallback when ffmpeg unavailable).
export function resamplePcm16Sinc(pcmBuffer, fromRate, toRate) {
  const inView = toInt16View(pcmBuffer);
  if (!inView || !inView.length) return Buffer.alloc(0);
  if (fromRate === toRate) return Buffer.from(pcmBuffer);

  const ratio = toRate / fromRate;
  const outSamples = Math.max(1, Math.floor(inView.length * ratio));
  const out = new Int16Array(outSamples);
  const taps = 16; // 33-tap symmetric window
  for (let i = 0; i < outSamples; i += 1) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    let acc = 0;
    let wsum = 0;
    for (let k = -taps; k <= taps; k += 1) {
      const sIdx = idx + k;
      if (sIdx < 0 || sIdx >= inView.length) continue;
      const x = srcPos - sIdx;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 * (1 + Math.cos((Math.PI * k) / taps)); // Hann
      const w = sinc * window;
      acc += inView[sIdx] * w;
      wsum += w;
    }
    const sample = wsum ? acc / wsum : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

let ffmpegChecked = false;
let ffmpegUsable = false;

function hasFfmpegSync() {
  if (ffmpegChecked) return ffmpegUsable;
  const probe = spawnSync('ffmpeg', ['-version']);
  ffmpegUsable = probe.status === 0;
  ffmpegChecked = true;
  return ffmpegUsable;
}

function resampleWithFfmpegSync(pcmBuffer, fromRate, toRate) {
  const result = spawnSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    String(fromRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-ar',
    String(toRate),
    '-ac',
    '1',
    'pipe:1',
  ], {
    input: pcmBuffer,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout?.length) {
    return result.stdout;
  }
  return null;
}

export function resamplePcm16Best(pcmBuffer, fromRate, toRate) {
  if (!pcmBuffer?.length) return Buffer.alloc(0);
  if (fromRate === toRate) return Buffer.from(pcmBuffer);
  if (hasFfmpegSync()) {
    const ff = resampleWithFfmpegSync(pcmBuffer, fromRate, toRate);
    if (ff?.length) return ff;
  }
  return resamplePcm16Sinc(pcmBuffer, fromRate, toRate);
}

// Specific downsampler for 24k PCM16LE -> 8k PCM16LE (averages groups of 3 samples).
export function downsamplePcm16leBy3(pcmBuffer) {
  const byteLength = pcmBuffer?.length ?? pcmBuffer?.byteLength ?? 0;
  if (!pcmBuffer || !byteLength) return Buffer.alloc(0);
  const inSamples = Math.floor(byteLength / 2);
  const inView = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, inSamples);
  const outSamples = Math.floor(inSamples / 3);
  if (outSamples <= 0) return Buffer.alloc(0);
  const outView = new Int16Array(outSamples);
  for (let i = 0; i < outSamples; i += 1) {
    const base = i * 3;
    const s1 = inView[base] || 0;
    const s2 = inView[base + 1] || 0;
    const s3 = inView[base + 2] || 0;
    outView[i] = Math.round((s1 + s2 + s3) / 3);
  }
  return Buffer.from(outView.buffer, outView.byteOffset, outView.byteLength);
}

export default {
  resamplePcm16Linear,
  downsamplePcm16leBy3,
};
