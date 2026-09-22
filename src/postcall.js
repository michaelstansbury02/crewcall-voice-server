'use strict';

/**
 * postcall.js — runs when a call ends (Twilio `stop` event or hangup):
 *   1. SMS summary to the business owner via Twilio.
 *   2. Persist the call record: Supabase `calls` table when configured,
 *      otherwise append to ./data/calls.jsonl.
 *   3. Console-log a clean one-line summary.
 */

const fs = require('fs');
const path = require('path');

let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  twilioClient = require('twilio')(sid, token);
  return twilioClient;
}

function buildOwnerSms(business, state) {
  const f = state.fields || {};
  const name = f.name || 'Unknown caller';
  const phone = f.phone || 'no number captured';
  const header = `CrewCall (${business.businessName})`;

  if (state.spam) return null; // never text the owner about spam

  if (state.urgent) {
    const what = state.emergencyKeyword ? ` — reported: ${state.emergencyKeyword}` : '';
    const svc = f.service ? ` (${f.service})` : '';
    return `🚨 URGENT ${header}: ${name}${svc}${what}. Callback: ${phone}. Full transcript logged.`;
  }

  if (state.classification === 'booking' && state.booking) {
    return `🔧 New booking ${header}: ${name} — ${f.service} at ${f.address}, ${state.booking.slotLabel}. Callback: ${phone}`;
  }

  const summary = state.summary || 'Left a message.';
  return `📞 ${header}: ${name} — ${summary} Callback: ${phone}`;
}

async function sendOwnerSms(business, text) {
  const client = getTwilioClient();
  if (!client) {
    console.warn('[postcall] Twilio not configured — SMS skipped');
    return null;
  }
  const from = business.twilioNumber || process.env.TWILIO_SMS_FROM;
  if (!from) {
    console.warn('[postcall] No sender number — SMS skipped');
    return null;
  }
  const msg = await client.messages.create({
    from,
    to: business.ownerPhone,
    body: text,
  });
  return msg.sid;
}

async function logToSupabase(record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return false;
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/calls`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase insert failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return true;
}

function logToJsonl(record) {
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(record) + '\n');
}

/**
 * @param {object} opts { business, state, callSid, from, to, startedAt, endedAt, endReason }
 */
async function handleCallEnd(opts) {
  const { business, state, callSid, from, to, startedAt, endedAt, endReason } = opts;

  const record = {
    business_id: business.id,
    call_sid: callSid || null,
    from: from || null,
    to: to || null,
    started_at: startedAt ? new Date(startedAt).toISOString() : null,
    ended_at: endedAt ? new Date(endedAt).toISOString() : new Date().toISOString(),
    end_reason: endReason || 'unknown',
    classification: state.classification,
    urgent: state.urgent,
    spam: state.spam,
    language: state.language,
    fields: state.fields,
    booking: state.booking,
    summary: state.summary,
    transcript: state.transcript,
  };

  // 1) Owner SMS
  let smsSid = null;
  try {
    const sms = buildOwnerSms(business, state);
    if (sms) smsSid = await sendOwnerSms(business, sms);
  } catch (err) {
    console.error(`[postcall] owner SMS failed: ${err.message}`);
  }

  // 2) Persist
  try {
    const usedSupabase = await logToSupabase({ ...record, owner_sms_sid: smsSid });
    if (!usedSupabase) logToJsonl(record);
  } catch (err) {
    console.error(`[postcall] Supabase log failed, falling back to JSONL: ${err.message}`);
    try { logToJsonl(record); } catch (e) { console.error(`[postcall] JSONL log failed: ${e.message}`); }
  }

  // 3) Clean console summary
  const f = state.fields || {};
  console.log(
    `[call] biz=${business.id} class=${state.classification} urgent=${state.urgent} ` +
    `lang=${state.language} name=${f.name || '-'} phone=${f.phone || '-'} ` +
    `service=${f.service || '-'} sms=${smsSid ? 'sent' : 'skipped'} sid=${callSid || '-'}`
  );

  return { smsSid, record };
}

module.exports = { handleCallEnd, buildOwnerSms, getTwilioClient };
