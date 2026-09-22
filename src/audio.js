'use strict';

/**
 * audio.js — PCM <-> G.711 mu-law conversion, downsampling, and 20ms framing
 * for Twilio Media Streams (8kHz mono mu-law).
 */

/** Encode a single 16-bit PCM sample to 8-bit mu-law (G.711). */
function encodeMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; exponent > 0 && (sample & expMask) === 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xff;
}

/** Decode a single mu-law byte back to 16-bit PCM (used in tests). */
function decodeMulaw(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/**
 * Downsample 16-bit PCM mono from fromRate to 8000 Hz (simple decimation with
 * light averaging — good enough for voice telephony).
 */
function downsampleTo8k(pcm16, fromRate) {
  if (fromRate === 8000) return pcm16;
  const ratio = fromRate / 8000;
  const outLen = Math.floor(pcm16.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = Math.floor(i * ratio);
    out[i] = pcm16[src];
  }
  return out;
}

/** Convert 16-bit PCM mono (any rate) to base64 mu-law 20ms frames (160 bytes each). */
function pcmToMulawFrames(pcm16, fromRate) {
  const pcm8k = downsampleTo8k(pcm16, fromRate);
  const mulaw = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) mulaw[i] = encodeMulaw(pcm8k[i]);

  const frames = [];
  for (let i = 0; i + 160 <= mulaw.length; i += 160) {
    frames.push(mulaw.subarray(i, i + 160).toString('base64'));
  }
  return frames;
}

/**
 * Parse a 16-bit PCM mono WAV buffer. Returns { sampleRate, pcm16 }.
 * Handles the standard 44-byte header produced by OpenAI's wav output.
 */
function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  // Walk chunks to find fmt + data (robust to extra chunks).
  let offset = 12;
  let sampleRate = null;
  let pcm16 = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      sampleRate = buffer.readUInt32LE(offset + 12);
      const format = buffer.readUInt16LE(offset + 8);
      const bits = buffer.readUInt16LE(offset + 22);
      if (format !== 1 || bits !== 16) throw new Error(`Unsupported WAV format (format=${format}, bits=${bits})`);
    } else if (id === 'data') {
      const count = Math.floor(size / 2);
      pcm16 = new Int16Array(count);
      for (let i = 0; i < count; i++) pcm16[i] = buffer.readInt16LE(offset + 8 + i * 2);
    }
    offset += 8 + size + (size % 2);
  }
  if (!pcm16 || !sampleRate) throw new Error('WAV missing fmt or data chunk');
  return { sampleRate, pcm16 };
}

module.exports = { encodeMulaw, decodeMulaw, downsampleTo8k, pcmToMulawFrames, parseWav };
