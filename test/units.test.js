'use strict';

/**
 * units.test.js — pure-function unit tests: audio codec, slot logic,
 * owner-SMS builder, config schema. No network, no API keys.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeMulaw, decodeMulaw, pcmToMulawFrames, parseWav } = require('../src/audio');
const { isOpenNow, nextAvailableSlot } = require('../src/booking');
const { buildOwnerSms } = require('../src/postcall');
const { looksLikeSpam, looksSpanish, findEmergency } = require('../src/conversation');

const businesses = require('../config/businesses.json');
const business = businesses[0];

// ---------- config schema ----------

test('businesses.json: sample business has all required fields', () => {
  assert.ok(Array.isArray(businesses) && businesses.length > 0);
  for (const b of businesses) {
    for (const k of ['id', 'twilioNumber', 'businessName', 'agentName', 'ownerPhone', 'services', 'hours', 'emergencyKeywords']) {
      assert.ok(b[k] !== undefined && b[k] !== null, `business ${b.id} missing ${k}`);
    }
    assert.ok(/^\+1\d{10}$/.test(b.twilioNumber), 'twilioNumber is E.164');
    assert.ok(/^\+1\d{10}$/.test(b.ownerPhone), 'ownerPhone is E.164');
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      assert.ok(d in b.hours, `hours missing ${d}`);
    }
  }
});

// ---------- audio codec ----------

test('mu-law: silence encodes to 0xFF and round-trips within tolerance', () => {
  assert.equal(encodeMulaw(0), 0xff);
  for (const sample of [0, 100, -100, 1000, -5000, 16000, -16000, 30000]) {
    const decoded = decodeMulaw(encodeMulaw(sample));
    const err = Math.abs(decoded - sample) / Math.max(1, Math.abs(sample));
    assert.ok(err < 0.05, `sample ${sample} decoded as ${decoded} (err ${(err * 100).toFixed(1)}%)`);
  }
});

test('pcmToMulawFrames: 1s of 24kHz PCM → fifty 20ms base64 frames', () => {
  const pcm = new Int16Array(24000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
  const frames = pcmToMulawFrames(pcm, 24000);
  assert.equal(frames.length, 50);
  for (const f of frames) {
    assert.equal(Buffer.from(f, 'base64').length, 160, 'each frame is 20ms (160 bytes)');
  }
});

test('parseWav: parses a synthetic 16-bit PCM wav', () => {
  const dataLen = 1600; // 100 samples
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  buf.writeInt16LE(1234, 44);
  const { sampleRate, pcm16 } = parseWav(buf);
  assert.equal(sampleRate, 8000);
  assert.equal(pcm16.length, 800);
  assert.equal(pcm16[0], 1234);
});

// ---------- booking slots ----------

test('isOpenNow respects hours config', () => {
  assert.equal(isOpenNow(business, new Date(2026, 8, 21, 10, 0)), true);  // Mon 10am
  assert.equal(isOpenNow(business, new Date(2026, 8, 21, 21, 0)), false); // Mon 9pm
  assert.equal(isOpenNow(business, new Date(2026, 8, 26, 10, 0)), false); // Sat
  assert.equal(isOpenNow(business, new Date(2026, 8, 21, 7, 59)), false); // before open
  assert.equal(isOpenNow(business, new Date(2026, 8, 21, 17, 0)), false); // at close
});

test('nextAvailableSlot: open day → today in next 2h window', () => {
  const slot = nextAvailableSlot(business, new Date(2026, 8, 21, 10, 0));
  assert.ok(slot);
  assert.match(slot.label, /today between 11:00 AM and 1:00 PM/);
});

test('nextAvailableSlot: evening → next open morning', () => {
  const slot = nextAvailableSlot(business, new Date(2026, 8, 21, 21, 0));
  assert.ok(slot);
  assert.match(slot.label, /tomorrow between 8:00 AM and 10:00 AM/);
});

test('nextAvailableSlot: Saturday → Monday', () => {
  const slot = nextAvailableSlot(business, new Date(2026, 8, 26, 10, 0));
  assert.ok(slot);
  assert.match(slot.label, /Monday between 8:00 AM and 10:00 AM/);
});

test('nextAvailableSlot: too close to closing → next day', () => {
  const slot = nextAvailableSlot(business, new Date(2026, 8, 21, 16, 0)); // 60 min left
  assert.ok(slot);
  assert.match(slot.label, /tomorrow/);
});

// ---------- owner SMS builder ----------

function baseState(overrides = {}) {
  return {
    fields: { name: 'Test Caller', phone: '919-555-0100', service: 'drain cleaning', address: '1 Main St', urgency: 'routine', timeWindow: null },
    classification: 'message', urgent: false, spam: false, language: 'en',
    booking: null, summary: 'Wants a quote for drain cleaning.', transcript: [],
    ...overrides,
  };
}

test('buildOwnerSms: booking format', () => {
  const sms = buildOwnerSms(business, baseState({
    classification: 'booking',
    booking: { slotLabel: 'tomorrow between 8:00 AM and 10:00 AM' },
  }));
  assert.match(sms, /^🔧 New booking/);
  assert.match(sms, /Coastal Flow Plumbing/);
  assert.match(sms, /tomorrow between 8:00 AM and 10:00 AM/);
});

test('buildOwnerSms: urgent format', () => {
  const sms = buildOwnerSms(business, baseState({ urgent: true, classification: 'urgent' }));
  const s2 = buildOwnerSms(business, { ...baseState(), urgent: true, classification: 'urgent', emergencyKeyword: 'burst pipe' });
  assert.match(sms, /^🚨 URGENT/);
  assert.match(s2, /burst pipe/);
});

test('buildOwnerSms: plain message format', () => {
  const sms = buildOwnerSms(business, baseState());
  assert.match(sms, /^📞/);
  assert.match(sms, /Wants a quote/);
});

test('buildOwnerSms: spam → null (no text)', () => {
  assert.equal(buildOwnerSms(business, baseState({ spam: true, classification: 'spam' })), null);
});

// ---------- detectors ----------

test('spam detector catches robocall patterns, not humans', () => {
  assert.equal(looksLikeSpam('Congratulations, you have won a free cruise! Press one to claim.'), true);
  assert.equal(looksLikeSpam('Hello? Hello? Hello? Hello?'), true);
  assert.equal(looksLikeSpam('Hi, my kitchen sink is clogged and water is backing up'), false);
  assert.equal(looksLikeSpam('Do you guys do water heater installs?'), false);
});

test('spanish detector', () => {
  assert.equal(looksSpanish('Hola, necesito un plomero por favor'), true);
  assert.equal(looksSpanish('Hi, I need a plumber please'), false);
});

test('emergency detector: EN + ES keywords, no false positives on routine leaks', () => {
  assert.ok(findEmergency("There's water pouring through my ceiling!", business));
  assert.ok(findEmergency('I smell gas near the furnace', business));
  assert.ok(findEmergency('Se rompió la tubería del baño', business));
  assert.equal(findEmergency('My water heater is leaking a little', business), null);
  assert.equal(findEmergency('Tengo una fuga en el baño', business), null);
  assert.equal(findEmergency('Do you install faucets?', business), null);
});
