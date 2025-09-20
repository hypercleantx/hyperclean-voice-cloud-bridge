/**
 * Provider Router for HyperClean TX
 * Purpose: Route intents to Claude/OpenAI/Perplexity with budget enforcement and short, speakable outputs.
 * Assumptions: External APIs reachable and keys present. This orchestrator is intentionally thin.
 * Required Scopes: None.
 * Change Log:
 *  - v1.0.0: Initial routing + budget guard + Perplexity->Claude summarize pipeline.
 */

'use strict';
const { fetch } = require('undici');

// ===== Budget Utilities =====
class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}
function createBudget(maxCents = 50) {
  return {
    maxCents,
    usedCents: 0,
    spend(cents, reason = 'unknown') {
      this.usedCents = Math.round((this.usedCents + cents) * 100) / 100;
      if (this.usedCents > this.maxCents) {
        throw new BudgetError(`budget_exceeded:${this.usedCents}/${this.maxCents}:${reason}`);
      }
      return this.usedCents;
    }
  };
}

// rough tokens estimate: 1 token ~ 4 chars
const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));

// Approx cost tables (cents per 1k tokens) — placeholders for budget enforcement only
const COST_TABLE_CENTS = {
  claude_in: 0.5,
  claude_out: 1.0,
  openai_in: 0.5,
  openai_out: 1.0,
  pplx_in: 0.6,
  pplx_out: 1.2
};

const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 6000);

// Abortable fetch
async function afetch(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ===== Provider Calls =====
async function callClaude(prompt, budget, { system, maxTokens = 220 } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Claude API key missing');

  const model = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307';

  const inTokens = estimateTokens(prompt);
  // Spend on input up-front
  budget.spend((inTokens / 1000) * COST_TABLE_CENTS.claude_in, 'claude_in');

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.6,
    system: system || 'You are HyperClean TX’s voice concierge. Keep it 45–75 words, plain and speakable. Avoid special characters and numeric prices. If booking is needed, say we’ll text a booking link right away.',
    messages: [{ role: 'user', content: prompt }]
  };

  const res = await afetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Claude error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const text = Array.isArray(data.content) ? data.content.map(c => c.text || '').join('') : (data.content?.[0]?.text || data.content || '');

  const outTokens = estimateTokens(text);
  budget.spend((outTokens / 1000) * COST_TABLE_CENTS.claude_out, 'claude_out');

  // Always return a consistent shape for downstream handlers
  return { text, quote: null, audioUrl: null };
}

async function callChatGPT(prompt, budget, { system, maxTokens = 220 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key missing');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const inTokens = estimateTokens(prompt);
  budget.spend((inTokens / 1000) * COST_TABLE_CENTS.openai_in, 'openai_in');

  const body = {
    model,
    temperature: 0.6,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system || 'Speak in 45–75 words, optimized for voice playback. No code or markup, just a concise plan.' },
      { role: 'user', content: prompt }
    ]
  };

  const res = await afetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  const outTokens = estimateTokens(text);
  budget.spend((outTokens / 1000) * COST_TABLE_CENTS.openai_out, 'openai_out');

  // Always return a consistent shape for downstream handlers
  return { text, quote: null, audioUrl: null };
}

async function callPerplexity(prompt, budget, { system, maxTokens = 300 } = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('Perplexity API key missing');

  const model = process.env.PERPLEXITY_MODEL || 'llama-3.1-sonar-small-128k-online';

  const inTokens = estimateTokens(prompt);
  budget.spend((inTokens / 1000) * COST_TABLE_CENTS.pplx_in, 'perplexity_in');

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system || 'Conduct live web research. Return a concise factual summary. Avoid URLs and quotes.' },
      { role: 'user', content: prompt }
    ]
  };

  const res = await afetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Perplexity error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  const outTokens = estimateTokens(text);
  budget.spend((outTokens / 1000) * COST_TABLE_CENTS.pplx_out, 'perplexity_out');

  // Always return a consistent shape for downstream handlers
  return { text, quote: null, audioUrl: null };
}

// ===== Router =====
const CLAUDE_INTENTS = new Set(['concierge_dialog', 'pm_outreach', 'contractor_comms', 'bi_narrative']);
const OPENAI_INTENTS = new Set(['code_scaffold', 'formatting', 'ops_patch']);
const PPLX_INTENTS = new Set(['market_research', 'pricing_scan', 'policy_update']);

/**
 * Extract best-effort user input from Twilio payload
 */
function extractUserInput(payload = {}) {
  return (
    payload.SpeechResult ||
    payload.TranscriptionText ||
    payload.Body ||
    payload.Digits ||
    payload.prompt ||
    'Caller is asking about HyperClean TX services. Provide a warm, brief, speakable response.'
  );
}

/**
 * Provider Router
 * @param {string} intent
 * @param {object} payload
 * @param {ReturnType<typeof createBudget>} budget
 * @returns {Promise<{ text: string, quote?: any }>}
 */
async function providerRouter(intent, payload, budget) {
  const user = extractUserInput(payload);

  // Optional simulation hooks (for acceptance tests)
  const approxTokens = Number(payload.approx_tokens || payload.approxTokens || 0);
  if (approxTokens > 0) {
    const simCostCents = (approxTokens / 1000) * 5;
    budget.spend(simCostCents, 'sim_tokens');
  }
  if (String(payload.force_delay || '') === '1') {
    await new Promise(r => setTimeout(r, PROVIDER_TIMEOUT_MS + 1000));
  }

  let result;
  if (CLAUDE_INTENTS.has(intent)) {
    result = await callClaude(user, budget);
  } else if (OPENAI_INTENTS.has(intent)) {
    result = await callChatGPT(user, budget, {
      system: 'You are a senior engineer summarizing the game plan. Speak it in 45–75 words for a caller; no code, just actions.'
    });
  } else if (PPLX_INTENTS.has(intent)) {
    const ppx = await callPerplexity(user, budget, {
      system: 'Do quick live research. Return a short bulletless digest (3–5 sentences).'
    });
    const summaryPrompt = `Summarize for voice in 45–75 words, friendly and clear:\n\n${ppx.text}`;
    result = await callClaude(summaryPrompt, budget, {
      system: 'You convert research into a short, speakable summary. Avoid prices. If next steps are needed, say we\'ll text a booking link.'
    });
  } else {
    // Default to Claude
    result = await callClaude(user, budget);
  }

  // Ensure consistent response structure
  return {
    text: result.text || '',
    quote: result.quote || null,
    audioUrl: result.audioUrl || null
  };
}

module.exports = {
  providerRouter,
  createBudget,
  callClaude,
  callChatGPT,
  callPerplexity
};