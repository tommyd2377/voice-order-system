// Minimal G.711 mu-law helpers for PCM16 <-> PCMU conversions.
// Pure JS to avoid native deps.

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

// Decode PCMU (G.711 mu-law) bytes to PCM16LE.
export function decodeMuLaw(muLawBuffer) {
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

// Encode PCM16LE buffer to PCMU bytes. Assumes input is already at 8kHz.
export function encodeMuLaw(pcmBuffer) {
  if (!pcmBuffer || !pcmBuffer.length) return Buffer.alloc(0);
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
  const output = Buffer.alloc(sampleCount);

  for (let i = 0; i < samples.length; i += 1) {
    const muSample = linearToMuLawSample(samples[i]);
    output[i] = muSample;
  }

  return output;
}

export function pcm16leToMulaw(pcmBuffer) {
  return encodeMuLaw(pcmBuffer);
}

export default {
  encodeMuLaw,
  decodeMuLaw,
  pcm16leToMulaw,
};
