import { PUBLIC_LOCATIONS } from '../data/campus.js';
import { getLocationBinding } from './pathfinding.js';
import { haversineDistanceMeters } from './geo.js';

/**
 * One-shot "where am I" → nearest navigable place, used to default the
 * route origin to the user's current position instead of the main gate.
 *
 * Priority is enforced by the caller (App): an explicitly stated origin
 * (URL param, typed/voice query, manual select) always wins; a GPS fix is
 * used only while the origin is still the untouched default; and the main
 * gate remains the final fallback when there is no fix and no user input.
 */

/** GPS fixes farther than this from any public place are not adopted. */
export const MAX_ORIGIN_DISTANCE_METERS = 250;

/** Entrance/binding anchor of a public location (falls back to its own coords). */
export function placeCoordinates(location) {
  const binding = getLocationBinding(location.id);
  const point = binding?.entrance ?? location;
  return { latitude: point.latitude, longitude: point.longitude };
}

/**
 * Nearest public place to a GPS fix, or null when nothing is within range.
 * Pure function — unit-testable without a browser.
 */
export function nearestPublicPlace(
  latitude,
  longitude,
  { maxDistanceMeters = MAX_ORIGIN_DISTANCE_METERS } = {},
) {
  let best = null;
  for (const location of PUBLIC_LOCATIONS) {
    const { latitude: lat, longitude: lng } = placeCoordinates(location);
    const distance = haversineDistanceMeters(
      { latitude, longitude },
      { latitude: lat, longitude: lng },
    );
    if (distance > maxDistanceMeters) continue;
    if (!best || distance < best.distanceMeters) {
      best = { id: location.id, distanceMeters: Math.round(distance) };
    }
  }
  return best;
}

/**
 * Browser geolocation wrapper. Resolves to the nearest public place, or
 * null on timeout, denial, unsupported API or out-of-range fix — callers
 * treat null as "keep the default origin".
 */
export async function locateCurrentPlace({
  timeoutMs = 6000,
  maximumAge = 60000,
  geolocation = null,
} = {}) {
  const api = geolocation ?? (typeof navigator !== 'undefined' ? navigator.geolocation : null);
  if (!api?.getCurrentPosition) return null;
  try {
    const position = await new Promise((resolve, reject) => {
      api.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge,
      });
    });
    return nearestPublicPlace(position.coords.latitude, position.coords.longitude);
  } catch {
    return null;
  }
}
