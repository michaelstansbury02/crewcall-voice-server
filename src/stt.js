'use strict';

/**
 * stt.js — Deepgram streaming speech-to-text over a raw WebSocket.
 * Twilio sends 8kHz mu-law; Deepgram accepts that natively.
 *
 * createStream({ onInterim(text), onFinal(text), onError(err) })
 *   → { sendAudio(base64Payload), close() }
 * Returns null when DEEPGRAM_API_KEY is missing (caller must degrade gracefully).
 */

const WebSocket = require('ws');

function createStream({ onInterim, onFinal, onError }) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return null;

  const model = process.env.DEEPGRAM_MODEL || 'nova-2';
  const params = new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    model,
    interim_results: 'true',
    smart_format: 'true',
    vad_events: 'true',
    endpointing: '400',
    utterance_end_ms: '1200',
  });

  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let open = false;
  ws.on('open', () => { open = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type !== 'Results') return;
    const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;
    try {
      if (msg.is_final) onFinal && onFinal(transcript);
      else onInterim && onInterim(transcript);
    } catch (err) {
      onError && onError(err);
    }
  });
  ws.on('error', (err) => onError && onError(err));
  ws.on('close', () => { open = false; });

  return {
    sendAudio(base64Payload) {
      if (open && ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(base64Payload, 'base64'));
      }
    },
    close() {
      try { ws.close(); } catch { /* noop */ }
    },
  };
}

function isConfigured() {
  return !!process.env.DEEPGRAM_API_KEY;
}

module.exports = { createStream, isConfigured };
