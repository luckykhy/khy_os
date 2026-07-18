'use strict';

/**
 * useTopic — derive a short, human-readable conversation topic that tracks the
 * CURRENT subject rather than the literal first message.
 *
 * Strategy (cheap-first, AI-refined):
 *   1. Watch committed user messages. When a new user message arrives, compare
 *      it to the seed message that set the current topic via a word-Jaccard
 *      similarity (boulderState.isSimilarMessage). Similar → topic unchanged.
 *      Divergent (or the first message) → a topic switch.
 *   2. On switch, set a COARSE title instantly via the free heuristic
 *      generateTitle() — zero latency, always available.
 *   3. In the background, refine to a ≤6-word title via generateTitleAI(),
 *      backed by a one-shot gateway.generate() shim that does NOT pollute the
 *      conversation history. When it returns, replace the coarse title in place.
 *
 * The hook only returns the topic string; the App decides how to render it
 * (pinned topicBar when supported, else FooterBar fallback).
 */
const React = require('react');

// Lazily required to keep the TUI bootstrap light and tolerant of missing deps.
let _titleSvc = null;
function _services() {
  if (_titleSvc === null) {
    try { _titleSvc = require('../../../services/sessionTitleService'); } catch { _titleSvc = false; }
  }
  return { titleSvc: _titleSvc };
}

// Topic-switch similarity. boulderState.isSimilarMessage tokenizes on whitespace
// only, so CJK text (KHY's primary language, no spaces) collapses to a single
// token and two distinct messages always score 0 — every turn would read as a
// switch. We use the same Jaccard idea but a CJK-aware tokenizer: Latin words
// from whitespace splitting PLUS CJK character bigrams. SIMILARITY_THRESHOLD is
// tunable; >0.5 overlap → same subject → topic unchanged.
const SIMILARITY_THRESHOLD = 0.5;
const _CJK = /[㐀-䶿一-鿿豈-﫿]/;

function _tokenSet(text) {
  const s = String(text || '').trim().slice(0, 200).toLowerCase();
  const tokens = new Set();
  // Latin / alnum words.
  for (const w of s.split(/[^a-z0-9_㐀-鿿]+/)) {
    if (w && !_CJK.test(w)) tokens.add(w);
  }
  // CJK character bigrams (and singletons for length-1 runs).
  const cjkRuns = s.match(/[㐀-䶿一-鿿豈-﫿]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) { tokens.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

function _isSameTopic(a, b) {
  if (!a || !b) return false;
  if (String(a).trim() === String(b).trim()) return true;
  const wa = _tokenSet(a);
  const wb = _tokenSet(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let overlap = 0;
  for (const t of wa) { if (wb.has(t)) overlap++; }
  const unionSize = new Set([...wa, ...wb]).size;
  return (overlap / unionSize) > SIMILARITY_THRESHOLD;
}

// A one-shot completion shim exposing the `query(prompt, opts)` shape that
// generateTitleAI() prefers. Backed by gateway.generate(), which is a stateless
// completion — it does NOT append to the active conversation history, so titling
// never leaks a stray turn into the user's transcript.
function _titleGateway() {
  return {
    query: async (prompt, opts = {}) => {
      const gateway = require('../../../services/gateway/aiGateway');
      const res = await gateway.generate(prompt, {
        taskScale: 'small',
        maxTokens: opts.maxTokens || 20,
        temperature: opts.temperature != null ? opts.temperature : 0.3,
      });
      return res && (res.content || res.text) || '';
    },
  };
}

function _lastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return messages[i];
  }
  return null;
}

function _lastAssistantText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') return m.content || '';
  }
  return '';
}

function useTopic(messages) {
  const [topic, setTopic] = React.useState('');
  // The user message that established the current topic. Topic-switch detection
  // compares each new user message against this seed.
  const seedRef = React.useRef(null);
  // Guards the AI refine: only the latest switch's refinement may write back, so
  // a slow earlier refine cannot clobber a newer coarse title.
  const refineTokenRef = React.useRef(0);

  React.useEffect(() => {
    const lastUser = _lastUserMessage(messages);
    if (!lastUser || !lastUser.content) return;
    // Skip if this is the same message object we already processed.
    if (seedRef.current === lastUser) return;

    const { titleSvc } = _services();
    if (!titleSvc) { return; }

    const prevSeed = seedRef.current;
    const isSwitch = !prevSeed || !_isSameTopic(lastUser.content, prevSeed.content);

    if (!isSwitch) return; // same subject — keep the existing topic

    // Mark this message as the new seed regardless of refine outcome.
    seedRef.current = lastUser;

    // (2) Coarse, instant title.
    let coarse = '';
    try { coarse = titleSvc.generateTitle(lastUser.content); } catch { coarse = ''; }
    if (coarse) setTopic(coarse);

    // (3) Background AI refine; replace in place when it resolves.
    const token = ++refineTokenRef.current;
    if (typeof titleSvc.generateTitleAI === 'function') {
      const reply = _lastAssistantText(messages);
      Promise.resolve()
        .then(() => titleSvc.generateTitleAI(lastUser.content, reply, _titleGateway()))
        .then((refined) => {
          // Stale guard: a newer switch happened while we were refining.
          if (token !== refineTokenRef.current) return;
          if (refined && typeof refined === 'string' && refined.trim()) {
            setTopic(refined.trim());
          }
        })
        .catch(() => { /* generateTitleAI already falls back internally */ });
    }
  }, [messages]);

  return topic;
}

module.exports = { useTopic };
