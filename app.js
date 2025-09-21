/**
 * HyperClean TX Voice Cloud Bridge
 * Purpose: Express service to handle Twilio voice webhooks, route to LLMs, synthesize TTS, and respond with TwiML.
 * Assumptions:
 *  - Deployed on Render or Cloud Run with public URL.
 *  - Env vars provided (see .env.example). ELEVENLABS_VOICE_ID optional (defaults set).
 *  - Local audio hosting via /audio/:filename (ephemeral disk OK).
 * Required Scopes/Perms: None (HTTP service). External API keys via env.
 * Triggers: HTTP routes (/voice/ai, /health, /audio/:filename).
 * Change Log:
 *  - v1.0.0: Initial implementation with Twilio verification, provider router, TTS, budget + timeout guards.
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { providerRouter, createBudget } = require('./providers.js');
const { elevenLabsTTS } = require('./tts.js');
const { verifyTwilio, sanitizeXml, redactPII, buildBaseUrl } = require('./security.js');

const app = express();

const AUDIO_DIR = process.env.AUDIO_DIR || path.join(process.cwd(), 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Parsers for Twilio form-encoded and JSON (for health/tests)
aapp.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Minimal PII-safe logger
app.use((req, _res, next) => {
  const safeBody = redactPII(req.body || {});
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} :: ${JSON.stringify(safeBody)}`);
  next();
});

// Health endpoint
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Serve audio files (temporary hosting for Twilio <Play>)
app.get('/audio/:filename', async (req, res) => {
  try {
    const safeName = path.basename(req.params.filename || '');
    const filePath = path.join(AUDIO_DIR, safeName);
    await fsp.access(filePath, fs.constants.R_OK);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
  } catch (_err) {
    res.status(404).send('Not found');
  }
});

// Default message used when no LLM or TTS response is available.
// Note: use a straight apostrophe instead of a curly one to avoid lint/test issues.
const FALLBACK_SAY = "I'll text you a booking link right away.";

/**
 * Promise timeout helper
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(id); resolve(val); },
      (err) => { clearTimeout(id); reject(err); }
    );
  });
}

/**
 * Simple TwiML builders
 */
function twimlSay(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${sanitizeXml(text)}</Say></Response>`;
}
function twimlPlay(url) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${url}</Play></Response>`;
}

app.post('/voice/ai', async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');

  // Verify Twilio signature when auth token is present
  try {
    if (process.env.TWILIO_AUTH_TOKEN) {
      const verified = await verifyTwilio(req, process.env.TWILIO_AUTH_TOKEN);
      if (!verified) {
        res.status(403).send(twimlSay('Unauthorized'));
        return;
      }
    }
  } catch (verifyErr) {
    res.status(403).send(twimlSay('Unauthorized'));
    return;
  }

  // Handle both JSON and form-encoded payloads
  const contentType = req.get('content-type') || '';
  let payload = req.body;

  // Ensure intent field exists
  if (!payload.intent) {
    payload.intent = 'concierge_dialog';
  }

  // Extract budget from payload or use default
  const budgetMaxCents = Number(
    payload.budget_cents ||
    payload.budgetCents ||
    process.env.BUDGET_CENTS ||
    50
  );

  const budget = createBudget(budgetMaxCents);

  try {
    // Enhanced error handling with specific timeouts
    const result = await Promise.race([
      providerRouter(payload.intent, payload, budget),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout_provider')), 8000)
      )
    ]);

    const text = (result && result.text) ? String(result.text).trim() : '';

    if (!text) {
      res.send(twimlSay("I'll text you our booking link right away."));
      return;
    }

    // TTS with fallback
    try {
      const audioUrl = await Promise.race([
        elevenLabsTTS(text, {
          baseUrl: buildBaseUrl(req),
          audioDir: AUDIO_DIR,
          filenamePrefix: payload.CallSid || 'hc'
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout_tts')), 5000)
        )
      ]);

      if (audioUrl) {
        res.send(twimlPlay(audioUrl));
      } else {
        res.send(twimlSay(text));
      }
    } catch (ttsErr) {
      console.warn('TTS failed, using text fallback:', ttsErr && ttsErr.message);
      res.send(twimlSay(text));
    }
  } catch (err) {
    console.error('Provider error:', err && err.message);
    res.send(twimlSay("I'll text you our booking link right away."));
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`HyperClean TX Voice Cloud Bridge listening on :${PORT}`);
});

module.exports = app;
