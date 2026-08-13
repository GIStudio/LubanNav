import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const osmData = JSON.parse(
  readFileSync(new URL('../../public/data/campus-osm.geojson', import.meta.url), 'utf8'),
);

describe('campus OSM snapshot', () => {
  it('contains only the requested minimal feature classes', () => {
    const classes = new Set(
      osmData.features.map((feature) => feature.properties.featureClass),
    );
    expect(classes).toEqual(new Set(['building', 'road', 'water', 'waterway']));
  });

  it('has useful campus coverage', () => {
    const counts = osmData.features.reduce((summary, feature) => {
      summary[feature.properties.featureClass] ??= 0;
      summary[feature.properties.featureClass] += 1;
      return summary;
    }, {});
    expect(counts.building).toBeGreaterThanOrEqual(40);
    expect(counts.road).toBeGreaterThanOrEqual(60);
    expect(counts.water).toBeGreaterThanOrEqual(1);
    expect(counts.waterway).toBeGreaterThanOrEqual(1);
  });

  it('carries OSM attribution and WGS84 bounds', () => {
    expect(osmData.attribution).toBe('© OpenStreetMap contributors');
    expect(osmData.license).toBe('ODbL-1.0');
    expect(osmData.bbox).toEqual([113.474, 22.8855, 113.484, 22.895]);
  });
});
