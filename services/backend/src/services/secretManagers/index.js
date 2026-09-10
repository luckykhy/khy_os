'use strict';

/**
 * Secret Managers — secure credential storage and retrieval.
 * Supports AWS Secrets Manager, Azure Key Vault, Google Secret Manager, HashiCorp Vault.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function _env(name) {
  return String(process.env[`KHY_SECRET_${name}`] || '').trim();
}

function _getLocalSecretsDir() {
  const dir = path.join(os.homedir(), '.khy', 'secrets');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ── Local Secrets Store ──
async function localGetSecret(name) {
  const secretFile = path.join(_getLocalSecretsDir(), `${name}.json`);
  if (!fs.existsSync(secretFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(secretFile, 'utf-8'));
  } catch (e) {
    return null;
  }
}

async function localSetSecret(name, value, metadata = {}) {
  const secretFile = path.join(_getLocalSecretsDir(), `${name}.json`);
  const entry = {
    name,
    value,
    metadata,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(secretFile, JSON.stringify(entry, null, 2));
  return { success: true, name };
}

async function localDeleteSecret(name) {
  const secretFile = path.join(_getLocalSecretsDir(), `${name}.json`);
  if (fs.existsSync(secretFile)) fs.unlinkSync(secretFile);
  return { success: true, name };
}

async function localListSecrets() {
  const dir = _getLocalSecretsDir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  } catch (e) {
    return [];
  }
}

// ── AWS Secrets Manager ──
async function awsGetSecret(secretName) {
  const region = _env('AWS_REGION') || process.env.AWS_REGION || 'us-east-1';
  const accessKey = _env('AWS_ACCESS_KEY_ID') || process.env.AWS_ACCESS_KEY_ID;
  const secretKey = _env('AWS_SECRET_ACCESS_KEY') || process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKey || !secretKey) {
    return { error: 'AWS credentials not configured.' };
  }

  // Use AWS SDK if available
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({ region, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } });
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await client.send(command);
    return { success: true, value: response.SecretString, provider: 'aws' };
  } catch (e) {
    return { error: `AWS Secrets Manager error: ${e.message}` };
  }
}

// ── Azure Key Vault ──
async function azureGetSecret(vaultName, secretName) {
  const tenantId = _env('AZURE_TENANT_ID');
  const clientId = _env('AZURE_CLIENT_ID');
  const clientSecret = _env('AZURE_CLIENT_SECRET');

  if (!tenantId || !clientId || !clientSecret) {
    return { error: 'Azure credentials not configured.' };
  }

  try {
    const { SecretClient } = require('@azure/keyvault-secrets');
    const { DefaultAzureCredential } = require('@azure/identity');
    const url = `https://${vaultName}.vault.azure.net`;
    const client = new SecretClient(url, new DefaultAzureCredential());
    const secret = await client.getSecret(secretName);
    return { success: true, value: secret.value, provider: 'azure' };
  } catch (e) {
    return { error: `Azure Key Vault error: ${e.message}` };
  }
}

// ── Google Secret Manager ──
async function gcpGetSecret(projectId, secretName) {
  const apiKey = _env('GOOGLE_API_KEY') || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { error: 'Google API Key not configured.' };

  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'secretmanager.googleapis.com',
      path: `/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ success: true, value: json.payload?.data, provider: 'gcp' });
        } catch (e) { resolve({ error: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ── HashiCorp Vault ──
async function vaultGetSecret(path) {
  const vaultAddr = _env('VAULT_ADDR') || process.env.VAULT_ADDR;
  const vaultToken = _env('VAULT_TOKEN') || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    return { error: 'Vault not configured. Set VAULT_ADDR and VAULT_TOKEN.' };
  }

  const https = require('https');
  return new Promise((resolve) => {
    const url = new URL(`${vaultAddr}/v1/secret/data/${path}`);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'GET',
      headers: { 'X-Vault-Token': vaultToken },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ success: true, value: json.data?.data, provider: 'vault' });
        } catch (e) { resolve({ error: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ── Unified Interface ──
async function getSecret(provider, name, options = {}) {
  switch (provider) {
    case 'aws': return awsGetSecret(name);
    case 'azure': return azureGetSecret(options.vaultName, name);
    case 'gcp': return gcpGetSecret(options.projectId, name);
    case 'vault': return vaultGetSecret(name);
    case 'local': return localGetSecret(name);
    default: return { error: `Unknown provider: ${provider}` };
  }
}

async function setSecret(provider, name, value, options = {}) {
  switch (provider) {
    case 'local': return localSetSecret(name, value, options.metadata);
    default: return { error: `Set not supported for provider: ${provider}` };
  }
}

async function deleteSecret(provider, name) {
  switch (provider) {
    case 'local': return localDeleteSecret(name);
    default: return { error: `Delete not supported for provider: ${provider}` };
  }
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'local', name: 'Local Secrets', type: 'local' },
  { id: 'aws', name: 'AWS Secrets Manager', type: 'cloud' },
  { id: 'azure', name: 'Azure Key Vault', type: 'cloud' },
  { id: 'gcp', name: 'Google Secret Manager', type: 'cloud' },
  { id: 'vault', name: 'HashiCorp Vault', type: 'cloud' },
];

function listProviders() {
  return PROVIDERS;
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'local': return true;
    case 'aws': return !!(_env('AWS_ACCESS_KEY_ID') || process.env.AWS_ACCESS_KEY_ID);
    case 'azure': return !!_env('AZURE_CLIENT_ID');
    case 'gcp': return !!(_env('GOOGLE_API_KEY') || process.env.GOOGLE_API_KEY);
    case 'vault': return !!(_env('VAULT_ADDR') && _env('VAULT_TOKEN'));
    default: return false;
  }
}

module.exports = {
  getSecret,
  setSecret,
  deleteSecret,
  listProviders,
  isProviderConfigured,
  localGetSecret,
  localSetSecret,
  localDeleteSecret,
  localListSecrets,
  awsGetSecret,
  azureGetSecret,
  gcpGetSecret,
  vaultGetSecret,
  PROVIDERS,
};
