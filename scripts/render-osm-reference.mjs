import { readFile, writeFile } from 'node:fs/promises';

const [input = 'public/data/campus-osm.geojson', output = '/tmp/lubannav-osm-reference.svg'] = process.argv.slice(2);
const data = JSON.parse(await readFile(input, 'utf8'));
const [minLon, minLat, maxLon, maxLat] = data.bbox;
const width = 1000;
const height = Math.round(width * ((maxLat - minLat) / (maxLon - minLon)));
const project = ([lon, lat]) => [
  ((lon - minLon) / (maxLon - minLon)) * width,
  ((maxLat - lat) / (maxLat - minLat)) * height,
];
const line = (coordinates) => coordinates.map((coordinate) => project(coordinate).map((value) => value.toFixed(1)).join(',')).join(' ');
const parts = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
  '<rect width="100%" height="100%" fill="#0a1f28"/>',
];

for (const feature of data.features) {
  if (feature.properties.featureClass === 'water' && feature.geometry.type === 'Polygon') {
    parts.push(`<polygon points="${line(feature.geometry.coordinates[0])}" fill="#16596a" stroke="#2f8793"/>`);
  }
}
for (const feature of data.features) {
  if (feature.properties.featureClass === 'road' && feature.geometry.type === 'LineString') {
    parts.push(`<polyline points="${line(feature.geometry.coordinates)}" fill="none" stroke="#83a3a3" stroke-width="2"/>`);
  }
}
for (const feature of data.features) {
  if (feature.properties.featureClass !== 'building' || feature.geometry.type !== 'Polygon') continue;
  const points = feature.geometry.coordinates[0];
  parts.push(`<polygon points="${line(points)}" fill="#e7e4d8" stroke="#ff9d63" stroke-width="1"/>`);
  const projected = points.map(project);
  const center = projected.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]).map((value) => value / projected.length);
  const name = feature.properties.name ?? feature.properties.ref;
  if (name) parts.push(`<text x="${center[0].toFixed(1)}" y="${center[1].toFixed(1)}" fill="#071c2c" font-size="11" text-anchor="middle">${name}</text>`);
}
parts.push('</svg>');
await writeFile(output, parts.join('\n'));
console.log(output);
