// μ-law helpers and Twilio-friendly framing.
import { encodeMuLaw, decodeMuLaw } from './g711.js';

const TWILIO_SAMPLE_RATE = 8000;
const TWILIO_FRAME_SAMPLES = 160; // 20ms @ 8k
const TWILIO_FRAME_BYTES = TWILIO_FRAME_SAMPLES; // mu-law is 1 byte/sample

export function pcm16ToMulaw(pcmBuffer) {
  return encodeMuLaw(pcmBuffer);
}

export function mulawToPcm16(muBuffer) {
  return decodeMuLaw(muBuffer);
}

export function chunkMulawFrames(muBuffer, frameSize = TWILIO_FRAME_BYTES) {
  const frames = [];
  for (let offset = 0; offset + frameSize <= muBuffer.length; offset += frameSize) {
    frames.push(muBuffer.subarray(offset, offset + frameSize));
  }
  return frames;
}

export function getTwilioFrameBytes() {
  return TWILIO_FRAME_BYTES;
}

export function getTwilioSampleRate() {
  return TWILIO_SAMPLE_RATE;
}

export default {
  pcm16ToMulaw,
  mulawToPcm16,
  chunkMulawFrames,
  getTwilioFrameBytes,
  getTwilioSampleRate,
};
