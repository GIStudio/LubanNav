export const ROUTABLE_HIGHWAYS = new Set(['footway', 'path', 'pedestrian', 'service']);

const BLOCKED_ACCESS = new Set(['no', 'private']);
const ROBOT_BLOCKED_SURFACES = new Set([
  'dirt',
  'earth',
  'grass',
  'gravel',
  'ground',
  'mud',
  'sand',
  'unpaved',
]);
const EARTH_RADIUS_METERS = 6_371_008.8;

export function distanceMeters(a, b) {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const deltaLat = ((b[1] - a[1]) * Math.PI) / 180;
  const deltaLon = ((b[0] - a[0]) * Math.PI) / 180;
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value));
}

function pedestrianAllowed(properties) {
  if (BLOCKED_ACCESS.has(properties.foot)) return false;
  if (BLOCKED_ACCESS.has(properties.access) && !['yes', 'designated', 'permissive'].includes(properties.foot)) {
    return false;
  }
  return true;
}

function robotAllowed(properties) {
  if (!pedestrianAllowed(properties) || properties.wheelchair === 'no') return false;
  if (ROBOT_BLOCKED_SURFACES.has(properties.surface)) return false;
  return true;
}

function roadNodeId(osmNodeId, coordinate) {
  if (osmNodeId !== undefined && osmNodeId !== null) return `osm-node/${osmNodeId}`;
  return `coordinate/${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`;
}

function edgeKey(from, to) {
  return from < to ? `${from}|${to}` : `${to}|${from}`;
}

function largestConnectedComponent(nodes, edges, mode) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!edge.modes.includes(mode)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }

  const visited = new Set();
  let largest = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const component = [];
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length) {
      const current = queue.shift();
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  return new Set(largest);
}

export function buildRoadGraph(geojson) {
  const nodeById = new Map();
  const edgeByKey = new Map();
  const roads = geojson.features.filter(
    (feature) =>
      feature.properties.featureClass === 'road' &&
      ROUTABLE_HIGHWAYS.has(feature.properties.highway) &&
      feature.geometry.type === 'LineString',
  );

  for (const road of roads) {
    const coordinates = road.geometry.coordinates;
    const osmNodeIds = road.properties.osmNodeIds ?? [];
    const modes = [];
    if (pedestrianAllowed(road.properties)) modes.push('pedestrian');
    if (robotAllowed(road.properties)) modes.push('robot');
    if (!modes.length) continue;

    coordinates.forEach((coordinate, index) => {
      const id = roadNodeId(osmNodeIds[index], coordinate);
      nodeById.set(id, {
        id,
        osmNodeId: osmNodeIds[index] ?? null,
        longitude: coordinate[0],
        latitude: coordinate[1],
      });
    });

    for (let index = 1; index < coordinates.length; index += 1) {
      const from = roadNodeId(osmNodeIds[index - 1], coordinates[index - 1]);
      const to = roadNodeId(osmNodeIds[index], coordinates[index]);
      if (from === to) continue;
      const distance = distanceMeters(coordinates[index - 1], coordinates[index]);
      const key = edgeKey(from, to);
      const candidate = {
        id: `${road.id}/${index - 1}`,
        from,
        to,
        distanceMeters: Number(distance.toFixed(3)),
        highway: road.properties.highway,
        osmWayId: road.properties.osmId,
        modes,
        segmentType: 'osm-road',
        indoor: false,
        level: null,
        source: 'openstreetmap',
        accessAssumed:
          road.properties.access === undefined ||
          (road.properties.highway !== 'pedestrian' && road.properties.foot === undefined),
      };
      const existing = edgeByKey.get(key);
      if (!existing || candidate.distanceMeters < existing.distanceMeters) edgeByKey.set(key, candidate);
    }
  }

  const nodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeByKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  const pedestrianComponent = largestConnectedComponent(nodes, edges, 'pedestrian');
  const robotComponent = largestConnectedComponent(nodes, edges, 'robot');
  const routableComponent = new Set(
    [...pedestrianComponent].filter((nodeId) => robotComponent.has(nodeId)),
  );

  return {
    nodes,
    edges,
    routableNodeIds: [...routableComponent].sort(),
    stats: {
      sourceRoadWays: roads.length,
      nodes: nodes.length,
      edges: edges.length,
      pedestrianLargestComponentNodes: pedestrianComponent.size,
      robotLargestComponentNodes: robotComponent.size,
      sharedRoutableComponentNodes: routableComponent.size,
    },
  };
}

function polygonRings(feature) {
  if (feature.geometry.type === 'Polygon') return feature.geometry.coordinates;
  if (feature.geometry.type === 'MultiPolygon') {
    return feature.geometry.coordinates.flatMap((polygon) => polygon);
  }
  return [];
}

function localPoint(coordinate, referenceLatitude) {
  return [
    coordinate[0] * 111_320 * Math.cos((referenceLatitude * Math.PI) / 180),
    coordinate[1] * 110_540,
  ];
}

function closestPointOnSegment(point, start, end) {
  const referenceLatitude = point[1];
  const p = localPoint(point, referenceLatitude);
  const a = localPoint(start, referenceLatitude);
  const b = localPoint(end, referenceLatitude);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator));
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

function distanceToFeatureBoundary(point, feature) {
  let best = { distance: Number.POSITIVE_INFINITY, point: null };
  for (const ring of polygonRings(feature)) {
    for (let index = 1; index < ring.length; index += 1) {
      const candidate = closestPointOnSegment(point, ring[index - 1], ring[index]);
      const distance = distanceMeters(point, candidate);
      if (distance < best.distance) best = { distance, point: candidate };
    }
  }
  return best;
}

function bestBuildingBoundarySnap(buildings, roadNodes) {
  let best = null;
  for (const roadNode of roadNodes) {
    const roadCoordinate = [roadNode.longitude, roadNode.latitude];
    for (const building of buildings) {
      const boundary = distanceToFeatureBoundary(roadCoordinate, building);
      if (!best || boundary.distance < best.snapDistanceMeters) {
        best = {
          entranceCoordinate: boundary.point,
          roadNode,
          snapDistanceMeters: boundary.distance,
          osmFeatureId: building.id,
        };
      }
    }
  }
  return best;
}

function entrancePriority(feature) {
  if (feature.properties['routing:entrance'] === 'main') return 0;
  if (feature.properties['routing:entrance']) return 1;
  if (feature.properties.entrance === 'main') return 2;
  return 3;
}

function validEntrance(feature) {
  return (
    feature.properties.featureClass === 'entrance' &&
    !['no', 'exit', 'emergency'].includes(feature.properties.entrance) &&
    !BLOCKED_ACCESS.has(feature.properties.access)
  );
}

function matchingBuildingEntrance(buildings, entrances) {
  const matches = [];
  for (const entrance of entrances.filter(validEntrance)) {
    for (const building of buildings) {
      const boundary = distanceToFeatureBoundary(entrance.geometry.coordinates, building);
      if (boundary.distance <= 2.5) {
        matches.push({
          feature: entrance,
          osmFeatureId: building.id,
          boundaryDistanceMeters: boundary.distance,
        });
      }
    }
  }
  return matches.sort(
    (a, b) => entrancePriority(a.feature) - entrancePriority(b.feature) || a.boundaryDistanceMeters - b.boundaryDistanceMeters,
  )[0];
}

function nearestRoadNode(coordinate, roadNodes) {
  return roadNodes.reduce((best, node) => {
    const distance = distanceMeters(coordinate, [node.longitude, node.latitude]);
    return !best || distance < best.distance ? { node, distance } : best;
  }, null);
}

export function bindLocationsToRoadGraph(geojson, roadGraph, locations, featureIdsByLocation) {
  const featureById = new Map(geojson.features.map((feature) => [feature.id, feature]));
  const buildings = geojson.features.filter((feature) => feature.properties.featureClass === 'building');
  const entrances = geojson.features.filter((feature) => feature.properties.featureClass === 'entrance');
  const routableIds = new Set(roadGraph.routableNodeIds);
  const roadNodes = roadGraph.nodes.filter((node) => routableIds.has(node.id));
  if (!roadNodes.length) throw new Error('OSM road graph has no shared pedestrian/robot component');

  const bindings = {};
  for (const location of locations) {
    const coordinate = [location.longitude, location.latitude];
    const matchedBuildings = (featureIdsByLocation[location.id] ?? [])
      .map((id) => featureById.get(id))
      .filter((feature) => feature?.properties.featureClass === 'building');
    let source = 'location-coordinate';
    let entranceCoordinate = coordinate;
    let roadNode = null;
    let snapDistanceMeters = null;
    let osmFeatureId = null;
    let osmEntranceId = null;

    const taggedEntrance = matchedBuildings.length
      ? matchingBuildingEntrance(matchedBuildings, entrances)
      : null;
    if (taggedEntrance) {
      source = 'osm-entrance';
      entranceCoordinate = taggedEntrance.feature.geometry.coordinates;
      osmFeatureId = taggedEntrance.osmFeatureId;
      osmEntranceId = taggedEntrance.feature.id;
      const nearest = nearestRoadNode(entranceCoordinate, roadNodes);
      roadNode = nearest.node;
      snapDistanceMeters = nearest.distance;
    } else if (matchedBuildings.length) {
      source = 'inferred-building-boundary';
      const snap = bestBuildingBoundarySnap(matchedBuildings, roadNodes);
      entranceCoordinate = snap.entranceCoordinate;
      roadNode = snap.roadNode;
      snapDistanceMeters = snap.snapDistanceMeters;
      osmFeatureId = snap.osmFeatureId;
    } else if (location.category === 'entrance') {
      const nearestTagged = entrances
        .filter(validEntrance)
        .map((feature) => ({ feature, distance: distanceMeters(coordinate, feature.geometry.coordinates) }))
        .filter((item) => item.distance <= 150)
        .sort((a, b) => entrancePriority(a.feature) - entrancePriority(b.feature) || a.distance - b.distance)[0];
      if (nearestTagged) {
        source = 'osm-entrance';
        entranceCoordinate = nearestTagged.feature.geometry.coordinates;
        osmEntranceId = nearestTagged.feature.id;
      }
      const nearest = nearestRoadNode(entranceCoordinate, roadNodes);
      roadNode = nearest.node;
      snapDistanceMeters = nearest.distance;
    } else {
      const nearest = nearestRoadNode(coordinate, roadNodes);
      roadNode = nearest.node;
      snapDistanceMeters = nearest.distance;
    }

    bindings[location.id] = {
      locationId: location.id,
      entrance: {
        longitude: Number(entranceCoordinate[0].toFixed(7)),
        latitude: Number(entranceCoordinate[1].toFixed(7)),
        source,
        osmFeatureId,
        osmEntranceId,
      },
      roadNodeId: roadNode.id,
      snapDistanceMeters: Number(snapDistanceMeters.toFixed(2)),
      matchedBuildingFeatureIds: matchedBuildings.map((feature) => feature.id),
    };
  }
  return bindings;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const intersects =
      y > point[1] !== previousY > point[1] &&
      point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y) + x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInsideFeature(point, feature) {
  return polygonRings(feature).some((ring) => pointInRing(point, ring));
}

function indoorNodeId(locationId, level, suffix) {
  return `indoor/${locationId}/level-${level}/${suffix}`;
}

export function applyEntrancePoiOverrides(campusGeojson, overlayGeojson, roadGraph, bindings) {
  const featureById = new Map(campusGeojson.features.map((feature) => [feature.id, feature]));
  const routableIds = new Set(roadGraph.routableNodeIds);
  const roadNodes = roadGraph.nodes.filter((node) => routableIds.has(node.id));
  let applied = 0;

  for (const feature of overlayGeojson.features ?? []) {
    if (feature.properties.featureClass !== 'entrancePoi') continue;
    if (feature.geometry?.type !== 'Point') {
      throw new Error(`Entrance POI ${feature.id} must be a Point`);
    }
    const locationId = feature.properties.locationId;
    const binding = bindings[locationId];
    if (!binding) throw new Error(`Entrance POI ${feature.id} references unknown location ${locationId}`);
    const building = featureById.get(feature.properties.buildingFeatureId);
    if (!building || building.properties.featureClass !== 'building') {
      throw new Error(`Entrance POI ${feature.id} references unknown building ${feature.properties.buildingFeatureId}`);
    }

    const coordinate = feature.geometry.coordinates;
    const boundary = distanceToFeatureBoundary(coordinate, building);
    if (!pointInsideFeature(coordinate, building) || boundary.distance > 5) {
      throw new Error(`Entrance POI ${feature.id} must be inside and within 5 m of ${building.id}`);
    }
    const nearest = nearestRoadNode(coordinate, roadNodes);
    binding.entrance = {
      longitude: Number(coordinate[0].toFixed(7)),
      latitude: Number(coordinate[1].toFixed(7)),
      source: 'local-entrance-poi',
      osmFeatureId: building.id,
      osmEntranceId: null,
      localFeatureId: feature.id,
      level: String(feature.properties.level ?? '0'),
      evidence: feature.properties.evidence ?? null,
      inferredFrom: feature.properties.inferredFrom ?? null,
      verificationStatus: feature.properties.verificationStatus ?? 'unverified',
      buildingBoundaryDistanceMeters: Number(boundary.distance.toFixed(2)),
    };
    binding.roadNodeId = nearest.node.id;
    binding.snapDistanceMeters = Number(nearest.distance.toFixed(2));
    binding.matchedBuildingFeatureIds = [building.id];
    applied += 1;
  }
  return { entrancePois: applied };
}

export function addIndoorRoutesToGraph(campusGeojson, indoorGeojson, roadGraph, bindings) {
  const featureById = new Map(campusGeojson.features.map((feature) => [feature.id, feature]));
  const nodeById = new Map(roadGraph.nodes.map((node) => [node.id, node]));
  const edgeIds = new Set(roadGraph.edges.map((edge) => edge.id));
  let addedNodes = 0;
  let addedEdges = 0;
  let addedIndoorEdges = 0;
  let addedConnectorEdges = 0;
  let routes = 0;

  for (const feature of indoorGeojson.features ?? []) {
    if (feature.properties.featureClass !== 'indoorPath') continue;
    if (feature.geometry?.type !== 'LineString' || feature.geometry.coordinates.length < 2) {
      throw new Error(`Indoor route ${feature.id} must be a LineString with at least two coordinates`);
    }
    if (BLOCKED_ACCESS.has(feature.properties.access)) continue;

    const locationId = feature.properties.locationId;
    const binding = bindings[locationId];
    if (!binding) throw new Error(`Indoor route ${feature.id} references unknown location ${locationId}`);
    const building = featureById.get(feature.properties.buildingFeatureId);
    if (!building || building.properties.featureClass !== 'building') {
      throw new Error(`Indoor route ${feature.id} references unknown building ${feature.properties.buildingFeatureId}`);
    }
    const level = String(feature.properties.level ?? '');
    if (!level) throw new Error(`Indoor route ${feature.id} is missing level`);

    const declaredStart = feature.geometry.coordinates[0];
    const entranceCoordinate = [binding.entrance.longitude, binding.entrance.latitude];
    if (distanceMeters(declaredStart, entranceCoordinate) > 3) {
      throw new Error(`Indoor route ${feature.id} does not start at the bound building entrance`);
    }
    for (const coordinate of feature.geometry.coordinates.slice(1)) {
      if (!pointInsideFeature(coordinate, building)) {
        throw new Error(`Indoor route ${feature.id} contains a point outside ${building.id}`);
      }
    }

    const requestedModes = feature.properties.modes ?? ['pedestrian'];
    const modes = requestedModes.filter(
      (mode) => mode === 'pedestrian' || (mode === 'robot' && feature.properties.robotValidated === true),
    );
    if (!modes.includes('pedestrian')) {
      throw new Error(`Indoor route ${feature.id} must explicitly permit pedestrian routing`);
    }

    const coordinates = [entranceCoordinate, ...feature.geometry.coordinates.slice(1)];
    const entranceNodeId = indoorNodeId(locationId, level, 'entrance');
    const routeNodeIds = coordinates.map((coordinate, index) =>
      index === 0 ? entranceNodeId : indoorNodeId(locationId, level, `point-${index}`),
    );
    routeNodeIds.forEach((id, index) => {
      if (nodeById.has(id)) throw new Error(`Duplicate indoor routing node ${id}`);
      const destination = index === routeNodeIds.length - 1;
      const node = {
        id,
        osmNodeId: null,
        longitude: coordinates[index][0],
        latitude: coordinates[index][1],
        kind: index === 0 ? 'entrance' : destination ? 'indoor-destination' : 'indoor-waypoint',
        indoor: index === 0 ? 'transition' : true,
        level,
        source: feature.properties.source ?? indoorGeojson.source ?? 'local-routing-overlay',
        verificationStatus: feature.properties.verificationStatus ?? 'unverified',
      };
      nodeById.set(id, node);
      roadGraph.nodes.push(node);
      addedNodes += 1;
    });

    const outdoorNode = nodeById.get(binding.roadNodeId);
    if (!outdoorNode) throw new Error(`Indoor route ${feature.id} has no outdoor attachment node`);
    const connectorId = `${feature.id}/entrance-connector`;
    if (edgeIds.has(connectorId)) throw new Error(`Duplicate indoor routing edge ${connectorId}`);
    roadGraph.edges.push({
      id: connectorId,
      from: binding.roadNodeId,
      to: entranceNodeId,
      distanceMeters: Number(
        distanceMeters(
          [outdoorNode.longitude, outdoorNode.latitude],
          entranceCoordinate,
        ).toFixed(3),
      ),
      highway: 'connector',
      osmWayId: null,
      modes: ['pedestrian', 'robot'],
      segmentType: 'entrance-connector',
      indoor: false,
      level,
      source: binding.entrance.source,
      accessAssumed: true,
    });
    edgeIds.add(connectorId);
    addedEdges += 1;
    addedConnectorEdges += 1;

    for (let index = 1; index < routeNodeIds.length; index += 1) {
      const id = `${feature.id}/segment-${index}`;
      if (edgeIds.has(id)) throw new Error(`Duplicate indoor routing edge ${id}`);
      roadGraph.edges.push({
        id,
        from: routeNodeIds[index - 1],
        to: routeNodeIds[index],
        distanceMeters: Number(distanceMeters(coordinates[index - 1], coordinates[index]).toFixed(3)),
        highway: feature.properties.highway ?? 'corridor',
        osmWayId: null,
        modes,
        segmentType: 'indoor-path',
        indoor: true,
        level,
        source: feature.properties.source ?? indoorGeojson.source ?? 'local-routing-overlay',
        verificationStatus: feature.properties.verificationStatus ?? 'unverified',
        indoorFeatureId: feature.id,
        accessAssumed: feature.properties.verificationStatus !== 'verified',
      });
      edgeIds.add(id);
      addedEdges += 1;
      addedIndoorEdges += 1;
    }

    const finalCoordinate = coordinates.at(-1);
    const finalNodeId = routeNodeIds.at(-1);
    binding.accessNodeId = entranceNodeId;
    binding.modeNodeIds = {
      pedestrian: modes.includes('pedestrian') ? finalNodeId : entranceNodeId,
      robot: modes.includes('robot') ? finalNodeId : entranceNodeId,
    };
    binding.destination = {
      longitude: Number(finalCoordinate[0].toFixed(7)),
      latitude: Number(finalCoordinate[1].toFixed(7)),
      source: feature.properties.source ?? indoorGeojson.source ?? 'local-routing-overlay',
      featureId: feature.id,
      indoor: true,
      level,
      levelAssumed: feature.properties.levelAssumed === true,
      verificationStatus: feature.properties.verificationStatus ?? 'unverified',
    };
    binding.indoorRoute = {
      featureId: feature.id,
      buildingFeatureId: building.id,
      highway: feature.properties.highway ?? 'corridor',
      level,
      levelAssumed: feature.properties.levelAssumed === true,
      modes,
      evidence: feature.properties.evidence ?? null,
      verificationStatus: feature.properties.verificationStatus ?? 'unverified',
    };
    routes += 1;
  }

  roadGraph.nodes.sort((a, b) => a.id.localeCompare(b.id));
  roadGraph.edges.sort((a, b) => a.id.localeCompare(b.id));
  roadGraph.stats.nodes = roadGraph.nodes.length;
  roadGraph.stats.edges = roadGraph.edges.length;
  roadGraph.stats.indoorRoutes = routes;
  roadGraph.stats.indoorNodes = addedNodes;
  roadGraph.stats.indoorEdges = addedIndoorEdges;
  roadGraph.stats.entranceConnectorEdges = addedConnectorEdges;
  return {
    routes,
    nodes: addedNodes,
    edges: addedEdges,
    indoorEdges: addedIndoorEdges,
    entranceConnectorEdges: addedConnectorEdges,
  };
}
