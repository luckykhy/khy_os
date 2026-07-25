'use strict';

/**
 * mediaUnderstanding.js — Provider registry for multi-modal media understanding.
 *
 * Ported from OpenClaw's media-understanding (150+ lines).
 * Provides a registry of AI providers with capability flags for different
 * media types (image, audio, video, document). Supports fallback chains
 * and MIME-based format negotiation.
 *
 * Key features:
 * - Provider capability registration (image/audio/video/document)
 * - MIME type to capability mapping
 * - Fallback chain resolution (try best provider first, fall back)
 * - Format negotiation (what can provider X handle?)
 * - Provider priority ordering
 */

// ── Capability flags ──

const CAPABILITY = {
  IMAGE:    0b0001,
  AUDIO:    0b0010,
  VIDEO:    0b0100,
  DOCUMENT: 0b1000,
};

// ── MIME type → capability mapping ──

const MIME_CAPABILITY_MAP = {
  'image/': CAPABILITY.IMAGE,
  'audio/': CAPABILITY.AUDIO,
  'video/': CAPABILITY.VIDEO,
  'application/pdf': CAPABILITY.DOCUMENT,
  'text/': CAPABILITY.DOCUMENT,
};

/**
 * Resolve capability flag from a MIME type string.
 *
 * @param {string} mimeType
 * @returns {number} capability flag (0 if unknown)
 */
function mimeToCapability(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return 0;
  const lower = mimeType.toLowerCase();

  // Check exact matches first
  if (MIME_CAPABILITY_MAP[lower]) return MIME_CAPABILITY_MAP[lower];

  // Check prefix matches
  for (const [prefix, cap] of Object.entries(MIME_CAPABILITY_MAP)) {
    if (prefix.endsWith('/') && lower.startsWith(prefix)) {
      return cap;
    }
  }

  return 0;
}

/**
 * @typedef {object} MediaProvider
 * @property {string} id - Provider identifier
 * @property {string} name - Display name
 * @property {number} capabilities - Bitfield of CAPABILITY flags
 * @property {number} priority - Lower = higher priority (0 = highest)
 * @property {string[]} supportedFormats - List of supported MIME types/prefixes
 * @property {number} maxFileSizeMb - Max file size in MB
 * @property {object} [limits] - Provider-specific limits
 * @property {boolean} available - Whether provider is currently available
 */

class MediaProviderRegistry {
  constructor() {
    /** @type {Map<string, MediaProvider>} */
    this._providers = new Map();
  }

  /**
   * Register a media-capable provider.
   *
   * @param {MediaProvider} provider
   */
  register(provider) {
    if (!provider?.id) throw new Error('Provider must have an id');

    this._providers.set(provider.id, {
      id: provider.id,
      name: provider.name || provider.id,
      capabilities: provider.capabilities || 0,
      priority: provider.priority ?? 100,
      supportedFormats: provider.supportedFormats || [],
      maxFileSizeMb: provider.maxFileSizeMb || 10,
      limits: provider.limits || {},
      available: provider.available !== false,
    });
  }

  /**
   * Unregister a provider.
   */
  unregister(providerId) {
    this._providers.delete(providerId);
  }

  /**
   * Get a provider by ID.
   */
  getProvider(providerId) {
    return this._providers.get(providerId) || null;
  }

  /**
   * Find all providers that support a given capability.
   * Sorted by priority (lower = better).
   *
   * @param {number} capability - CAPABILITY flag
   * @returns {MediaProvider[]}
   */
  findByCapability(capability) {
    const matches = [];
    for (const p of this._providers.values()) {
      if (p.available && (p.capabilities & capability) === capability) {
        matches.push(p);
      }
    }
    return matches.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find all providers that can handle a given MIME type.
   * Sorted by priority.
   *
   * @param {string} mimeType
   * @returns {MediaProvider[]}
   */
  findByMimeType(mimeType) {
    const cap = mimeToCapability(mimeType);
    if (cap === 0) return [];

    const matches = this.findByCapability(cap);

    // Further filter by specific format support
    return matches.filter(p => {
      if (p.supportedFormats.length === 0) return true; // accepts all in category
      const lower = mimeType.toLowerCase();
      return p.supportedFormats.some(fmt => {
        if (fmt.endsWith('/*')) {
          return lower.startsWith(fmt.slice(0, -1));
        }
        return lower === fmt.toLowerCase();
      });
    });
  }

  /**
   * Build a fallback chain for a media request.
   * Returns ordered list of providers to try.
   *
   * @param {string} mimeType
   * @param {number} [fileSizeMb=0]
   * @returns {MediaProvider[]}
   */
  buildFallbackChain(mimeType, fileSizeMb = 0) {
    let providers = this.findByMimeType(mimeType);

    // Filter by file size
    if (fileSizeMb > 0) {
      providers = providers.filter(p => p.maxFileSizeMb >= fileSizeMb);
    }

    return providers;
  }

  /**
   * Get the best provider for a media type.
   * Returns null if none available.
   *
   * @param {string} mimeType
   * @param {number} [fileSizeMb=0]
   * @returns {MediaProvider|null}
   */
  getBestProvider(mimeType, fileSizeMb = 0) {
    const chain = this.buildFallbackChain(mimeType, fileSizeMb);
    return chain.length > 0 ? chain[0] : null;
  }

  /**
   * Query what formats a specific provider supports.
   *
   * @param {string} providerId
   * @returns {{ image: boolean, audio: boolean, video: boolean, document: boolean, formats: string[] }}
   */
  getProviderCapabilities(providerId) {
    const p = this._providers.get(providerId);
    if (!p) return { image: false, audio: false, video: false, document: false, formats: [] };

    return {
      image: (p.capabilities & CAPABILITY.IMAGE) !== 0,
      audio: (p.capabilities & CAPABILITY.AUDIO) !== 0,
      video: (p.capabilities & CAPABILITY.VIDEO) !== 0,
      document: (p.capabilities & CAPABILITY.DOCUMENT) !== 0,
      formats: p.supportedFormats,
    };
  }

  /**
   * Mark a provider as available or unavailable.
   */
  setAvailability(providerId, available) {
    const p = this._providers.get(providerId);
    if (p) p.available = available;
  }

  /**
   * Get all registered providers.
   */
  listProviders() {
    return Array.from(this._providers.values())
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get summary of capabilities across all providers.
   */
  getSummary() {
    const all = this.listProviders();
    const available = all.filter(p => p.available);
    return {
      totalProviders: all.length,
      availableProviders: available.length,
      capabilities: {
        image: this.findByCapability(CAPABILITY.IMAGE).length,
        audio: this.findByCapability(CAPABILITY.AUDIO).length,
        video: this.findByCapability(CAPABILITY.VIDEO).length,
        document: this.findByCapability(CAPABILITY.DOCUMENT).length,
      },
    };
  }
}

// ── Default provider configurations ──

/**
 * Register default providers based on common AI services.
 */
function registerDefaults(registry) {
  // Claude (Anthropic) — image + document
  registry.register({
    id: 'claude',
    name: 'Claude (Anthropic)',
    capabilities: CAPABILITY.IMAGE | CAPABILITY.DOCUMENT,
    priority: 10,
    supportedFormats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],
    maxFileSizeMb: 20,
  });

  // GPT-4 Vision — image + document
  registry.register({
    id: 'gpt4-vision',
    name: 'GPT-4 Vision',
    capabilities: CAPABILITY.IMAGE | CAPABILITY.DOCUMENT,
    priority: 20,
    supportedFormats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    maxFileSizeMb: 20,
  });

  // Gemini — image + audio + video + document
  registry.register({
    id: 'gemini',
    name: 'Gemini',
    capabilities: CAPABILITY.IMAGE | CAPABILITY.AUDIO | CAPABILITY.VIDEO | CAPABILITY.DOCUMENT,
    priority: 15,
    supportedFormats: ['image/*', 'audio/*', 'video/*', 'application/pdf'],
    maxFileSizeMb: 100,
  });

  // Ollama (local) — image only (llava, etc.)
  registry.register({
    id: 'ollama',
    name: 'Ollama Local',
    capabilities: CAPABILITY.IMAGE,
    priority: 50,
    supportedFormats: ['image/jpeg', 'image/png'],
    maxFileSizeMb: 10,
    available: false, // needs detection
  });

  return registry;
}

// Singleton
const mediaRegistry = new MediaProviderRegistry();
registerDefaults(mediaRegistry);

module.exports = {
  CAPABILITY,
  MIME_CAPABILITY_MAP,
  mimeToCapability,
  MediaProviderRegistry,
  mediaRegistry,
  registerDefaults,
};
