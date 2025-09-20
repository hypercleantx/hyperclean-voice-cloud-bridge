# HyperClean Voice Cloud Bridge

This project is a Node.js service designed to bridge Twilio voice webhooks with large language model (LLM) providers and ElevenLabs Text‑To‑Speech (TTS). It receives incoming calls via Twilio, routes user intents to an appropriate LLM (Anthropic Claude, OpenAI ChatGPT, or Perplexity) based on simple intent rules, synthesizes the response into audio via ElevenLabs, and returns TwiML to play back the audio or speak the text directly.

## Features

* **Express server** that exposes `/voice/ai` for Twilio webhooks, `/health` for health checks, and `/audio/:filename` for serving generated audio.
* **Provider router** (`providers.js`) that enforces a budget and selects among Claude, ChatGPT, and Perplexity based on the `intent` provided in the Twilio payload.
* **ElevenLabs TTS** integration (`tts.js`) that converts LLM outputs to MP3 and serves them via the `/audio` route.
* **Security helpers** (`security.js`) for verifying Twilio signatures, sanitizing XML, and redacting personally identifiable information in logs.

## Getting Started

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and populate it with your API keys (Twilio, Anthropic, OpenAI, Perplexity, and ElevenLabs).

3. Run the server locally:

   ```sh
   node app.js
   ```

4. Point your Twilio number’s voice webhook to `https://<your-host>/voice/ai`.

## Deployment

The service is designed to be deployed on platforms like Render or Google Cloud Run. See the deployment instructions in your accompanying documentation for step‑by‑step guidance.