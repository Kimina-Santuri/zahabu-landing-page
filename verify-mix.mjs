// Checks the mix compressor (mix-encoder-src.js) in Node: WAV 16/24-bit, 96 kHz, mono, AIFF, float WAV, MP3 re-encode.
// Each input is a generated 440 Hz tone; the MP3 must decode back to roughly the same length and pitch.
import assert from 'node:assert/strict';
import { compress } from './mix-encoder-src.js';
import { MPEGDecoder } from 'mpg123-decoder';

function tone({seconds, rate, channels, bits = 16, float = false, freq = 440}) {
  const frames = Math.round(seconds * rate), bytes = bits / 8;
  const data = new DataView(new ArrayBuffer(frames * channels * bytes));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const v = 0.5 * Math.sin(2 * Math.PI * freq * i / rate), p = (i * channels + c) * bytes;
    if (float) data.setFloat32(p, v, true);
    else if (bits === 16) data.setInt16(p, Math.round(v * 32767), true);
    else if (bits === 24) { const x = Math.round(v * 8388607) & 0xFFFFFF; data.setUint8(p, x & 255); data.setUint8(p + 1, (x >> 8) & 255); data.setUint8(p + 2, x >> 16); }
  }
  return {data, frames};
}
function wav(opts) {
  const {data} = tone(opts), {rate, channels, bits = 16, float = false} = opts;
  const h = new DataView(new ArrayBuffer(44)), w = (o, s) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + data.byteLength, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true);
  h.setUint16(20, float ? 3 : 1, true); h.setUint16(22, channels, true); h.setUint32(24, rate, true);
  h.setUint32(28, rate * channels * bits / 8, true); h.setUint16(32, channels * bits / 8, true); h.setUint16(34, bits, true);
  w(36, 'data'); h.setUint32(40, data.byteLength, true);
  return new File([h, data], 'test.wav');
}
function aiff({seconds, rate, channels}) {
  const frames = Math.round(seconds * rate), data = new DataView(new ArrayBuffer(frames * channels * 2));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) data.setInt16((i * channels + c) * 2, Math.round(0.5 * Math.sin(2 * Math.PI * 440 * i / rate) * 32767), false);
  const h = new DataView(new ArrayBuffer(54)), w = (o, s) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'FORM'); h.setUint32(4, 46 + data.byteLength); w(8, 'AIFF'); w(12, 'COMM'); h.setUint32(16, 18);
  h.setInt16(20, channels); h.setUint32(22, frames); h.setInt16(26, 16);
  // 80-bit extended sample rate
  const e = Math.floor(Math.log2(rate)); h.setUint16(28, 16383 + e); const m = rate / 2 ** e * 2 ** 31; h.setUint32(30, Math.floor(m)); h.setUint32(34, 0);
  w(38, 'SSND'); h.setUint32(42, 8 + data.byteLength); h.setUint32(46, 0); h.setUint32(50, 0);
  return new File([h, data], 'test.aiff');
}
async function check(name, file, {seconds, rate, channels}) {
  const started = performance.now();
  const out = await compress(file, 128, () => {});
  const ms = performance.now() - started;
  const bytes = new Uint8Array(await out.blob.arrayBuffer());
  const decoder = new MPEGDecoder(); await decoder.ready;
  const decoded = decoder.decode(bytes); decoder.free();
  const pcm = decoded.channelData[0];
  // Pitch: count upward zero crossings in the middle second.
  const mid = pcm.subarray(Math.floor(decoded.sampleRate * seconds / 2 - decoded.sampleRate / 2), Math.floor(decoded.sampleRate * seconds / 2 + decoded.sampleRate / 2));
  let crossings = 0; for (let i = 1; i < mid.length; i++) if (mid[i - 1] < 0 && mid[i] >= 0) crossings++;
  const kbps = Math.round(bytes.length * 8 / seconds / 1000);
  console.log(`${name}: ${out.sampleRate} Hz, ${out.channels} ch, ${out.durationSeconds}s, ${kbps} kbps, pitch ${crossings} Hz, ${Math.round(ms)} ms (${(seconds * 1000 / ms).toFixed(0)}x real time)`);
  assert.equal(out.sampleRate, rate); assert.equal(out.channels, channels);
  // The decoder always gives two channels, so read mono/stereo from the first MP3 frame header (mode 3 = mono).
  const sync = bytes.findIndex((b, i) => b === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0);
  assert.equal((bytes[sync + 3] >> 6) === 3 ? 1 : 2, channels, 'MP3 channel mode');
  assert.ok(Math.abs(out.durationSeconds - seconds) <= 1, 'duration');
  assert.ok(Math.abs(crossings - 440) <= 3, `pitch ${crossings}`);
  assert.ok(kbps >= 120 && kbps <= 140, `bitrate ${kbps}`);
  return bytes;
}
await check('WAV 16-bit 44.1k stereo', wav({seconds:20, rate:44100, channels:2}), {seconds:20, rate:44100, channels:2});
await check('WAV 24-bit 48k stereo', wav({seconds:10, rate:48000, channels:2, bits:24}), {seconds:10, rate:48000, channels:2});
await check('WAV 32-bit float 96k → 48k', wav({seconds:10, rate:96000, channels:2, bits:32, float:true}), {seconds:10, rate:48000, channels:2});
await check('WAV 16-bit 22.05k mono → 44.1k', wav({seconds:10, rate:22050, channels:1}), {seconds:10, rate:44100, channels:1});
await check('AIFF 16-bit 44.1k stereo', aiff({seconds:10, rate:44100, channels:2}), {seconds:10, rate:44100, channels:2});
const mp3 = await check('WAV for MP3 test', wav({seconds:10, rate:44100, channels:2}), {seconds:10, rate:44100, channels:2});
await check('MP3 re-encode', new File([mp3], 'in.mp3'), {seconds:10, rate:44100, channels:2});
await assert.rejects(compress(new File([new Uint8Array(64)], 'x.m4a'), 128, () => {}), /isn't supported/);
console.log('Verified mix compressor: WAV 16/24/float, 96k and 22.05k resampling, mono, AIFF, MP3 re-encode, unsupported files refused.');

// FLAC: made by macOS afconvert from an 8 s, 48 kHz stereo 440 Hz tone (skipped when the file isn't there).
import { readFile } from 'node:fs/promises';
const flacPath = process.env.FLAC_SAMPLE;
if (flacPath) {
  await check('FLAC 16-bit 48k stereo', new File([await readFile(flacPath)], 'tone.flac'), {seconds:8, rate:48000, channels:2});
  console.log('Verified FLAC decoding.');
}
