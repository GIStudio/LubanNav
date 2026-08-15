import { DEFAULT_EVENT_ID, DEFAULT_EVENTS, EVENT_SCHEMA_VERSION } from '../data/events.js';
import { MODES, NODE_BY_ID } from '../data/campus.js';

export const EVENT_STORAGE_KEY = 'lubannav.event-profiles.v1';

const MULTI_PLACE_KEYS = ['breakoutVenues', 'accommodations', 'diningRecommendations'];

function cleanText(value, maxLength = 160) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedPlace(place, fallbackId) {
  if (!place || typeof place !== 'object') return null;
  const name = cleanText(place.name, 80);
  if (!name) return null;
  const locationId = cleanText(place.locationId, 80);
  return {
    id: cleanText(place.id, 80) || fallbackId,
    name,
    locationId: NODE_BY_ID[locationId]?.public ? locationId : null,
    floor: cleanText(place.floor, 30),
    room: cleanText(place.room, 60),
    note: cleanText(place.note, 240),
  };
}

export function createEventPlace(id, name = '') {
  return { id, name, locationId: null, floor: '', room: '', note: '' };
}

export function createBlankEvent(id = `event-${Date.now()}`) {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id,
    name: '新活动',
    dateLabel: '',
    description: '',
    mainVenue: createEventPlace('main-venue', '主会场'),
    checkIn: null,
    breakoutVenues: [],
    accommodations: [],
    diningRecommendations: [],
  };
}

export function normalizeEventConfig(input, fallbackId = `event-${Date.now()}`) {
  if (!input || typeof input !== 'object') return null;
  const name = cleanText(input.name, 100);
  const mainVenue = normalizedPlace(input.mainVenue, 'main-venue');
  if (!name || !mainVenue) return null;

  const event = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: cleanText(input.id, 100) || fallbackId,
    name,
    dateLabel: cleanText(input.dateLabel, 80),
    description: cleanText(input.description, 300),
    mainVenue,
    checkIn: normalizedPlace(input.checkIn, 'check-in'),
  };

  for (const key of MULTI_PLACE_KEYS) {
    event[key] = Array.isArray(input[key])
      ? input[key]
        .map((place, index) => normalizedPlace(place, `${key}-${index + 1}`))
        .filter(Boolean)
      : [];
  }
  return event;
}

export function defaultEventProfiles() {
  return DEFAULT_EVENTS.map((event) => normalizeEventConfig(clone(event), event.id));
}

export function loadEventProfiles(storage = globalThis.localStorage) {
  const defaults = defaultEventProfiles();
  if (!storage?.getItem) return defaults;

  try {
    const saved = JSON.parse(storage.getItem(EVENT_STORAGE_KEY) || '[]');
    if (!Array.isArray(saved)) return defaults;
    const normalized = saved
      .map((event, index) => normalizeEventConfig(event, `saved-event-${index + 1}`))
      .filter(Boolean);
    if (!normalized.length) return defaults;

    const byId = new Map(defaults.map((event) => [event.id, event]));
    normalized.forEach((event) => byId.set(event.id, event));
    return [...byId.values()];
  } catch {
    return defaults;
  }
}

export function saveEventProfiles(events, storage = globalThis.localStorage) {
  if (!storage?.setItem) return false;
  const normalized = Array.isArray(events)
    ? events.map((event, index) => normalizeEventConfig(event, `event-${index + 1}`)).filter(Boolean)
    : [];
  storage.setItem(EVENT_STORAGE_KEY, JSON.stringify(normalized));
  return true;
}

export function upsertEventProfile(events, input) {
  const event = normalizeEventConfig(input);
  if (!event) return events;
  const next = [...events];
  const index = next.findIndex((item) => item.id === event.id);
  if (index >= 0) next[index] = event;
  else next.push(event);
  return next;
}

export function restoreDefaultEvent(events, eventId = DEFAULT_EVENT_ID) {
  const defaultEvent = defaultEventProfiles().find((event) => event.id === eventId);
  if (!defaultEvent) return events;
  return upsertEventProfile(events, defaultEvent);
}

export function eventPlaces(event) {
  if (!event) return [];
  return [
    { role: 'mainVenue', roleLabel: '主会场', place: event.mainVenue },
    { role: 'checkIn', roleLabel: '签到地点', place: event.checkIn },
    ...(event.breakoutVenues || []).map((place) => ({ role: 'breakoutVenue', roleLabel: '分会场', place })),
    ...(event.accommodations || []).map((place) => ({ role: 'accommodation', roleLabel: '住宿地点', place })),
    ...(event.diningRecommendations || []).map((place) => ({ role: 'dining', roleLabel: '推荐食堂', place })),
  ].filter((item) => item.place);
}

function compact(value) {
  return String(value ?? '').toLowerCase().replace(/[\s，。！？、,.!?：:；;（）()\-_/]/g, '');
}

function roleRequested(query, role) {
  const text = compact(query);
  if (role === 'mainVenue') return /主会场|大会场/.test(text);
  if (role === 'checkIn') return /签到|报到/.test(text);
  if (role === 'breakoutVenue') return /分会场/.test(text);
  if (role === 'accommodation') return /住宿|住哪里|酒店/.test(text);
  if (role === 'dining') return /推荐食堂|推荐饭堂|吃饭|用餐/.test(text);
  return false;
}

export function resolveEventNavigationQuery(
  query,
  event,
  currentOrigin = 'main-entrance',
  currentMode = 'pedestrian',
) {
  if (!event) return { detected: false, understood: false };
  const text = compact(query);
  const places = eventPlaces(event);
  const roleMatches = places.filter(({ role }) => roleRequested(text, role));
  const nameMatches = places.filter(({ place }) => text.includes(compact(place.name)));
  const candidates = nameMatches.length ? nameMatches : roleMatches;
  const detected = candidates.length > 0
    || /主会场|分会场|签到|报到|住宿|住哪里|酒店|推荐食堂|推荐饭堂|吃饭|用餐/.test(text);
  if (!detected) return { detected: false, understood: false };

  const available = candidates.filter(({ place }) => NODE_BY_ID[place.locationId]?.public);
  if (available.length !== 1) {
    return {
      detected: true,
      understood: false,
      error: available.length > 1 ? 'ambiguous_event_place' : 'event_place_unbound',
    };
  }

  const robot = /机器人|robot|轮椅|无障碍/.test(text);
  const mode = robot ? 'robot' : (MODES[currentMode] ? currentMode : 'pedestrian');
  return {
    detected: true,
    understood: true,
    intent: 'navigate',
    from: NODE_BY_ID[currentOrigin]?.public ? currentOrigin : 'main-entrance',
    to: available[0].place.locationId,
    mode,
    eventId: event.id,
    eventRole: available[0].role,
  };
}

export function eventAssistantContext(event) {
  if (!event) return '当前未启用活动模式。';
  const details = eventPlaces(event).map(({ roleLabel, place }) => {
    const anchor = place.locationId
      ? `${NODE_BY_ID[place.locationId].name}（${place.locationId}）`
      : '地图地点未绑定';
    const indoor = [place.floor, place.room].filter(Boolean).join(' · ');
    return `${roleLabel}：${place.name}${indoor ? `，${indoor}` : ''}，${anchor}`;
  });
  const emptyRoles = [];
  if (!event.checkIn) emptyRoles.push('签到地点未设置');
  if (!event.breakoutVenues?.length) emptyRoles.push('无分会场');
  if (!event.accommodations?.length) emptyRoles.push('无住宿地点');
  if (!event.diningRecommendations?.length) emptyRoles.push('推荐食堂未设置');
  return [
    `当前活动：${event.name}${event.dateLabel ? `（${event.dateLabel}）` : ''}。`,
    ...details,
    ...emptyRoles,
    '只有已绑定地图地点的活动场所才能调用 set_navigation_route；未绑定时应说明并请组织者配置，不得猜测地点 ID。',
  ].join('\n');
}
