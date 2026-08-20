import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATASET, LOCATION_OSM_FEATURES, PUBLIC_LOCATIONS } from '../src/data/campus.js';
import {
  ROUTABLE_HIGHWAYS,
  addIndoorRoutesToGraph,
  addIndoorNetworkToGraph,
  applyEntrancePoiOverrides,
  bindLocationsToRoadGraph,
  buildRoadGraph,
} from './lib/osm-routing.mjs';

const sourcePath = resolve('public/data/campus-osm.geojson');
const indoorSourcePath = resolve('public/data/campus-indoor.geojson');
const localNavSourcePath = resolve('public/data/campus-local-nav.geojson');
const outputPath = resolve('src/data/osm-routing.json');
const geojson = JSON.parse(await readFile(sourcePath, 'utf8'));
const indoorGeojson = JSON.parse(await readFile(indoorSourcePath, 'utf8'));
// 本地导航图（GCJ-02 -> WGS84 转换后的步行路网）作为道路补充并入 OSM 快照；
// 由 `npm run import:global-nav` 生成，文件缺失时跳过（仅 OSM 路网）。
try {
  const localNav = JSON.parse(await readFile(localNavSourcePath, 'utf8'));
  geojson.features.push(...localNav.features);
  geojson.localNav = { source: localNav.source, stats: localNav.stats };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('未找到 campus-local-nav.geojson，跳过本地导航图（运行 npm run import:global-nav 生成）');
}
// 室内楼层补丁（global-nav core F2/F3），由 import:global-nav-indoor 生成
const localNavIndoorSourcePath = resolve('public/data/campus-local-nav-indoor.geojson');
try {
  const localNavIndoor = JSON.parse(await readFile(localNavIndoorSourcePath, 'utf8'));
  indoorGeojson.features.push(...localNavIndoor.features);
  indoorGeojson.localNavIndoor = { source: localNavIndoor.source };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('未找到 campus-local-nav-indoor.geojson，跳过室内补丁（运行 npm run import:global-nav-indoor 生成）');
}
const graph = buildRoadGraph(geojson);
const locations = bindLocationsToRoadGraph(
  geojson,
  graph,
  PUBLIC_LOCATIONS,
  LOCATION_OSM_FEATURES,
);
const entrancePoiStats = applyEntrancePoiOverrides(geojson, indoorGeojson, graph, locations);
const indoorStats = addIndoorRoutesToGraph(geojson, indoorGeojson, graph, locations);
const indoorNetworkStats = addIndoorNetworkToGraph(indoorGeojson, graph, locations);

const routing = {
  schemaVersion: '2.0',
  dataset: DATASET.id,
  generatedAt: geojson.fetchedAt,
  source: geojson.source,
  indoorSource: {
    source: indoorGeojson.source,
    disclaimer: indoorGeojson.disclaimer,
  },
  localNavSource: geojson.localNav,
  allowedHighways: [...ROUTABLE_HIGHWAYS].sort(),
  indoorHighways: ['corridor', 'elevator'],
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
    localEntrancePois: entrancePoiStats.entrancePois,
    maximumSnapDistanceMeters: Math.max(
      ...Object.values(locations).map((binding) => binding.snapDistanceMeters),
    ),
    indoorRoutes: indoorStats.routes,
    indoorNodes: indoorStats.nodes,
    indoorEdges: indoorStats.indoorEdges,
    entranceConnectorEdges: indoorStats.entranceConnectorEdges,
    indoorNetworks: indoorNetworkStats.networks,
    indoorNetworkNodes: indoorNetworkStats.nodes,
    indoorNetworkEdges: indoorNetworkStats.edges,
    verticalConnectorEdges: indoorNetworkStats.verticalEdges,
  },
};

await writeFile(outputPath, `${JSON.stringify(routing, null, 2)}\n`);
console.log(
  `Generated OSM routing graph: ${routing.stats.nodes} nodes, ${routing.stats.edges} edges, ` +
    `${routing.stats.locations} locations, ${routing.stats.indoorRoutes} indoor route(s), ` +
    `${routing.stats.indoorNetworks} shared indoor network(s), ` +
    `max snap ${routing.stats.maximumSnapDistanceMeters.toFixed(2)} m.`,
);
