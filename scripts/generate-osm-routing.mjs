import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATASET, LOCATION_OSM_FEATURES, PUBLIC_LOCATIONS } from '../src/data/campus.js';
import {
  ROUTABLE_HIGHWAYS,
  bindLocationsToRoadGraph,
  buildRoadGraph,
} from './lib/osm-routing.mjs';

const sourcePath = resolve('public/data/campus-osm.geojson');
const outputPath = resolve('src/data/osm-routing.json');
const geojson = JSON.parse(await readFile(sourcePath, 'utf8'));
const graph = buildRoadGraph(geojson);
const locations = bindLocationsToRoadGraph(
  geojson,
  graph,
  PUBLIC_LOCATIONS,
  LOCATION_OSM_FEATURES,
);

const routing = {
  schemaVersion: '2.0',
  dataset: DATASET.id,
  generatedAt: geojson.fetchedAt,
  source: geojson.source,
  allowedHighways: [...ROUTABLE_HIGHWAYS].sort(),
  graph: {
    nodes: graph.nodes,
    edges: graph.edges,
    routableNodeIds: graph.routableNodeIds,
  },
  locations,
  stats: {
    ...graph.stats,
    locations: Object.keys(locations).length,
    osmEntrances: geojson.features.filter(
      (feature) => feature.properties.featureClass === 'entrance',
    ).length,
    taggedLocationEntrances: Object.values(locations).filter(
      (binding) => binding.entrance.source === 'osm-entrance',
    ).length,
    inferredBuildingEntrances: Object.values(locations).filter(
      (binding) => binding.entrance.source === 'inferred-building-boundary',
    ).length,
    coordinateAnchors: Object.values(locations).filter(
      (binding) => binding.entrance.source === 'location-coordinate',
    ).length,
    maximumSnapDistanceMeters: Math.max(
      ...Object.values(locations).map((binding) => binding.snapDistanceMeters),
    ),
  },
};

await writeFile(outputPath, `${JSON.stringify(routing, null, 2)}\n`);
console.log(
  `Generated OSM routing graph: ${routing.stats.nodes} nodes, ${routing.stats.edges} edges, ` +
    `${routing.stats.locations} locations, max snap ${routing.stats.maximumSnapDistanceMeters.toFixed(2)} m.`,
);
