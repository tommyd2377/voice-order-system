// Lightweight audio transcoding helpers for Twilio (PCMU 8k) <-> Gemini (PCM16)
// No external deps to keep cold-start small.

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

export function pcmuToPcm16(muLawBuffer) {
  if (!muLawBuffer || !muLawBuffer.length) return Buffer.alloc(0);
  const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);
  for (let i = 0; i < muLawBuffer.length; i += 1) {
    const mu = ~muLawBuffer[i] & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    if (sign) sample = -sample;
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  return pcmBuffer;
}

function linearToMuLawSample(sample) {
  const BIAS = 0x84;
  const MAX = 32635;
  let clamped = clamp(sample, -MAX, MAX);
  const sign = clamped < 0 ? 0x80 : 0x00;
  if (clamped < 0) {
    clamped = -clamped;
  }
  clamped += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (clamped & expMask) === 0 && exponent > 0; exponent -= 1) {
    expMask >>= 1;
  }

  const mantissa = (clamped >> (exponent === 0 ? 0 : exponent - 3)) & 0x0f;
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muLawByte;
}

export function pcm16ToPcmu(pcmBuffer, inputSampleRate = 8000) {
  if (!pcmBuffer || !pcmBuffer.length) return Buffer.alloc(0);
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
  const step = Math.max(1, Math.round(inputSampleRate / 8000));
  const output = Buffer.alloc(Math.ceil(sampleCount / step));

  let outIdx = 0;
  for (let i = 0; i < samples.length; i += step) {
    const muSample = linearToMuLawSample(samples[i]);
    output[outIdx] = muSample;
    outIdx += 1;
  }

  return outIdx === output.length ? output : output.slice(0, outIdx);
}

// Simple linear interpolation resampler; good enough for diagnostics + real-time voice MVP.
export function resamplePcm16Linear(pcmBuffer, fromRate, toRate) {
  if (!pcmBuffer || !pcmBuffer.length) return Buffer.alloc(0);
  if (!fromRate || !toRate || fromRate <= 0 || toRate <= 0) return pcmBuffer;
  if (fromRate === toRate) return pcmBuffer;

  const inputSamples = pcmBuffer.length / 2;
  const outSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
  const inView = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, inputSamples);
  const outView = new Int16Array(outSamples);

  const ratio = fromRate / toRate;
  for (let i = 0; i < outSamples; i += 1) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s1 = inView[idx] || 0;
    const s2 = inView[Math.min(idx + 1, inputSamples - 1)] || 0;
    outView[i] = Math.round(s1 + (s2 - s1) * frac);
  }

  return Buffer.from(outView.buffer, outView.byteOffset, outView.byteLength);
}

export function base64PcmuToPcm16(base64String) {
  if (!base64String) return Buffer.alloc(0);
  const muLawBuffer = Buffer.from(base64String, 'base64');
  return pcmuToPcm16(muLawBuffer);
}

export function pcm16ToBase64Pcmu(pcmBuffer, inputSampleRate = 8000) {
  const muLawBuffer = pcm16ToPcmu(pcmBuffer, inputSampleRate);
  return muLawBuffer.toString('base64');
}

export function runTranscodeSelfTest() {
  const muLaw = Buffer.from([255, 127, 0, 1, 2, 3, 4, 5]);
  const pcm = pcmuToPcm16(muLaw);
  const muRoundTrip = pcm16ToPcmu(pcm);
  const resampled = resamplePcm16Linear(pcm, 8000, 24000);
  console.log('[Transcode SelfTest]', {
    inputMuLawLen: muLaw.length,
    pcmLen: pcm.length,
    muRoundTripMatches: muRoundTrip.equals(muLaw),
    resampledLen: resampled.length,
  });
}

if (process.argv[1] && process.argv[1].endsWith('transcode.js')) {
  runTranscodeSelfTest();
}

export default {
  pcmuToPcm16,
  pcm16ToPcmu,
  resamplePcm16Linear,
  base64PcmuToPcm16,
  pcm16ToBase64Pcmu,
  runTranscodeSelfTest,
};
