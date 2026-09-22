'use strict';

/**
 * conversation.test.js — scripted caller scenarios against the conversation
 * engine with a deterministic fake LLM. No network, no API keys, no cost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../src/conversation');
const { buildOwnerSms } = require('../src/postcall');

const businesses = require('../config/businesses.json');
const business = businesses.find((b) => b.id === 'coastal-plumbing-nc');

// Deterministic fake LLM: pops the next scripted response (object or JSON string).
function scripted(responses) {
  const queue = [...responses];
  return async (prompt) => {
    assert.ok(queue.length > 0, `fake LLM ran out of scripted responses. Prompt was:\n${prompt}`);
    return queue.shift();
  };
}

async function runScript({ now, script }) {
  const engine = createEngine({ business, now, llmRespond: scripted(script.map((s) => s.llm)) });
  const replies = [];
  replies.push(engine.greet());
  for (const turn of script) {
    const result = await engine.handleUtterance(turn.caller);
    replies.push(result.reply);
    if (result.done) break;
  }
  return { engine, replies, state: engine.getState() };
}

// Monday 2026-09-21 10:00 local — business OPEN.
const MON_10AM = new Date(2026, 8, 21, 10, 0, 0);
// Monday 2026-09-21 21:00 local — business CLOSED.
const MON_9PM = new Date(2026, 8, 21, 21, 0, 0);

test('happy path: full booking with phone read-back confirmation', async () => {
  const { state, replies } = await runScript({
    now: MON_10AM,
    script: [
      { caller: 'Hi, my water heater is leaking and I think I need it replaced',
        llm: { reply: "Oh no — I can get you scheduled for that. What's your name?", fields: { service: 'water heater replacement' } } },
      { caller: 'Mike Johnson',
        llm: { reply: "Thanks Mike. What's the best callback number for you?", fields: { name: 'Mike Johnson' } } },
      { caller: '919-555-0142',
        llm: JSON.stringify({ reply: "Just to confirm, that's 9-1-9, 5-5-5, 0-1-2-3?", fields: { phone: '919-555-0142' } }) },
      { caller: "Yes that's right",
        llm: { reply: "Perfect. And what's the service address?", fields: {} } },
      { caller: '4210 Gum Branch Road in Jacksonville',
        llm: { reply: 'Got it. I have an opening today between 11:00 AM and 1:00 PM — does that work?', fields: { address: '4210 Gum Branch Road, Jacksonville' } } },
      { caller: 'Yes, that works',
        llm: { reply: "You're all set, Mike — water heater replacement at 4210 Gum Branch Road, today between 11:00 AM and 1:00 PM. We'll see you then!",
               fields: { timeWindow: 'today 11-1' }, bookingRequested: true, done: true,
               summary: 'Booked water heater replacement for Mike Johnson' } },
    ],
  });

  assert.equal(state.classification, 'booking');
  assert.equal(state.done, true);
  assert.equal(state.hangup, true);
  assert.equal(state.fields.name, 'Mike Johnson');
  assert.equal(state.fields.phone, '919-555-0142');
  assert.equal(state.fields.service, 'water heater replacement');
  assert.equal(state.fields.address, '4210 Gum Branch Road, Jacksonville');
  assert.ok(state.booking, 'booking slot created');
  assert.match(state.booking.slotLabel, /today between 11:00 AM and 1:00 PM/);
  assert.ok(replies[3].includes('9-1-9'), 'phone number read back for confirmation');
  assert.equal(state.transcript[0].role, 'agent', 'greeting recorded in transcript');
  assert.match(state.transcript[0].text, /Coastal Flow Plumbing/);

  const sms = buildOwnerSms(business, state);
  assert.match(sms, /^🔧 New booking/);
  assert.match(sms, /Mike Johnson/);
  assert.match(sms, /919-555-0142/);
});

test('emergency: burst pipe → URGENT flag, escalation, urgent owner SMS', async () => {
  const engine = createEngine({ business, now: MON_10AM, llmRespond: scripted([
    { reply: 'contact', fields: { name: 'Sarah Miller', phone: '252-555-0199' } },
  ]) });
  engine.greet();
  const r1 = await engine.handleUtterance("There's water pouring through my kitchen ceiling!");
  assert.equal(r1.done, false, 'does not hang up before contact captured');
  assert.match(r1.reply, /urgent/i);
  assert.match(r1.reply, /technician/i);

  const r2 = await engine.handleUtterance('Sarah Miller, 252-555-0199');
  assert.equal(r2.done, true);
  assert.equal(r2.hangup, true);

  const s = engine.getState();
  assert.equal(s.urgent, true);
  assert.equal(s.classification, 'urgent');
  assert.equal(s.fields.urgency, 'urgent');
  assert.equal(s.fields.name, 'Sarah Miller');
  assert.equal(s.fields.phone, '252-555-0199');
  assert.match(s.emergencyKeyword || 'water pouring', /water pouring/);

  const sms = buildOwnerSms(business, s);
  assert.match(sms, /^🚨 URGENT/);
  assert.match(sms, /Sarah Miller/);
  assert.match(sms, /252-555-0199/);
});

test('Spanish speaker: full conversation switches to Spanish', async () => {
  const { state, replies } = await runScript({
    now: MON_10AM,
    script: [
      { caller: 'Hola, necesito un plomero, tengo una fuga en el baño',
        llm: { reply: 'Claro que sí. ¿Me puede dar su nombre?', fields: { service: 'reparación de fuga' }, language: 'es' } },
      { caller: 'Carlos Ruiz',
        llm: { reply: 'Gracias, Carlos. ¿Cuál es su número de teléfono?', fields: { name: 'Carlos Ruiz' }, language: 'es' } },
      { caller: '910-555-0134',
        llm: { reply: '¿Me confirma que es 9-1-0, 5-5-5, 0-1-3-4?', fields: { phone: '910-555-0134' }, language: 'es' } },
    ],
  });

  assert.equal(state.language, 'es');
  assert.equal(state.urgent, false, 'a routine leak is not an emergency');
  assert.equal(state.fields.name, 'Carlos Ruiz');
  assert.equal(state.fields.service, 'reparación de fuga');
  for (const reply of replies.slice(1)) {
    assert.ok(reply && !/what's your name\?/i.test(reply), `agent reply stayed in Spanish: ${reply}`);
  }
  assert.match(replies[1], /Claro que sí/);
});

test('robocall spam: polite close, hangup, no owner SMS', async () => {
  let llmCalls = 0;
  const engine = createEngine({
    business,
    now: MON_10AM,
    llmRespond: async () => { llmCalls += 1; return { reply: 'x', fields: {} }; },
  });
  engine.greet();
  const result = await engine.handleUtterance(
    "Congratulations! You've won a free cruise! Press one now to claim your prize!"
  );

  assert.equal(result.done, true);
  assert.equal(result.hangup, true);
  assert.equal(llmCalls, 0, 'spam detected without spending an LLM call');
  const s = engine.getState();
  assert.equal(s.spam, true);
  assert.equal(s.classification, 'spam');
  assert.match(result.reply, /goodbye/i);
  assert.equal(buildOwnerSms(business, s), null, 'no SMS to owner for spam');
});

test('after-hours caller: told closed, booked for next open slot', async () => {
  const { state } = await runScript({
    now: MON_9PM,
    script: [
      { caller: 'Hi, do you fix garbage disposals?',
        llm: { reply: "We're actually closed right now, but I can book you for tomorrow between 8:00 AM and 10:00 AM. What's your name?", fields: { service: 'garbage disposal repair' } } },
      { caller: 'Dana White',
        llm: { reply: "Thanks Dana. What's your callback number?", fields: { name: 'Dana White' } } },
      { caller: '910-555-0117',
        llm: { reply: 'And the service address?', fields: { phone: '910-555-0117' } } },
      { caller: '88 Brynn Marr Road',
        llm: { reply: 'Perfect — tomorrow between 8:00 AM and 10:00 AM works. Sound good?', fields: { address: '88 Brynn Marr Road' } } },
      { caller: 'Yes',
        llm: { reply: "Done — garbage disposal repair at 88 Brynn Marr Road, tomorrow between 8:00 AM and 10:00 AM. We'll see you then!",
               fields: {}, bookingRequested: true, done: true, summary: 'Booked garbage disposal repair for Dana White' } },
    ],
  });

  assert.equal(state.classification, 'booking');
  assert.equal(state.done, true);
  assert.match(state.booking.slotLabel, /tomorrow between 8:00 AM and 10:00 AM/);
  const start = new Date(state.booking.windowStart);
  assert.equal(start.getDay(), 2, 'slot falls on Tuesday (next open day after Monday night)');
  assert.equal(start.getHours(), 8);
});

test('emergency at night still escalates (hours do not gate emergencies)', async () => {
  const engine = createEngine({
    business,
    now: MON_9PM,
    llmRespond: scripted([{ reply: 'ok', fields: { name: 'Tom', phone: '252-555-0100' } }]),
  });
  engine.greet();
  const r1 = await engine.handleUtterance('I smell gas near my water heater!');
  const s = engine.getState();
  assert.equal(s.urgent, true);
  assert.equal(s.classification, 'urgent');
  assert.match(r1.reply, /urgent/i);
  const r2 = await engine.handleUtterance('Tom, 252-555-0100');
  assert.equal(r2.hangup, true);
});
