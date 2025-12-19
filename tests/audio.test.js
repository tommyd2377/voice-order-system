import { strict as assert } from 'assert';
import { test } from 'node:test';
import { resamplePcm16Linear, downsamplePcm16leBy3 } from '../src/audio/resample.js';
import { encodeMuLaw, decodeMuLaw } from '../src/audio/g711.js';
import { chunkMulawFrames } from '../src/audio/mulaw.js';

test('resample length basic check 16k -> 8k', () => {
  const samples16k = 1600;
  const buf = Buffer.alloc(samples16k * 2);
  for (let i = 0; i < samples16k; i += 1) {
    buf.writeInt16LE(i % 100, i * 2);
  }
  const resampled = resamplePcm16Linear(buf, 16000, 8000);
  assert.equal(resampled.length, Math.round((buf.length / 2) * (8000 / 16000)) * 2);
});

test('downsample by 3 length check 24k -> 8k', () => {
  const samples24k = 2400;
  const buf = Buffer.alloc(samples24k * 2);
  const ds = downsamplePcm16leBy3(buf);
  assert.equal(ds.length, Math.floor(samples24k / 3) * 2);
});

test('mulaw roundtrip stays within tolerance', () => {
  const samples = 320;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.sin((2 * Math.PI * i) / samples) * 10000;
    buf.writeInt16LE(sample, i * 2);
  }
  const mu = encodeMuLaw(buf);
  const pcm = decodeMuLaw(mu);
  let diffSum = 0;
  for (let i = 0; i < samples; i += 1) {
    diffSum += Math.abs(buf.readInt16LE(i * 2) - pcm.readInt16LE(i * 2));
  }
  const avgDiff = diffSum / samples;
  assert.ok(avgDiff < 2000, `avgDiff too high: ${avgDiff}`);
});

test('chunking produces 160-byte frames', () => {
  const mu = Buffer.alloc(160 * 3);
  const frames = chunkMulawFrames(mu);
  assert.equal(frames.length, 3);
  frames.forEach((f) => assert.equal(f.length, 160));
});
