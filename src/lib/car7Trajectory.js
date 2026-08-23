/**
 * Car7 trajectory control: fetch the car's recorded RTK trajectory from the
 * car7 status server (8901) and dispatch a real navigation run to it.
 *
 * This is the "real" path-following path — the status server starts
 * car7_navigator.py (no-IMU stop-and-go / RTK differential heading) which then
 * publishes /cmd_vel to the chassis. The web page just:
 *   - loads the recorded trajectory via GET  /api/trajectory
 *   - starts the run via          POST /api/trajectory/start {points, speed, minLeg, turnThresh}
 *   - stops via                   POST /api/trajectory/stop
 *
 * The base URL is the same configurable host as the car-status poller
 * (`luban-nav:car-status-url` localStorage or ?carStatusUrl= query param); the
 * `/api/status` path suffix is stripped to get the origin.
 */

import { loadCarStatusUrl } from './carStatus.js';

export const DEFAULT_NAV_SPEED = 3.0; // m/s — the requested default cruise speed
export const DEFAULT_MIN_LEG = 1.2;   // key-point min spacing (m)
export const DEFAULT_TURN_THRESH = 25.0; // turn threshold (deg) to stop-and-recompute

// Derive the host ("origin") from the car-status URL, e.g.
//   http://10.7.181.161:8901/api/status  ->  http://10.7.181.161:8901
export function trajectoryBaseUrl() {
  try {
    return loadCarStatusUrl().replace(/\/api\/status.*$/, '');
  } catch {
    return 'http://10.7.181.161:8901';
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${trajectoryBaseUrl()}${path}`, {
    cache: 'no-store',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  if (!response.ok) {
    const fallback = `HTTP ${response.status}`;
    let detail = fallback;
    try {
      const data = await response.json();
      detail = data?.error || fallback;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return response.json();
}

export function loadTrajectory() {
  return request('/api/trajectory');
}

export function loadSavedTrajectories() {
  return request('/api/trajectories');
}

/** Start the car following the given points. Defaults to 3.0 m/s. */
export function startTrajectory(points, {
  speed = DEFAULT_NAV_SPEED,
  minLeg = DEFAULT_MIN_LEG,
  turnThresh = DEFAULT_TURN_THRESH,
  radius = 0.8,
} = {}) {
  if (!Array.isArray(points) || points.length < 3) {
    return Promise.reject(new Error('轨迹点太少（至少 3 个）'));
  }
  return request('/api/trajectory/start', {
    method: 'POST',
    body: JSON.stringify({ speed, points, minLeg, turnThresh, radius }),
  });
}

export function stopTrajectory() {
  return request('/api/trajectory/stop', { method: 'POST' });
}
