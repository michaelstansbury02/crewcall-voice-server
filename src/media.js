'use strict';

/**
 * media.js — Twilio Media Streams WebSocket handler (`/media`).
 *
 * Protocol (Twilio → us): connected, start, media (base64 8kHz mu-law), stop.
 * Protocol (us → Twilio): media (outbound audio), clear (barge-in), mark.
 *
 * Per call:
 *   start   → look up business, greet via TTS, open Deepgram stream
 *   media   → forward inbound audio to Deepgram
 *   interim → barge-in: clear queued outbound audio
 *   final   → conversation engine → speak reply (or hang up)
 *   stop    → post-call actions (owner SMS + logging)
 */

const WebSocket = require('ws');
const { createEngine } = require('./conversation');
const stt = require('./stt');
const tts = require('./tts');
const llm = require('./llm');
const { handleCallEnd, getTwilioClient } = require('./postcall');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SILENCE_REPROMPT_MS = 9000;
const MAX_CALL_MS = 5 * 60 * 1000;

function loadBusinesses() {
  return require('../config/businesses.json');
}

class CallSession {
  constructor(ws, startMsg) {
    this.ws = ws;
    this.streamSid = startMsg.streamSid;
    this.callSid = startMsg.callSid;
    this.from = startMsg.customParameters?.from || startMsg.from;
    this.to = startMsg.customParameters?.to || startMsg.to;
    this.startedAt = Date.now();
    this.finished = false;

    const businesses = loadBusinesses();
    const businessId = startMsg.customParameters?.businessId || process.env.DEFAULT_BUSINESS_ID;
    this.business =
      businesses.find((b) => b.id === businessId) ||
      businesses.find((b) => b.twilioNumber === this.to) ||
      null;

    this.outbound = [];      // queued base64 20ms frames
    this.sending = false;
    this.interrupted = false;
    this.engine = null;
    this.sttStream = null;
    this.silenceTimer = null;
    this.maxCallTimer = null;
    this.reprompted = false;
    this.onDrained = null;
  }

  log(...args) {
    console.log(`[call ${this.callSid || '?'}]`, ...args);
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async start() {
    if (!this.business) {
      this.log(`no business configured for id/to=${this.to} — closing`);
      this.finish('no-business');
      return;
    }
    this.log(`started: ${this.from} → ${this.business.businessName}`);

    this.engine = createEngine({
      business: this.business,
      now: new Date(),
      llmRespond: (prompt, ctx) => llm.respond(prompt, ctx),
    });

    if (!stt.isConfigured() || !llm.isConfigured()) {
      this.log('STT or LLM not configured — playing fallback and closing');
      await this.speak(
        `Thanks for calling ${this.business.businessName}. We're having technical difficulties right now, please call back shortly. Goodbye.`
      );
      this.hangupAfterDrain();
      return;
    }

    this.sttStream = stt.createStream({
      onInterim: (text) => this.onInterim(text),
      onFinal: (text) => this.onFinal(text),
      onError: (err) => this.log(`stt error: ${err.message}`),
    });

    this.maxCallTimer = setTimeout(() => {
      this.log('max call duration reached');
      this.wrapUp();
    }, MAX_CALL_MS);

    this.armSilenceTimer();
    await this.speak(this.engine.greet());
  }

  armSilenceTimer() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.onSilence(), SILENCE_REPROMPT_MS);
  }

  onSilence() {
    if (this.finished || !this.engine) return;
    if (!this.reprompted) {
      this.reprompted = true;
      this.speak(`Are you still there? How can I help you today?`).catch(() => {});
      this.armSilenceTimer();
    } else {
      this.log('silence twice — closing politely');
      this.speak(`I didn't hear anything, so I'll let you go. Thanks for calling ${this.business.businessName}!`)
        .catch(() => {})
        .finally(() => this.hangupAfterDrain());
    }
  }

  handleInboundMedia(payload) {
    if (this.finished) return;
    this.sttStream?.sendAudio(payload);
  }

  /** Barge-in: caller started talking while we were speaking — cut our audio. */
  onInterim(text) {
    if (this.finished || !text.trim()) return;
    if (this.sending || this.outbound.length > 0) {
      this.log('barge-in — clearing outbound audio');
      this.outbound = [];
      this.interrupted = true;
      this.send({ event: 'clear', streamSid: this.streamSid });
    }
  }

  async onFinal(text) {
    if (this.finished || !this.engine) return;
    this.armSilenceTimer();
    const wasInterrupted = this.interrupted;
    this.interrupted = false;
    this.log(`caller${wasInterrupted ? ' (barge-in)' : ''}: ${text}`);

    let result;
    try {
      result = await this.engine.handleUtterance(text);
    } catch (err) {
      this.log(`engine error: ${err.message}`);
      await this.speak(`Sorry, I missed that — could you say it once more?`);
      return;
    }
    if (result.reply) await this.speak(result.reply);
    if (result.hangup) this.hangupAfterDrain();
  }

  async speak(text) {
    if (this.finished || !text) return;
    const frames = await tts.synthesize(text).catch((err) => {
      this.log(`tts error: ${err.message}`);
      return null;
    });
    if (!frames || frames.length === 0) return;
    this.outbound.push(...frames);
    this.pump();
  }

  async pump() {
    if (this.sending) return;
    this.sending = true;
    while (this.outbound.length > 0 && !this.finished) {
      const payload = this.outbound.shift();
      this.send({ event: 'media', streamSid: this.streamSid, media: { track: 'outbound', payload } });
      await sleep(18); // pace ~20ms frames
      if (this.interrupted) break; // barge-in cleared the queue
    }
    this.sending = false;
    if (!this.finished && this.ws.readyState === WebSocket.OPEN) {
      this.send({ event: 'mark', streamSid: this.streamSid, mark: { name: 'reply-done' } });
    }
    const cb = this.onDrained;
    this.onDrained = null;
    if (cb) cb();
  }

  wrapUp() {
    if (this.finished || !this.engine) return;
    this.speak(`Thanks for calling ${this.business.businessName}! We'll talk soon. Goodbye.`)
      .catch(() => {})
      .finally(() => this.hangupAfterDrain());
  }

  hangupAfterDrain() {
    if (this.finished) return this.finish('hangup');
    if (this.sending || this.outbound.length > 0) {
      this.onDrained = () => this.finish('hangup');
      // safety: don't wait forever for audio to drain
      setTimeout(() => { if (!this.finished) this.finish('hangup'); }, 15000);
    } else {
      this.finish('hangup');
    }
  }

  async finish(reason) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.maxCallTimer);
    try { this.sttStream?.close(); } catch { /* noop */ }

    // Hard-hangup the Twilio call leg so we don't linger.
    const client = getTwilioClient();
    if (client && this.callSid) {
      client.calls(this.callSid).update({ status: 'completed' }).catch((err) => {
        this.log(`twilio hangup failed: ${err.message}`);
      });
    }
    try { this.ws.close(); } catch { /* noop */ }

    if (this.engine && this.business) {
      const state = this.engine.getState();
      this.log(`ended (${reason}): classification=${state.classification} urgent=${state.urgent}`);
      try {
        await handleCallEnd({
          business: this.business,
          state,
          callSid: this.callSid,
          from: this.from,
          to: this.to,
          startedAt: this.startedAt,
          endedAt: Date.now(),
          endReason: reason,
        });
      } catch (err) {
        this.log(`post-call failed: ${err.message}`);
      }
    } else {
      this.log(`ended (${reason}) — no engine/business, nothing to log`);
    }
  }
}

function attachMediaServer(wss) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/media', 'http://localhost');
    if (url.pathname !== '/media') {
      ws.close(1008, 'unknown path');
      return;
    }
    let session = null;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.event) {
        case 'connected':
          break;
        case 'start':
          if (!session) {
            session = new CallSession(ws, msg.start);
            session.start().catch((err) => console.error('[media] start failed:', err.message));
          }
          break;
        case 'media':
          session?.handleInboundMedia(msg.media?.payload);
          break;
        case 'mark':
          break;
        case 'stop':
          session?.finish('twilio-stop');
          break;
        default:
          break;
      }
    });

    ws.on('close', () => session?.finish('ws-close'));
    ws.on('error', (err) => {
      console.error('[media] ws error:', err.message);
      session?.finish('ws-error');
    });
  });
}

module.exports = { attachMediaServer, CallSession };
