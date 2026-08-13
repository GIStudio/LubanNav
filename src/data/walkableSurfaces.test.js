import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DATA_URL = new URL('../../public/data/walkable-surfaces/walkable-surfaces.image.geojson', import.meta.url);
const SUMMARY_URL = new URL('../../public/data/walkable-surfaces/walkable-surfaces-summary.json', import.meta.url);

describe('render-derived walkable surface candidates', () => {
  const data = JSON.parse(readFileSync(DATA_URL, 'utf8'));
  const summary = JSON.parse(readFileSync(SUMMARY_URL, 'utf8'));

  it('keeps image-derived geometry outside the active routing graph', () => {
    expect(data.coordinateSpace).toBe('normalized-image');
    expect(data.reviewRequired).toContain('register-image-coordinates-to-WGS84');
    expect(data.features.length).toBeGreaterThan(0);
    expect(data.features.every((feature) => feature.properties.routingEnabled === false)).toBe(true);
    expect(
      data.features.every(
        (feature) => feature.properties.surfaceClass === 'ground-or-roof-unclassified',
      ),
    ).toBe(true);
  });

  it('emits closed, normalized polygon rings', () => {
    for (const feature of data.features) {
      expect(feature.geometry.type).toBe('Polygon');
      for (const ring of feature.geometry.coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring.at(-1)).toEqual(ring[0]);
        for (const [x, y] of ring) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(1);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('publishes provenance without a local absolute path', () => {
    expect(summary.sourceImage).toBe('微信图片_2026-08-13_172033_970.jpg');
    expect(summary.sourceImageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.classificationMode).toBe('ground-or-roof-unclassified');
    expect(summary.routingEnabled).toBe(false);
    expect(summary.candidatePixelRatio).toBeGreaterThan(0.4);
    expect(summary.candidatePixelRatio).toBeLessThan(0.8);
  });
});
