import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_LOCATIONS } from './campus.js';

const routing = JSON.parse(
  readFileSync(new URL('./osm-routing.json', import.meta.url), 'utf8'),
);
const osmData = JSON.parse(
  readFileSync(new URL('../../public/data/campus-osm.geojson', import.meta.url), 'utf8'),
);
const indoorData = JSON.parse(
  readFileSync(new URL('../../public/data/campus-indoor.geojson', import.meta.url), 'utf8'),
);

describe('generated OSM routing graph', () => {
  it('uses only the requested highway classes', () => {
    expect(routing.allowedHighways).toEqual(['footway', 'path', 'pedestrian', 'service']);
    expect(routing.indoorHighways).toEqual(['corridor', 'elevator']);
    expect(
      new Set(
        routing.graph.edges
          .filter((edge) => edge.segmentType === 'osm-road')
          .map((edge) => edge.highway),
      ),
    ).toEqual(
      new Set(['footway', 'path', 'pedestrian', 'service']),
    );
  });

  it('has a useful shared pedestrian and robot component', () => {
    expect(routing.stats.sourceRoadWays).toBeGreaterThanOrEqual(40);
    expect(routing.stats.sharedRoutableComponentNodes).toBeGreaterThanOrEqual(200);
    expect(routing.graph.routableNodeIds).toHaveLength(
      routing.stats.sharedRoutableComponentNodes,
    );
  });

  it('creates valid edges and excludes roads that deny pedestrian access', () => {
    const nodeIds = new Set(routing.graph.nodes.map((node) => node.id));
    for (const edge of routing.graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(edge.distanceMeters).toBeGreaterThan(0);
    }

    const blockedWayIds = new Set(
      osmData.features
        .filter(
          (feature) =>
            feature.properties.featureClass === 'road' &&
            ['no', 'private'].includes(feature.properties.access) &&
            !['yes', 'designated', 'permissive'].includes(feature.properties.foot),
        )
        .map((feature) => feature.properties.osmId),
    );
    expect(routing.graph.edges.some((edge) => blockedWayIds.has(edge.osmWayId))).toBe(false);
  });

  it('binds every public location to an entrance and road node', () => {
    expect(Object.keys(routing.locations)).toHaveLength(PUBLIC_LOCATIONS.length);
    for (const location of PUBLIC_LOCATIONS) {
      const binding = routing.locations[location.id];
      expect(binding.roadNodeId).toMatch(/^osm-node\//);
      expect(binding.entrance.source).toMatch(
        /^(osm-entrance|inferred-building-boundary|local-entrance-poi|location-coordinate)$/,
      );
      expect(binding.snapDistanceMeters).toBeGreaterThanOrEqual(0);
      expect(binding.snapDistanceMeters).toBeLessThan(160);
    }
  });

  it('records both tagged and inferred entrance provenance', () => {
    expect(routing.stats.taggedLocationEntrances).toBeGreaterThanOrEqual(1);
    expect(routing.stats.inferredBuildingEntrances).toBeGreaterThanOrEqual(15);
  });

  it('binds the wing and W2/E2 lobby POIs as local entrances', () => {
    const entrancePois = indoorData.features.filter(
      (feature) => feature.properties.featureClass === 'entrancePoi',
    );
    expect(entrancePois).toHaveLength(4);
    expect(routing.stats.localEntrancePois).toBe(4);
    expect(routing.stats.coordinateAnchors).toBe(2);

    expect(routing.locations['west-concourse'].entrance).toMatchObject({
      longitude: 113.47664,
      latitude: 22.89094,
      source: 'local-entrance-poi',
      osmFeatureId: 'way/1096048403',
      verificationStatus: 'user-confirmed',
      buildingBoundaryDistanceMeters: 2.9,
    });
    expect(routing.locations['east-concourse'].entrance).toMatchObject({
      longitude: 113.47762,
      latitude: 22.8904414,
      source: 'local-entrance-poi',
      osmFeatureId: 'way/1098450389',
      inferredFrom: 'local/west-lobby-entrance-poi',
      verificationStatus: 'approximate-unverified',
      buildingBoundaryDistanceMeters: 2.8,
    });
    expect(routing.locations.w2.entrance).toMatchObject({
      longitude: 113.47693,
      latitude: 22.89156,
      source: 'local-entrance-poi',
      osmFeatureId: 'way/1096048404',
      verificationStatus: 'approximate-user-supplied',
      buildingBoundaryDistanceMeters: 4.73,
    });
    expect(routing.locations.e2.entrance).toMatchObject({
      longitude: 113.47796,
      latitude: 22.8909,
      source: 'local-entrance-poi',
      osmFeatureId: 'way/1096049211',
      verificationStatus: 'approximate-user-supplied',
      buildingBoundaryDistanceMeters: 3.61,
    });
  });

  it('adds the local library indoor corridor to pedestrian routing only', () => {
    expect(
      indoorData.features.filter(
        (feature) => feature.properties.featureClass === 'indoorPath',
      ),
    ).toHaveLength(1);
    const library = routing.locations.library;
    expect(library.destination).toMatchObject({
      indoor: true,
      level: '0',
      levelAssumed: true,
      verificationStatus: 'approximate-unverified',
    });
    expect(library.indoorRoute).toMatchObject({
      highway: 'corridor',
      modes: ['pedestrian'],
      evidence: 'user-confirmed-walkable',
    });
    expect(library.modeNodeIds.pedestrian).toMatch(/^indoor\/library\//);
    expect(library.modeNodeIds.robot).toBe(library.accessNodeId);

    const indoorEdges = routing.graph.edges.filter(
      (edge) => edge.indoorFeatureId === 'local/library-level-0-main-corridor',
    );
    expect(indoorEdges).toHaveLength(4);
    expect(indoorEdges.every((edge) => edge.modes.includes('pedestrian'))).toBe(true);
    expect(indoorEdges.some((edge) => edge.modes.includes('robot'))).toBe(false);
  });

  it('adds W2/E2 elevators, all five stops, and the shared 3F platform network', () => {
    expect(routing.stats.indoorNetworks).toBe(1);
    expect(routing.stats.indoorNetworkNodes).toBe(19);
    expect(routing.stats.indoorNetworkEdges).toBe(21);
    expect(routing.stats.verticalConnectorEdges).toBe(9);

    for (const locationId of ['w2-elevator', 'e2-elevator']) {
      const binding = routing.locations[locationId];
      expect(binding.destination).toMatchObject({
        kind: 'elevator',
        indoor: true,
        level: '1',
        servedLevels: ['1', '2', '3', '4', '5'],
        verificationStatus: 'approximate-user-supplied',
      });
      expect(binding.modeNodeIds.pedestrian).toMatch(/elevator-1f$/);
      expect(binding.modeNodeIds.robot).toBe(binding.roadNodeId);
    }

    expect(routing.locations['third-floor-platform'].destination).toMatchObject({
      name: '三楼中央',
      kind: 'platform',
      indoor: true,
      level: '3',
    });
    expect(routing.locations['platform-restaurant'].destination).toMatchObject({
      name: '3楼平台餐厅',
      kind: 'restaurant',
      indoor: true,
      level: '3',
    });

    const verticalEdges = routing.graph.edges.filter((edge) => edge.highway === 'elevator');
    expect(verticalEdges).toHaveLength(9);
    expect(verticalEdges.every((edge) => edge.segmentType === 'vertical-connector')).toBe(true);
    expect(verticalEdges.every((edge) => edge.modes.includes('pedestrian'))).toBe(true);
    expect(verticalEdges.some((edge) => edge.modes.includes('robot'))).toBe(false);
  });
});
