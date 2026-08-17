import { useMemo, useState } from 'preact/hooks';
import { DEFAULT_EVENT_ID } from '../data/events.js';
import { NODE_BY_ID, PUBLIC_LOCATIONS } from '../data/campus.js';
import { createBlankEvent, createEventPlace, eventPlaces } from '../lib/eventMode.js';
import { useI18n, localizedName } from '../lib/i18n.js';

const MULTI_GROUPS = [
  { key: 'breakoutVenues' },
  { key: 'accommodations' },
  { key: 'diningRecommendations' },
];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function locationMeta(place, lang) {
  const anchor = place.locationId ? localizedName(NODE_BY_ID[place.locationId], lang) : null;
  return [place.floor, place.room, anchor].filter(Boolean).join(' · ');
}

function EventPlaceCard({ roleKey, place, onNavigate }) {
  const { t, lang } = useI18n();
  if (!place) return null;
  const navigable = Boolean(NODE_BY_ID[place.locationId]?.public);
  return (
    <article class={`event-place ${roleKey === 'mainVenue' ? 'primary' : ''}`}>
      <div>
        <span>{t(`event.roles.${roleKey}`)}</span>
        <strong>{place.name}</strong>
        <small>{locationMeta(place, lang) || t('event.metaUnbound')}</small>
        {place.note && <p>{place.note}</p>}
      </div>
      <button
        type="button"
        disabled={!navigable}
        onClick={() => onNavigate(place)}
        title={navigable ? t('event.navigateTo', { name: place.name }) : t('event.bindFirst')}
      >
        {navigable ? t('event.navigate') : t('event.unbound')}
      </button>
    </article>
  );
}

function PlaceEditor({ label, place, onChange, onRemove }) {
  const { t, lang } = useI18n();
  return (
    <fieldset class="event-place-editor">
      <legend>{label}</legend>
      <div class="event-editor-grid">
        <label>
          <span>{t('event.editor.placeName')}</span>
          <input
            value={place.name}
            onInput={(event) => onChange('name', event.currentTarget.value)}
            placeholder={label}
            required
          />
        </label>
        <label>
          <span>{t('event.editor.placeLocation')}</span>
          <select
            value={place.locationId || ''}
            onChange={(event) => onChange('locationId', event.currentTarget.value || null)}
          >
            <option value="">{t('event.editor.noBind')}</option>
            {PUBLIC_LOCATIONS.map((location) => (
              <option key={location.id} value={location.id}>{localizedName(location, lang)} · {location.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('event.editor.floor')}</span>
          <input
            value={place.floor}
            onInput={(event) => onChange('floor', event.currentTarget.value)}
            placeholder={t('event.editor.floorPlaceholder')}
          />
        </label>
        <label>
          <span>{t('event.editor.room')}</span>
          <input
            value={place.room}
            onInput={(event) => onChange('room', event.currentTarget.value)}
            placeholder={t('event.editor.roomPlaceholder')}
          />
        </label>
      </div>
      <label class="event-note-field">
        <span>{t('event.editor.note')}</span>
        <textarea
          value={place.note}
          onInput={(event) => onChange('note', event.currentTarget.value)}
          placeholder={t('event.editor.notePlaceholder')}
          rows="2"
        />
      </label>
      {onRemove && (
        <button type="button" class="event-remove" onClick={onRemove}>{t('event.editor.remove')}</button>
      )}
    </fieldset>
  );
}

function EventEditor({ initialEvent, onClose, onSave, onRestore }) {
  const { t, lang } = useI18n();
  const [draft, setDraft] = useState(() => copy(initialEvent));

  function updateField(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateSinglePlace(key, field, value) {
    setDraft((current) => ({
      ...current,
      [key]: { ...current[key], [field]: value },
    }));
  }

  function updateListPlace(key, index, field, value) {
    setDraft((current) => ({
      ...current,
      [key]: current[key].map((place, placeIndex) =>
        placeIndex === index ? { ...place, [field]: value } : place),
    }));
  }

  function addListPlace(key, label) {
    setDraft((current) => ({
      ...current,
      [key]: [
        ...current[key],
        createEventPlace(`${key}-${Date.now()}`, label),
      ],
    }));
  }

  function removeListPlace(key, index) {
    setDraft((current) => ({
      ...current,
      [key]: current[key].filter((_, placeIndex) => placeIndex !== index),
    }));
  }

  function submit(event) {
    event.preventDefault();
    onSave(draft);
  }

  return (
    <div class="event-editor-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form class="event-editor" role="dialog" aria-modal="true" aria-labelledby="event-editor-title" onSubmit={submit}>
        <header>
          <div>
            <p class="eyebrow">EVENT CONFIG / LOCAL</p>
            <h2 id="event-editor-title">{t('event.editor.title')}</h2>
          </div>
          <button type="button" class="icon-button" onClick={onClose} aria-label={t('event.editor.close')}>×</button>
        </header>

        <div class="event-editor-grid event-basics">
          <label>
            <span>{t('event.editor.name')}</span>
            <input value={draft.name} onInput={(event) => updateField('name', event.currentTarget.value)} required />
          </label>
          <label>
            <span>{t('event.editor.dateLabel')}</span>
            <input value={draft.dateLabel} onInput={(event) => updateField('dateLabel', event.currentTarget.value)} placeholder={t('event.editor.datePlaceholder')} />
          </label>
        </div>
        <label class="event-note-field event-description-field">
          <span>{t('event.editor.description')}</span>
          <textarea value={draft.description} onInput={(event) => updateField('description', event.currentTarget.value)} rows="2" />
        </label>

        <PlaceEditor
          label={t('event.roles.mainVenue')}
          place={draft.mainVenue}
          onChange={(field, value) => updateSinglePlace('mainVenue', field, value)}
        />

        {draft.checkIn ? (
          <PlaceEditor
            label={t('event.roles.checkIn')}
            place={draft.checkIn}
            onChange={(field, value) => updateSinglePlace('checkIn', field, value)}
            onRemove={() => updateField('checkIn', null)}
          />
        ) : (
          <button
            type="button"
            class="event-add"
            onClick={() => updateField('checkIn', createEventPlace('check-in', '签到地点'))}
          >{t('event.editor.addCheckIn')}</button>
        )}

        {MULTI_GROUPS.map((group) => (
          <section class="event-editor-group" key={group.key}>
            {draft[group.key].map((place, index) => (
              <PlaceEditor
                key={place.id}
                label={`${t(`event.groups.${group.key}.label`)} ${index + 1}`}
                place={place}
                onChange={(field, value) => updateListPlace(group.key, index, field, value)}
                onRemove={() => removeListPlace(group.key, index)}
              />
            ))}
            <button type="button" class="event-add" onClick={() => addListPlace(group.key, t(`event.groups.${group.key}.label`))}>
              ＋ {t(`event.groups.${group.key}.addLabel`)}
            </button>
          </section>
        ))}

        <footer>
          {draft.id === DEFAULT_EVENT_ID && (
            <button type="button" class="event-reset" onClick={onRestore}>{t('event.editor.reset')}</button>
          )}
          <span />
          <button type="button" class="event-cancel" onClick={onClose}>{t('event.editor.cancel')}</button>
          <button type="submit" class="event-save">{t('event.editor.save')}</button>
        </footer>
      </form>
    </div>
  );
}

export function EventPanel({
  events,
  activeEventId,
  onSelectEvent,
  onSaveEvent,
  onRestoreDefault,
  onNavigate,
}) {
  const { t, lang } = useI18n();
  const [editing, setEditing] = useState(null);
  const activeEvent = useMemo(
    () => events.find((event) => event.id === activeEventId) || null,
    [activeEventId, events],
  );
  const groupedPlaces = activeEvent ? eventPlaces(activeEvent) : [];

  function startNewEvent() {
    setEditing(createBlankEvent(`event-${Date.now()}`));
  }

  return (
    <section class="event-panel" aria-labelledby="event-title">
      <div class="event-heading">
        <div>
          <p class="eyebrow">EVENT MODE / MANIFEST</p>
          <h2 id="event-title">{t('event.title')}</h2>
        </div>
        <span class={activeEvent ? 'event-live' : 'event-idle'}>{activeEvent ? t('event.active') : t('event.idle')}</span>
      </div>

      <div class="event-selector-row">
        <label>
          <span>{t('event.currentMode')}</span>
          <select value={activeEventId || ''} onChange={(event) => onSelectEvent(event.currentTarget.value || null)}>
            <option value="">{t('event.normalNav')}</option>
            {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={startNewEvent} title={t('event.newEvent')}>＋</button>
        <button type="button" onClick={() => activeEvent && setEditing(copy(activeEvent))} disabled={!activeEvent}>{t('event.configure')}</button>
      </div>

      {activeEvent ? (
        <div class="event-manifest" data-event-id={activeEvent.id}>
          <header>
            <span>{activeEvent.dateLabel || t('event.dateTbd')}</span>
            <strong>{activeEvent.name}</strong>
            {activeEvent.description && <p>{activeEvent.description}</p>}
          </header>

          <EventPlaceCard roleKey="mainVenue" place={activeEvent.mainVenue} onNavigate={onNavigate} />

          <div class="event-role-list">
            {groupedPlaces.filter(({ role }) => role !== 'mainVenue').map(({ role, place }) => (
              <EventPlaceCard key={`${role}-${place.id}`} roleKey={role} place={place} onNavigate={onNavigate} />
            ))}
            {!activeEvent.checkIn && <p><span>{t('event.roles.checkIn')}</span><b>{t('event.roleEmpty.checkIn')}</b></p>}
            {!activeEvent.breakoutVenues.length && <p><span>{t('event.roles.breakoutVenue')}</span><b>{t('event.roleEmpty.breakoutVenue')}</b></p>}
            {!activeEvent.accommodations.length && <p><span>{t('event.roles.accommodation')}</span><b>{t('event.roleEmpty.accommodation')}</b></p>}
            {!activeEvent.diningRecommendations.length && <p><span>{t('event.roles.dining')}</span><b>{t('event.roleEmpty.dining')}</b></p>}
          </div>
          <small class="event-storage-note">{t('event.storageNote')}</small>
        </div>
      ) : (
        <p class="event-empty">{t('event.empty')}</p>
      )}

      {editing && (
        <EventEditor
          initialEvent={editing}
          onClose={() => setEditing(null)}
          onSave={(event) => {
            onSaveEvent(event);
            setEditing(null);
          }}
          onRestore={() => {
            onRestoreDefault(editing.id);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}
