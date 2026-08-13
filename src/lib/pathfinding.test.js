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
    expect(route.path.at(-1)).toMatchObject({
      kind: 'indoor-destination',
      indoor: true,
      level: '0',
      levelAssumed: true,
      entranceSource: 'inferred-building-boundary',
    });
    expect(route.summary.distanceMeters).toBeGreaterThan(0);
    expect(route.summary.roadDistanceMeters).toBeGreaterThan(0);
    expect(route.summary.indoorDistanceMeters).toBeGreaterThan(40);
    expect(route.routing.engine).toBe('layered-osm-indoor-a-star');
    expect(route.routing.allowedHighways).toEqual([
      'footway',
      'path',
      'pedestrian',
      'service',
    ]);
    expect(route.routing.indoorFeatureIds).toEqual([
      'local/library-level-0-main-corridor',
    ]);
    expect(route.instructions.some((instruction) => instruction.includes('室内通道'))).toBe(true);
    expect(route.instructions.at(-1)).toContain('图书馆');
  });

  it('keeps an unverified indoor segment out of the robot search space', () => {
    const pedestrian = findRoute('main-entrance', 'library', 'pedestrian');
    const robot = findRoute('main-entrance', 'library', 'robot');
    expect(pedestrian.path.at(-1).kind).toBe('indoor-destination');
    expect(pedestrian.summary.indoorDistanceMeters).toBeGreaterThan(0);
    expect(robot.path.at(-1).kind).toBe('entrance');
    expect(robot.summary.indoorDistanceMeters).toBe(0);
    expect(robot.routing.destination.indoorAccess).toBe(false);
  });

  it('routes to the two lobby entrance POIs without changing stable IDs', () => {
    const west = findRoute('main-entrance', 'west-concourse');
    const east = findRoute('main-entrance', 'east-concourse');
    expect(west.path.at(-1)).toMatchObject({
      id: 'west-concourse',
      name: '西翼大堂',
      longitude: 113.47664,
      latitude: 22.89094,
      entranceSource: 'local-entrance-poi',
    });
    expect(east.path.at(-1)).toMatchObject({
      id: 'east-concourse',
      name: '东翼大堂',
      longitude: 113.47762,
      latitude: 22.8904414,
      entranceSource: 'local-entrance-poi',
    });
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
