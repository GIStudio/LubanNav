export const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Great-circle distance in meters between two { longitude, latitude } points.
 */
export function haversineDistanceMeters(a, b) {
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const deltaLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const deltaLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value));
}

/**
 * Linear interpolation between two { longitude, latitude } points.
 * fraction must be in [0, 1]. Linear interpolation in lon/lat is accurate
 * enough at campus scale (segments are far shorter than ~1 km).
 */
export function interpolatePoint(a, b, fraction) {
  return {
    longitude: a.longitude + (b.longitude - a.longitude) * fraction,
    latitude: a.latitude + (b.latitude - a.latitude) * fraction,
  };
}

/**
 * Local planar approximation of the distance in meters from a point to a
 * segment, good enough for campus-scale proximity checks (< 2 km).
 */
export function distanceToSegmentMeters(point, a, b) {
  const referenceLatitude = (point.latitude + a.latitude + b.latitude) / 3;
  const metersPerDegreeLat = 110_574;
  const metersPerDegreeLon =
    metersPerDegreeLat * Math.cos((referenceLatitude * Math.PI) / 180);

  const px = point.longitude * metersPerDegreeLon;
  const py = point.latitude * metersPerDegreeLat;
  const ax = a.longitude * metersPerDegreeLon;
  const ay = a.latitude * metersPerDegreeLat;
  const bx = b.longitude * metersPerDegreeLon;
  const by = b.latitude * metersPerDegreeLat;

  const abx = bx - ax;
  const aby = by - ay;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared === 0) {
    return Math.hypot(px - ax, py - ay);
  }
  let t = ((px - ax) * abx + (py - ay) * aby) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const closestX = ax + t * abx;
  const closestY = ay + t * aby;
  return Math.hypot(px - closestX, py - closestY);
}

/**
 * Nearest distance in meters from a point to a polyline of
 * { longitude, latitude } points, plus the index of the segment that is
 * nearest (measured by its start point) and the closest point coordinates.
 */
export function nearestOnPolyline(point, polyline) {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestIndex = 0;
  let bestLongitude = polyline[0]?.longitude ?? point.longitude;
  let bestLatitude = polyline[0]?.latitude ?? point.latitude;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const distance = distanceToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
      // Project the point onto the winning segment for a stable anchor.
      const referenceLatitude = (point.latitude + polyline[i].latitude + polyline[i + 1].latitude) / 3;
      const metersPerDegreeLat = 110_574;
      const metersPerDegreeLon =
        metersPerDegreeLat * Math.cos((referenceLatitude * Math.PI) / 180);
      const px = point.longitude * metersPerDegreeLon;
      const py = point.latitude * metersPerDegreeLat;
      const ax = polyline[i].longitude * metersPerDegreeLon;
      const ay = polyline[i].latitude * metersPerDegreeLat;
      const bx = polyline[i + 1].longitude * metersPerDegreeLon;
      const by = polyline[i + 1].latitude * metersPerDegreeLat;
      const abx = bx - ax;
      const aby = by - ay;
      const lengthSquared = abx * abx + aby * aby;
      let t = ((px - ax) * abx + (py - ay) * aby) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
      bestLongitude = (ax + t * abx) / metersPerDegreeLon;
      bestLatitude = (ay + t * aby) / metersPerDegreeLat;
    }
  }
  return { distanceMeters: bestDistance, index: bestIndex, longitude: bestLongitude, latitude: bestLatitude };
}

/**
 * Total great-circle length in meters of a polyline of
 * { longitude, latitude } points.
 */
export function polylineLengthMeters(polyline) {
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    total += haversineDistanceMeters(polyline[i], polyline[i + 1]);
  }
  return total;
}

/**
 * Distance in meters travelled along a polyline from its start to the
 * projection of `point` onto it (0 for a point before the start, the full
 * length for a point past the end).
 */
export function distanceAlongPolylineMeters(point, polyline) {
  if (!polyline?.length) return 0;
  const nearest = nearestOnPolyline(point, polyline);
  const closest = { longitude: nearest.longitude, latitude: nearest.latitude };
  let distance = 0;
  for (let i = 0; i < nearest.index; i += 1) {
    distance += haversineDistanceMeters(polyline[i], polyline[i + 1]);
  }
  distance += haversineDistanceMeters(polyline[nearest.index], closest);
  return distance;
}
