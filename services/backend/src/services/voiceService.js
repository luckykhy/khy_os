/**
 * Voice Service — TTS/STT integration for khy OS CLI.
 *
 * Provides voice input (speech-to-text) and voice output (text-to-speech)
 * using system-native commands or API-based providers.
 *
 * Architecture:
 *   - STT: System `arecord` + Whisper API / local whisper.cpp
 *   - TTS: System `say` (macOS) / `espeak` (Linux) / `edge-tts` (cross-platform)
 *   - Toggle: /voice command in REPL
 *   - Streaming: TTS runs async, does not block input
 *
 * Aligned with Claude Code's voice input/output integration.
 */
const { spawn, execSync, spawnSync } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VOICE_SETTINGS_KEY = 'voiceEnabled';
const VOICE_PROVIDER_KEY = 'voiceProvider';
const TEMP_DIR = path.join(os.tmpdir(), 'khy-voice');

// ── Provider detection ─────────────────────────────────────────────

const PLATFORM = process.platform;

/**
 * Detect available TTS provider.
 * @returns {'say'|'espeak'|'edge-tts'|'piper'|null}
 */
function _whichCmd(bin) {
  const { searchExecutable } = require('../tools/platformUtils');
  if (!searchExecutable(bin)) throw new Error(`${bin} not found`);
}

function detectTTSProvider() {
  if (PLATFORM === 'win32') {
    // Windows has no common CLI TTS out-of-the-box.
    // Check for edge-tts (Python package) only.
    try { _whichCmd('edge-tts'); return 'edge-tts'; } catch { /* ignore */ }
    return null;
  }

  if (PLATFORM === 'darwin') {
    try { _whichCmd('say'); return 'say'; } catch { /* ignore */ }
  }

  // Linux: espeak or espeak-ng
  try { _whichCmd('espeak-ng'); return 'espeak'; } catch { /* ignore */ }
  try { _whichCmd('espeak'); return 'espeak'; } catch { /* ignore */ }

  // Cross-platform: edge-tts (Python package)
  try { _whichCmd('edge-tts'); return 'edge-tts'; } catch { /* ignore */ }

  // Piper (fast local TTS)
  try { _whichCmd('piper'); return 'piper'; } catch { /* ignore */ }

  return null;
}

/**
 * Detect available STT provider.
 * @returns {'whisper-api'|'whisper-local'|'sox'|null}
 */
function detectSTTProvider() {
  if (PLATFORM === 'win32') {
    // Windows: only check for whisper
    try { _whichCmd('whisper'); return 'whisper-local'; } catch { /* ignore */ }
    return null;
  }

  // Check for whisper.cpp or whisper CLI
  try { _whichCmd('whisper'); return 'whisper-local'; } catch { /* ignore */ }

  // Check for sox (recording)
  try { _whichCmd('sox'); return 'sox'; } catch { /* ignore */ }

  // macOS: can use `say -i` workaround or system speech recognition
  if (PLATFORM === 'darwin') {
    try { _whichCmd('rec'); return 'sox'; } catch { /* ignore */ }
  }

  // Linux: arecord
  try { _whichCmd('arecord'); return 'sox'; } catch { /* ignore */ }

  return null;
}

// ── TTS (Text-to-Speech) ───────────────────────────────────────────

let _ttsProcess = null;

/**
 * Speak text aloud using the detected TTS provider.
 * Non-blocking — runs in background.
 *
 * @param {string} text - Text to speak
 * @param {object} [options]
 * @param {string} [options.provider] - Force a specific TTS provider
 * @param {string} [options.voice] - Voice name (provider-specific)
 * @param {number} [options.rate] - Speech rate (words per minute)
 * @returns {{ cancel: Function }}
 */
function speak(text, options = {}) {
  // Cancel any ongoing speech
  if (_ttsProcess) {
    try { safeKill(_ttsProcess); } catch { /* ignore */ }
    _ttsProcess = null;
  }

  if (!text || typeof text !== 'string') return { cancel: () => {} };

  // Clean text for speech (remove markdown, code blocks, etc.)
  const cleanText = text
    .replace(/```[\s\S]*?```/g, 'code block omitted')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/[*_~]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();

  if (!cleanText) return { cancel: () => {} };

  const provider = options.provider || detectTTSProvider();

  switch (provider) {
    case 'say': {
      // macOS
      const args = [cleanText];
      if (options.voice) args.unshift('-v', options.voice);
      if (options.rate) args.unshift('-r', String(options.rate));
      _ttsProcess = spawn('say', args, { stdio: 'ignore' });
      _ttsProcess.on('error', () => { /* say not available */ });
      break;
    }

    case 'espeak': {
      // Linux espeak/espeak-ng
      const { searchExecutable } = require('../tools/platformUtils');
      const cmd = searchExecutable('espeak-ng') ? 'espeak-ng' : 'espeak';
      const args = [cleanText];
      if (options.rate) args.unshift('-s', String(options.rate));
      _ttsProcess = spawn(cmd, args, { stdio: 'ignore' });
      _ttsProcess.on('error', () => { /* espeak not available */ });
      break;
    }

    case 'edge-tts': {
      // Microsoft Edge TTS (cross-platform, requires Python package)
      const voice = options.voice || 'en-US-AriaNeural';
      const outFile = path.join(ensureTempDir(), `tts_${Date.now()}.mp3`);
      _ttsProcess = spawn('edge-tts', ['--voice', voice, '--text', cleanText, '--write-media', outFile], {
        stdio: 'ignore',
      });
      _ttsProcess.on('error', () => { /* edge-tts not available */ });
      _ttsProcess.on('close', () => {
        // Play the generated audio
        const player = PLATFORM === 'darwin' ? 'afplay' : PLATFORM === 'win32' ? 'powershell' : 'mpv';
        try {
          const playArgs = PLATFORM === 'win32'
            ? ['-NoProfile', '-c', `Start-Process "${outFile}"`]
            : [outFile];
          const playProcess = spawn(player, playArgs, { stdio: 'ignore' });
          playProcess.on('error', () => { /* player not available */ });
          playProcess.on('close', () => {
            try { fs.unlinkSync(outFile); } catch { /* ignore */ }
          });
        } catch { /* no player available */ }
      });
      break;
    }

    case 'piper': {
      // Piper local TTS
      const outFile = path.join(ensureTempDir(), `tts_${Date.now()}.wav`);
      _ttsProcess = spawn('piper', ['--output_file', outFile], { stdio: ['pipe', 'ignore', 'ignore'] });
      _ttsProcess.on('error', () => { /* piper not available */ });
      _ttsProcess.stdin.write(cleanText);
      _ttsProcess.stdin.end();
      _ttsProcess.on('close', () => {
        const player = PLATFORM === 'darwin' ? 'afplay' : PLATFORM === 'win32' ? 'powershell' : 'aplay';
        try {
          const playArgs = PLATFORM === 'win32'
            ? ['-NoProfile', '-c', `(New-Object Media.SoundPlayer "${outFile}").PlaySync()`]
            : [outFile];
          spawn(player, playArgs, { stdio: 'ignore' }).on('error', () => { /* player not available */ }).on('close', () => {
            try { fs.unlinkSync(outFile); } catch { /* ignore */ }
          });
        } catch { /* ignore */ }
      });
      break;
    }

    default:
      // No TTS provider available
      return { cancel: () => {} };
  }

  const proc = _ttsProcess;
  _ttsProcess.on('close', () => { if (_ttsProcess === proc) _ttsProcess = null; });
  _ttsProcess.on('error', () => { if (_ttsProcess === proc) _ttsProcess = null; });

  return {
    cancel: () => {
      if (proc && !proc.killed) {
        try { safeKill(proc); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * Stop any ongoing speech.
 */
function stopSpeaking() {
  if (_ttsProcess) {
    try { safeKill(_ttsProcess); } catch { /* ignore */ }
    _ttsProcess = null;
  }
}

// ── STT (Speech-to-Text) ──────────────────────────────────────────

/**
 * Record audio from microphone and transcribe to text.
 * Blocks until recording is done (press Enter or timeout).
 *
 * @param {object} [options]
 * @param {number} [options.maxDurationSeconds=30] - Maximum recording duration
 * @param {string} [options.language='en'] - Language hint for transcription
 * @returns {Promise<{ text: string, duration: number }|{ error: string }>}
 */
async function listen(options = {}) {
  const maxDuration = options.maxDurationSeconds || 30;
  const tempFile = path.join(ensureTempDir(), `stt_${Date.now()}.wav`);

  const sttProvider = detectSTTProvider();
  if (!sttProvider) {
    return { error: 'No STT provider available. Install sox or whisper.' };
  }

  // Record audio
  try {
    await recordAudio(tempFile, maxDuration);
  } catch (err) {
    return { error: `Recording failed: ${err.message}` };
  }

  if (!fs.existsSync(tempFile)) {
    return { error: 'No audio recorded.' };
  }

  // Transcribe
  try {
    const text = await transcribeAudio(tempFile, options.language);
    const stat = fs.statSync(tempFile);
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    return { text, duration: Math.round(stat.size / 32000) }; // rough duration estimate
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    return { error: `Transcription failed: ${err.message}` };
  }
}

/**
 * Record audio to a WAV file.
 */
function recordAudio(outFile, maxDurationSec) {
  return new Promise((resolve, reject) => {
    let recorder;

    if (PLATFORM === 'darwin') {
      // macOS: use sox's `rec` command
      recorder = spawn('rec', ['-q', outFile, 'trim', '0', String(maxDurationSec)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } else {
      // Linux: arecord
      recorder = spawn('arecord', ['-f', 'cd', '-t', 'wav', '-d', String(maxDurationSec), outFile], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    }

    recorder.on('close', (code) => {
      if (code === 0 || fs.existsSync(outFile)) {
        resolve();
      } else {
        reject(new Error(`Recorder exited with code ${code}`));
      }
    });

    recorder.on('error', reject);

    // Allow early stop via SIGINT
    const sigintHandler = () => {
      try { safeKill(recorder); } catch { /* ignore */ }
    };
    process.once('SIGINT', sigintHandler);
    recorder.on('close', () => process.removeListener('SIGINT', sigintHandler));
  });
}

/**
 * Transcribe a WAV file to text.
 */
async function transcribeAudio(wavFile, language = 'en') {
  // Try whisper first
  try {
    const result = spawnSync('whisper', [
      wavFile,
      '--model', 'base',
      '--language', language,
      '--output_format', 'txt',
      '--output_dir', path.dirname(wavFile),
    ], { encoding: 'utf-8', timeout: 60000 });

    if (result.status === 0) {
      const txtFile = wavFile.replace(/\.wav$/, '.txt');
      if (fs.existsSync(txtFile)) {
        const text = fs.readFileSync(txtFile, 'utf-8').trim();
        try { fs.unlinkSync(txtFile); } catch { /* ignore */ }
        return text;
      }
    }
  } catch { /* whisper not available */ }

  // Fallback: whisper.cpp
  try {
    const result = spawnSync('whisper-cpp', [
      '-m', 'base',
      '-f', wavFile,
      '-l', language,
    ], { encoding: 'utf-8', timeout: 60000 });

    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch { /* not available */ }

  throw new Error('No transcription engine available. Install whisper or whisper.cpp.');
}

// ── Settings ───────────────────────────────────────────────────────

function getVoiceSettings() {
  try {
    const settingsFile = path.join(os.homedir(), '.khy', 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      return {
        enabled: settings[VOICE_SETTINGS_KEY] === true,
        provider: settings[VOICE_PROVIDER_KEY] || null,
      };
    }
  } catch { /* ignore */ }
  return { enabled: false, provider: null };
}

function setVoiceEnabled(enabled) {
  try {
    const settingsFile = path.join(os.homedir(), '.khy', 'settings.json');
    const settingsDir = path.dirname(settingsFile);
    if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

    let settings = {};
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }
    settings[VOICE_SETTINGS_KEY] = enabled;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// ── Capabilities ───────────────────────────────────────────────────

function getCapabilities() {
  return {
    tts: detectTTSProvider(),
    stt: detectSTTProvider(),
    platform: PLATFORM,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  return TEMP_DIR;
}

module.exports = {
  speak,
  stopSpeaking,
  listen,
  detectTTSProvider,
  detectSTTProvider,
  getVoiceSettings,
  setVoiceEnabled,
  getCapabilities,
};
