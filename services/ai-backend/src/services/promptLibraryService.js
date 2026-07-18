/**
 * Prompt Library Service — User's personal prompt collection.
 *
 * Users can save, organize, and reuse their prompts.
 * Prompts are stored in user-specified folders (default: ~/.khyquant/prompts/).
 * Supports creating/selecting custom folders for organization.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PROMPT_DIR = path.join(os.homedir(), '.khyquant', 'prompts');

/**
 * Initialize prompt directory.
 */
function initPromptDir(customDir) {
  const dir = customDir || DEFAULT_PROMPT_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* best effort */ }
  return dir;
}

/**
 * Get configured prompt directory.
 */
function getPromptDir() {
  try {
    const configPath = path.join(os.homedir(), '.khyquant', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.promptDir && fs.existsSync(config.promptDir)) {
        return config.promptDir;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_PROMPT_DIR;
}

/**
 * Set custom prompt directory.
 */
function setPromptDir(dir) {
  try {
    const configPath = path.join(os.homedir(), '.khyquant', 'config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    config.promptDir = dir;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a prompt to the library.
 * @param {object} prompt - { title, content, category, tags }
 * @param {string} [folder] - subfolder within prompt directory
 */
function savePrompt(prompt, folder) {
  const dir = getPromptDir();
  const targetDir = folder ? path.join(dir, folder) : dir;
  fs.mkdirSync(targetDir, { recursive: true });

  const id = crypto.randomUUID().slice(0, 8);
  const filename = `${_slugify(prompt.title || 'prompt')}_${id}.json`;
  const filePath = path.join(targetDir, filename);

  const data = {
    id,
    title: prompt.title || '未命名提示词',
    content: prompt.content,
    category: prompt.category || 'general',
    tags: prompt.tags || [],
    createdAt: new Date().toISOString(),
    usedCount: 0,
    lastUsedAt: null,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { id, path: filePath, title: data.title };
}

/**
 * List all saved prompts.
 * @param {string} [folder] - filter by subfolder
 */
function listPrompts(folder) {
  const dir = getPromptDir();
  const searchDir = folder ? path.join(dir, folder) : dir;

  if (!fs.existsSync(searchDir)) return [];

  const results = [];
  _scanDir(searchDir, dir, results);
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function _scanDir(dirPath, baseDir, results) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        _scanDir(fullPath, baseDir, results);
      } else if (entry.name.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          results.push({
            ...data,
            path: fullPath,
            folder: path.relative(baseDir, dirPath) || '/',
          });
        } catch { /* skip invalid files */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Get a specific prompt by ID.
 */
function getPrompt(id) {
  const prompts = listPrompts();
  return prompts.find(p => p.id === id) || null;
}

/**
 * Use a prompt (mark as used, return content).
 */
function usePrompt(id) {
  const prompts = listPrompts();
  const prompt = prompts.find(p => p.id === id);
  if (!prompt) return null;

  // Update usage stats
  try {
    const data = JSON.parse(fs.readFileSync(prompt.path, 'utf-8'));
    data.usedCount = (data.usedCount || 0) + 1;
    data.lastUsedAt = new Date().toISOString();
    fs.writeFileSync(prompt.path, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }

  return prompt.content;
}

/**
 * Delete a prompt.
 */
function deletePrompt(id) {
  const prompts = listPrompts();
  const prompt = prompts.find(p => p.id === id);
  if (!prompt) return false;

  try {
    fs.unlinkSync(prompt.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List available folders/categories.
 */
function listFolders() {
  const dir = getPromptDir();
  if (!fs.existsSync(dir)) return ['/'];

  const folders = ['/'];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        folders.push(entry.name);
      }
    }
  } catch { /* ignore */ }
  return folders;
}

/**
 * Create a new folder for prompt organization.
 */
function createFolder(name) {
  const dir = getPromptDir();
  const folderPath = path.join(dir, name);
  try {
    fs.mkdirSync(folderPath, { recursive: true });
    return { success: true, path: folderPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Search prompts by keyword.
 */
function searchPrompts(keyword) {
  const prompts = listPrompts();
  const lower = keyword.toLowerCase();
  return prompts.filter(p =>
    (p.title && p.title.toLowerCase().includes(lower)) ||
    (p.content && p.content.toLowerCase().includes(lower)) ||
    (p.tags && p.tags.some(t => t.toLowerCase().includes(lower)))
  );
}

function _slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'prompt';
}

module.exports = {
  initPromptDir,
  getPromptDir,
  setPromptDir,
  savePrompt,
  listPrompts,
  getPrompt,
  usePrompt,
  deletePrompt,
  listFolders,
  createFolder,
  searchPrompts,
};
