import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EVENT_ID } from '../data/events.js';
import {
  EVENT_STORAGE_KEY,
  defaultEventProfiles,
  eventAssistantContext,
  loadEventProfiles,
  normalizeEventConfig,
  resolveEventNavigationQuery,
  saveEventProfiles,
  upsertEventProfile,
} from './eventMode.js';

describe('event mode data', () => {
  it('ships the August device demo without invented map bindings', () => {
    const [event] = defaultEventProfiles();
    expect(event).toMatchObject({
      id: DEFAULT_EVENT_ID,
      name: '八月真机展示活动',
      dateLabel: '2026 年 8 月',
      mainVenue: { name: '三楼主会场', floor: '3F', locationId: null },
      breakoutVenues: [],
      accommodations: [],
    });
  });

  it('drops invalid location IDs while preserving organizer-facing details', () => {
    const normalized = normalizeEventConfig({
      id: 'demo',
      name: '测试会议',
      mainVenue: {
        name: '三楼会议室',
        locationId: 'invented-building',
        floor: '3F',
      },
    });
    expect(normalized.mainVenue).toMatchObject({
      name: '三楼会议室',
      floor: '3F',
      locationId: null,
    });
  });

  it('persists local event overrides and keeps bundled defaults', () => {
    const values = new Map();
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
    };
    const custom = normalizeEventConfig({
      id: 'conference-a',
      name: '会议 A',
      mainVenue: { name: '主会场', locationId: 'library' },
    });
    expect(saveEventProfiles([custom], storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(EVENT_STORAGE_KEY, expect.any(String));
    const loaded = loadEventProfiles(storage);
    expect(loaded.map((event) => event.id)).toEqual([DEFAULT_EVENT_ID, 'conference-a']);
  });

  it('resolves a configured event role but blocks an unbound venue', () => {
    const [event] = defaultEventProfiles();
    expect(resolveEventNavigationQuery('带我去主会场', event)).toMatchObject({
      detected: true,
      understood: false,
      error: 'event_place_unbound',
    });

    const configured = upsertEventProfile([event], {
      ...event,
      mainVenue: { ...event.mainVenue, locationId: 'west-concourse' },
    })[0];
    expect(resolveEventNavigationQuery('带我去主会场', configured)).toMatchObject({
      understood: true,
      from: 'main-entrance',
      to: 'west-concourse',
      eventRole: 'mainVenue',
    });
  });

  it('prefers a named venue when an event role has multiple configured places', () => {
    const event = normalizeEventConfig({
      id: 'conference-b',
      name: '会议 B',
      mainVenue: { name: '主会场', locationId: 'library' },
      diningRecommendations: [
        { id: 'canteen-a', name: '中央饭堂', locationId: 'food-court' },
        { id: 'cafe-b', name: '咖啡厅', locationId: 'east-concourse' },
      ],
    });

    expect(resolveEventNavigationQuery('去推荐食堂咖啡厅', event)).toMatchObject({
      understood: true,
      to: 'east-concourse',
      eventRole: 'dining',
    });
  });

  it('tells the model which event locations remain unconfigured', () => {
    const context = eventAssistantContext(defaultEventProfiles()[0]);
    expect(context).toContain('八月真机展示活动');
    expect(context).toContain('三楼主会场');
    expect(context).toContain('地图地点未绑定');
    expect(context).toContain('无分会场');
    expect(context).toContain('无住宿地点');
  });
});
