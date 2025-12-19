// Lightweight DSP chain for telephony-friendly audio.

export function initDspState() {
  return {
    dcMean: 0,
    hpPrevInput: 0,
    hpPrevOutput: 0,
    lpPrevOutput: 0,
    compressorEnv: 0,
    agcGain: 1,
    agcEnergyQueue: [],
    agcEnergyTotal: 0,
    agcSampleTotal: 0,
  };
}

export function pcm16ToFloat32(pcmBuffer) {
  const view = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) {
    out[i] = view[i] / 32768;
  }
  return out;
}

export function float32ToPcm16(floatArray) {
  const out = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i += 1) {
    const s = Math.max(-1, Math.min(1, floatArray[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function applyDCRemoval(floatArray, state) {
  const alpha = 0.995;
  for (let i = 0; i < floatArray.length; i += 1) {
    state.dcMean = alpha * state.dcMean + (1 - alpha) * floatArray[i];
    floatArray[i] -= state.dcMean;
  }
}

function onePoleHighpass(floatArray, sampleRate, cutoffHz, state) {
  const c = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  for (let i = 0; i < floatArray.length; i += 1) {
    const x = floatArray[i];
    const y = c * (state.hpPrevOutput + x - state.hpPrevInput);
    state.hpPrevInput = x;
    state.hpPrevOutput = y;
    floatArray[i] = y;
  }
}

function onePoleLowpass(floatArray, sampleRate, cutoffHz, state) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  for (let i = 0; i < floatArray.length; i += 1) {
    state.lpPrevOutput = state.lpPrevOutput + alpha * (floatArray[i] - state.lpPrevOutput);
    floatArray[i] = state.lpPrevOutput;
  }
}

function applyCompressor(floatArray, sampleRate, state, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? -18;
  const ratio = opts.ratio ?? 2.0;
  const attackMs = opts.attackMs ?? 8;
  const releaseMs = opts.releaseMs ?? 140;
  const attack = Math.exp((-1 / sampleRate) * (1000 / attackMs));
  const release = Math.exp((-1 / sampleRate) * (1000 / releaseMs));
  const kneeDb = 2;

  const threshold = Math.pow(10, thresholdDb / 20);

  for (let i = 0; i < floatArray.length; i += 1) {
    const x = floatArray[i];
    const rectified = Math.abs(x);
    if (rectified > state.compressorEnv) {
      state.compressorEnv = attack * (state.compressorEnv - rectified) + rectified;
    } else {
      state.compressorEnv = release * (state.compressorEnv - rectified) + rectified;
    }

    let gain = 1;
    if (state.compressorEnv > threshold) {
      const dbOver = 20 * Math.log10(state.compressorEnv / threshold);
      const compressedDb = dbOver > kneeDb ? dbOver / ratio : (dbOver * 0.5) / ratio;
      const targetDb = compressedDb - dbOver;
      gain = Math.pow(10, targetDb / 20);
    }
    floatArray[i] = x * gain;
  }
}

function applyLimiter(floatArray, ceilingDbfs = -1) {
  const ceiling = Math.pow(10, ceilingDbfs / 20);
  for (let i = 0; i < floatArray.length; i += 1) {
    if (floatArray[i] > ceiling) floatArray[i] = ceiling;
    else if (floatArray[i] < -ceiling) floatArray[i] = -ceiling;
  }
}

function normalizeRms(floatArray, targetDbfs = -20) {
  if (!floatArray.length) return;
  let sumSquares = 0;
  for (let i = 0; i < floatArray.length; i += 1) {
    sumSquares += floatArray[i] * floatArray[i];
  }
  const rms = Math.sqrt(sumSquares / floatArray.length) || 1e-6;
  const currentDb = 20 * Math.log10(rms);
  const neededDb = targetDbfs - currentDb;
  const gain = Math.pow(10, neededDb / 20);
  for (let i = 0; i < floatArray.length; i += 1) {
    floatArray[i] *= gain;
  }
}

function applyAgc(floatArray, sampleRate, state, targetDbfs = -19) {
  if (!floatArray.length) return;
  let sumSquares = 0;
  for (let i = 0; i < floatArray.length; i += 1) {
    sumSquares += floatArray[i] * floatArray[i];
  }
  const chunkSamples = floatArray.length;
  state.agcEnergyQueue.push({ energy: sumSquares, samples: chunkSamples });
  state.agcEnergyTotal += sumSquares;
  state.agcSampleTotal += chunkSamples;
  const windowSamples = sampleRate; // 1s window
  while (state.agcSampleTotal > windowSamples && state.agcEnergyQueue.length) {
    const oldest = state.agcEnergyQueue.shift();
    state.agcEnergyTotal -= oldest.energy;
    state.agcSampleTotal -= oldest.samples;
  }
  const windowRms = Math.sqrt((state.agcEnergyTotal || 1e-9) / Math.max(1, state.agcSampleTotal));
  const targetLinear = Math.pow(10, targetDbfs / 20);
  const desiredGain = targetLinear / (windowRms || 1e-6);
  const currentDb = 20 * Math.log10(state.agcGain || 1e-6);
  const desiredDb = 20 * Math.log10(desiredGain || 1e-6);
  const chunkMs = (chunkSamples / sampleRate) * 1000;
  const maxDeltaDb = Math.max(0.001, (chunkMs / 100) * 1); // cap 1 dB per 100ms
  let newDb = currentDb;
  if (desiredDb > currentDb + maxDeltaDb) newDb = currentDb + maxDeltaDb;
  else if (desiredDb < currentDb - maxDeltaDb) newDb = currentDb - maxDeltaDb;
  else newDb = desiredDb;
  const gain = Math.pow(10, newDb / 20);
  state.agcGain = gain;
  for (let i = 0; i < floatArray.length; i += 1) {
    floatArray[i] *= gain;
  }
}

export function processForTelephony(floatArray, sampleRate, state = initDspState()) {
  if (!floatArray || !floatArray.length) return floatArray;
  applyDCRemoval(floatArray, state);
  onePoleHighpass(floatArray, sampleRate, 100, state);
  onePoleLowpass(floatArray, sampleRate, 3400, state);
  applyCompressor(floatArray, sampleRate, state);
  applyLimiter(floatArray, -1);
  applyAgc(floatArray, sampleRate, state, -19);
  applyLimiter(floatArray, -1);
  return floatArray;
}

export default {
  initDspState,
  pcm16ToFloat32,
  float32ToPcm16,
  processForTelephony,
};
