#!/usr/bin/env node
/**
 * Import the local navigation graph (GISprojects/global_nav_0408.geojson)
 * into the LubanNav routing pipeline as a road supplement.
 *
 * The source file is a pre-built pedestrian navigation graph in GCJ-02
 * ("Mars" coordinates, e.g. drawn against Amap/Tencent basemaps). All
 * coordinates are converted to WGS84 with the standard GCJ-02 -> WGS84
 * inverse transform before use.
 *
 * Conversion rules:
 *   - edge_type walk / gate  -> featureClass=road, highway=footway (pedestrian+robot)
 *   - edge_type stairs       -> featureClass=road, highway=footway, wheelchair=no
 *                               (pedestrian only; robot blocked)
 *   - edge_type elevator_*   -> skipped (vertical connectors are a separate,
 *                               indoor-layer task)
 *   - nodes within SNAP_METERS of an OSM road vertex reuse that OSM node id,
 *     so the two networks merge into one connected graph.
 *   - indoor floor maps (building core / W / E / library floors) skipped for now.
 *
 * Output: public/data/campus-local-nav.geojson (road features only), which
 * generate-osm-routing.mjs merges before building the road graph.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const INPUT = resolve('GISprojects/global_nav_0408.geojson');
const OUTPUT = resolve('public/data/campus-local-nav.geojson');
const OSM_SOURCE = resolve('public/data/campus-osm.geojson');
const SNAP_METERS = 3.0;
const CAMPUS_LAT = 22.89; // for meter conversion only

const M_PER_DEG_LON = 111320 * Math.cos((CAMPUS_LAT * Math.PI) / 180);
const M_PER_DEG_LAT = 110540;

import { gcjToWgs84 } from './lib/gcj-wgs84.mjs';

function meters(a, b) {
  const dx = (a[0] - b[0]) * M_PER_DEG_LON;
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

// -------------------------------------------------------------------- main

const [globalNav, osm] = await Promise.all([
  readFile(INPUT, 'utf8').then(JSON.parse),
  readFile(OSM_SOURCE, 'utf8').then(JSON.parse),
]);

// OSM road vertices -> osmNodeId lookup
const osmVertices = [];
for (const feature of osm.features) {
  if (feature.properties.featureClass !== 'road' || feature.geometry.type !== 'LineString') continue;
  const ids = feature.properties.osmNodeIds ?? [];
  feature.geometry.coordinates.forEach((coordinate, index) => {
    osmVertices.push({ coordinate, osmNodeId: ids[index] ?? null });
  });
}

// OSM 建筑多边形（用于剔除穿楼的 local-nav 边）
const buildingRings = [];
for (const feature of osm.features) {
  if (
    feature.properties.featureClass === 'building' &&
    feature.geometry.type === 'Polygon'
  ) {
    buildingRings.push(feature.geometry.coordinates[0]);
  }
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function crossesBuilding(coordinates) {
  const n = coordinates.length;
  if (n < 2) return false;
  const midpoint = [
    (coordinates[0][0] + coordinates[n - 1][0]) / 2,
    (coordinates[0][1] + coordinates[n - 1][1]) / 2,
  ];
  return buildingRings.some((ring) => {
    const endpointsInside =
      pointInRing(coordinates[0], ring) && pointInRing(coordinates[n - 1], ring);
    return endpointsInside || pointInRing(midpoint, ring);
  });
}

const snappedTo = new Map(); // local node id -> osm-node/{id}
const edges = globalNav.features.filter((f) => f.geometry.type === 'LineString');
const nodeMapSlug = new Map(
  globalNav.features
    .filter((f) => f.geometry.type === 'Point')
    .map((f) => [f.properties.id, f.properties.map_slug]),
);
const stats = { total: edges.length, walk: 0, gate: 0, stairs: 0, elevator: 0, other: 0, indoorSkipped: 0, buildingCrossingSkipped: 0, snapped: 0 };
const roads = [];

for (const edge of edges) {
  const p = edge.properties;
  const type = p.edge_type;
  if (type === 'elevator_vertical' || type === 'elevator_slanted') {
    stats.elevator += 1;
    continue;
  }
  if (type !== 'walk' && type !== 'gate' && type !== 'stairs') {
    stats.other += 1;
    continue;
  }
  // 只导入室外步行网络；室内楼层走廊与跨层边（gate/stairs 连接楼内）留待室内层任务
  if (
    nodeMapSlug.get(p.u) !== 'campus_outdoor' ||
    nodeMapSlug.get(p.v) !== 'campus_outdoor'
  ) {
    stats.indoorSkipped += 1;
    continue;
  }
  stats[type] += 1;

  const coordinates = edge.geometry.coordinates.map(([lng, lat]) => gcjToWgs84(lng, lat));
  if (crossesBuilding(coordinates)) {
    stats.buildingCrossingSkipped += 1;
    continue;
  }

  const resolveNodeId = (nodeId, coordinate) => {
    if (snappedTo.has(nodeId)) return snappedTo.get(nodeId);
    let best = null;
    let bestDistance = SNAP_METERS;
    for (const vertex of osmVertices) {
      if (vertex.osmNodeId === null) continue;
      const d = meters(coordinate, vertex.coordinate);
      if (d < bestDistance) {
        bestDistance = d;
        best = vertex.osmNodeId; // raw id; builder wraps it as osm-node/{id}
      }
    }
    const resolved = best ?? `local-nav/${nodeId}`;
    snappedTo.set(nodeId, resolved);
    if (best) stats.snapped += 1;
    return resolved;
  };

  const from = resolveNodeId(p.u, coordinates[0]);
  const to = resolveNodeId(p.v, coordinates[coordinates.length - 1]);

  roads.push({
    type: 'Feature',
    id: `local/global-nav/${p.id ?? edge.id}`,
    properties: {
      featureClass: 'road',
      highway: 'footway',
      osmId: `local/global-nav/${p.id ?? edge.id}`,
      osmNodeIds: [from, to],
      localEdgeId: p.id ?? null,
      localEdgeType: type,
      localStair: type === 'stairs' ? true : undefined,
      wheelchair: type === 'stairs' ? 'no' : undefined,
      source: 'global-nav-0408-gcj2wgs84',
      verificationStatus: 'from-navigation-graph-unverified',
    },
    geometry: { type: 'LineString', coordinates },
  });
}

const output = {
  type: 'FeatureCollection',
  schemaVersion: '1.0',
  name: 'HKUST(GZ) local navigation graph (road supplement)',
  source: {
    file: 'GISprojects/global_nav_0408.geojson',
    coordinateSystem: 'GCJ-02',
    transform: 'GCJ-02 -> WGS84 (standard inverse transform)',
    convertedAt: new Date().toISOString(),
    disclaimer:
      'Network imported from a pre-built navigation graph; positions verified against Esri imagery pavement statistics but not field-surveyed. All features routingEnabled=false until review.',
  },
  stats,
  features: roads,
};

await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Imported ${roads.length} road features (walk=${stats.walk}, gate=${stats.gate}, stairs=${stats.stairs}); ` +
    `skipped elevators=${stats.elevator}, other=${stats.other}; nodes snapped to OSM=${stats.snapped}.`,
);
