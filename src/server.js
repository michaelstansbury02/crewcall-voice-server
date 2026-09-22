'use strict';

/**
 * server.js — CrewCall voice server entrypoint.
 *
 *   POST /voice  → TwiML that bridges the call into the /media WebSocket
 *   GET  /health → { ok: true }
 *
 * The WebSocket server (Twilio Media Streams protocol) lives in media.js and
 * shares this HTTP server.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const { attachMediaServer } = require('./media');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function loadBusinesses() {
  return require('../config/businesses.json');
}

function twilioWebhookUrl() {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/voice` : null;
}

function signatureValid(req) {
  if (process.env.SKIP_SIGNATURE_CHECK === 'true') {
    console.warn('[voice] WARNING: Twilio signature check skipped (SKIP_SIGNATURE_CHECK=true)');
    return true;
  }
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.get('X-Twilio-Signature') || '';
  const url = twilioWebhookUrl();
  if (!token || !url) return false;
  // Twilio signs the full URL + sorted POST params.
  return twilio.validateRequest(token, signature, url, req.body || {});
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/voice', (req, res) => {
  if (!signatureValid(req)) {
    console.warn('[voice] rejected: invalid Twilio signature');
    return res.status(403).send('Forbidden');
  }

  const to = req.body?.To || '';
  const businesses = loadBusinesses();
  const business =
    businesses.find((b) => b.twilioNumber === to) ||
    businesses.find((b) => b.id === process.env.DEFAULT_BUSINESS_ID);

  const twiml = new twilio.twiml.VoiceResponse();
  if (!business) {
    console.warn(`[voice] no business for To=${to}`);
    twiml.say('This number is not configured. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const wsHost = process.env.PUBLIC_WS_HOST;
  if (!wsHost) {
    console.error('[voice] PUBLIC_WS_HOST not set');
    twiml.say('Service is not configured. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const connect = twiml.connect();
  const stream = connect.stream({ url: `wss://${wsHost}/media` });
  stream.parameter({ name: 'businessId', value: business.id });

  console.log(`[voice] incoming call ${req.body?.CallSid || '?'} → ${business.businessName}`);
  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
attachMediaServer(wss);

server.listen(PORT, () => {
  console.log(`[server] CrewCall voice server listening on :${PORT}`);
  console.log(`[server] POST /voice  (Twilio webhook → wss://$PUBLIC_WS_HOST/media)`);
  console.log(`[server] GET  /health`);
});

module.exports = { app };
