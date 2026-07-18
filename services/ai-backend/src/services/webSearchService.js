/**
 * Web Search Service — search the web using Kiro's InvokeMCP API.
 *
 * Reuses kiroAdapter's auth token and SDK client infrastructure.
 * Calls Amazon Q Developer's InvokeMCP endpoint with the web_search tool.
 *
 * Reference: https://github.com/Colin3191/kiro-web-search
 */
const crypto = require('crypto');

const SEARCH_TIMEOUT_MS = 30_000;

// Lazy refs
let _kiroAdapter = null;

function getKiroAdapter() {
  if (!_kiroAdapter) {
    _kiroAdapter = require('./gateway/adapters/kiroAdapter');
  }
  return _kiroAdapter;
}

/**
 * Check if web search is available (Kiro token exists).
 * @returns {boolean}
 */
function isAvailable() {
  try {
    return getKiroAdapter().detect();
  } catch {
    return false;
  }
}

/**
 * Search the web using Kiro's remote MCP web_search tool.
 *
 * @param {string} query - Search query (max 200 characters)
 * @returns {Promise<{success: boolean, results?: object[], formatted?: string, error?: string}>}
 */
async function search(query) {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'Search query is required' };
  }

  // Enforce max length per API spec
  const trimmedQuery = query.trim().slice(0, 200);
  if (!trimmedQuery) {
    return { success: false, error: 'Search query is empty' };
  }

  try {
    const kiro = getKiroAdapter();
    const tokenData = await kiro.getAccessToken();
    const client = await kiro.createSDKClient(tokenData);
    const { InvokeMCPCommand, MCPMethod } = await kiro.getCWModule();

    const command = new InvokeMCPCommand({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: MCPMethod.TOOLS_CALL,
      profileArn: tokenData.profileArn,
      params: {
        name: 'web_search',
        arguments: { query: trimmedQuery },
      },
    });

    // Race against timeout
    const response = await Promise.race([
      client.send(command),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Web search timed out (30s)')), SEARCH_TIMEOUT_MS)
      ),
    ]);

    if (response.error) {
      return {
        success: false,
        error: `Web search failed (code ${response.error.code}): ${response.error.message}`,
      };
    }

    // Parse and format results
    const { results, formatted } = formatResults(response.result);
    return { success: true, results, formatted };
  } catch (err) {
    // Clear cached client on auth errors
    if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('expired')) {
      try { getKiroAdapter().destroy(); } catch { /* ignore */ }
    }
    return { success: false, error: err.message || 'Web search failed' };
  }
}

/**
 * Parse MCP response into structured results + formatted markdown.
 */
function formatResults(result) {
  const empty = { results: [], formatted: 'No results found.' };
  if (!result?.content) return empty;

  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) return empty;

  try {
    const parsed = JSON.parse(textContent.text);
    if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
      return { results: [], formatted: textContent.text };
    }

    const results = parsed.results.map(r => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      snippet: r.snippet || '',
      publishedDate: r.publishedDate || '',
    }));

    const formatted = results.map((r, i) => {
      const parts = [`### ${i + 1}. ${r.title}`];
      if (r.url) parts.push(`   ${r.url}`);
      if (r.snippet) parts.push(`   ${r.snippet}`);
      if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`);
      return parts.join('\n');
    }).join('\n\n');

    return { results, formatted };
  } catch {
    return { results: [], formatted: textContent.text };
  }
}

module.exports = { search, isAvailable, formatResults };
