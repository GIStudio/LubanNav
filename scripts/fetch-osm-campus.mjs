import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'public/data/campus-osm.geojson');
const bbox = {
  south: 22.8855,
  west: 113.474,
  north: 22.895,
  east: 113.484,
};

const query = `[out:json][timeout:90];
(
  way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  relation["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  way["waterway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["entrance"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["routing:entrance"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out geom;`;

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function getArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function fetchOverpass() {
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const body = new URLSearchParams({ data: query });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { payload: await response.json(), endpoint };
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed:\n${errors.join('\n')}`);
}

function classify(tags = {}) {
  if (tags.entrance || tags['routing:entrance']) return 'entrance';
  if (tags.building) return 'building';
  if (tags.natural === 'water' || tags.water) return 'water';
  if (tags.waterway) return 'waterway';
  if (tags.highway) return 'road';
  return null;
}

function closeRing(coordinates) {
  if (!coordinates.length) return coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? coordinates
    : [...coordinates, first];
}

function isInside([longitude, latitude]) {
  return (
    longitude >= bbox.west &&
    longitude <= bbox.east &&
    latitude >= bbox.south &&
    latitude <= bbox.north
  );
}

function propertiesFor(element, featureClass) {
  const tags = element.tags ?? {};
  const properties = {
    osmType: element.type,
    osmId: element.id,
    featureClass,
  };
  const keptTags = [
    'name',
    'name:en',
    'ref',
    'building',
    'building:levels',
    'highway',
    'service',
    'surface',
    'foot',
    'access',
    'natural',
    'water',
    'waterway',
    'bridge',
    'tunnel',
    'layer',
    'entrance',
    'routing:entrance',
    'wheelchair',
    'level',
  ];
  for (const key of keptTags) {
    if (tags[key] !== undefined) properties[key] = tags[key];
  }
  return properties;
}

function featureFromNode(element, featureClass) {
  if (featureClass !== 'entrance' || element.lon === undefined || element.lat === undefined) {
    return null;
  }
  const coordinates = [element.lon, element.lat];
  if (!isInside(coordinates)) return null;
  return {
    type: 'Feature',
    id: `${element.type}/${element.id}`,
    properties: propertiesFor(element, featureClass),
    geometry: { type: 'Point', coordinates },
  };
}

function featureFromWay(element, featureClass) {
  if (!element.geometry?.length) return null;
  const coordinates = element.geometry.map(({ lon, lat }) => [lon, lat]);
  if (!coordinates.some(isInside)) return null;
  const polygon = featureClass === 'building' || featureClass === 'water';
  return {
    type: 'Feature',
    id: `${element.type}/${element.id}`,
    properties: {
      ...propertiesFor(element, featureClass),
      ...(featureClass === 'road' && element.nodes ? { osmNodeIds: element.nodes } : {}),
    },
    geometry: polygon
      ? { type: 'Polygon', coordinates: [closeRing(coordinates)] }
      : { type: 'LineString', coordinates },
  };
}

function featureFromRelation(element, featureClass) {
  if (featureClass !== 'building' && featureClass !== 'water') return null;
  const rings = (element.members ?? [])
    .filter((member) => member.role === 'outer' && member.geometry?.length)
    .map((member) => closeRing(member.geometry.map(({ lon, lat }) => [lon, lat])))
    .filter((ring) => ring.some(isInside));
  if (!rings.length) return null;
  return {
    type: 'Feature',
    id: `${element.type}/${element.id}`,
    properties: propertiesFor(element, featureClass),
    geometry:
      rings.length === 1
        ? { type: 'Polygon', coordinates: [rings[0]] }
        : { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) },
  };
}

export function convertOverpass(payload, metadata = {}) {
  const features = payload.elements
    .map((element) => {
      const featureClass = classify(element.tags);
      if (!featureClass) return null;
      if (element.type === 'node') return featureFromNode(element, featureClass);
      return element.type === 'relation'
        ? featureFromRelation(element, featureClass)
        : featureFromWay(element, featureClass);
    })
    .filter(Boolean)
    .sort((a, b) =>
      `${a.properties.featureClass}-${a.properties.osmType}-${a.properties.osmId}`.localeCompare(
        `${b.properties.featureClass}-${b.properties.osmType}-${b.properties.osmId}`,
      ),
    );

  return {
    type: 'FeatureCollection',
    name: 'HKUST(GZ) minimal OSM campus map',
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    attribution: '© OpenStreetMap contributors',
    license: 'ODbL-1.0',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    source: 'https://www.openstreetmap.org/way/894157108',
    fetchedAt: metadata.fetchedAt ?? new Date().toISOString(),
    overpassEndpoint: metadata.endpoint ?? 'local-input',
    features,
  };
}

const inputPath = getArgument('--input');
const source = inputPath
  ? {
      payload: JSON.parse(await readFile(resolve(inputPath), 'utf8')),
      endpoint: 'local-input',
    }
  : await fetchOverpass();
const entrancesInputPath = getArgument('--entrances-input');
if (entrancesInputPath) {
  const entrancePayload = JSON.parse(await readFile(resolve(entrancesInputPath), 'utf8'));
  const existing = new Set(source.payload.elements.map((element) => `${element.type}/${element.id}`));
  source.payload.elements.push(
    ...entrancePayload.elements.filter((element) => !existing.has(`${element.type}/${element.id}`)),
  );
}
const geojson = convertOverpass(source.payload, { endpoint: source.endpoint });

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(geojson)}\n`);

const counts = geojson.features.reduce((groups, feature) => {
  const key = feature.properties.featureClass;
  groups[key] ??= [];
  groups[key].push(feature);
  return groups;
}, {});
console.log(
  `Wrote ${geojson.features.length} OSM features to ${outputPath}: ` +
    Object.entries(counts)
      .map(([key, items]) => `${key}=${items.length}`)
      .join(', '),
);
