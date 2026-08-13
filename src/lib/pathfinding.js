import { CAMPUS_BOUNDS, DATASET, MODES, NODE_BY_ID } from '../data/campus.js';
import OSM_ROUTING from '../data/osm-routing.json' with { type: 'json' };

const EARTH_RADIUS_METERS = 6_371_008.8;
const ROUTING_NODE_BY_ID = new Map(OSM_ROUTING.graph.nodes.map((node) => [node.id, node]));

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
  const graph = new Map(OSM_ROUTING.graph.nodes.map((node) => [node.id, []]));
  for (const edge of OSM_ROUTING.graph.edges) {
    if (!edge.modes.includes(modeId)) continue;
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

function selectedDestination(binding, modeId) {
  return binding.indoorRoute?.modes.includes(modeId) ? binding.destination : binding.entrance;
}

function routingNodeId(binding, modeId) {
  return binding.modeNodeIds?.[modeId] ?? binding.roadNodeId;
}

function endpointPoint(locationId, role, modeId) {
  const location = NODE_BY_ID[locationId];
  const binding = OSM_ROUTING.locations[locationId];
  const destination = selectedDestination(binding, modeId);
  const { longitude, latitude } = destination;
  return {
    id: locationId,
    name: location.name,
    kind: destination.indoor ? 'indoor-destination' : 'entrance',
    role,
    longitude,
    latitude,
    ...legacyPosition(longitude, latitude),
    entranceSource: binding.entrance.source,
    osmFeatureId: binding.entrance.osmFeatureId,
    osmEntranceId: binding.entrance.osmEntranceId,
    indoor: destination.indoor === true,
    level: destination.level ?? null,
    levelAssumed: destination.levelAssumed ?? false,
    source: destination.source,
    verificationStatus: destination.verificationStatus ?? null,
  };
}

function roadPoint(nodeId) {
  const node = ROUTING_NODE_BY_ID.get(nodeId);
  return {
    id: nodeId,
    name: node.indoor === true ? '室内路径节点' : node.indoor === 'transition' ? '建筑入口' : 'OSM 道路节点',
    kind: node.indoor === true ? 'indoor' : node.indoor === 'transition' ? 'entrance-transition' : 'road',
    osmNodeId: node.osmNodeId,
    longitude: node.longitude,
    latitude: node.latitude,
    ...legacyPosition(node.longitude, node.latitude),
    indoor: node.indoor === true,
    indoorTransition: node.indoor === 'transition',
    level: node.level ?? null,
    source: node.source ?? 'openstreetmap',
    verificationStatus: node.verificationStatus ?? null,
  };
}

function sameCoordinate(a, b) {
  return Math.abs(a.longitude - b.longitude) < 1e-8 && Math.abs(a.latitude - b.latitude) < 1e-8;
}

function composePath(from, to, modeId, roadNodeIds) {
  const points = [endpointPoint(from, 'origin', modeId)];
  for (const nodeId of roadNodeIds) {
    const point = roadPoint(nodeId);
    if (!sameCoordinate(points.at(-1), point)) points.push(point);
  }
  const destination = endpointPoint(to, 'destination', modeId);
  if (sameCoordinate(points.at(-1), destination)) points.pop();
  points.push(destination);
  return points;
}

function sumEdgeDistance(edges, predicate) {
  return edges.filter(predicate).reduce((total, edge) => total + edge.distanceMeters, 0);
}

function withEntrance(locationId) {
  const name = NODE_BY_ID[locationId].name;
  return name.endsWith('入口') ? name : `${name}入口`;
}

function makeInstructions(from, to, modeId, edges) {
  if (from === to) return [`已在${NODE_BY_ID[from].name}`];
  const fromDestination = selectedDestination(OSM_ROUTING.locations[from], modeId);
  const toDestination = selectedDestination(OSM_ROUTING.locations[to], modeId);
  const osmEdges = edges.filter((edge) => edge.segmentType === 'osm-road');
  const fromIndoorFeatureId = OSM_ROUTING.locations[from].indoorRoute?.featureId;
  const toIndoorFeatureId = OSM_ROUTING.locations[to].indoorRoute?.featureId;
  const fromIndoorEdges = edges.filter(
    (edge) => edge.indoorFeatureId === fromIndoorFeatureId,
  );
  const toIndoorEdges = edges.filter(
    (edge) => edge.indoorFeatureId === toIndoorFeatureId,
  );
  const instructions = [
    `从${fromDestination.indoor ? `${NODE_BY_ID[from].name}馆内目的地` : withEntrance(from)}出发`,
  ];

  if (fromDestination.indoor && fromIndoorEdges.length) {
    instructions.push(
      `沿${fromDestination.level ?? '当前'}层室内通道前往出口，约 ${Math.round(sumEdgeDistance(fromIndoorEdges, () => true))} 米`,
    );
    instructions.push(`经${withEntrance(from)}离开建筑`);
  }
  if (osmEdges.length) {
    const highwayTypes = [...new Set(osmEdges.map((edge) => edge.highway))].join(' / ');
    instructions.push(
      `沿 OSM ${highwayTypes}前行约 ${Math.round(sumEdgeDistance(osmEdges, () => true))} 米`,
    );
  }
  if (toDestination.indoor && toIndoorEdges.length) {
    instructions.push(`经${withEntrance(to)}进入建筑`);
    instructions.push(
      `沿${toDestination.level ?? '当前'}层室内通道前行约 ${Math.round(sumEdgeDistance(toIndoorEdges, () => true))} 米`,
    );
  }
  instructions.push(
    `抵达${toDestination.indoor ? `${NODE_BY_ID[to].name}馆内目的地` : withEntrance(to)}`,
  );
  return instructions;
}

function publicBinding(locationId, modeId = null) {
  const binding = OSM_ROUTING.locations[locationId];
  const result = {
    entrance: binding.entrance,
    destination: binding.destination ?? null,
    roadNodeId: binding.roadNodeId,
    accessNodeId: binding.accessNodeId ?? null,
    snapDistanceMeters: binding.snapDistanceMeters,
    modeNodeIds: binding.modeNodeIds ?? null,
    indoorRoute: binding.indoorRoute ?? null,
  };
  if (modeId) {
    result.selectedDestination = selectedDestination(binding, modeId);
    result.routingNodeId = routingNodeId(binding, modeId);
    result.indoorAccess = binding.indoorRoute?.modes.includes(modeId) ?? false;
  }
  return result;
}

function externalConnectorDistance(binding, modeId) {
  const nodeId = binding.modeNodeIds?.[modeId];
  return nodeId && nodeId !== binding.roadNodeId ? 0 : binding.snapDistanceMeters;
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
      schemaVersion: '1.2',
      dataset: DATASET.id,
      status: 'ok',
      request: { from, to, mode: modeId },
      summary: {
        distanceMeters: 0,
        durationSeconds: 0,
        distanceEstimated: true,
        roadDistanceMeters: 0,
        connectorDistanceMeters: 0,
        indoorDistanceMeters: 0,
      },
      path: [endpointPoint(from, 'origin-destination', modeId)],
      instructions: makeInstructions(from, to, modeId, []),
      routing: {
        engine: 'layered-osm-indoor-a-star',
        allowedHighways: OSM_ROUTING.allowedHighways,
        indoorHighways: OSM_ROUTING.indoorHighways,
        origin: publicBinding(from, modeId),
        destination: publicBinding(to, modeId),
      },
      disclaimer: DATASET.disclaimer,
    };
  }

  const roadRoute = findRoadPath(
    routingNodeId(fromBinding, modeId),
    routingNodeId(toBinding, modeId),
    modeId,
  );
  if (!roadRoute) {
    return {
      schemaVersion: '1.2',
      dataset: DATASET.id,
      status: 'no_route',
      request: { from, to, mode: modeId },
      routing: {
        engine: 'layered-osm-indoor-a-star',
        allowedHighways: OSM_ROUTING.allowedHighways,
        indoorHighways: OSM_ROUTING.indoorHighways,
        origin: publicBinding(from, modeId),
        destination: publicBinding(to, modeId),
      },
      disclaimer: DATASET.disclaimer,
    };
  }

  const roadDistance = sumEdgeDistance(
    roadRoute.edges,
    (edge) => edge.segmentType === 'osm-road',
  );
  const indoorDistance = sumEdgeDistance(roadRoute.edges, (edge) => edge.indoor === true);
  const graphConnectorDistance = sumEdgeDistance(
    roadRoute.edges,
    (edge) => edge.segmentType === 'entrance-connector',
  );
  const connectorDistance =
    graphConnectorDistance +
    externalConnectorDistance(fromBinding, modeId) +
    externalConnectorDistance(toBinding, modeId);
  const distance = roadDistance + indoorDistance + connectorDistance;
  const distanceMetersRounded = Math.round(distance);
  const durationSeconds = Math.ceil(distance / mode.speedMetersPerSecond);

  return {
    schemaVersion: '1.2',
    dataset: DATASET.id,
    status: 'ok',
    request: { from, to, mode: modeId },
    summary: {
      distanceMeters: distanceMetersRounded,
      durationSeconds,
      distanceEstimated: true,
      roadDistanceMeters: Math.round(roadDistance),
      connectorDistanceMeters: Math.round(connectorDistance),
      indoorDistanceMeters: Math.round(indoorDistance),
    },
    path: composePath(from, to, modeId, roadRoute.nodeIds),
    instructions: makeInstructions(from, to, modeId, roadRoute.edges),
    routing: {
      engine: 'layered-osm-indoor-a-star',
      allowedHighways: OSM_ROUTING.allowedHighways,
      indoorHighways: OSM_ROUTING.indoorHighways,
      osmWayIds: [
        ...new Set(roadRoute.edges.map((edge) => edge.osmWayId).filter(Boolean)),
      ],
      indoorFeatureIds: [
        ...new Set(roadRoute.edges.map((edge) => edge.indoorFeatureId).filter(Boolean)),
      ],
      origin: publicBinding(from, modeId),
      destination: publicBinding(to, modeId),
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
