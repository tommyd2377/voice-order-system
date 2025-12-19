import { strict as assert } from 'assert';
import { test } from 'node:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { encodeMulaw8k, writeMulawWav } from '../src/audio/telephonyAudio.js';
import { getTwilioSampleRate } from '../src/audio/mulaw.js';

function genTonePcm(rate, seconds = 1) {
  const samples = Math.floor(rate * seconds);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
    buf.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return buf;
}

function hasFfprobe() {
  return spawnSync('ffprobe', ['-version']).status === 0;
}

function probeInfo(filePath) {
  const res = spawnSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels',
    '-of',
    'default=noprint_wrappers=1',
    filePath,
  ]);
  if (res.status !== 0) return null;
  const lines = res.stdout.toString().trim().split('\n');
  const info = {};
  lines.forEach((line) => {
    const [k, v] = line.split('=');
    info[k] = v;
  });
  return info;
}

test('integration: 16k and 24k inputs become 8k mulaw with stable duration', async (t) => {
  const rates = [16000, 24000];
  for (const rate of rates) {
    const tone = genTonePcm(rate, 1);
    const mu = await encodeMulaw8k(tone, rate);
    assert.ok(mu.length > 7500 && mu.length < 8500, `unexpected mu-law length for ${rate}: ${mu.length}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-int-'));
    const wavPath = path.join(tmp, `out_${rate}.wav`);
    await writeMulawWav(mu, wavPath);
    if (hasFfprobe()) {
      const info = probeInfo(wavPath);
      assert.equal(info?.codec_name, 'pcm_mulaw');
      assert.equal(Number(info?.sample_rate), getTwilioSampleRate());
      assert.equal(Number(info?.channels), 1);
    } else {
      await t.skip('ffprobe not available; skipping format check');
    }
  }
});
