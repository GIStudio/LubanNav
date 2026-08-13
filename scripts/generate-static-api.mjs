import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET, MODES, PUBLIC_LOCATIONS } from '../src/data/campus.js';
import { findRoute, getLocationBinding } from '../src/lib/pathfinding.js';

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

await writeFile(
  resolve(apiRoot, 'locations.json'),
  pretty({ schemaVersion: '1.0', dataset: DATASET, count: locations.length, locations }),
);

await writeFile(
  resolve(apiRoot, 'catalog.json'),
  pretty({
    schemaVersion: '1.0',
    dataset: DATASET,
    modes: Object.values(MODES).map(({ id, label, accessibleOnly }) => ({ id, label, accessibleOnly })),
    routing: {
      engine: 'osm-highway-a-star',
      allowedHighways: ['footway', 'path', 'pedestrian', 'service'],
      entranceFallback: 'nearest building-boundary point to the routable graph',
    },
    endpoints: {
      locations: './locations.json',
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
