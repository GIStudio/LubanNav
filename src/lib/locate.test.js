import { describe, expect, it, vi } from 'vitest';
import { locateCurrentPlace, nearestPublicPlace } from './locate.js';

describe('nearestPublicPlace', () => {
  it('returns the closest public place for a fix inside the campus', () => {
    // A fix right at the main gate (entrance 113.47768, 22.88837).
    const result = nearestPublicPlace(22.8884, 113.4777);
    expect(result).not.toBeNull();
    expect(result.id).toBe('main-entrance');
    expect(result.distanceMeters).toBeLessThan(50);
  });

  it('returns null for a fix far outside the campus', () => {
    expect(nearestPublicPlace(23.13, 113.26)).toBeNull();
  });

  it('respects a custom distance threshold', () => {
    // ~500 m north of the campus center: rejected at 250 m, accepted at 1000 m.
    const strict = nearestPublicPlace(22.8947, 113.4791, { maxDistanceMeters: 200 });
    const loose = nearestPublicPlace(22.8947, 113.4791, { maxDistanceMeters: 1000 });
    expect(strict).toBeNull();
    expect(loose).not.toBeNull();
  });
});

describe('locateCurrentPlace', () => {
  it('resolves to the nearest place when the browser reports a position', async () => {
    const geolocation = {
      getCurrentPosition: (resolve) =>
        resolve({ coords: { latitude: 22.8884, longitude: 113.4777 } }),
    };
    const result = await locateCurrentPlace({ geolocation });
    expect(result?.id).toBe('main-entrance');
  });

  it('resolves to null when the user denies permission', async () => {
    const geolocation = {
      getCurrentPosition: (_resolve, reject) => reject(new Error('denied')),
    };
    expect(await locateCurrentPlace({ geolocation })).toBeNull();
  });

  it('resolves to null when geolocation is unavailable', async () => {
    expect(await locateCurrentPlace({ geolocation: null })).toBeNull();
  });

  it('passes high-accuracy options through to the browser API', async () => {
    const optionsSpy = vi.fn();
    const geolocation = {
      getCurrentPosition: (_resolve, _reject, options) => {
        optionsSpy(options);
        _resolve({ coords: { latitude: 22.8902, longitude: 113.4791 } });
      },
    };
    await locateCurrentPlace({ geolocation, timeoutMs: 3000 });
    expect(optionsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enableHighAccuracy: true, timeout: 3000, maximumAge: 60000 }),
    );
  });
});
