import { describe, expect, it } from 'vitest';
import { MODES, PUBLIC_LOCATIONS } from '../data/campus.js';
import { findRoute, getLocationBinding, getRoutingGraph } from './pathfinding.js';

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

  it('returns a self-contained ordered segment path with coordinates and edge metadata', () => {
    const route = findRoute('dorm-5', 'library', 'pedestrian');
    expect(route.schemaVersion).toBe('1.4');
    expect(route.summary.segmentCount).toBe(route.segments.length);
    expect(route.segments[0]).toMatchObject({
      segmentType: 'location-connector',
      source: 'inferred-building-boundary',
    });
    expect(route.segments.some((segment) => segment.segmentType === 'osm-road')).toBe(true);
    expect(route.segments.some((segment) => segment.segmentType === 'indoor-path')).toBe(true);

    for (const [index, segment] of route.segments.entries()) {
      expect(segment.from).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          longitude: expect.any(Number),
          latitude: expect.any(Number),
        }),
      );
      expect(segment.to).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          longitude: expect.any(Number),
          latitude: expect.any(Number),
        }),
      );
      if (index < route.segments.length - 1) {
        expect(segment.to).toMatchObject(route.segments[index + 1].from);
      }
    }

    const detailedDistance = route.segments.reduce(
      (total, segment) => total + segment.distanceMeters,
      0,
    );
    expect(Math.abs(detailedDistance - route.summary.distanceMeters)).toBeLessThanOrEqual(0.5);
    expect(route.geometry).toEqual({
      type: 'LineString',
      coordinates: route.path.map((point) => [point.longitude, point.latitude]),
    });
  });

  it('densifies the path into navigation waypoints at ≤ 2.5 m spacing for robot dispatch', () => {
    const route = findRoute('dorm-5', 'library', 'robot');
    expect(route.schemaVersion).toBe('1.4');
    expect(route.summary.navigationWaypointCount).toBe(route.navigationWaypoints.length);
    expect(route.navigationWaypoints.length).toBeGreaterThanOrEqual(route.path.length);
    expect(route.navigationWaypoints[0]).toMatchObject({
      sequence: 0,
      nodeId: 'dorm-5',
      interpolated: false,
    });
    expect(route.navigationWaypoints.at(-1)).toMatchObject({
      nodeId: 'library',
      interpolated: false,
    });
    for (const waypoint of route.navigationWaypoints) {
      expect(waypoint.distanceMeters).toBeLessThanOrEqual(2.5 + 1e-6);
      expect(waypoint.longitude).toEqual(expect.any(Number));
      expect(waypoint.latitude).toEqual(expect.any(Number));
    }
    expect(route.summary.maxNavigationSpacingMeters).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(route.navigationWaypoints.some((waypoint) => waypoint.interpolated === true)).toBe(true);
  });

  it('lists nearby points of interest as ordered route highlights with descriptions', () => {
    const route = findRoute('main-entrance', 'library', 'pedestrian');
    expect(Array.isArray(route.highlights)).toBe(true);
    expect(route.highlights.length).toBeGreaterThan(0);
    const ids = new Set();
    for (const highlight of route.highlights) {
      expect(highlight.description).toEqual(expect.any(String));
      expect(highlight.distanceMeters).toBeLessThanOrEqual(80);
      expect(highlight.id).not.toBe('main-entrance');
      expect(highlight.id).not.toBe('library');
      expect(ids.has(highlight.id)).toBe(false);
      ids.add(highlight.id);
    }
    for (let i = 1; i < route.highlights.length; i += 1) {
      expect(route.highlights[i].approachIndex).toBeGreaterThanOrEqual(
        route.highlights[i - 1].approachIndex,
      );
    }
  });

  it('embeds resolved routing nodes and exports a graph that needs no OSM lookup', () => {
    const binding = getLocationBinding('dorm-5');
    expect(binding).toMatchObject({
      roadNodeId: 'osm-node/10775863297',
      roadNode: {
        id: 'osm-node/10775863297',
        osmNodeId: 10775863297,
        longitude: expect.any(Number),
        latitude: expect.any(Number),
      },
      routingByMode: {
        pedestrian: {
          routingNodeId: 'osm-node/10775863297',
          routingNode: {
            longitude: expect.any(Number),
            latitude: expect.any(Number),
          },
          connectorDistanceMeters: 5.12,
        },
      },
    });

    const routingGraph = getRoutingGraph();
    const nodeIds = new Set(routingGraph.graph.nodes.map((node) => node.id));
    expect(routingGraph.schemaVersion).toBe('1.0');
    expect(routingGraph.directed).toBe(false);
    expect(nodeIds.has(binding.roadNodeId)).toBe(true);
    expect(routingGraph.graph.edges.length).toBeGreaterThan(300);
    expect(routingGraph.locations['dorm-5'].routing.roadNode).toEqual(binding.roadNode);
    for (const edge of routingGraph.graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
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

  it('routes between the W2/E2 elevators and the shared 3F platform', () => {
    const west = findRoute('w2-elevator', 'third-floor-platform', 'pedestrian');
    expect(west.status).toBe('ok');
    expect(west.path[0]).toMatchObject({
      id: 'w2-elevator',
      kind: 'elevator',
      level: '1',
      servedLevels: ['1', '2', '3', '4', '5'],
    });
    expect(west.path.at(-1)).toMatchObject({
      id: 'third-floor-platform',
      name: '三楼中央',
      kind: 'platform',
      level: '3',
    });
    expect(west.segments.filter((segment) => segment.highway === 'elevator')).toHaveLength(2);
    expect(west.instructions.some((instruction) => instruction.includes('乘电梯前往 3F'))).toBe(true);

    const east = findRoute('e2-elevator', 'platform-restaurant', 'pedestrian');
    expect(east.status).toBe('ok');
    expect(east.path.at(-1)).toMatchObject({
      id: 'platform-restaurant',
      kind: 'restaurant',
      level: '3',
    });
    expect(east.routing.indoorFeatureIds).toContain(
      'local/central-academic/e2-elevator-to-platform-3f',
    );
  });

  it('routes robots onto the confirmed outdoor 3F platform but not into the restaurant', () => {
    const platform = findRoute('main-entrance', 'third-floor-platform', 'robot');
    expect(platform.status).toBe('ok');
    expect(platform.path.at(-1)).toMatchObject({
      id: 'third-floor-platform',
      kind: 'platform',
      indoor: false,
      outdoor: true,
      level: '3',
      longitude: 113.47755,
      latitude: 22.89147,
    });
    expect(platform.segments.some((segment) => segment.highway === 'elevator')).toBe(true);
    expect(platform.segments.some((segment) => segment.segmentType === 'outdoor-platform')).toBe(true);
    expect(platform.summary.indoorDistanceMeters).toBeGreaterThan(0);
    expect(platform.summary.outdoorPlatformDistanceMeters).toBeGreaterThan(0);
    expect(platform.instructions.some((instruction) => instruction.includes('室外平台'))).toBe(true);

    const restaurant = findRoute('main-entrance', 'platform-restaurant', 'robot');
    expect(restaurant.path.at(-1)).toMatchObject({
      kind: 'entrance',
      longitude: 113.47693,
      latitude: 22.89156,
    });
    expect(restaurant.summary.indoorDistanceMeters).toBe(0);
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
