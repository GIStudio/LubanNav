import { haversineDistanceMeters } from './geo.js';

/**
 * Position fusion store: the robot's RTK telemetry is the primary position
 * source; the browser's geolocation is the fallback. The active source is
 * picked by freshness:
 *   - robot position fresh (default 5 s)  → source 'robot'
 *   - else browser position fresh (30 s)  → source 'browser'
 *   - else no position.
 *
 * Browser geolocation requires a secure context (HTTPS or localhost); when it
 * is unavailable or denied the store simply never reports a browser fix.
 */

export const ROBOT_STALE_MS = 5_000;
export const BROWSER_STALE_MS = 30_000;

export function createPositionStore({
  geolocation = null,
  robotStaleMs = ROBOT_STALE_MS,
  browserStaleMs = BROWSER_STALE_MS,
  getNow = () => Date.now(),
} = {}) {
  const api = geolocation ?? (typeof navigator !== 'undefined' ? navigator.geolocation : null);
  const listeners = new Set();
  let robot = null; // { longitude, latitude, headingDegrees, accuracyMeters, receivedAt }
  let browser = null; // { longitude, latitude, accuracyMeters, receivedAt }
  let watchId = null;
  let watchError = null;

  function emit() {
    const state = getState();
    for (const listener of listeners) listener(state);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setRobotPosition(position) {
    if (!position) return;
    const now = getNow();
    robot = {
      longitude: position.longitude,
      latitude: position.latitude,
      headingDegrees: position.headingDegrees ?? null,
      accuracyMeters: position.accuracyMeters ?? null,
      speedMetersPerSecond: position.speedMetersPerSecond ?? null,
      fixStatus: position.fixStatus ?? null,
      receivedAt: now,
    };
    emit();
  }

  function clearRobotPosition() {
    robot = null;
    emit();
  }

  function startBrowserWatch() {
    if (watchId != null || !api?.watchPosition) return;
    watchId = api.watchPosition(
      (position) => {
        watchError = null;
        const { latitude, longitude, accuracy, speed, heading } = position.coords;
        browser = {
          latitude,
          longitude,
          accuracyMeters: accuracy ?? null,
          speedMetersPerSecond: speed ?? null,
          headingDegrees: heading ?? null,
          receivedAt: getNow(),
        };
        emit();
      },
      (error) => {
        watchError = {
          code: error?.code ?? null,
          message: error?.message ?? 'Geolocation error',
        };
        browser = null;
        emit();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2_000,
        timeout: 15_000,
      },
    );
  }

  function stopBrowserWatch() {
    if (watchId != null && api?.clearWatch) {
      api.clearWatch(watchId);
    }
    watchId = null;
  }

  function getState() {
    const now = getNow();
    let active = null;
    let reason = null;

    if (robot && now - robot.receivedAt <= robotStaleMs) {
      active = { source: 'robot', position: robot };
    } else if (browser && now - browser.receivedAt <= browserStaleMs) {
      active = { source: 'browser', position: browser };
    } else if (robot) {
      reason = 'robot-stale';
    }

    return {
      robot,
      browser,
      active,
      source: active?.source ?? null,
      staleReason: reason,
      watchError,
      watchingBrowser: watchId != null,
    };
  }

  return {
    subscribe,
    setRobotPosition,
    clearRobotPosition,
    startBrowserWatch,
    stopBrowserWatch,
    getState,
  };
}

/**
 * Distance from a WGS84 position to a polyline, plus the polyline index of the
 * nearest vertex. Pure function — unit-testable.
 */
export function nearestPointOnRoute(points, latitude, longitude) {
  if (!points?.length) return null;
  let bestIndex = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = haversineDistanceMeters(
      { latitude, longitude },
      { latitude: point.latitude, longitude: point.longitude },
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return { index: bestIndex, distanceMeters: bestDistance };
}

/**
 * Navigation progress from the current position along a route's dense
 * waypoint list. Returns remaining meters / percent / next waypoint index.
 */
export function progressAlongRoute(route, position) {
  if (!route?.path?.length || !position) return null;
  const points = route.navigationWaypoints ?? route.path;
  const nearest = nearestPointOnRoute(points, position.latitude, position.longitude);
  if (!nearest) return null;

  let remainingMeters = nearest.distanceMeters;
  for (let index = nearest.index; index < points.length - 1; index += 1) {
    remainingMeters += haversineDistanceMeters(
      { latitude: points[index].latitude, longitude: points[index].longitude },
      { latitude: points[index + 1].latitude, longitude: points[index + 1].longitude },
    );
  }

  let totalMeters = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    totalMeters += haversineDistanceMeters(
      { latitude: points[index].latitude, longitude: points[index].longitude },
      { latitude: points[index + 1].latitude, longitude: points[index + 1].longitude },
    );
  }
  if (totalMeters <= 0) totalMeters = route.summary?.distanceMeters ?? 1;

  const percent = Math.min(1, Math.max(0, 1 - remainingMeters / totalMeters));
  const nextIndex = Math.min(nearest.index + 1, points.length - 1);
  const distanceToNext = haversineDistanceMeters(
    { latitude: position.latitude, longitude: position.longitude },
    { latitude: points[nextIndex].latitude, longitude: points[nextIndex].longitude },
  );

  return {
    nearestIndex: nearest.index,
    nextIndex,
    distanceToNextMeters: distanceToNext,
    remainingMeters,
    totalMeters,
    percent,
    arrived: nearest.index >= points.length - 1 || remainingMeters < 1.0,
  };
}
