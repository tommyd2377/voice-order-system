// Simple audio pipeline test harness.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { audioTestHarness } from '../src/audio/telephonyAudio.js';
import { getTwilioSampleRate } from '../src/audio/mulaw.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const samplesDir = path.join(__dirname, '..', 'samples');
  if (!fs.existsSync(samplesDir)) {
    fs.mkdirSync(samplesDir, { recursive: true });
  }

  const inputPath = path.join(samplesDir, 'input.wav');

  // Generate a 1s 440Hz mono PCM16LE @24kHz test tone if missing.
  if (!fs.existsSync(inputPath)) {
    const rate = 24000;
    const durationSec = 1;
    const samples = rate * durationSec;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      const t = i / rate;
      const sample = Math.sin(2 * Math.PI * 440 * t) * 0.4; // -8 dBFS tone
      buf.writeInt16LE(Math.round(sample * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + buf.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits
    header.write('data', 36);
    header.writeUInt32LE(buf.length, 40);
    fs.writeFileSync(inputPath, Buffer.concat([header, buf]));
    console.log(`[audio:test] generated ${inputPath}`);
  }

  const inputBuffer = fs.readFileSync(inputPath);
  const { outPath, muLawBytes, frames } = await audioTestHarness(inputBuffer, {
    sampleRateHint: 24000,
    outputDir: samplesDir,
  });
  console.log('[audio:test] output', { outPath, muLawBytes, frames, sampleRate: getTwilioSampleRate() });

  // Lightweight format check (header inspect).
  const header = Buffer.alloc(44);
  const fd = fs.openSync(outPath, 'r');
  fs.readSync(fd, header, 0, 44, 0);
  fs.closeSync(fd);
  const fmtTag = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const rate = header.readUInt32LE(24);
  const bits = header.readUInt16LE(34);
  console.log('[audio:test] wav info', { fmtTag, channels, rate, bits });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
