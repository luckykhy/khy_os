import { ref } from 'vue';

/**
 * Geolocation composable (singleton).
 *
 * Wraps the browser Geolocation API for the chat "share my location" toggle:
 * - requestLocation(): one-shot coordinate fetch with normalized status codes
 *   ('granted' | 'denied' | 'unavailable' | 'timeout').
 * - queryPermissionState(): probe via the Permissions API so callers can avoid
 *   triggering the browser permission prompt unnecessarily.
 * - The on/off preference persists to localStorage; `maximumAge` lets the
 *   browser reuse a cached fix for up to 5 minutes, so callers can read
 *   `lastCoords` instead of re-locating on every message.
 */

const STORAGE_KEY = 'khy_chat_location_enabled';
const POSITION_OPTIONS = { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 };

function readStoredEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // ignore storage access errors (private mode, etc.)
    return false;
  }
}

// Singleton state shared across all callers.
const enabled = ref(readStoredEnabled());
// Mirrors the Permissions API states: 'granted' | 'denied' | 'prompt'.
const permissionState = ref('prompt');
// Last known coordinates: { latitude, longitude, accuracy } or null.
const lastCoords = ref(null);

export function useGeolocation() {
  /** Persist the user's on/off preference. */
  function setEnabled(value) {
    enabled.value = !!value;
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      // ignore storage write errors
    }
  }

  /**
   * Probe the current geolocation permission without prompting the user.
   * Returns 'prompt' when the Permissions API is unsupported so callers fall
   * back to an explicit requestLocation() call.
   */
  async function queryPermissionState() {
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.permissions ||
        typeof navigator.permissions.query !== 'function'
      ) {
        return 'prompt';
      }
      const status = await navigator.permissions.query({ name: 'geolocation' });
      permissionState.value = status.state || 'prompt';
      return permissionState.value;
    } catch {
      return 'prompt';
    }
  }

  /**
   * Request the current position once. Never rejects; resolves to
   * `{ coords, status }` where `coords` is null unless status === 'granted'.
   */
  async function requestLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return { coords: null, status: 'unavailable' };
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const coords = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          };
          lastCoords.value = coords;
          permissionState.value = 'granted';
          resolve({ coords, status: 'granted' });
        },
        (error) => {
          let status = 'unavailable';
          if (error && error.code === error.PERMISSION_DENIED) {
            status = 'denied';
            permissionState.value = 'denied';
          } else if (error && error.code === error.TIMEOUT) {
            status = 'timeout';
          }
          resolve({ coords: null, status });
        },
        POSITION_OPTIONS
      );
    });
  }

  return {
    enabled,
    permissionState,
    lastCoords,
    setEnabled,
    requestLocation,
    queryPermissionState,
  };
}
