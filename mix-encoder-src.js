// Mix compressor for the Stories editor (comms.zahabu.co.ke). Runs in a Web Worker so the page stays usable.
// Bundled by build.mjs (esbuild) into /admin/mix-encoder.js. Input: {file, kbps}. Output messages:
//   {type:'progress', progress:0..1}   {type:'done', blob, durationSeconds, sampleRate, channels}   {type:'error', message}
// The file is read in pieces (never all at once), so hour-long WAVs don't run a phone or laptop out of memory.
// WAV and AIFF are read here; FLAC and MP3 are decoded with wasm-audio-decoders; MP3 encoding is lamejs (LGPL-3.0,
// unminified in the bundle; source and exact versions in package.json).

import { Mp3Encoder } from '@breezystack/lamejs';
import { MPEGDecoder } from 'mpg123-decoder';
import { FLACDecoder } from '@wasm-audio-decoders/flac';

const READ_BYTES = 4 * 1024 * 1024;
const MP3_RATES = [32000, 44100, 48000];

// In the browser this runs as a Web Worker; verify-mix.mjs imports compress() directly in Node.
if (typeof self !== 'undefined') self.onmessage = async ({data}) => {
  try {
    const result = await compress(data.file, data.kbps || 128, progress => self.postMessage({type:'progress', progress}));
    self.postMessage({type:'done', ...result});
  } catch (error) {
    self.postMessage({type:'error', message:error?.message || String(error)});
  }
};

const text = (view, offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, length));
const read = async (file, start, length) => new DataView(await file.slice(start, start + length).arrayBuffer());

async function sniff(file) {
  const head = await read(file, 0, 12);
  if (head.byteLength < 12) throw new Error('That file is too short to be a mix.');
  const magic = text(head, 0, 4), type = text(head, 8, 4);
  if (magic === 'RIFF' && type === 'WAVE') return 'wav';
  if (magic === 'RF64') throw new Error('This WAV is over 4 GB (RF64). Export the mix in smaller parts or as FLAC.');
  if (magic === 'FORM' && (type === 'AIFF' || type === 'AIFC')) return 'aiff';
  if (magic === 'fLaC') return 'flac';
  if (text(head, 0, 3) === 'ID3' || (head.getUint8(0) === 0xFF && (head.getUint8(1) & 0xE0) === 0xE0)) return 'mp3';
  throw new Error('This file type isn\'t supported. Export the mix as WAV, AIFF, FLAC or MP3.');
}

// ---------- WAV / AIFF headers ----------

async function wavFormat(file) {
  let offset = 12, fmt = null;
  while (offset + 8 <= file.size) {
    const header = await read(file, offset, 8);
    const id = text(header, 0, 4);
    let size = header.getUint32(4, true);
    if (id === 'fmt ') {
      const f = await read(file, offset + 8, Math.min(size, 40));
      let format = f.getUint16(0, true);
      const bits = f.getUint16(14, true);
      if (format === 0xFFFE && size >= 26) format = f.getUint16(24, true);   // WAVE_FORMAT_EXTENSIBLE: sub-format
      fmt = {channels:f.getUint16(2, true), rate:f.getUint32(4, true), blockAlign:f.getUint16(12, true), bits, float:format === 3, littleEndian:true};
      if (format !== 1 && format !== 3) throw new Error('This WAV is compressed (not plain PCM). Export it as a normal WAV, FLAC or MP3.');
    } else if (id === 'data') {
      if (!fmt) throw new Error('This WAV file is damaged (no format information).');
      if (!size || size === 0xFFFFFFFF || offset + 8 + size > file.size) size = file.size - offset - 8;
      return {...fmt, dataStart:offset + 8, dataBytes:size};
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('This WAV file is damaged (no audio found).');
}

function extended80(view, offset) {
  const exponent = view.getUint16(offset) & 0x7FFF;
  const mantissa = view.getUint32(offset + 2) * 2 ** 32 + view.getUint32(offset + 6);
  return Math.round(mantissa * 2 ** (exponent - 16383 - 63));
}

async function aiffFormat(file) {
  const isAifc = text(await read(file, 8, 4), 0, 4) === 'AIFC';
  let offset = 12, comm = null;
  while (offset + 8 <= file.size) {
    const header = await read(file, offset, 8);
    const id = text(header, 0, 4);
    const size = header.getUint32(4);
    if (id === 'COMM') {
      const c = await read(file, offset + 8, Math.min(size, 26));
      const channels = c.getInt16(0), bits = c.getInt16(6);
      const compression = isAifc && size >= 22 ? text(c, 18, 4) : 'NONE';
      const littleEndian = compression === 'sowt';
      const float = compression === 'fl32' || compression === 'FL32' || compression === 'fl64' || compression === 'FL64';
      if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32', 'fl64', 'FL64'].includes(compression)) throw new Error('This AIFF is compressed. Export it as a normal AIFF, WAV, FLAC or MP3.');
      const sampleBits = float ? (compression.toLowerCase() === 'fl64' ? 64 : 32) : bits;
      comm = {channels, rate:extended80(c, 8), bits:sampleBits, float, littleEndian, blockAlign:channels * Math.ceil(sampleBits / 8)};
    } else if (id === 'SSND') {
      if (!comm) throw new Error('This AIFF file is damaged (no format information).');
      const s = await read(file, offset + 8, 8);
      const start = offset + 16 + s.getUint32(0);
      return {...comm, dataStart:start, dataBytes:Math.min(size - 8 - s.getUint32(0), file.size - start)};
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('This AIFF file is damaged (no audio found).');
}

// Interleaved PCM bytes → one Float32Array per channel (first two channels; mono stays mono).
function pcmToFloat(view, f, outChannels) {
  const frames = Math.floor(view.byteLength / f.blockAlign);
  const bytes = f.blockAlign / f.channels;
  const channels = Array.from({length:outChannels}, () => new Float32Array(frames));
  const le = f.littleEndian;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < outChannels; c++) {
      const p = i * f.blockAlign + c * bytes;
      let v;
      if (f.float) v = bytes === 8 ? view.getFloat64(p, le) : view.getFloat32(p, le);
      else if (bytes === 2) v = view.getInt16(p, le) / 32768;
      else if (bytes === 3) {
        const b0 = view.getUint8(p), b1 = view.getUint8(p + 1), b2 = view.getUint8(p + 2);
        const x = le ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        v = (x & 0x800000 ? x - 0x1000000 : x) / 8388608;
      } else if (bytes === 4) v = view.getInt32(p, le) / 2147483648;
      else v = (le ? view.getUint8(p) - 128 : view.getInt8(p)) / 128;   // 8-bit: unsigned in WAV, signed in AIFF
      channels[c][i] = v;
    }
  }
  return channels;
}

async function* pcmChunks(file, f, outChannels, onBytes) {
  if (![8, 16, 24, 32, 64].includes(f.bits)) throw new Error(`${f.bits}-bit audio isn't supported. Export at 16 or 24 bit.`);
  const step = Math.max(f.blockAlign, Math.floor(READ_BYTES / f.blockAlign) * f.blockAlign);
  for (let pos = 0; pos < f.dataBytes; pos += step) {
    const view = await read(file, f.dataStart + pos, Math.min(step, f.dataBytes - pos));
    onBytes(f.dataStart + pos + view.byteLength);
    yield pcmToFloat(view, f, outChannels);
  }
}

// ---------- FLAC / MP3 decoding ----------

async function* decodedChunks(file, decoder, onBytes, info) {
  await decoder.ready;
  try {
    for (let pos = 0; pos < file.size; pos += READ_BYTES) {
      const bytes = new Uint8Array(await file.slice(pos, pos + READ_BYTES).arrayBuffer());
      const out = await decoder.decode(bytes);
      onBytes(pos + bytes.length);
      if (out.samplesDecoded) { info.rate ||= out.sampleRate; info.channels ||= out.channelData.length; yield out.channelData.slice(0, 2).map(c => c.slice(0, out.samplesDecoded)); }
    }
    if (decoder.flush) {
      const out = await decoder.flush();
      if (out?.samplesDecoded) yield out.channelData.slice(0, 2).map(c => c.slice(0, out.samplesDecoded));
    }
  } finally {
    decoder.free();
  }
}

// ---------- Resampling to an MP3 rate ----------
// 88.2/96/176.4/192 kHz → 44.1/48 kHz by averaging (a simple low-pass); anything else → 44.1 kHz by linear interpolation.

function makeResampler(inRate, channels) {
  if (MP3_RATES.includes(inRate)) return {rate:inRate, process:chunk => chunk};
  const factor = [2, 4].find(n => MP3_RATES.includes(inRate / n));
  if (factor) {
    let carry = Array.from({length:channels}, () => new Float32Array(0));
    return {rate:inRate / factor, process(chunk) {
      return chunk.map((data, c) => {
        const all = new Float32Array(carry[c].length + data.length);
        all.set(carry[c]); all.set(data, carry[c].length);
        const n = Math.floor(all.length / factor);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) { let sum = 0; for (let k = 0; k < factor; k++) sum += all[i * factor + k]; out[i] = sum / factor; }
        carry[c] = all.slice(n * factor);
        return out;
      });
    }};
  }
  // Linear interpolation. `pos` is where the next output sample falls, relative to the start of the next chunk;
  // it can be between -1 and 0, meaning between the previous chunk's last sample (`last`) and this chunk's first.
  const outRate = 44100, ratio = inRate / outRate;
  let pos = 0;
  const last = new Float32Array(channels);
  return {rate:outRate, process(chunk) {
    const len = chunk[0].length;
    const count = pos > len - 1 ? 0 : Math.floor((len - 1 - pos) / ratio) + 1;
    const out = chunk.map(() => new Float32Array(count));
    for (let i = 0; i < count; i++) {
      const x = pos + i * ratio, j = Math.floor(x), t = x - j;
      for (let c = 0; c < chunk.length; c++) {
        const a = j < 0 ? last[c] : chunk[c][j];
        const b = j + 1 < len ? chunk[c][j + 1] : a;
        out[c][i] = a + (b - a) * t;
      }
    }
    pos += count * ratio - len;
    for (let c = 0; c < chunk.length; c++) last[c] = chunk[c][len - 1];
    return out;
  }};
}

// ---------- Encoding ----------

const toInt16 = data => {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) { const v = Math.max(-1, Math.min(1, data[i])); out[i] = v < 0 ? v * 32768 : v * 32767; }
  return out;
};

async function compress(file, kbps, onProgress) {
  const kind = await sniff(file);
  let lastReport = 0;
  const onBytes = bytes => { const now = Date.now(); if (now - lastReport > 250) { lastReport = now; onProgress(Math.min(0.99, bytes / file.size)); } };
  let chunks, rate, channels;
  if (kind === 'wav' || kind === 'aiff') {
    const f = kind === 'wav' ? await wavFormat(file) : await aiffFormat(file);
    channels = Math.min(2, f.channels);
    rate = f.rate;
    chunks = pcmChunks(file, f, channels, onBytes);
  } else {
    const info = {};
    chunks = decodedChunks(file, kind === 'flac' ? new FLACDecoder() : new MPEGDecoder(), onBytes, info);
    // Decoders tell us the rate and channel count with the first decoded chunk.
    const first = await chunks.next();
    if (first.done) throw new Error('No audio could be decoded from this file.');
    rate = info.rate; channels = Math.min(2, info.channels);
    const rest = chunks;
    chunks = (async function* () { yield first.value; yield* rest; })();
  }
  if (!rate || rate < 8000 || rate > 384000) throw new Error('This file has an unusual sample rate. Export at 44.1 or 48 kHz.');
  const resampler = makeResampler(rate, channels);
  const encoder = new Mp3Encoder(channels, resampler.rate, kbps);
  const parts = [];
  let samples = 0;
  for await (const chunk of chunks) {
    const data = resampler.process(chunk.slice(0, channels));
    if (!data[0].length) continue;
    samples += data[0].length;
    const mp3 = channels === 2 ? encoder.encodeBuffer(toInt16(data[0]), toInt16(data[1])) : encoder.encodeBuffer(toInt16(data[0]));
    if (mp3.length) parts.push(new Uint8Array(mp3));
  }
  const end = encoder.flush();
  if (end.length) parts.push(new Uint8Array(end));
  if (!samples) throw new Error('No audio found in this file.');
  onProgress(1);
  return {blob:new Blob(parts, {type:'audio/mpeg'}), durationSeconds:Math.round(samples / resampler.rate), sampleRate:resampler.rate, channels};
}

export { compress };
