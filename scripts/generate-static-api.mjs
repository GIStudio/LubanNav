import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET, MODES, PUBLIC_LOCATIONS } from '../src/data/campus.js';
import { defaultEventProfiles } from '../src/lib/eventMode.js';
import { findRoute, getLocationBinding, getRoutingGraph } from '../src/lib/pathfinding.js';
import { getRobotProtocolDescriptor } from '../src/lib/robotProtocol.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = resolve(root, 'public/api/v1');
const routesRoot = resolve(apiRoot, 'routes');
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

await rm(routesRoot, { recursive: true, force: true });
await mkdir(routesRoot, { recursive: true });

const locations = PUBLIC_LOCATIONS.map(({ id, name, en, category, aliases }) => ({
  id,
  name,
  en,
  category,
  aliases,
  routing: getLocationBinding(id),
}));
const events = defaultEventProfiles();

await writeFile(
  resolve(apiRoot, 'locations.json'),
  pretty({ schemaVersion: '1.2', dataset: DATASET, count: locations.length, locations }),
);
await writeFile(
  resolve(apiRoot, 'events.json'),
  pretty({ schemaVersion: '1.0', dataset: DATASET, count: events.length, events }),
);

await writeFile(resolve(apiRoot, 'routing-graph.json'), pretty(getRoutingGraph()));
await writeFile(
  resolve(apiRoot, 'robot-ble-protocol.json'),
  pretty(getRobotProtocolDescriptor()),
);
await copyFile(
  resolve(root, 'public/data/walkable-surfaces/walkable-surfaces.image.geojson'),
  resolve(apiRoot, 'walkable-surfaces.image.geojson'),
);
await copyFile(
  resolve(root, 'public/data/walkable-surfaces/walkable-surfaces.wgs84.geojson'),
  resolve(apiRoot, 'walkable-surfaces.wgs84.geojson'),
);
await copyFile(
  resolve(root, 'public/data/walkable-surfaces/registration-report.json'),
  resolve(apiRoot, 'walkable-registration-report.json'),
);

await writeFile(
  resolve(apiRoot, 'catalog.json'),
  pretty({
    schemaVersion: '1.6',
    dataset: DATASET,
    modes: Object.values(MODES).map(({ id, label, accessibleOnly }) => ({ id, label, accessibleOnly })),
    routing: {
      engine: 'layered-osm-indoor-a-star',
      allowedHighways: ['footway', 'path', 'pedestrian', 'service'],
      indoorHighways: ['corridor'],
      entranceFallback: 'nearest building-boundary point to the routable graph',
      indoorOverlay: {
        path: '../../data/campus-indoor.geojson',
        policy: 'Pedestrian by default; robot requires robotValidated=true.',
      },
      offlineUse:
        'Download routingGraph once, use each location routingByMode binding as the A* endpoint, and filter edges by modes.',
    },
    endpoints: {
      locations: './locations.json',
      events: './events.json',
      routingGraph: './routing-graph.json',
      robotBleProtocol: './robot-ble-protocol.json',
      renderWalkableSurfaceCandidates: './walkable-surfaces.image.geojson',
      registeredWalkableSurfaceCandidates: './walkable-surfaces.wgs84.geojson',
      walkableSurfaceRegistrationReport: './walkable-registration-report.json',
      routeTemplate: './routes/{from}/{to}.{mode}.json',
    },
    examples: [
      './routes/main-entrance/library.pedestrian.json',
      './routes/dorm-5/sports-hall.robot.json',
    ],
  }),
);

let count = 0;
for (const from of PUBLIC_LOCATIONS) {
  const originDirectory = resolve(routesRoot, from.id);
  await mkdir(originDirectory, { recursive: true });
  for (const to of PUBLIC_LOCATIONS) {
    for (const mode of Object.keys(MODES)) {
      const route = findRoute(from.id, to.id, mode);
      await writeFile(resolve(originDirectory, `${to.id}.${mode}.json`), pretty(route));
      count += 1;
    }
  }
}

console.log(`Generated ${count} static route responses for ${locations.length} public locations.`);
