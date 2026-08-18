import { describe, expect, it } from 'vitest';
import {
  distanceAlongPolylineMeters,
  haversineDistanceMeters,
  polylineLengthMeters,
} from './geo.js';

const MERIDIAN = [
  { longitude: 0, latitude: 0 },
  { longitude: 0, latitude: 0.5 },
  { longitude: 0, latitude: 1 },
];

describe('polylineLengthMeters', () => {
  it('returns 0 for empty or single-point polylines', () => {
    expect(polylineLengthMeters([])).toBe(0);
    expect(polylineLengthMeters([{ longitude: 0, latitude: 0 }])).toBe(0);
  });

  it('sums segment great-circle distances along a meridian', () => {
    const total = polylineLengthMeters(MERIDIAN);
    expect(total).toBeCloseTo(haversineDistanceMeters(MERIDIAN[0], MERIDIAN[2]), 6);
  });
});

describe('distanceAlongPolylineMeters', () => {
  it('is 0 at the start and the full length at the end', () => {
    const total = polylineLengthMeters(MERIDIAN);
    expect(distanceAlongPolylineMeters(MERIDIAN[0], MERIDIAN)).toBe(0);
    expect(distanceAlongPolylineMeters(MERIDIAN[2], MERIDIAN)).toBeCloseTo(total, 6);
  });

  it('is the length of the prefix for a point on the middle vertex', () => {
    const prefix = haversineDistanceMeters(MERIDIAN[0], MERIDIAN[1]);
    expect(distanceAlongPolylineMeters(MERIDIAN[1], MERIDIAN)).toBeCloseTo(prefix, 6);
  });

  it('is about half the route for a point at the midpoint of the route', () => {
    const midpoint = { longitude: 0, latitude: 0.5 };
    const along = distanceAlongPolylineMeters(midpoint, MERIDIAN);
    const total = polylineLengthMeters(MERIDIAN);
    expect(along).toBeCloseTo(total / 2, 6);
  });
});
