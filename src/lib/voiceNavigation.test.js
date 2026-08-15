import { describe, expect, it } from 'vitest';
import {
  NAVIGATION_TOOL,
  NAVIGATION_TOOL_NAME,
  campusLocationCatalog,
  resolveNavigationCommand,
} from './voiceNavigation.js';

describe('voice navigation tool', () => {
  it('exposes a constrained function call with stable public location IDs', () => {
    expect(NAVIGATION_TOOL.function.name).toBe(NAVIGATION_TOOL_NAME);
    expect(NAVIGATION_TOOL.function.parameters.required).toEqual(['to']);
    expect(NAVIGATION_TOOL.function.parameters.properties.to.enum).toContain('library');
    expect(NAVIGATION_TOOL.function.parameters.properties.mode.enum).toEqual([
      'pedestrian',
      'robot',
    ]);
  });

  it('resolves stable IDs emitted by the model', () => {
    expect(resolveNavigationCommand({
      from: 'main-entrance',
      to: 'w4',
      mode: 'pedestrian',
    })).toMatchObject({
      from: 'main-entrance',
      to: 'w4',
      mode: 'pedestrian',
      understood: true,
    });
  });

  it('accepts a human-readable model argument as a defensive fallback', () => {
    expect(resolveNavigationCommand({ to: '图书馆' }, 'activity-center')).toMatchObject({
      from: 'activity-center',
      to: 'library',
      understood: true,
    });
  });

  it('rejects an invented destination instead of changing the page route', () => {
    expect(resolveNavigationCommand({ to: '火星基地' })).toMatchObject({
      understood: false,
      to: null,
      error: 'unknown_destination',
    });
  });

  it('provides the model with the ID-to-name catalog', () => {
    expect(campusLocationCatalog()).toContain('main-entrance=主入口');
    expect(campusLocationCatalog()).toContain('library=图书馆');
  });
});
