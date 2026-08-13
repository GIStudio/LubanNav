import { describe, expect, it } from 'vitest';
import { MODES, PUBLIC_LOCATIONS } from '../data/campus.js';
import { findRoute } from './pathfinding.js';

describe('findRoute', () => {
  it('finds an A* route with expected endpoints and summary', () => {
    const route = findRoute('main-entrance', 'library');
    expect(route.status).toBe('ok');
    expect(route.path[0].id).toBe('main-entrance');
    expect(route.path.at(-1).id).toBe('library');
    expect(route.path[0]).toMatchObject({
      kind: 'entrance',
      entranceSource: 'osm-entrance',
    });
    expect(route.path.some((point) => point.kind === 'road')).toBe(true);
    expect(route.path.at(-1).entranceSource).toBe('inferred-building-boundary');
    expect(route.summary.distanceMeters).toBeGreaterThan(0);
    expect(route.summary.roadDistanceMeters).toBeGreaterThan(0);
    expect(route.routing.engine).toBe('osm-highway-a-star');
    expect(route.routing.allowedHighways).toEqual([
      'footway',
      'path',
      'pedestrian',
      'service',
    ]);
    expect(route.instructions.at(-1)).toContain('图书馆');
  });

  it('uses the selected mobility profile', () => {
    const pedestrian = findRoute('dorm-5', 'sports-hall', 'pedestrian');
    const robot = findRoute('dorm-5', 'sports-hall', 'robot');
    expect(robot.request.mode).toBe('robot');
    expect(robot.summary.durationSeconds).toBeGreaterThan(pedestrian.summary.durationSeconds);
  });

  it('keeps every public location connected for every mode', () => {
    for (const mode of Object.keys(MODES)) {
      for (const from of PUBLIC_LOCATIONS) {
        for (const to of PUBLIC_LOCATIONS) {
          expect(findRoute(from.id, to.id, mode).status).toBe('ok');
        }
      }
    }
  });

  it('rejects unknown public endpoints', () => {
    expect(() => findRoute('unknown', 'library')).toThrow('Unknown public origin');
  });
});
