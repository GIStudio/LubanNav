#!/usr/bin/env node
/**
 * Import the indoor floor networks from the local navigation graph
 * (GISprojects/global_nav_0408.geojson) into the LubanNav indoor patch.
 *
 * Covers: lecture hall core F2/F3 (演讲厅 A/B/C, 中央花园, 逸林茶餐厅),
 * W building F2/F3 (光塔亚洲餐厅, 学术科研区), E building F2/F3
 * (森绿餐吧, CMA创意区) and library F2.
 *
 * All coordinates are GCJ-02 -> WGS84 converted (standard inverse transform).
 * Connections:
 *   - floor-to-floor elevators -> indoorVerticalConnector,
 *   - stairs -> vertical links (pedestrian only),
 *   - gates -> horizontal links,
 *   - outdoor-to-building stairs/gates/elevators -> bridge node with
 *     outdoorLocationId anchored at the nearest location road node
 *     (read from src/data/osm-routing.json, so run import:global-nav first),
 *   - F3 corridor bridges into the existing 3F platform network.
 *
 * Per school policy indoor corridors are robot-walkable
 * (modes pedestrian+robot, robotValidated true); stairs remain pedestrian.
 *
 * Output: public/data/campus-local-nav-indoor.geojson, merged by
 * generate-osm-routing.mjs before the indoor network is built.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gcjToWgs84 } from './lib/gcj-wgs84.mjs';

const INPUT = resolve('GISprojects/global_nav_0408.geojson');
const OUTPUT = resolve('public/data/campus-local-nav-indoor.geojson');
const INDOOR_SOURCE = resolve('public/data/campus-indoor.geojson');
const ROUTING_SOURCE = resolve('src/data/osm-routing.json');

const MAPS = {
  building_core_f2: { networkId: 'global-nav-core-f2', level: '2', outdoor: false },
  building_core_f3: { networkId: 'global-nav-core-f3', level: '3', outdoor: true },
  building_w_f2: { networkId: 'global-nav-w-f2', level: '2', outdoor: false },
  building_w_f3: { networkId: 'global-nav-w-f3', level: '3', outdoor: false },
  building_e_f2: { networkId: 'global-nav-e-f2', level: '2', outdoor: false },
  building_e_f3: { networkId: 'global-nav-e-f3', level: '3', outdoor: false },
  library_f2: { networkId: 'global-nav-library-f2', level: '2', outdoor: false },
};

const POI_LOCATIONS = {
  poi_building_core_f2_1775648255079: { locationId: 'lecture-hall-a', kind: 'lecture-hall' },
  poi_building_core_f2_1775648265103: { locationId: 'lecture-hall-c', kind: 'lecture-hall' },
  poi_building_core_f2_1775648280376: { locationId: 'lecture-hall-b', kind: 'lecture-hall' },
  poi_building_core_f3_1775650535767: { locationId: 'central-garden', kind: 'garden' },
  poi_building_core_f2_1775648294351: { kind: 'restaurant' },
  poi_building_w_f2_1775648343294: { locationId: 'light-tower-restaurant', kind: 'restaurant' },
  poi_building_w_f2_1775650919567: { locationId: 'academic-research-area', kind: 'academic' },
  poi_building_e_f2_1775579562554: { locationId: 'senlv-cafe', kind: 'restaurant' },
  poi_building_e_f3_1775649869901: { locationId: 'cma-creative-area', kind: 'creative-area' },
};

const CORRIDOR_MODES = ['pedestrian', 'robot'];
const STAIR_MODES = ['pedestrian'];

const g = JSON.parse(await readFile(INPUT, 'utf8'));
const indoor = JSON.parse(await readFile(INDOOR_SOURCE, 'utf8'));
const routing = JSON.parse(await readFile(ROUTING_SOURCE, 'utf8'));

const features = [];
const edgeId = (kind, id) => `local/global-nav-indoor/${kind}/${id}`;
const shortNodeId = (id) => id.replace(/^node_/, '');
const UNVERIFIED = 'from-navigation-graph-unverified';

const points = g.features.filter((f) => f.geometry.type === 'Point');
const lines = g.features.filter((f) => f.geometry.type === 'LineString');
const pointById = new Map(points.map((f) => [f.properties.id, f]));
const slugOf = (id) => pointById.get(id)?.properties.map_slug;
const posOf = (id) => {
  const [lng, lat] = pointById.get(id).geometry.coordinates;
  return gcjToWgs84(lng, lat);
};

const meters = (a, b) => {
  const dx = (a[0] - b[0]) * 111320 * Math.cos((22.89 * Math.PI) / 180);
  const dy = (a[1] - b[1]) * 110540;
  return Math.hypot(dx, dy);
};

// 地点锚点: 当前绑定 roadNode 坐标（用于楼梯/闸口/电梯的室外桥接）
const graphNodes = new Map(routing.graph.nodes.map((n) => [n.id, [n.longitude, n.latitude]]));
const locationAnchors = [];
for (const [locationId, binding] of Object.entries(routing.locations)) {
  const roadNode = binding.roadNodeId;
  const pos = roadNode && graphNodes.get(roadNode);
  if (pos) locationAnchors.push({ locationId, roadNode, pos });
}
function nearestAnchor(coordinate) {
  let best = null;
  let bestDistance = Infinity;
  for (const anchor of locationAnchors) {
    const d = meters(coordinate, anchor.pos);
    if (d < bestDistance) {
      bestDistance = d;
      best = anchor;
    }
  }
  if (!best || bestDistance > 60) {
    throw new Error(`室外端点 ${coordinate} 无 60m 内地点锚点（最近 ${best ? bestDistance.toFixed(0) : '无'}m）`);
  }
  return { ...best, distance: bestDistance };
}

const nodeIds = new Set();

// ---- 1) 节点
for (const [slug, meta] of Object.entries(MAPS)) {
  for (const point of points) {
    if (point.properties.map_slug !== slug) continue;
    const id = point.properties.id;
    const short = shortNodeId(id);
    nodeIds.add(short);
    const poi = POI_LOCATIONS[id];
    const [longitude, latitude] = gcjToWgs84(...point.geometry.coordinates);
    features.push({
      type: 'Feature',
      id: edgeId('node', id),
      properties: {
        featureClass: 'indoorNetworkNode',
        networkId: meta.networkId,
        nodeId: short,
        name: point.properties.name ?? null,
        kind: poi?.kind ?? 'indoor-waypoint',
        level: meta.level,
        outdoor: meta.outdoor === true,
        modes: CORRIDOR_MODES,
        robotValidated: true,
        locationId: poi?.locationId ?? null,
        source: 'global-nav-0408-gcj2wgs84',
        verificationStatus: UNVERIFIED,
      },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    });
  }
}

// ---- 2) 楼层内 walk 边 -> 走廊 link
for (const line of lines) {
  const p = line.properties;
  if (p.edge_type !== 'walk') continue;
  const su = slugOf(p.u);
  const sv = slugOf(p.v);
  if (!su || !sv || su !== sv || !MAPS[su]) continue;
  const meta = MAPS[su];
  features.push({
    type: 'Feature',
    id: edgeId('link', p.id),
    properties: {
      featureClass: 'indoorNetworkLink',
      networkId: meta.networkId,
      fromNodeId: shortNodeId(p.u),
      toNodeId: shortNodeId(p.v),
      level: meta.level,
      highway: 'corridor',
      vertical: false,
      outdoor: meta.outdoor === true,
      modes: CORRIDOR_MODES,
      robotValidated: true,
      source: 'global-nav-0408-gcj2wgs84',
      verificationStatus: UNVERIFIED,
    },
    geometry: {
      type: 'LineString',
      coordinates: line.geometry.coordinates.map(([lng, lat]) => gcjToWgs84(lng, lat)),
    },
  });
}

// ---- 3) 跨地图/跨层边
const bridgeByOutdoorNode = new Map();
let bridgeIndex = 0;
let elevatorIndex = 0;

function bridgeNodeFor(outdoorId) {
  if (bridgeByOutdoorNode.has(outdoorId)) return bridgeByOutdoorNode.get(outdoorId);
  bridgeIndex += 1;
  const [blng, blat] = posOf(outdoorId);
  const anchor = nearestAnchor([blng, blat]);
  const bridgeId = `global-nav-bridge-${bridgeIndex}`;
  features.push({
    type: 'Feature',
    id: edgeId('node', `bridge-${bridgeIndex}`),
    properties: {
      featureClass: 'indoorNetworkNode',
      networkId: 'global-nav-bridges',
      nodeId: bridgeId,
      name: `室内桥接出口 ${bridgeIndex}（${anchor.locationId}）`,
      kind: 'stairs',
      level: '1',
      outdoor: true,
      modes: CORRIDOR_MODES,
      robotValidated: true,
      outdoorLocationId: anchor.locationId,
      source: 'global-nav-0408-gcj2wgs84',
      verificationStatus: UNVERIFIED,
    },
    geometry: { type: 'Point', coordinates: [blng, blat] },
  });
  console.log(`桥接 ${bridgeId} @(${blng.toFixed(5)},${blat.toFixed(5)}) -> ${anchor.locationId} (${anchor.distance.toFixed(1)} m)`);
  bridgeByOutdoorNode.set(outdoorId, bridgeId);
  return bridgeId;
}

for (const line of lines) {
  const p = line.properties;
  const type = p.edge_type;
  if (!['gate', 'stairs', 'elevator_vertical'].includes(type)) continue;
  const su = slugOf(p.u);
  const sv = slugOf(p.v);
  if (!su || !sv) continue;
  if (!MAPS[su] && !MAPS[sv]) continue; // outdoor<->outdoor 跳过
  const outdoorSide = su === 'campus_outdoor' ? p.u : sv === 'campus_outdoor' ? p.v : null;
  const aSide = MAPS[su] ? p.u : p.v; // 室内侧
  const bSide = MAPS[sv] ? p.v : p.u;
  const meta = MAPS[slugOf(aSide)] ?? MAPS[slugOf(bSide)];
  const level = meta?.level ?? '1';
  const fromId = outdoorSide === aSide ? bridgeNodeFor(aSide) : shortNodeId(aSide);
  const toId = outdoorSide === bSide ? bridgeNodeFor(bSide) : shortNodeId(bSide);
  const isStair = type === 'stairs';
  const isElevator = type === 'elevator_vertical';

  if (isElevator && !outdoorSide) {
    // 楼内电梯 f2<->f3 -> 垂直连接器 + 井道到各层走廊的连接
    elevatorIndex += 1;
    const connectorNodeId = `global-nav-el-${elevatorIndex}`;
    const elPos = [
      (posOf(aSide)[0] + posOf(bSide)[0]) / 2,
      (posOf(aSide)[1] + posOf(bSide)[1]) / 2,
    ];
    features.push({
      type: 'Feature',
      id: edgeId('connector', p.id),
      properties: {
        featureClass: 'indoorVerticalConnector',
        networkId: 'global-nav-cross',
        nodeId: connectorNodeId,
        name: '楼内电梯',
        levels: ['2', '3'],
        defaultLevel: '2',
        modes: CORRIDOR_MODES,
        robotValidated: true,
        source: 'global-nav-0408-gcj2wgs84',
        verificationStatus: UNVERIFIED,
      },
      geometry: { type: 'Point', coordinates: elPos },
    });
    for (const [level, endpoint] of [
      ['2', shortNodeId(aSide)],
      ['3', shortNodeId(bSide)],
    ]) {
      features.push({
        type: 'Feature',
        id: edgeId('link', `${p.id}-el-${level}f`),
        properties: {
          featureClass: 'indoorNetworkLink',
          networkId: 'global-nav-cross',
          fromNodeId: `${connectorNodeId}-${level}f`,
          toNodeId: endpoint,
          level,
          highway: 'corridor',
          vertical: false,
          outdoor: false,
          distanceMeters: Number(Math.max(meters(elPos, posOf(level === '2' ? aSide : bSide)), 1.0).toFixed(3)),
          modes: CORRIDOR_MODES,
          robotValidated: true,
          source: 'global-nav-0408-gcj2wgs84',
          verificationStatus: UNVERIFIED,
        },
        geometry: {
          type: 'LineString',
          coordinates: [elPos, posOf(level === '2' ? aSide : bSide)],
        },
      });
    }
    continue;
  }
  const linkLength = Math.max(meters(posOf(aSide), posOf(bSide)), 1.0);
  features.push({
    type: 'Feature',
    id: edgeId('link', p.id),
    properties: {
      featureClass: 'indoorNetworkLink',
      networkId: 'global-nav-cross',
      fromNodeId: fromId,
      toNodeId: toId,
      level,
      highway: isElevator ? 'elevator' : 'corridor',
      vertical: isStair || isElevator,
      outdoor: false,
      distanceMeters: Number(linkLength.toFixed(3)),
      modes: isStair ? STAIR_MODES : CORRIDOR_MODES,
      robotValidated: !isStair,
      source: 'global-nav-0408-gcj2wgs84',
      verificationStatus: UNVERIFIED,
    },
    geometry: { type: 'LineString', coordinates: [posOf(aSide), posOf(bSide)] },
  });
}

// ---- 4) POI 锚点连接到最近走廊节点
for (const [slug, meta] of Object.entries(MAPS)) {
  const corridorIds = [...nodeIds].filter((id) => id.startsWith(slug + '_') && !id.startsWith('poi_'));
  for (const point of points) {
    if (point.properties.map_slug !== slug) continue;
    const id = point.properties.id;
    if (!POI_LOCATIONS[id]) continue;
    const short = shortNodeId(id);
    const pc = gcjToWgs84(...point.geometry.coordinates);
    let nearest = null;
    let best = Infinity;
    for (const cid of corridorIds) {
      const d = meters(pc, posOf(`node_${cid}`));
      if (d < best) { best = d; nearest = cid; }
    }
    if (!nearest) throw new Error(`POI ${id} 无走廊邻居`);
    features.push({
      type: 'Feature',
      id: edgeId('link', `poi-${short}-to-corridor`),
      properties: {
        featureClass: 'indoorNetworkLink',
        networkId: meta.networkId,
        fromNodeId: short,
        toNodeId: nearest,
        level: meta.level,
        highway: 'corridor',
        vertical: false,
        outdoor: meta.outdoor === true,
        modes: CORRIDOR_MODES,
        robotValidated: true,
        source: 'global-nav-0408-gcj2wgs84',
        verificationStatus: UNVERIFIED,
      },
      geometry: { type: 'LineString', coordinates: [pc, posOf(`node_${nearest}`)] },
    });
  }
}

// ---- 5) F3 走廊并入现有 3F 平台网络
const platformNodes = ['platform-west-3f', 'platform-main-3f', 'platform-east-3f'];
const platformPos = new Map(
  indoor.features
    .filter((f) => f.properties.featureClass === 'indoorNetworkNode' && platformNodes.includes(f.properties.nodeId))
    .map((f) => [f.properties.nodeId, f.geometry.coordinates]),
);
const coreF3Ids = [...nodeIds].filter((id) => id.startsWith('building_core_f3_'));
for (const platformNodeId of platformNodes) {
  const pc = platformPos.get(platformNodeId);
  if (!pc) throw new Error(`platform node ${platformNodeId} not found in indoor patch`);
  let nearest = null;
  let best = Infinity;
  for (const id of coreF3Ids) {
    const d = meters(pc, posOf(`node_${id}`));
    if (d < best) { best = d; nearest = id; }
  }
  features.push({
    type: 'Feature',
    id: edgeId('link', `platform-${platformNodeId}-to-core-f3`),
    properties: {
      featureClass: 'indoorNetworkLink',
      networkId: 'global-nav-core-f3',
      fromNodeId: platformNodeId,
      toNodeId: nearest,
      level: '3',
      highway: 'corridor',
      vertical: false,
      outdoor: true,
      modes: CORRIDOR_MODES,
      robotValidated: true,
      source: 'global-nav-0408-gcj2wgs84',
      verificationStatus: UNVERIFIED,
    },
    geometry: { type: 'LineString', coordinates: [pc, posOf(`node_${nearest}`)] },
  });
}

const output = {
  type: 'FeatureCollection',
  schemaVersion: '1.1',
  name: 'HKUST(GZ) local navigation graph indoor supplement (core/W/E/library floors)',
  source: {
    file: 'GISprojects/global_nav_0408.geojson',
    coordinateSystem: 'GCJ-02',
    transform: 'GCJ-02 -> WGS84 (standard inverse transform)',
    convertedAt: new Date().toISOString(),
    disclaimer:
      'Indoor corridors imported from a pre-built navigation graph; positions converted from GCJ-02 and not field-surveyed. Corridors are robot-walkable per school policy (robotValidated=true, field verification still recommended); stairs are pedestrian-only.',
  },
  features,
};

await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
const counts = {};
for (const f of features) counts[f.properties.featureClass] = (counts[f.properties.featureClass] ?? 0) + 1;
console.log(`室内补丁写入: ${JSON.stringify(counts)} (共 ${features.length} 要素)`);
