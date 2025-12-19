import { spawn } from 'child_process';
import { writeFileSync, mkdtempSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { resamplePcm16Best } from './resample.js';
import { pcm16ToMulaw, chunkMulawFrames, getTwilioSampleRate } from './mulaw.js';
import {
  initDspState,
  pcm16ToFloat32,
  float32ToPcm16,
  processForTelephony,
} from './dsp.js';

const TMP_PREFIX = 'telephony-audio-';
const DEFAULT_RATE = 24000;

function ffmpegAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    let done = false;
    proc.on('error', () => {
      if (!done) resolve(false);
      done = true;
    });
    proc.on('exit', (code) => {
      if (!done) resolve(code === 0);
      done = true;
    });
  });
}

async function ffmpegResample(buffer, fromRate, toRate, channels = 1) {
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) return null;
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      String(fromRate),
      '-ac',
      String(channels),
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      String(toRate),
      '-ac',
      String(channels),
      'pipe:1',
    ]);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    proc.stdin.end(buffer);
  });
}

async function ffprobeSampleRate(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        const txt = Buffer.concat(chunks).toString('utf8').trim();
        const rate = Number(txt);
        resolve(Number.isFinite(rate) ? rate : null);
      } else {
        resolve(null);
      }
    });
  });
}

export async function decodeToPcm16(inputBuffer, sampleRateHint = DEFAULT_RATE) {
  if (!inputBuffer) return { pcm: new Int16Array(0), sampleRate: sampleRateHint };

  const hasFfmpeg = await ffmpegAvailable();
  if (hasFfmpeg) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    const tmpPath = path.join(tmpDir, 'input');
    writeFileSync(tmpPath, inputBuffer);
    let detectedRate = sampleRateHint;
    try {
      const probed = await ffprobeSampleRate(tmpPath);
      if (probed) detectedRate = probed;
    } catch (err) {
      // fall back to hint
    }
    try {
      const pcmBuf = await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-loglevel',
          'error',
          '-i',
          tmpPath,
          '-f',
          's16le',
          '-ac',
          '1',
          '-ar',
          String(detectedRate),
          'pipe:1',
        ]);
        const chunks = [];
        proc.stdout.on('data', (d) => chunks.push(d));
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`ffmpeg decode exit ${code}`));
        });
      });
      unlinkSync(tmpPath);
      return {
        pcm: new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.length / 2)),
        sampleRate: detectedRate,
      };
    } catch (err) {
      unlinkSync(tmpPath);
      // fall through to raw decode
    }
  }

  // Assume raw PCM16LE if not otherwise decodable.
  return { pcm: new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, Math.floor(inputBuffer.length / 2)), sampleRate: sampleRateHint };
}

export async function resampleTo8k(pcmBuffer, sourceRate = DEFAULT_RATE) {
  if (!pcmBuffer?.length) return Buffer.alloc(0);
  const targetRate = getTwilioSampleRate();
  if (sourceRate === targetRate) return Buffer.from(pcmBuffer);
  try {
    const ff = await ffmpegResample(pcmBuffer, sourceRate, targetRate);
    if (ff?.length) return ff;
  } catch (err) {
    // fallback below
  }
  return resamplePcm16Best(pcmBuffer, sourceRate, targetRate);
}

export async function processForTwilio(pcmBuffer, sourceRate = DEFAULT_RATE, state = initDspState()) {
  if (!pcmBuffer?.length) return Buffer.alloc(0);
  const float = pcm16ToFloat32(pcmBuffer);
  processForTelephony(float, sourceRate, state);
  const processedPcm = float32ToPcm16(float);
  return resampleTo8k(processedPcm, sourceRate);
}

export async function encodeMulaw8k(pcmBuffer, sourceRate = DEFAULT_RATE, state = initDspState()) {
  const pcm8k = await processForTwilio(pcmBuffer, sourceRate, state);
  const mu = pcm16ToMulaw(pcm8k);
  return mu;
}

export function twilioFrameChunks(muBuffer) {
  return chunkMulawFrames(muBuffer);
}

export async function writeMulawWav(muBuffer, outputPath) {
  // Simple WAV header for mu-law 8k mono.
  const dataSize = muBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(7, 20); // mu-law format code
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(getTwilioSampleRate(), 24);
  header.writeUInt32LE(getTwilioSampleRate(), 28); // byte rate (1 byte/sample)
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  const wav = Buffer.concat([header, muBuffer]);
  writeFileSync(outputPath, wav);
  return outputPath;
}

export async function audioTestHarness(inputBuffer, options = {}) {
  const { sampleRateHint = DEFAULT_RATE, outputDir = 'samples' } = options;
  const decode = await decodeToPcm16(inputBuffer, sampleRateHint);
  const mu = await encodeMulaw8k(Buffer.from(decode.pcm.buffer, decode.pcm.byteOffset, decode.pcm.byteLength), decode.sampleRate);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const outPath = path.join(tempDir, 'output_mulaw.wav');
  await writeMulawWav(mu, outPath);
  return { outPath, muLawBytes: mu.length, frames: chunkMulawFrames(mu).length };
}

export default {
  decodeToPcm16,
  resampleTo8k,
  processForTwilio,
  encodeMulaw8k,
  twilioFrameChunks,
  writeMulawWav,
  audioTestHarness,
};
