'use strict';

/**
 * conversation.js — the CrewCall conversation engine.
 *
 * Pure logic, no I/O: the LLM is injected as `llmRespond(prompt)`, which makes
 * the engine fully testable with scripted/fake responders (see test/).
 *
 * Flow per caller utterance:
 *   1. spam check (rule-based, no LLM cost)
 *   2. language detection (Spanish switch)
 *   3. emergency keyword check (rule-based, immediate escalation)
 *   4. LLM turn: field extraction + natural reply (JSON contract)
 *   5. booking creation when the caller agrees and fields are complete
 */

const { isOpenNow, nextAvailableSlot } = require('./booking');

const SPAM_PATTERNS = [
  /press\s+(one|1|two|2)/i,
  /car('s)?\s+warranty/i,
  /congratulations.*(won|winner|prize)/i,
  /claim your (prize|reward|gift)/i,
  /this is the irs/i,
  /lawsuit.*filed against you/i,
  /your (social security|ssn) .*suspended/i,
  /free (cruise|vacation|gift card)/i,
  /extended warranty/i,
];

const EMERGENCY_DEFAULTS = [
  // English
  'burst pipe', 'pipe burst', 'flooding', 'flooded', 'water pouring',
  'water gushing', 'water everywhere', 'gas smell', 'smell gas', 'smell of gas',
  'gas leak', 'sparking', 'sparks', 'burning smell', 'electrical fire',
  'sewage backup', 'sewage coming up', 'no heat', 'carbon monoxide',
  // Spanish
  'tubería rota', 'tubo roto', 'se rompió la tubería', 'inundación', 'inundado',
  'agua saliendo', 'agua por todas partes', 'olor a gas', 'huele a gas',
  'fuga de gas', 'chispas', 'olor a quemado', 'sin calefacción',
  'aguas residuales',
];

const SPANISH_HINTS = [
  'hola', 'gracias', 'por favor', 'necesito', 'quiero', 'tengo una', 'tengo un',
  'plomero', 'fuga', 'gracias', 'buenos días', 'buenas tardes', 'cuánto cuesta',
  'dirección', 'teléfono', 'mañana', 'hoy', 'baño', 'cocina', 'calentador',
];

const MAX_CALLER_TURNS = 14;

function normalize(text) {
  return (text || '').toLowerCase();
}

function looksLikeSpam(text) {
  const t = normalize(text);
  if (SPAM_PATTERNS.some((re) => re.test(t))) return true;
  // Robocall "hello? ... hello? ... hello?" loops
  const hellos = (t.match(/hello\?*/g) || []).length;
  if (hellos >= 3 && t.replace(/hello\?*|\W/g, '').length < 10) return true;
  return false;
}

function looksSpanish(text) {
  const t = ' ' + normalize(text) + ' ';
  return SPANISH_HINTS.some((hint) => t.includes(hint));
}

function findEmergency(text, business) {
  const t = normalize(text);
  const keywords = [...EMERGENCY_DEFAULTS, ...(business.emergencyKeywords || [])];
  return keywords.find((kw) => kw && t.includes(normalize(kw))) || null;
}

function createEngine({ business, now = new Date(), llmRespond }) {
  if (!business) throw new Error('business is required');
  if (typeof llmRespond !== 'function') throw new Error('llmRespond is required');

  const state = {
    businessId: business.id,
    language: 'en',
    fields: {
      name: null,
      phone: null,
      service: null,
      address: null,
      timeWindow: null,
      urgency: 'routine',
    },
    classification: 'inquiry', // inquiry | booking | urgent | spam | message
    urgent: false,
    spam: false,
    done: false,
    hangup: false,
    booking: null,
    transcript: [], // [{ role: 'agent'|'caller', text }]
    callerTurns: 0,
    emergencyKeyword: null,
    awaitingContactAfterEmergency: false,
    summary: null,
  };

  const L = (en, es) => (state.language === 'es' ? es : en);

  function greeting() {
    return L(
      `Thanks for calling ${business.businessName}, this is ${business.agentName}, how can I help you today?`,
      `Gracias por llamar a ${business.businessName}, soy ${business.agentName}, ¿en qué puedo ayudarle hoy?`
    );
  }

  /** Speak the greeting AND record it in the transcript (call this once per call). */
  function greet() {
    return agentSay(greeting());
  }

  function agentSay(text) {
    state.transcript.push({ role: 'agent', text });
    return text;
  }

  function requiredFields() {
    return ['name', 'phone', 'service', 'address'].filter((k) => !state.fields[k]);
  }

  function buildLlmPrompt(callerText) {
    const open = isOpenNow(business, now);
    const slot = nextAvailableSlot(business, now);
    const missing = requiredFields();
    const history = state.transcript.slice(-10).map((t) =>
      `${t.role === 'agent' ? business.agentName : 'Caller'}: ${t.text}`
    ).join('\n');

    const langName = state.language === 'es' ? 'Spanish' : 'English';
    return [
      `You are ${business.agentName}, the friendly AI receptionist for ${business.businessName}, a ${business.services.join(', ')} company serving ${business.serviceArea}.`,
      `VOICE RULES: Speak like a warm human on the phone. 1-2 short sentences per turn, never more. No lists, no bullet points, no jargon, no "as an AI".`,
      `Current local time: ${now.toString()}. The business is currently ${open ? 'OPEN' : 'CLOSED'}.`,
      slot
        ? `Next available appointment: ${slot.label}. Offer this slot when the caller wants to book.`
        : `No availability found in the next 2 weeks — apologize and take a message instead.`,
      `Already collected: ${JSON.stringify(state.fields)}.`,
      missing.length
        ? `Still needed before booking: ${missing.join(', ')}. Ask for ONE missing item at a time, conversationally.`
        : `All required fields collected. Confirm the booking at the next available slot.`,
      `If the caller just gave a phone number, read it back grouped (e.g. "9-1-9, 5-5-5, 0-1-2-3") and ask them to confirm it.`,
      `If the caller agrees to the appointment time (or asks to schedule/book), set bookingRequested=true.`,
      `When the booking is confirmed and you have summarized it, set done=true and write a one-sentence summary in "summary".`,
      state.awaitingContactAfterEmergency
        ? `URGENT CALL: this caller reported an emergency ("${state.emergencyKeyword}"). Do NOT ask about services. Just collect their name and callback number, then set done=true.`
        : null,
      `Respond in ${langName}. Output ONLY valid JSON, no other text:`,
      `{"reply":"what you say out loud","fields":{"name":"...","phone":"...","service":"...","address":"...","timeWindow":"..."},"language":"en|es","bookingRequested":true|false,"done":true|false,"summary":"..."}`,
      `Only include fields in "fields" that were stated or confirmed in THIS turn.`,
      ``,
      `Conversation so far:\n${history || '(start of call)'}`,
      `Caller just said: "${callerText}"`,
    ].filter(Boolean).join('\n');
  }

  async function llmTurn(callerText) {
    const prompt = buildLlmPrompt(callerText);
    let out = await llmRespond(prompt, { state: snapshot(), business });
    if (typeof out === 'string') {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return { reply: out.trim(), fields: {} };
      try {
        out = JSON.parse(m[0]);
      } catch {
        return { reply: out.trim(), fields: {} };
      }
    }
    return out && typeof out === 'object' ? out : { reply: '', fields: {} };
  }

  function applyFields(patch) {
    if (!patch || typeof patch !== 'object') return;
    for (const k of ['name', 'phone', 'service', 'address', 'timeWindow']) {
      if (patch[k] && typeof patch[k] === 'string' && patch[k].trim()) {
        state.fields[k] = patch[k].trim();
      }
    }
  }

  function emergencyReply() {
    return L(
      `That sounds urgent — I'm flagging this for our on-call technician right now. Can I get your name and the best number to reach you in the next few minutes?`,
      `Eso suena urgente — lo estoy pasando a nuestro técnico de guardia ahora mismo. ¿Me puede dar su nombre y el mejor número para llamarle en los próximos minutos?`
    );
  }

  function emergencyDoneReply() {
    const f = state.fields;
    return L(
      `Got it, ${f.name || 'thanks'}. Our technician will call you back at ${f.phone} within minutes. Stay safe — is there anything else I can do?`,
      `Entendido${f.name ? ', ' + f.name : ''}. Nuestro técnico le llamará al ${f.phone} en unos minutos. Cuídese — ¿algo más en lo que pueda ayudar?`
    );
  }

  function spamReply() {
    return L(
      `I think this might be an automated call, so I'll let you go. Goodbye!`,
      `Creo que esta puede ser una llamada automática, así que me despido. ¡Adiós!`
    );
  }

  function wrapUpReply() {
    return L(
      `I want to make sure I get this right — could you tell me your name and callback number so our team can follow up?`,
      `Quiero asegurarme de anotarlo bien — ¿me puede dar su nombre y un número para que nuestro equipo le llame?`
    );
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({
      businessId: state.businessId,
      language: state.language,
      fields: state.fields,
      classification: state.classification,
      urgent: state.urgent,
      spam: state.spam,
      done: state.done,
      hangup: state.hangup,
      booking: state.booking,
      transcript: state.transcript,
      callerTurns: state.callerTurns,
      summary: state.summary,
    }));
  }

  /**
   * Process one finalized caller utterance.
   * Returns { reply, done, hangup, state } — reply may be null (ignore).
   */
  async function handleUtterance(rawText) {
    const text = (rawText || '').trim();
    if (!text) return { reply: null, done: state.done, hangup: state.hangup, state: snapshot() };
    if (state.done) {
      return { reply: null, done: true, hangup: state.hangup, state: snapshot() };
    }

    state.transcript.push({ role: 'caller', text });
    state.callerTurns += 1;

    // 1) Spam — no LLM call wasted.
    if (looksLikeSpam(text)) {
      state.spam = true;
      state.classification = 'spam';
      state.done = true;
      state.hangup = true;
      state.summary = 'Spam/robocall — call closed politely.';
      return { reply: agentSay(spamReply()), done: true, hangup: true, state: snapshot() };
    }

    // 2) Language switch.
    if (state.language === 'en' && business.spanishSupported !== false && looksSpanish(text)) {
      state.language = 'es';
    }

    // 3) Emergency — immediate escalation path, no LLM needed for detection.
    const emergencyKw = findEmergency(text, business);
    if (emergencyKw && !state.urgent) {
      state.urgent = true;
      state.classification = 'urgent';
      state.fields.urgency = 'urgent';
      state.emergencyKeyword = emergencyKw;
      state.awaitingContactAfterEmergency = true;
      return { reply: agentSay(emergencyReply()), done: false, hangup: false, state: snapshot() };
    }

    // Follow-up turn after an emergency: just extract name/phone, then close.
    if (state.awaitingContactAfterEmergency) {
      const out = await llmTurn(text);
      applyFields(out.fields);
      if (out.language === 'es' || out.language === 'en') state.language = out.language;
      state.summary = `URGENT (${state.emergencyKeyword}): ${state.fields.name || 'unknown caller'} — callback ${state.fields.phone || 'no number'}.`;
      if (state.fields.phone) {
        state.done = true;
        state.hangup = true;
        state.awaitingContactAfterEmergency = false;
        return { reply: agentSay(emergencyDoneReply()), done: true, hangup: true, state: snapshot() };
      }
      return { reply: agentSay(out.reply || emergencyReply()), done: false, hangup: false, state: snapshot() };
    }

    // 4) Guard against endless calls.
    if (state.callerTurns >= MAX_CALLER_TURNS && !state.done) {
      state.done = true;
      state.hangup = true;
      state.classification = state.classification === 'inquiry' ? 'message' : state.classification;
      state.summary = state.summary || 'Long call — took a message for the team.';
      return { reply: agentSay(wrapUpReply()), done: true, hangup: true, state: snapshot() };
    }

    // 5) Normal LLM turn.
    const out = await llmTurn(text);
    applyFields(out.fields);
    if (out.language === 'es' || out.language === 'en') state.language = out.language;

    const missing = requiredFields();
    const wantsBooking = out.bookingRequested === true;

    if ((wantsBooking || out.done === true) && missing.length === 0) {
      const slot = nextAvailableSlot(business, now);
      state.booking = slot
        ? {
            slotLabel: slot.label,
            windowStart: slot.windowStart.toISOString(),
            windowEnd: slot.windowEnd.toISOString(),
            requestedWindow: state.fields.timeWindow,
            service: state.fields.service,
            address: state.fields.address,
          }
        : null;
      state.classification = 'booking';
      state.done = true;
      state.hangup = true;
      state.summary = out.summary
        || `Booked ${state.fields.service} for ${state.fields.name} at ${state.fields.address} — ${slot ? slot.label : 'no slot found'}.`;
      const reply = out.reply || L(
        `You're all set, ${state.fields.name}. ${state.fields.service} at ${state.fields.address}, ${slot ? slot.label : ''}. We'll see you then!`,
        `Listo, ${state.fields.name}. ${state.fields.service} en ${state.fields.address}, ${slot ? slot.label : ''}. ¡Nos vemos entonces!`
      );
      return { reply: agentSay(reply), done: true, hangup: true, state: snapshot() };
    }

    if (out.done === true && missing.length > 0) {
      // LLM wants to close but we're missing info — take a message instead.
      state.classification = 'message';
      state.done = true;
      state.hangup = true;
      state.summary = out.summary || `Message from ${state.fields.name || 'caller'}: ${text}`;
    }

    const reply = out.reply || wrapUpReply();
    return { reply: agentSay(reply), done: state.done, hangup: state.hangup, state: snapshot() };
  }

  return { handleUtterance, greeting, greet, getState: snapshot, business };
}

module.exports = { createEngine, looksLikeSpam, looksSpanish, findEmergency };
