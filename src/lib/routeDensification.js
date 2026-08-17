import { haversineDistanceMeters, interpolatePoint } from './geo.js';

/**
 * Default maximum spacing between consecutive navigation waypoints.
 * The campus robot follows points roughly every 2–3 meters; 2.5 m is the
 * midpoint of that band.
 */
export const DEFAULT_WAYPOINT_SPACING_METERS = 2.5;

const sameCoordinate = (a, b) =>
  a != null &&
  b != null &&
  Math.abs(a.longitude - b.longitude) < 1e-8 &&
  Math.abs(a.latitude - b.latitude) < 1e-8;

/**
 * Turn a route `path` (one point per graph node, OSM nodes can be tens of
 * meters apart) into a dense, robot-friendly waypoint list where no two
 * consecutive waypoints are farther apart than `maxSpacingMeters`.
 *
 * Original graph points keep their identity (`id`, `name`, ...) and are
 * marked `interpolated: false`. Points inserted by linear interpolation carry
 * `interpolated: true`, `source: 'linear-interpolation'`, and references to
 * the segment they were inserted on (`edgeIndex`, `fromNodeId`, `toNodeId`).
 *
 * Every waypoint carries `sequence` and `distanceMeters` (the spacing to the
 * previous waypoint), so a robot can build a speed profile without further
 * computation.
 */
export function densifyNavigationWaypoints(path, { maxSpacingMeters = DEFAULT_WAYPOINT_SPACING_METERS } = {}) {
  if (!Array.isArray(path) || path.length === 0) return [];
  if (!Number.isFinite(maxSpacingMeters) || maxSpacingMeters <= 0) {
    throw new Error('maxSpacingMeters must be a positive number');
  }

  const raw = [];
  const pushPoint = (point, interpolated, edgeIndex, fromNodeId, toNodeId) => {
    const previous = raw.at(-1);
    if (
      previous &&
      previous.interpolated === interpolated &&
      sameCoordinate(previous.point, point)
    ) {
      return;
    }
    raw.push({ point, interpolated, edgeIndex, fromNodeId, toNodeId });
  };

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i];
    const to = path[i + 1];
    const length = haversineDistanceMeters(from, to);
    if (length === 0) continue;
    pushPoint(from, false, i, from.id ?? null, to.id ?? null);
    const steps = Math.max(1, Math.ceil(length / maxSpacingMeters - 1e-9));
    for (let k = 1; k < steps; k += 1) {
      const fraction = k / steps;
      const point = interpolatePoint(from, to, fraction);
      point.id = null;
      point.name = null;
      point.kind = 'interpolated';
      point.interpolated = true;
      point.source = 'linear-interpolation';
      point.indoor = from.indoor === true;
      point.outdoor = from.outdoor === true;
      point.indoorTransition = from.indoorTransition === true;
      point.level = from.level ?? null;
      point.servedLevels = from.servedLevels ?? null;
      pushPoint(point, true, i, from.id ?? null, to.id ?? null);
    }
  }
  const lastPoint = path.at(-1);
  if (lastPoint) {
    pushPoint(
      lastPoint,
      false,
      Math.max(0, path.length - 2),
      path.at(-2)?.id ?? null,
      lastPoint.id ?? null,
    );
  }

  let maxSpacing = 0;
  const waypoints = raw.map((entry, sequence) => {
    const point = entry.point;
    const previous = raw[sequence - 1]?.point ?? null;
    const spacing =
      previous == null ? 0 : haversineDistanceMeters(previous, point);
    maxSpacing = Math.max(maxSpacing, spacing);
    return {
      sequence,
      nodeId: point.id ?? null,
      name: point.name ?? null,
      kind: point.kind ?? 'road',
      longitude: Number(point.longitude.toFixed(7)),
      latitude: Number(point.latitude.toFixed(7)),
      indoor: point.indoor === true,
      outdoor: point.outdoor === true,
      indoorTransition: point.indoorTransition === true,
      level: point.level ?? null,
      servedLevels: point.servedLevels ?? null,
      interpolated: entry.interpolated,
      source: entry.interpolated ? 'linear-interpolation' : (point.source ?? null),
      edgeIndex: entry.edgeIndex,
      fromNodeId: entry.fromNodeId,
      toNodeId: entry.toNodeId,
      distanceMeters: Number(spacing.toFixed(2)),
    };
  });

  return {
    waypoints,
    maxSpacingMeters: Number(maxSpacing.toFixed(2)),
  };
}
