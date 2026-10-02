# Global Thought Stream™
### *One Thought. Every Language. Continuity Preserved.*

**By Sphinx Global Enterprises Corp**  
Live at [globalthoughtstream.net](https://globalthoughtstream.net)

---

## The Mission

The original Tower of Babel scattered humanity across language lines. Global Thought Stream™ is the reversal — a multilingual AI conversation platform that preserves meaning, intent, and context across every language switch. When someone in Lagos speaks Igbo and someone in Beijing responds in Mandarin, the thought stream stays intact. The bridge holds.

---

## What It Does

Global Thought Stream™ is a production-grade multilingual AI platform powered by a multi-model router (Claude + Gemini + ElevenLabs) with three proprietary systems at its core:

| System | Function |
|--------|----------|
| **ThreadLock™** | Preserves semantic meaning, tone, and context across language switches — no reset, no loss |
| **TrustChain™** | SHA-256 cryptographic chain logs every language transition as an immutable audit trail |
| **NarrativePure™** | Claude + Gemini verify facts in parallel — dual-model consensus with divergence alerts |

---

## Supported Languages

🇺🇸 English · 🇳🇬 Igbo · 🇳🇬 Yoruba · 🇳🇬 Hausa · 🇸🇦 Arabic · 🇨🇳 Mandarin · 🇫🇷 French · 🇪🇸 Spanish · 🇰🇪 Swahili · 🇪🇹 Amharic

Igbo, Yoruba, and Hausa represent 100M+ speakers historically underserved by major AI platforms. This is a core part of the mission.

---

## Features

- **Voice input** — 10-language Speech Recognition with real-time language detection and continuity scoring
- **NarrativePure™** — Claude + Gemini fact-check in parallel. Consensus scoring with divergence alerts
- **TrustChain™ audit trail** — SHA-256 HOB chain logs every turn. Export as JSON, Markdown, or HTML compliance report
- **Real-time translation** — Live translation toggle across all 10 language combinations
- **Multi-speaker mode** — Dual-speaker voice with individual language detection per speaker
- **ThreadLock™ scoring** — Real-time continuity score tracks meaning preservation across every language switch
- **ElevenLabs TTS** — High-quality multilingual voice synthesis with browser fallback
- **WebSocket streaming** — Token-by-token response streaming for sub-500ms perceived latency
- **Session history** — Up to 50 sessions stored with full HOB audit trail per session
- **Export** — JSON (developer), Markdown (transcript), HTML (compliance report)

---

## Tech Stack

```
Browser (client)
  └── No API keys exposed — X-GTS-Token auth only

Proxy Server (Node.js / Express v3.2)
  ├── Token authentication + rate limiting
  ├── Feature gating by tier
  ├── Input sanitization
  ├── Helmet security headers
  └── WebSocket streaming engine

Model Router
  ├── Claude Sonnet   → conversation + NarrativePure™ verification
  ├── Gemini 1.5 Flash → audio transcription + NarrativePure™ verification
  └── ElevenLabs       → multilingual voice synthesis

TrustChain™ Database
  └── SQLite + SHA-256 HOB chain → audit export → compliance trail
```

---

## Pricing Tiers

| Tier | Price | Messages | Features |
|------|-------|----------|----------|
| **Starter** | Free | 20/day · 100 total · 14-day trial | Chat, voice, HOB audit |
| **Professional** | $49/mo | 2,000/day | All features + NarrativePure™ + export + translation |
| **Enterprise** | $299/mo | Unlimited | All Pro + dual-model audit + webhooks + API access |

---

## Installation

### Requirements
- Node.js v18+
- API keys: Anthropic (required), Gemini (recommended), ElevenLabs (optional)

### Quick Start

**Mac / Linux:**
```bash
chmod +x install.sh && ./install.sh
```

**Windows:**
```
Double-click install.bat
```

The installer checks Node.js, installs dependencies, prompts for API keys, generates an admin secret, creates your admin account, and launches the app.

### Manual Setup

```bash
# 1. Install dependencies
npm install

# 2. Create .env file
cp .env.example .env
# Edit .env with your API keys

# 3. Start the server
node proxy-server-v2.js

# 4. Open the app
# http://localhost:3000
```

### Environment Variables

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-5

# Recommended
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-1.5-flash

# Optional
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=1DC6VAfJKAscIyFOOTRa
ELEVENLABS_MODEL=eleven_multilingual_v2

# Auth + admin
ADMIN_SECRET=your_strong_random_secret

# Payments (Stripe)
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_ENT_PRICE_ID=price_...

# Server
PORT=3000
APP_URL=https://yourdomain.com
ALLOWED_ORIGINS=https://yourdomain.com
DB_PATH=./gts_audit.db

# Free trial limits
FREE_TRIAL_DAYS=14
FREE_DAILY_LIMIT=20
FREE_TOTAL_LIMIT=100
```

---

## Admin Setup

After starting the server, create your admin account:

```bash
curl -X POST http://localhost:3000/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -d '{"email":"you@example.com","name":"Your Name"}'
```

Copy the returned token, then in your browser console:
```javascript
localStorage.setItem('gts_auth_token', 'your_token_here')
location.reload()
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/register` | Create free account |
| `GET` | `/api/me` | Get current user + trial status |
| `POST` | `/api/chat` | Claude conversation proxy |
| `POST` | `/api/verify` | NarrativePure™ dual-model verification |
| `POST` | `/api/transcribe` | Gemini audio transcription |
| `POST` | `/api/speak` | ElevenLabs TTS synthesis |
| `POST` | `/api/hob/add` | Add HOB block to chain |
| `GET` | `/api/audit/hob` | Query HOB chain |
| `POST` | `/api/checkout` | Create Stripe checkout session |
| `POST` | `/api/portal` | Open Stripe billing portal |
| `POST` | `/webhook/stripe` | Stripe webhook handler |
| `POST` | `/api/admin/bootstrap` | Create admin account |
| `GET` | `/api/admin/users` | List all users |
| `POST` | `/api/admin/set-tier` | Update user tier |
| `WS` | `/ws/voice` | WebSocket voice streaming |
| `GET` | `/health` | Server health check |
| `GET` | `/setup` | Browser setup wizard |

---

## Deployment

Deployed on [Railway](https://railway.app) with automatic HTTPS.

**Required Railway environment variables:** All variables from `.env.example` except `PORT` (Railway provides this automatically).

**After deployment, lock CORS:**
```
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

---

## Security

- API keys never reach the browser — all calls proxied server-side
- Token authentication on every endpoint
- Helmet.js security headers on all responses
- express-rate-limit — 300 req/min global, 20 req/15min on auth endpoints
- Input sanitization — null bytes and control characters stripped from all requests
- CORS lockdown configurable via environment variable
- Stripe webhook signature verification
- Admin endpoints require `X-Admin-Secret` header

---

## Roadmap

- [ ] Amazon QLDB integration — legal-grade immutable TrustChain™ audit trail
- [ ] WebGPU/WASM voice activity detection — client-side VAD to reduce API costs
- [ ] SOC2 Type II certification — unlocks healthcare and government contracts
- [ ] ThreadLock™ API marketplace — metered per-call pricing for third-party platforms
- [ ] Mobile app (iOS / Android)
- [ ] Telephony integration — by-the-minute live interpretation for events

---

## License

Proprietary — Sphinx Global Enterprises Corp © 2026  
All rights reserved. ThreadLock™, TrustChain™, and NarrativePure™ are trademarks of Sphinx Global Enterprises Corp.

---

*Built by Jalisa Basnight · Sphinx Global Enterprises Corp · sphinxdigitalmarketingagencyllc.com*
