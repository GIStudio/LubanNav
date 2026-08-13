import { CAMPUS_BOUNDS, DATASET, MODES, NODE_BY_ID } from '../data/campus.js';
import OSM_ROUTING from '../data/osm-routing.json' with { type: 'json' };

const EARTH_RADIUS_METERS = 6_371_008.8;
const ROUTING_NODE_BY_ID = new Map(OSM_ROUTING.graph.nodes.map((node) => [node.id, node]));
const ROUTABLE_NODE_IDS = new Set(OSM_ROUTING.graph.routableNodeIds);

function distanceMeters(a, b) {
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const deltaLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const deltaLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value));
}

function adjacencyFor(modeId) {
  const graph = new Map([...ROUTABLE_NODE_IDS].map((id) => [id, []]));
  for (const edge of OSM_ROUTING.graph.edges) {
    if (!edge.modes.includes(modeId)) continue;
    if (!ROUTABLE_NODE_IDS.has(edge.from) || !ROUTABLE_NODE_IDS.has(edge.to)) continue;
    graph.get(edge.from).push({ ...edge, node: edge.to });
    graph.get(edge.to).push({ ...edge, node: edge.from });
  }
  return graph;
}

const ADJACENCY_BY_MODE = Object.fromEntries(
  Object.keys(MODES).map((modeId) => [modeId, adjacencyFor(modeId)]),
);

function reconstruct(cameFrom, current) {
  const path = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current).node;
    path.unshift(current);
  }
  return path;
}

function findRoadPath(from, to, modeId) {
  if (from === to) return { nodeIds: [from], edges: [] };
  const graph = ADJACENCY_BY_MODE[modeId];
  const destination = ROUTING_NODE_BY_ID.get(to);
  const open = new Set([from]);
  const cameFrom = new Map();
  const gScore = new Map([[from, 0]]);
  const fScore = new Map([
    [from, distanceMeters(ROUTING_NODE_BY_ID.get(from), destination)],
  ]);

  while (open.size) {
    const current = [...open].reduce((best, id) =>
      (fScore.get(id) ?? Number.POSITIVE_INFINITY) <
      (fScore.get(best) ?? Number.POSITIVE_INFINITY)
        ? id
        : best,
    );
    if (current === to) {
      const nodeIds = reconstruct(cameFrom, current);
      return {
        nodeIds,
        edges: nodeIds.slice(1).map((nodeId) => cameFrom.get(nodeId).edge),
      };
    }

    open.delete(current);
    for (const neighbor of graph.get(current) ?? []) {
      const tentative = (gScore.get(current) ?? Number.POSITIVE_INFINITY) + neighbor.distanceMeters;
      if (tentative < (gScore.get(neighbor.node) ?? Number.POSITIVE_INFINITY)) {
        cameFrom.set(neighbor.node, { node: current, edge: neighbor });
        gScore.set(neighbor.node, tentative);
        fScore.set(
          neighbor.node,
          tentative + distanceMeters(ROUTING_NODE_BY_ID.get(neighbor.node), destination),
        );
        open.add(neighbor.node);
      }
    }
  }
  return null;
}

function legacyPosition(longitude, latitude) {
  const [[south, west], [north, east]] = CAMPUS_BOUNDS;
  return {
    x: Number((((longitude - west) / (east - west)) * 1100).toFixed(2)),
    y: Number((((north - latitude) / (north - south)) * 760).toFixed(2)),
  };
}

function endpointPoint(locationId, role) {
  const location = NODE_BY_ID[locationId];
  const binding = OSM_ROUTING.locations[locationId];
  const { longitude, latitude } = binding.entrance;
  return {
    id: locationId,
    name: location.name,
    kind: 'entrance',
    role,
    longitude,
    latitude,
    ...legacyPosition(longitude, latitude),
    entranceSource: binding.entrance.source,
    osmFeatureId: binding.entrance.osmFeatureId,
    osmEntranceId: binding.entrance.osmEntranceId,
  };
}

function roadPoint(nodeId) {
  const node = ROUTING_NODE_BY_ID.get(nodeId);
  return {
    id: nodeId,
    name: 'OSM 道路节点',
    kind: 'road',
    osmNodeId: node.osmNodeId,
    longitude: node.longitude,
    latitude: node.latitude,
    ...legacyPosition(node.longitude, node.latitude),
  };
}

function sameCoordinate(a, b) {
  return Math.abs(a.longitude - b.longitude) < 1e-8 && Math.abs(a.latitude - b.latitude) < 1e-8;
}

function composePath(from, to, roadNodeIds) {
  const points = [endpointPoint(from, 'origin')];
  for (const nodeId of roadNodeIds) {
    const point = roadPoint(nodeId);
    if (!sameCoordinate(points.at(-1), point)) points.push(point);
  }
  const destination = endpointPoint(to, 'destination');
  if (sameCoordinate(points.at(-1), destination)) points.pop();
  points.push(destination);
  return points;
}

function makeInstructions(from, to, distance, edges) {
  if (from === to) return [`已在${NODE_BY_ID[from].name}`];
  const highwayTypes = [...new Set(edges.map((edge) => edge.highway))].join(' / ');
  return [
    `从${NODE_BY_ID[from].name}入口出发`,
    `沿 OSM ${highwayTypes || '校园道路'}前行约 ${distance} 米`,
    `抵达${NODE_BY_ID[to].name}入口`,
  ];
}

function publicBinding(locationId) {
  const binding = OSM_ROUTING.locations[locationId];
  return {
    entrance: binding.entrance,
    roadNodeId: binding.roadNodeId,
    snapDistanceMeters: binding.snapDistanceMeters,
  };
}

export function findRoute(from, to, modeId = 'pedestrian') {
  if (!NODE_BY_ID[from]?.public || !OSM_ROUTING.locations[from]) {
    throw new Error(`Unknown public origin: ${from}`);
  }
  if (!NODE_BY_ID[to]?.public || !OSM_ROUTING.locations[to]) {
    throw new Error(`Unknown public destination: ${to}`);
  }
  const mode = MODES[modeId];
  if (!mode) throw new Error(`Unknown mode: ${modeId}`);

  const fromBinding = OSM_ROUTING.locations[from];
  const toBinding = OSM_ROUTING.locations[to];
  if (from === to) {
    return {
      schemaVersion: '1.1',
      dataset: DATASET.id,
      status: 'ok',
      request: { from, to, mode: modeId },
      summary: { distanceMeters: 0, durationSeconds: 0, distanceEstimated: true },
      path: [endpointPoint(from, 'origin-destination')],
      instructions: makeInstructions(from, to, 0, []),
      routing: {
        engine: 'osm-highway-a-star',
        allowedHighways: OSM_ROUTING.allowedHighways,
        origin: publicBinding(from),
        destination: publicBinding(to),
      },
      disclaimer: DATASET.disclaimer,
    };
  }

  const roadRoute = findRoadPath(fromBinding.roadNodeId, toBinding.roadNodeId, modeId);
  if (!roadRoute) {
    return {
      schemaVersion: '1.1',
      dataset: DATASET.id,
      status: 'no_route',
      request: { from, to, mode: modeId },
      routing: {
        engine: 'osm-highway-a-star',
        allowedHighways: OSM_ROUTING.allowedHighways,
        origin: publicBinding(from),
        destination: publicBinding(to),
      },
      disclaimer: DATASET.disclaimer,
    };
  }

  const roadDistance = roadRoute.edges.reduce((total, edge) => total + edge.distanceMeters, 0);
  const distance = fromBinding.snapDistanceMeters + roadDistance + toBinding.snapDistanceMeters;
  const distanceMetersRounded = Math.round(distance);
  const durationSeconds = Math.ceil(distance / mode.speedMetersPerSecond);

  return {
    schemaVersion: '1.1',
    dataset: DATASET.id,
    status: 'ok',
    request: { from, to, mode: modeId },
    summary: {
      distanceMeters: distanceMetersRounded,
      durationSeconds,
      distanceEstimated: true,
      roadDistanceMeters: Math.round(roadDistance),
      connectorDistanceMeters: Math.round(
        fromBinding.snapDistanceMeters + toBinding.snapDistanceMeters,
      ),
    },
    path: composePath(from, to, roadRoute.nodeIds),
    instructions: makeInstructions(from, to, distanceMetersRounded, roadRoute.edges),
    routing: {
      engine: 'osm-highway-a-star',
      allowedHighways: OSM_ROUTING.allowedHighways,
      osmWayIds: [...new Set(roadRoute.edges.map((edge) => edge.osmWayId))],
      origin: publicBinding(from),
      destination: publicBinding(to),
    },
    disclaimer: DATASET.disclaimer,
  };
}

export function getLocationBinding(locationId) {
  if (!OSM_ROUTING.locations[locationId]) return null;
  return publicBinding(locationId);
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}
