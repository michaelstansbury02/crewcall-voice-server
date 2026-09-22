# CrewCall Voice Server (MVP)

AI phone receptionist for home-service contractors. A homeowner dials the
business; Twilio bridges the call audio to this server over Media Streams;
the server holds a natural spoken conversation (greeting → intake → booking),
detects emergencies, and texts the business owner a summary when the call ends.

```
                        ┌─────────────────────────────┐
                        │        Twilio Cloud         │
                        │  (business phone number)    │
                        └──────────────┬──────────────┘
                                       │ ① POST /voice (TwiML webhook)
                                       ▼
┌──────────────┐   ② TwiML <Stream>   ┌──────────────────────────────┐
│   Caller     │◄────────────────────►│   CrewCall voice server      │
│  (homeowner) │   RTP audio          │                              │
└──────────────┘                      │  src/server.js  Express      │
                                      │   ├─ POST /voice → TwiML     │
                                      │   └─ GET  /health            │
                                      │  src/media.js   WS /media    │
                                      │   ├─ inbound 8kHz μ-law      │
                                      │   ├─ outbound 20ms frames    │
                                      │   └─ barge-in via `clear`    │
                                      │  ┌────────────────────────┐  │
                                      │  │  Speech pipeline       │  │
                                      │  │  stt.js → Deepgram     │  │
                                      │  │   streaming (nova-2)   │  │
                                      │  │  conversation.js       │  │
                                      │  │   engine (state +      │  │
                                      │  │   emergency/spam/ES)   │  │
                                      │  │  llm.js → Claude/OpenAI│  │
                                      │  │  tts.js → OpenAI TTS   │  │
                                      │  │   → 8kHz μ-law frames  │  │
                                      │  └────────────────────────┘  │
                                      │  src/postcall.js             │
                                      └──────────────┬───────────────┘
                                                     │ ③ SMS to owner (Twilio)
                                                     │ ④ call log → Supabase
                                                     │    or ./data/calls.jsonl
                                                     ▼
                                        ┌────────────────────────┐
                                        │ Business owner (SMS)   │
                                        │ 🔧 booking / 🚨 urgent │
                                        │ 📞 message             │
                                        └────────────────────────┘
```

**Call flow:** `connected` → `start` (business lookup) → greeting (TTS) →
Deepgram interim/final transcripts → engine → spoken reply → … →
`stop`/hangup → owner SMS + call log.

**Barge-in:** if Deepgram reports speech while TTS audio is queued/playing,
the server sends Twilio a `clear` message, drops the queue, and listens.

## Quick start

```bash
cd voice-server
npm install
cp .env.example .env        # fill in keys (see below)
npm test                    # 22 tests, no API calls, must all pass
npm start                   # → http://localhost:3000
```

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (3000) | HTTP listen port |
| `PUBLIC_BASE_URL` | **yes (prod)** | e.g. `https://crewcall-voice.fly.dev` — used for Twilio signature validation; must exactly match the webhook URL set in Twilio |
| `PUBLIC_WS_HOST` | **yes (prod)** | e.g. `crewcall-voice.fly.dev` — host placed in the TwiML `<Stream url="wss://…/media">` |
| `TWILIO_ACCOUNT_SID` | **yes** | Twilio account SID (SMS + hangup + signature) |
| `TWILIO_AUTH_TOKEN` | **yes** | Twilio auth token (signature validation) |
| `TWILIO_SMS_FROM` | no | Fallback SMS sender if a business has no number of its own |
| `DEFAULT_BUSINESS_ID` | no | Fallback business when the `To` number isn't in config |
| `SKIP_SIGNATURE_CHECK` | no (`false`) | **Dev only.** Skips `X-Twilio-Signature` validation. Never `true` in production |
| `DEEPGRAM_API_KEY` | **yes** | Streaming speech-to-text |
| `DEEPGRAM_MODEL` | no (`nova-2`) | Deepgram model name |
| `LLM_PROVIDER` | no (`auto`) | `anthropic` \| `openai` \| `auto` |
| `ANTHROPIC_API_KEY` | yes* | Claude (fast model) for conversation |
| `ANTHROPIC_MODEL` | no (`claude-haiku-4-5`) | Override if a newer fast model is preferred |
| `OPENAI_API_KEY` | yes* | Fallback LLM + **required** for TTS |
| `OPENAI_MODEL` | no (`gpt-4o-mini`) | Fallback chat model |
| `TTS_VOICE` | no (`nova`) | OpenAI TTS voice |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | no | Call log goes to Supabase `calls` table; without these it appends to `./data/calls.jsonl` |

\* At least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is required for the
conversation LLM. `OPENAI_API_KEY` is additionally required for TTS — without
it the server answers with a "technical difficulties" message and hangs up.

**Existing credentials:** this workspace already has connected CLIs/skills for
GitHub, Stripe, and Vercel under `~/workspace/skills/`. There is no stored
Twilio/Deepgram/Anthropic/OpenAI credential here — those keys must be supplied
via `.env` (values are never printed or committed).

## Twilio setup (what to click)

1. **Buy a number** (~$2/mo): Twilio Console → Phone Numbers → Buy a Number
   (pick one with Voice + SMS, area code near the business).
2. **Point the voice webhook** at the deployed server:
   Phone Numbers → *your number* → Voice Configuration →
   *A call comes in*: **Webhook**, `https://<your-host>/voice`, **HTTP POST**.
3. **Add the business** to `config/businesses.json` (see below) with the new
   number in `twilioNumber` and the owner's mobile in `ownerPhone`.
4. **Test call**: dial the Twilio number from your cell. You should hear
   *"Thanks for calling {business}, this is {agent}…"*. After hangup the owner
   gets an SMS and the call lands in `./data/calls.jsonl` (or Supabase).
5. Optional: enable **call recording** later via `<Record>` in `/voice`
   (not in the MVP).

## Deploy — Fly.io (primary)

```bash
fly launch            # accept the generated name, or set app="crewcall-voice" in fly.toml
fly secrets set TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… \
  DEEPGRAM_API_KEY=… ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
  PUBLIC_BASE_URL=https://crewcall-voice.fly.dev \
  PUBLIC_WS_HOST=crewcall-voice.fly.dev
fly deploy
```

Then set the Twilio voice webhook to `https://crewcall-voice.fly.dev/voice`.
`GET /health` is the Fly health check target.

**Render (alternative):** create a Web Service from this directory,
start command `npm start`, add the same env vars, and set the Twilio webhook
to `https://<service>.onrender.com/voice`. Note: Render free tier sleeps —
the first call of the day may take ~30s to answer while it wakes.

## Tests

```bash
npm test   # node --test test/*.test.js — 22 tests, zero external API calls
```

The conversation engine is fully decoupled from I/O: tests inject a scripted
fake LLM (`llmRespond`) and drive scripted caller transcripts through it.

| Scenario | Asserts |
|---|---|
| Happy-path booking | classification=booking, name/phone/service/address collected, phone read back for confirmation, slot label correct |
| Emergency (burst pipe) | `urgent=true`, escalation reply before contact captured, `🚨 URGENT` owner SMS |
| Spanish speaker | whole conversation in Spanish, routine leak ≠ emergency |
| Robocall spam | polite close + hangup, **zero** LLM calls spent, no owner SMS |
| After-hours caller | told closed, booked next open morning (Tue 8–10 AM) |
| Emergency at night | still escalates (hours don't gate emergencies) |
| Units | μ-law codec round-trip, 20 ms framing, WAV parse, slot math (today/evening/weekend/near-close), SMS formats, spam/Spanish/emergency detectors, config schema |

## Adding a new business

Append to `config/businesses.json`:

```json
{
  "id": "apex-hvac-raleigh",
  "twilioNumber": "+19195550123",
  "businessName": "Apex Heating & Air",
  "agentName": "Sarah",
  "ownerPhone": "+19195550456",
  "ownerEmail": "owner@example.com",
  "services": ["ac repair", "furnace install", "maintenance plans"],
  "serviceArea": "Raleigh-Durham, NC",
  "hours": {
    "mon": {"open": "08:00", "close": "17:00"},
    "tue": {"open": "08:00", "close": "17:00"},
    "wed": {"open": "08:00", "close": "17:00"},
    "thu": {"open": "08:00", "close": "17:00"},
    "fri": {"open": "08:00", "close": "17:00"},
    "sat": null,
    "sun": null
  },
  "emergencyKeywords": ["no ac", "furnace won't start"],
  "spanishSupported": true
}
```

No code changes needed — redeploy (or restart) and point the business's
Twilio number at `/voice`. The sample entry (`coastal-plumbing-nc`, a
fictional Jacksonville NC plumbing company) is safe to delete once real
businesses are added.

## Conversation design (the product logic)

- **Turns are short** — 1–2 spoken sentences, no lists, no jargon.
- **Field collection order:** service → name → phone (read back to confirm) →
  address → time. One missing item asked per turn.
- **Emergency:** rule-based keyword match (EN+ES, incl. per-business keywords)
  interrupts normal flow immediately: *"That sounds urgent — I'm flagging this
  for our on-call technician right now…"*, then captures name + callback
  number and closes. Hours never gate emergencies.
- **Spam:** robocall patterns close politely without spending an LLM call, and
  the owner is never texted.
- **Bilingual:** Spanish detected from the caller's speech switches the entire
  conversation (greeting stays English until the switch is detected).
- **Booking:** simple slot model in `src/booking.js` (next 2-hour window in
  business hours).
  **TODO:** replace with Google Calendar freebusy — add `GOOGLE_CALENDAR_ID`
  per business and implement `findFreeSlot()` in `booking.js`; the engine only
  calls `nextAvailableSlot()`.

## Security notes

- `POST /voice` validates `X-Twilio-Signature` against `TWILIO_AUTH_TOKEN`
  and `PUBLIC_BASE_URL`; invalid → `403`. Keep `SKIP_SIGNATURE_CHECK=false`
  everywhere except local dev.
- Secrets live only in `.env` (gitignored) / `fly secrets` — never in code,
  logs, or the repo.
- The `/media` WebSocket accepts Twilio's protocol messages only; unknown
  paths are closed. Serve strictly over `wss://` in production.
- Call transcripts contain PII (names, phone numbers, addresses). The JSONL
  fallback is gitignored; if using Supabase, enable RLS on the `calls` table
  and restrict the service key.
- No ElevenLabs anywhere in this codebase (subscription cancelled) — TTS is
  OpenAI only.

## File map

```
voice-server/
├── src/
│   ├── server.js        Express: POST /voice (TwiML+sig check), GET /health
│   ├── media.js         WS /media: Media Streams session, barge-in, silence/max-call guards
│   ├── conversation.js  engine: greeting, intake, emergency/spam/ES, booking (injectable LLM)
│   ├── booking.js       hours + next-available 2h slot (TODO: GCal freebusy)
│   ├── stt.js           Deepgram streaming over raw WS (8kHz μ-law native)
│   ├── llm.js           Claude (primary) / OpenAI (fallback), JSON contract
│   ├── tts.js           OpenAI TTS wav → 8kHz μ-law 20ms frames (+cache)
│   ├── audio.js         G.711 μ-law codec, downsample, WAV parse, framing
│   └── postcall.js      owner SMS (🔧/🚨/📞) + Supabase or data/calls.jsonl log
├── config/businesses.json   multi-tenant config (+1 fictional NC sample)
├── test/                    22 tests, mocked LLM, no network
├── fly.toml                 Fly.io deploy config
├── .env.example             all env vars documented
└── package.json             npm start / npm test
```
