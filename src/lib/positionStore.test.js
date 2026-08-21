import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_STALE_MS,
  ROBOT_STALE_MS,
  createPositionStore,
  nearestPointOnRoute,
  progressAlongRoute,
} from './positionStore.js';

describe('createPositionStore', () => {
  it('picks the robot position while it is fresh', () => {
    let now = 1_000;
    const store = createPositionStore({ getNow: () => now });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setRobotPosition({
      longitude: 113.4777,
      latitude: 22.8884,
      headingDegrees: 90,
      accuracyMeters: 0.03,
      fixStatus: 'rtk_fixed',
    });
    now += 1_000; // still within 5 s
    const state = store.getState();
    expect(state.source).toBe('robot');
    expect(state.active.position.latitude).toBe(22.8884);
    expect(state.active.position.fixStatus).toBe('rtk_fixed');
    expect(listener).toHaveBeenCalled();
  });

  it('falls back to the browser position when the robot fix is stale', () => {
    let now = 1_000;
    const geolocation = {
      watchPosition: (resolve) => {
        resolve({
          coords: { latitude: 22.889, longitude: 113.478, accuracy: 8 },
        });
      },
      clearWatch: () => {},
    };
    const watched = createPositionStore({ geolocation, getNow: () => now });
    watched.startBrowserWatch();
    watched.setRobotPosition({ longitude: 113.4777, latitude: 22.8884 });
    now += ROBOT_STALE_MS + 1;
    const state = watched.getState();
    expect(state.source).toBe('browser');
    expect(state.browser.latitude).toBe(22.889);
  });

  it('reports no source when both are stale or missing', () => {
    let now = 1_000;
    const store = createPositionStore({ getNow: () => now });
    store.setRobotPosition({ longitude: 113.4777, latitude: 22.8884 });
    expect(store.getState().source).toBe('robot');
    now += ROBOT_STALE_MS + 1;
    expect(store.getState().source).toBeNull();
    expect(store.getState().staleReason).toBe('robot-stale');
  });

  it('clears the robot position on clearRobotPosition', () => {
    const store = createPositionStore({ getNow: () => 0 });
    store.setRobotPosition({ longitude: 113.4777, latitude: 22.8884 });
    store.clearRobotPosition();
    expect(store.getState().source).toBeNull();
  });

  it('reports browser watch errors', () => {
    const geolocation = {
      watchPosition: (_resolve, reject) => reject({ code: 1, message: 'denied' }),
      clearWatch: () => {},
    };
    const store = createPositionStore({ geolocation, getNow: () => 0 });
    store.startBrowserWatch();
    expect(store.getState().watchError?.code).toBe(1);
    expect(store.getState().source).toBeNull();
  });
});

describe('nearestPointOnRoute / progressAlongRoute', () => {
  const points = [
    { longitude: 113.47768, latitude: 22.88836 },
    { longitude: 113.47770, latitude: 22.88840 },
    { longitude: 113.47772, latitude: 22.88844 },
  ];

  it('finds the nearest vertex', () => {
    const nearest = nearestPointOnRoute(points, 22.88837, 113.47769);
    expect(nearest.index).toBe(0);
    expect(nearest.distanceMeters).toBeLessThan(150);
  });

  it('computes remaining distance and percent from a mid-route position', () => {
    const route = {
      path: points,
      summary: { distanceMeters: 100 },
    };
    // Position at the first vertex → 0% completed (route not started).
    const start = progressAlongRoute(route, { latitude: 22.88836, longitude: 113.47768 });
    expect(start.percent).toBeLessThan(0.01);
    // Position at the last vertex → arrived (100% completed).
    const end = progressAlongRoute(route, { latitude: 22.88844, longitude: 113.47772 });
    expect(end.arrived).toBe(true);
    expect(end.percent).toBeGreaterThan(0.99);
    expect(end.remainingMeters).toBeLessThan(1);
  });

  it('returns null without a position or route', () => {
    expect(progressAlongRoute(null, { latitude: 1, longitude: 1 })).toBeNull();
    expect(progressAlongRoute({ path: points }, null)).toBeNull();
  });
});
