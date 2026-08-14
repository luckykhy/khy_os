'use strict';

/**
 * geolocationService.js — single implementation point for device geolocation.
 *
 * Resolution chain (getLocation):
 *   1. In-memory cache (TTL GEOLOCATION_CACHE_TTL_MS; refresh=true bypasses)
 *   2. Windows location service via WinRT (win32 only, high accuracy)
 *   3. IP geolocation (ipify → ip-api, city-level accuracy)
 *   4. All failed → { success: false, error, guidance }
 *
 * Privacy: coordinate values are NEVER written to console.log/logger;
 * the cache lives in process memory only.
 *
 * All URLs/timeouts come from constants/serviceDefaults (Zero Hardcoding).
 */

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const {
  GEOLOCATION_IP_API_URL,
  GEOLOCATION_IPIFY_URL,
  GEOLOCATION_HTTP_TIMEOUT_MS,
  WINDOWS_GEO_TIMEOUT_MS,
  GEOLOCATION_CACHE_TTL_MS,
} = require('../constants/serviceDefaults');

// ── In-memory cache (single entry; coordinates never leave the process) ─────
let _cache = null; // { result, ts }

function _clearCache() {
  _cache = null;
}

// ── HTTP helper (follows repo convention: localBrainExternalApi._fetchJson) ──
function _fetchJson(url, timeout = GEOLOCATION_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

// ── Windows location service (WinRT via PowerShell) ─────────────────────────

// PowerShell script: load the WinRT Geolocator type, request access, await
// GetGeopositionAsync via the AsTask bridge, print compact JSON to stdout.
// Any permission denial or exception exits non-zero → caller degrades to IP.
const _WINDOWS_GEO_PS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  '  Function Await($WinRtTask, $ResultType) {',
  '    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
  '    $netTask = $asTask.Invoke($null, @($WinRtTask))',
  '    $null = $netTask.Wait(-1)',
  '    $netTask.Result',
  '  }',
  '  $null = [Windows.Devices.Geolocation.Geolocator,Windows.Devices.Geolocation,ContentType=WindowsRuntime]',
  '  $access = Await ([Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()) ([Windows.Devices.Geolocation.GeolocationAccessStatus])',
  '  if ($access -ne [Windows.Devices.Geolocation.GeolocationAccessStatus]::Allowed) { exit 2 }',
  '  $geolocator = New-Object Windows.Devices.Geolocation.Geolocator',
  '  $pos = Await ($geolocator.GetGeopositionAsync()) ([Windows.Devices.Geolocation.Geoposition])',
  '  $coord = $pos.Coordinate',
  '  @{ latitude = $coord.Point.Position.Latitude; longitude = $coord.Point.Position.Longitude; accuracy = $coord.Accuracy } | ConvertTo-Json -Compress',
  '} catch { exit 3 }',
].join('\n');

/**
 * Try the Windows location service (win32 only).
 *
 * Spawns powershell.exe directly (NEVER an .cmd shim — Node 20+ on Windows
 * throws spawn EINVAL for .cmd/.bat; a real .exe is safe). Kills the child on
 * WINDOWS_GEO_TIMEOUT_MS (short I/O timeout). Single spawn without shell, so
 * child.kill() cannot leak grandchildren.
 *
 * @returns {Promise<{latitude:number, longitude:number, accuracy:number}|null>}
 */
function tryWindowsGeolocation() {
  if (process.platform !== 'win32') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', _WINDOWS_GEO_PS_SCRIPT],
        { windowsHide: true }
      );
    } catch {
      // Synchronous spawn failure (missing binary etc.) → degrade to IP path
      return resolve(null);
    }

    let stdout = '';
    let settled = false;
    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    // Short I/O timeout: kill the child and fall back to IP geolocation.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      done(null);
    }, WINDOWS_GEO_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) {
        return done(null);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
          return done({
            latitude: parsed.latitude,
            longitude: parsed.longitude,
            accuracy: typeof parsed.accuracy === 'number' ? parsed.accuracy : null,
          });
        }
      } catch {
        /* malformed output → degrade */
      }
      done(null);
    });
  });
}

// ── IP geolocation (ipify → ip-api) ─────────────────────────────────────────

/**
 * Resolve location from the public IP: GET ipify for the IP, then ip-api
 * for the geo record (lang=zh-CN). Returns null on any failure.
 *
 * @returns {Promise<{latitude:number, longitude:number, city:string, region:string, country:string}|null>}
 */
async function tryIpGeolocation() {
  let ip;
  try {
    const data = await _fetchJson(GEOLOCATION_IPIFY_URL);
    if (!data || !data.ip) {
      return null;
    }
    ip = data.ip;
  } catch {
    return null;
  }

  try {
    const geo = await _fetchJson(`${GEOLOCATION_IP_API_URL}/${ip}?lang=zh-CN`);
    if (geo && geo.status === 'success') {
      return {
        latitude: geo.lat,
        longitude: geo.lon,
        city: geo.city || null,
        region: geo.regionName || null,
        country: geo.country || null,
      };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current device location.
 *
 * @param {object} [options]
 * @param {boolean} [options.refresh=false] - Bypass the in-memory cache
 * @returns {Promise<object>} On success:
 *   { success: true, latitude, longitude, accuracy, city, region, country,
 *     source: 'windows'|'ip', timestamp }
 *   On failure: { success: false, error, guidance }
 */
async function getLocation({ refresh = false } = {}) {
  // 1. Cache
  if (!refresh && _cache && Date.now() - _cache.ts < GEOLOCATION_CACHE_TTL_MS) {
    return _cache.result;
  }

  // 2. Windows location service (high accuracy)
  const win = await tryWindowsGeolocation();
  if (win) {
    const result = {
      success: true,
      latitude: win.latitude,
      longitude: win.longitude,
      accuracy: win.accuracy,
      city: null,
      region: null,
      country: null,
      source: 'windows',
      timestamp: Date.now(),
    };
    // Windows commonly returns coordinates only (no reverse-geocoded place
    // text). getEnvironmentSection injects city/region TEXT, so when all place
    // fields are null, backfill them from the IP path while KEEPING Windows'
    // high-accuracy coordinates. Best-effort: if IP lookup fails we still
    // return the coordinates-only Windows result.
    if (!result.city && !result.region && !result.country) {
      const ipGeo = await tryIpGeolocation();
      if (ipGeo) {
        result.city = ipGeo.city;
        result.region = ipGeo.region;
        result.country = ipGeo.country;
      }
    }
    _cache = { result, ts: result.timestamp };
    return result;
  }

  // 3. IP geolocation (city-level accuracy)
  const ipGeo = await tryIpGeolocation();
  if (ipGeo) {
    const result = {
      success: true,
      latitude: ipGeo.latitude,
      longitude: ipGeo.longitude,
      accuracy: null,
      city: ipGeo.city,
      region: ipGeo.region,
      country: ipGeo.country,
      source: 'ip',
      timestamp: Date.now(),
    };
    _cache = { result, ts: result.timestamp };
    return result;
  }

  // 4. All strategies failed
  return {
    success: false,
    error: '定位失败：Windows 位置服务不可用且 IP 定位请求未成功',
    guidance: '请在 Windows 设置 > 隐私和安全性 > 位置 中开启位置服务，或检查网络连接后重试',
  };
}

/**
 * Synchronous, cache-only read of the current location.
 *
 * Returns the cached success result when it is still within
 * GEOLOCATION_CACHE_TTL_MS, otherwise null. This accessor NEVER performs a
 * network request, NEVER blocks, and NEVER throws — it exists so synchronous
 * callers (e.g. system-prompt assembly) can opportunistically read a location
 * that a background getLocation() call has already warmed.
 *
 * @returns {object|null} The cached location result (with city/region fields)
 *   or null when there is no fresh cache entry.
 */
function getCachedLocation() {
  if (_cache && Date.now() - _cache.ts < GEOLOCATION_CACHE_TTL_MS) {
    return _cache.result;
  }
  return null;
}

module.exports = { getLocation, getCachedLocation, _clearCache };
