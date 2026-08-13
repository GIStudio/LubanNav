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
    expect(routing.indoorHighways).toEqual(['corridor']);
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

  it('binds both lobby POIs as corresponding local entrances', () => {
    const entrancePois = indoorData.features.filter(
      (feature) => feature.properties.featureClass === 'entrancePoi',
    );
    expect(entrancePois).toHaveLength(2);
    expect(routing.stats.localEntrancePois).toBe(2);
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

    const indoorEdges = routing.graph.edges.filter((edge) => edge.indoor === true);
    expect(indoorEdges).toHaveLength(4);
    expect(indoorEdges.every((edge) => edge.modes.includes('pedestrian'))).toBe(true);
    expect(indoorEdges.some((edge) => edge.modes.includes('robot'))).toBe(false);
  });
});
