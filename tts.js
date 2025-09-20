/**
 * ElevenLabs TTS adapter
 * Purpose: Convert text to MP3, store locally, and return a public URL for Twilio <Play>.
 * Assumptions: Local disk is writable (ephemeral ok). BASE URL provided by caller or env.
 * Change Log:
 *  - v1.0.0: Initial implementation with configurable voice and output directory.
 */

'use strict';
const { fetch } = require('undici');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function safeFilename(prefix = 'tts') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${stamp}-${rand}.mp3`;
}

/**
 * @param {string} text
 * @param {{ baseUrl?: string, audioDir?: string, filenamePrefix?: string }} [opts]
 * @returns {Promise<string>} absolute audio URL for Twilio <Play>
 */
async function elevenLabsTTS(text, opts = {}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ElevenLabs API key missing');

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Rachel (default public voice)
  const audioDir = opts.audioDir || process.env.AUDIO_DIR || path.join(process.cwd(), 'audio');
  const baseUrl = (opts.baseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/+/g, '');

  await fsp.mkdir(audioDir, { recursive: true });

  const fileName = safeFilename(opts.filenamePrefix || 'hc');
  const outPath = path.join(audioDir, fileName);

  const payload = {
    text: String(text).slice(0, 1000), // keep fast and short
    model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.7,
      style: 0.2,
      use_speaker_boost: true
    }
  };

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ElevenLabs error ${res.status}: ${t}`);
  }

  const arrayBuf = await res.arrayBuffer();
  await fsp.writeFile(outPath, Buffer.from(arrayBuf));

  if (!baseUrl) {
    // Relative path (OK for tests proxied through same host). Twilio requires absolute URL in production.
    return `/audio/${fileName}`;
  }
  return `${baseUrl}/audio/${fileName}`;
}

module.exports = { elevenLabsTTS };