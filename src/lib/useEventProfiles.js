import { useEffect, useMemo, useState } from 'preact/hooks';
import { DEFAULT_EVENT_ID } from '../data/events.js';
import {
  loadEventProfiles,
  normalizeEventConfig,
  restoreDefaultEvent,
  saveEventProfiles,
  upsertEventProfile,
} from './eventMode.js';

/**
 * Event profile CRUD + active-event state for the App shell.
 *
 * All data shaping lives in the pure `eventMode.js` functions; this hook is
 * only the glue: it loads profiles once, exposes save/restore (persisting to
 * localStorage), tracks the active event id (initialized from the `event`
 * URL param) and mirrors it back into the URL.
 */
export function useEventProfiles(params) {
  const [events, setEvents] = useState(() => loadEventProfiles(window.localStorage));
  const [activeEventId, setActiveEventId] = useState(() => {
    const requestedEventId = params.get('event');
    if (requestedEventId === 'none') return null;
    return events.some((event) => event.id === requestedEventId)
      ? requestedEventId
      : DEFAULT_EVENT_ID;
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('event', activeEventId || 'none');
    window.history.replaceState({}, '', url);
  }, [activeEventId]);

  const activeEvent = useMemo(
    () => events.find((event) => event.id === activeEventId) || null,
    [activeEventId, events],
  );

  function saveEvent(input) {
    const event = normalizeEventConfig(input);
    if (!event) return;
    setEvents((current) => {
      const next = upsertEventProfile(current, event);
      saveEventProfiles(next, window.localStorage);
      return next;
    });
    setActiveEventId(event.id);
  }

  function restoreDefault(eventId) {
    setEvents((current) => {
      const next = restoreDefaultEvent(current, eventId);
      saveEventProfiles(next, window.localStorage);
      return next;
    });
  }

  return {
    events,
    activeEventId,
    activeEvent,
    setActiveEventId,
    saveEvent,
    restoreDefault,
  };
}
