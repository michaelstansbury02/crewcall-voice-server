'use strict';

/**
 * tts.js — OpenAI TTS → 8kHz mu-law 20ms frames for Twilio Media Streams.
 *
 * synthesize(text) → string[] (base64 frames). Small in-memory cache keyed by
 * text+voice avoids paying twice for repeated phrases (greetings, closings).
 * Returns null when OPENAI_API_KEY is missing (caller must degrade gracefully).
 */

const crypto = require('crypto');
const { parseWav, pcmToMulawFrames } = require('./audio');

const cache = new Map();
const CACHE_MAX = 200;

async function synthesize(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const clean = String(text || '').trim();
  if (!clean) return [];

  const voice = process.env.TTS_VOICE || 'nova';
  const key = crypto.createHash('sha1').update(`${voice}:${clean}`).digest('hex');
  if (cache.has(key)) return cache.get(key);

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const res = await client.audio.speech.create({
    model: 'tts-1',
    voice,
    input: clean,
    response_format: 'wav', // 24kHz 16-bit PCM mono
  });
  const wavBuffer = Buffer.from(await res.arrayBuffer());
  const { sampleRate, pcm16 } = parseWav(wavBuffer);
  const frames = pcmToMulawFrames(pcm16, sampleRate);

  cache.set(key, frames);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return frames;
}

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

module.exports = { synthesize, isConfigured };
