/**
 * Car status poller: polls the car7 status server (car7-status-server on the
 * NUC, http://10.7.181.161:8901/api/status, CORS-enabled) so the web page can
 * show the car's live state (RTK fix, fixed-record count, road network, speed).
 *
 * The URL is configurable via the `luban-nav:car-status-url` localStorage key
 * (or `?carStatusUrl=` query param) so different environments can point at
 * the car. When unreachable the poller reports `offline` instead of failing.
 */

export const DEFAULT_CAR_STATUS_URL = 'http://10.7.181.161:8901/api/status';

export function loadCarStatusUrl() {
  try {
    const query = new URLSearchParams(window.location.search).get('carStatusUrl');
    if (query) return query;
    return localStorage.getItem('luban-nav:car-status-url') || DEFAULT_CAR_STATUS_URL;
  } catch {
    return DEFAULT_CAR_STATUS_URL;
  }
}

export function createCarStatusPoller({
  url = loadCarStatusUrl(),
  intervalMs = 5000,
  timeoutMs = 3000,
  getNow = () => Date.now(),
} = {}) {
  const listeners = new Set();
  let timer = null;
  let state = {
    online: false,
    data: null,
    error: null,
    lastUpdatedAt: null,
    url,
  };

  function emit() {
    for (const listener of listeners) listener(state);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function poll() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state = {
        online: true,
        data,
        error: null,
        lastUpdatedAt: getNow(),
        url,
      };
    } catch (error) {
      state = {
        online: false,
        data: state.data, // keep the last good snapshot for display
        error: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
        lastUpdatedAt: state.lastUpdatedAt,
        url,
      };
    } finally {
      clearTimeout(timeout);
    }
    emit();
  }

  function start() {
    if (timer != null) return;
    poll();
    timer = setInterval(poll, intervalMs);
  }

  function stop() {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { subscribe, start, stop, getState: () => state };
}
