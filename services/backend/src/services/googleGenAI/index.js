'use strict';

/**
 * Google GenAI Extensions — enhanced Gemini and Imagen capabilities.
 * Extends existing googleGenService with additional models and features.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

function _env(name) {
  return String(process.env[`KHY_GOOGLE_${name}`] || '').trim();
}

function _getApiKey() {
  return _env('API_KEY') || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
}

function _getClient() {
  const apiKey = _getApiKey();
  if (!apiKey) return null;
  return new GoogleGenerativeAI(apiKey);
}

// ── Gemini 2.0 Flash with Enhanced Features ──
async function geminiFlashGenerate(prompt, options = {}) {
  const client = _getClient();
  if (!client) return { error: 'Google API Key not configured.' };

  const model = client.getGenerativeModel({
    model: options.model || 'gemini-2.0-flash',
    generationConfig: {
      temperature: options.temperature || 0.7,
      maxOutputTokens: options.maxTokens || 8192,
    },
  });

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return {
    success: true,
    text: response.text(),
    usage: response.usageMetadata,
    model: options.model || 'gemini-2.0-flash',
    provider: 'google',
  };
}

// ── Imagen 3 — Image Generation ──
async function imagenGenerate(prompt, options = {}) {
  const client = _getClient();
  if (!client) return { error: 'Google API Key not configured.' };

  try {
    const model = client.getGenerativeModel({
      model: options.model || 'imagen-3.0-generate-002',
    });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const response = await result.response;
    return {
      success: true,
      images: response.candidates?.[0]?.content?.parts?.filter((p) => p.inlineData) || [],
      provider: 'google',
      model: options.model || 'imagen-3.0-generate-002',
    };
  } catch (err) {
    return { error: `Imagen error: ${err.message}` };
  }
}

// ── Gemini Vision — Image Understanding ──
async function geminiVisionAnalyze(imageBase64, prompt, options = {}) {
  const client = _getClient();
  if (!client) return { error: 'Google API Key not configured.' };

  const model = client.getGenerativeModel({
    model: options.model || 'gemini-2.0-flash',
  });

  const imagePart = {
    inlineData: {
      mimeType: options.mimeType || 'image/png',
      data: imageBase64,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  const response = await result.response;
  return {
    success: true,
    text: response.text(),
    provider: 'google',
    model: options.model || 'gemini-2.0-flash',
  };
}

// ── Gemini Embedding ──
async function geminiEmbed(texts, options = {}) {
  const client = _getClient();
  if (!client) return { error: 'Google API Key not configured.' };

  const model = client.getGenerativeModel({
    model: options.model || 'text-embedding-004',
  });

  const embeddings = [];
  for (const text of texts) {
    const result = await model.embedContent(text);
    embeddings.push(result.embedding.values);
  }

  return {
    success: true,
    embeddings,
    model: options.model || 'text-embedding-004',
    provider: 'google',
  };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini', available: !!_getApiKey() },
  { id: 'imagen', name: 'Google Imagen', available: !!_getApiKey() },
  { id: 'gemini_embedding', name: 'Google Embedding', available: !!_getApiKey() },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ ...p, configured: _getApiKey() ? true : false }));
}

function isConfigured() {
  return !!_getApiKey();
}

module.exports = {
  geminiFlashGenerate,
  imagenGenerate,
  geminiVisionAnalyze,
  geminiEmbed,
  listProviders,
  isConfigured,
  PROVIDERS,
};
