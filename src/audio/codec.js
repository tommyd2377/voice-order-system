// Audio codec helpers for bridging Twilio PCMU 8kHz <-> Gemini PCM16.
// Uses small, pure-JS deps to keep cold-start light.
import alawmulaw from 'alawmulaw';
import waveResampler from 'wave-resampler';

const { mulaw } = alawmulaw || {};
const resample = waveResampler?.resample || waveResampler;

function toInt16(buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
}

// Decode PCMU 8k -> PCM16LE buffer (still 8k samples).
export function pcmuToPcm16(pcmuBuf) {
  if (!pcmuBuf || !pcmuBuf.length) return Buffer.alloc(0);
  const decoded = mulaw.decode(new Uint8Array(pcmuBuf));
  return Buffer.from(new Int16Array(decoded).buffer);
}

export function pcmu8ToPcm16_16k(pcmuBuf, fromRate = 8000, toRate = 16000) {
  if (!pcmuBuf || !pcmuBuf.length) return Buffer.alloc(0);
  // Decode PCMU (8k) -> Int16Array (8k)
  const decoded = mulaw.decode(new Uint8Array(pcmuBuf));
  // Resample to 16k for Gemini native audio input
  const resampled = resample(decoded, fromRate, toRate);
  return Buffer.from(new Int16Array(resampled).buffer);
}

export function pcm16_24k_ToPcmu8k(pcmBuf, fromRate = 24000, toRate = 8000) {
  if (!pcmBuf || !pcmBuf.length) return Buffer.alloc(0);
  // PCM16 input is at 24k from Gemini output
  const inView = toInt16(pcmBuf);
  const resampled = resample(inView, fromRate, toRate);
  const resampledView = new Int16Array(resampled);
  const encoded = mulaw.encode(resampledView);
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

export function runCodecSanityChecks() {
  // 20ms @16k PCM16 should be 320 samples -> 640 bytes
  const samples16k = 320;
  const pcm16 = Buffer.alloc(samples16k * 2);
  const mu = mulaw.encode(new Int16Array(pcm16.buffer));
  const pcmRoundTrip = mulaw.decode(mu);
  const resampled = resample(new Int16Array(pcm16.buffer), 16000, 8000);
  console.log('[Codec][SelfTest]', {
    pcm16Bytes: pcm16.length,
    pcmuBytes20ms: mu.length,
    roundTripLength: pcmRoundTrip.length * 2,
    resampledSamples: resampled.length,
  });
}

if (process.argv[1] && process.argv[1].endsWith('codec.js')) {
  runCodecSanityChecks();
}

export default {
  pcmu8ToPcm16_16k,
  pcm16_24k_ToPcmu8k,
  pcmuToPcm16,
  runCodecSanityChecks,
};
