'use strict';

/**
 * llm.js — conversational LLM abstraction.
 *
 * Provider selection via env:
 *   LLM_PROVIDER=anthropic | openai | auto   (default: auto)
 *   auto → Anthropic if ANTHROPIC_API_KEY is set, else OpenAI if OPENAI_API_KEY.
 *
 * respond(prompt, context) → parsed JSON object (or { reply } fallback).
 * Throws if no provider is configured — call isConfigured() first.
 */

function pickProvider() {
  const want = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (want === 'anthropic' && hasAnthropic) return 'anthropic';
  if (want === 'openai' && hasOpenAI) return 'openai';
  if (want === 'auto') {
    if (hasAnthropic) return 'anthropic';
    if (hasOpenAI) return 'openai';
  }
  return null;
}

function isConfigured() {
  return pickProvider() !== null;
}

function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function respondAnthropic(prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  const msg = await client.messages.create({
    model,
    max_tokens: 400,
    system: 'You are a phone receptionist. Follow the instructions exactly and output only JSON.',
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return extractJson(text) || { reply: text.trim(), fields: {} };
}

async function respondOpenAI(prompt) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a phone receptionist. Follow the instructions exactly and output only JSON.' },
      { role: 'user', content: prompt },
    ],
  });
  const text = completion.choices[0]?.message?.content || '';
  return extractJson(text) || { reply: text.trim(), fields: {} };
}

async function respond(prompt /*, context */) {
  const provider = pickProvider();
  if (!provider) throw new Error('No LLM provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  try {
    return provider === 'anthropic' ? await respondAnthropic(prompt) : await respondOpenAI(prompt);
  } catch (err) {
    console.error(`[llm] ${provider} failed: ${err.message} — retrying once`);
    await new Promise((r) => setTimeout(r, 800));
    return provider === 'anthropic' ? await respondAnthropic(prompt) : await respondOpenAI(prompt);
  }
}

module.exports = { respond, isConfigured, pickProvider };
