import { NODE_BY_ID } from '../data/campus.js';
import { useI18n, localizedName } from '../lib/i18n.js';

const CATEGORY_EMOJI = {
  entrance: '🚪',
  academic: '🏛',
  indoor: '🏢',
  service: '☕',
  residence: '🏠',
  sports: '🏀',
};

/**
 * Compact "campus snapshot" strip inside the navigation card: the active
 * event plus the places the current route passes, as tappable chips. Short
 * and scannable — the voice assistant reads the full place descriptions
 * aloud while navigating.
 */
export function CampusInsights({ route, activeEvent, onSelectDestination }) {
  const { t, lang } = useI18n();
  const highlights = (route?.highlights ?? []).slice(0, 3);
  const venue = activeEvent?.mainVenue;
  const venueBound = venue?.locationId && NODE_BY_ID[venue.locationId]?.public;

  return (
    <div class="insights">
      {activeEvent ? (
        <button
          type="button"
          class="insights-event"
          disabled={!venueBound}
          onClick={() => venueBound && onSelectDestination(venue.locationId)}
          title={venueBound ? t('insights.navigateTo', { name: localizedName(NODE_BY_ID[venue.locationId], lang) }) : undefined}
        >
          <span class="insights-event-icon" aria-hidden="true">🎪</span>
          <span class="insights-event-copy">
            <strong>{activeEvent.name}</strong>
            <small>{activeEvent.dateLabel ?? t('event.dateTbd')}</small>
          </span>
          <span class="insights-event-go" aria-hidden="true">↗</span>
        </button>
      ) : (
        <p class="insights-empty">{t('insights.noEvent')}</p>
      )}

      {highlights.length > 0 && (
        <div class="insights-places" aria-label={t('insights.alongTitle')}>
          <p class="eyebrow">{t('insights.alongTitle')}</p>
          <div class="insights-chips">
            {highlights.map((item) => (
              <button
                key={item.id}
                type="button"
                class="insights-chip"
                onClick={() => onSelectDestination(item.id)}
                title={item.description ?? t('app.defaultPlaceDesc')}
              >
                <span aria-hidden="true">{CATEGORY_EMOJI[item.category] ?? '📍'}</span>
                <strong>{localizedName(item, lang)}</strong>
                <small>{item.distanceMeters}m</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <p class="insights-hint" aria-hidden="true">👂 {t('insights.alongHint')}</p>
    </div>
  );
}
