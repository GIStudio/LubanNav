import { useMemo, useState } from 'preact/hooks';
import { DEFAULT_EVENT_ID } from '../data/events.js';
import { NODE_BY_ID, PUBLIC_LOCATIONS } from '../data/campus.js';
import { createBlankEvent, createEventPlace, eventPlaces } from '../lib/eventMode.js';

const MULTI_GROUPS = [
  { key: 'breakoutVenues', label: '分会场', addLabel: '添加分会场', empty: '本活动不设分会场' },
  { key: 'accommodations', label: '住宿地点', addLabel: '添加住宿', empty: '本活动不提供住宿' },
  { key: 'diningRecommendations', label: '推荐食堂', addLabel: '添加食堂', empty: '尚未推荐食堂' },
];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function locationMeta(place) {
  const anchor = place.locationId ? NODE_BY_ID[place.locationId]?.name : null;
  return [place.floor, place.room, anchor].filter(Boolean).join(' · ') || '地图地点待绑定';
}

function EventPlaceCard({ role, place, onNavigate }) {
  if (!place) return null;
  const navigable = Boolean(NODE_BY_ID[place.locationId]?.public);
  return (
    <article class={`event-place ${role === '主会场' ? 'primary' : ''}`}>
      <div>
        <span>{role}</span>
        <strong>{place.name}</strong>
        <small>{locationMeta(place)}</small>
        {place.note && <p>{place.note}</p>}
      </div>
      <button
        type="button"
        disabled={!navigable}
        onClick={() => onNavigate(place)}
        title={navigable ? `导航到${place.name}` : '请先在活动配置中绑定地图地点'}
      >
        {navigable ? '导航 ↗' : '待绑定'}
      </button>
    </article>
  );
}

function PlaceEditor({ label, place, onChange, onRemove }) {
  return (
    <fieldset class="event-place-editor">
      <legend>{label}</legend>
      <div class="event-editor-grid">
        <label>
          <span>显示名称</span>
          <input
            value={place.name}
            onInput={(event) => onChange('name', event.currentTarget.value)}
            placeholder={label}
            required
          />
        </label>
        <label>
          <span>地图地点</span>
          <select
            value={place.locationId || ''}
            onChange={(event) => onChange('locationId', event.currentTarget.value || null)}
          >
            <option value="">暂不绑定</option>
            {PUBLIC_LOCATIONS.map((location) => (
              <option key={location.id} value={location.id}>{location.name} · {location.id}</option>
            ))}
          </select>
        </label>
        <label>
          <span>楼层</span>
          <input
            value={place.floor}
            onInput={(event) => onChange('floor', event.currentTarget.value)}
            placeholder="例如 3F"
          />
        </label>
        <label>
          <span>房间</span>
          <input
            value={place.room}
            onInput={(event) => onChange('room', event.currentTarget.value)}
            placeholder="例如 301"
          />
        </label>
      </div>
      <label class="event-note-field">
        <span>现场说明</span>
        <textarea
          value={place.note}
          onInput={(event) => onChange('note', event.currentTarget.value)}
          placeholder="门口、楼层转换或集合说明"
          rows="2"
        />
      </label>
      {onRemove && (
        <button type="button" class="event-remove" onClick={onRemove}>移除此项</button>
      )}
    </fieldset>
  );
}

function EventEditor({ initialEvent, onClose, onSave, onRestore }) {
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
            <h2 id="event-editor-title">配置活动模式</h2>
          </div>
          <button type="button" class="icon-button" onClick={onClose} aria-label="关闭活动配置">×</button>
        </header>

        <div class="event-editor-grid event-basics">
          <label>
            <span>活动名称</span>
            <input value={draft.name} onInput={(event) => updateField('name', event.currentTarget.value)} required />
          </label>
          <label>
            <span>日期标签</span>
            <input value={draft.dateLabel} onInput={(event) => updateField('dateLabel', event.currentTarget.value)} placeholder="例如 2026 年 8 月" />
          </label>
        </div>
        <label class="event-note-field event-description-field">
          <span>活动说明</span>
          <textarea value={draft.description} onInput={(event) => updateField('description', event.currentTarget.value)} rows="2" />
        </label>

        <PlaceEditor
          label="主会场"
          place={draft.mainVenue}
          onChange={(field, value) => updateSinglePlace('mainVenue', field, value)}
        />

        {draft.checkIn ? (
          <PlaceEditor
            label="签到地点"
            place={draft.checkIn}
            onChange={(field, value) => updateSinglePlace('checkIn', field, value)}
            onRemove={() => updateField('checkIn', null)}
          />
        ) : (
          <button
            type="button"
            class="event-add"
            onClick={() => updateField('checkIn', createEventPlace('check-in', '签到地点'))}
          >＋ 添加签到地点</button>
        )}

        {MULTI_GROUPS.map((group) => (
          <section class="event-editor-group" key={group.key}>
            {draft[group.key].map((place, index) => (
              <PlaceEditor
                key={place.id}
                label={`${group.label} ${index + 1}`}
                place={place}
                onChange={(field, value) => updateListPlace(group.key, index, field, value)}
                onRemove={() => removeListPlace(group.key, index)}
              />
            ))}
            <button type="button" class="event-add" onClick={() => addListPlace(group.key, group.label)}>
              ＋ {group.addLabel}
            </button>
          </section>
        ))}

        <footer>
          {draft.id === DEFAULT_EVENT_ID && (
            <button type="button" class="event-reset" onClick={onRestore}>恢复仓库默认值</button>
          )}
          <span />
          <button type="button" class="event-cancel" onClick={onClose}>取消</button>
          <button type="submit" class="event-save">保存到当前浏览器</button>
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
          <h2 id="event-title">活动专属导航</h2>
        </div>
        <span class={activeEvent ? 'event-live' : 'event-idle'}>{activeEvent ? 'ACTIVE' : 'OFF'}</span>
      </div>

      <div class="event-selector-row">
        <label>
          <span>当前模式</span>
          <select value={activeEventId || ''} onChange={(event) => onSelectEvent(event.currentTarget.value || null)}>
            <option value="">普通校园导航</option>
            {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={startNewEvent} title="新增本地活动">＋</button>
        <button type="button" onClick={() => activeEvent && setEditing(copy(activeEvent))} disabled={!activeEvent}>配置</button>
      </div>

      {activeEvent ? (
        <div class="event-manifest" data-event-id={activeEvent.id}>
          <header>
            <span>{activeEvent.dateLabel || '日期待定'}</span>
            <strong>{activeEvent.name}</strong>
            {activeEvent.description && <p>{activeEvent.description}</p>}
          </header>

          <EventPlaceCard role="主会场" place={activeEvent.mainVenue} onNavigate={onNavigate} />

          <div class="event-role-list">
            {groupedPlaces.filter(({ role }) => role !== 'mainVenue').map(({ roleLabel, place }) => (
              <EventPlaceCard key={`${roleLabel}-${place.id}`} role={roleLabel} place={place} onNavigate={onNavigate} />
            ))}
            {!activeEvent.checkIn && <p><span>签到地点</span><b>待配置</b></p>}
            {!activeEvent.breakoutVenues.length && <p><span>分会场</span><b>不设置</b></p>}
            {!activeEvent.accommodations.length && <p><span>住宿地点</span><b>不提供</b></p>}
            {!activeEvent.diningRecommendations.length && <p><span>推荐食堂</span><b>待配置</b></p>}
          </div>
          <small class="event-storage-note">自定义配置仅保存在当前浏览器；仓库默认活动可由静态 API 读取。</small>
        </div>
      ) : (
        <p class="event-empty">当前使用普通校园导航。选择活动后，可直接查看并导航到会场、签到、住宿和推荐餐饮地点。</p>
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
