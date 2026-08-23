import { useState } from 'preact/hooks';
import { useI18n } from '../lib/i18n.js';

/**
 * Top-bar car status badge: live car state from the car7 status server.
 * Green dot = car online; shows RTK fix label, fixed-record count and a
 * click-through detail popover (records / road network / speed / heading).
 */
export function CarStatusBadge({ status }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const data = status?.data;
  const fixLabel = data?.fixLabel;
  const fixClass = fixLabel === 'RTK 固定解' || fixLabel === 'RTK fixed'
    ? 'ok' : (fixLabel && fixLabel !== '无信号' ? 'warn' : 'bad');

  return (
    <div class={`car-status-badge ${status?.online ? 'online' : 'offline'}`}>
      <button
        type="button"
        class="car-status-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={status?.online ? t('carStatus.onlineTitle') : t('carStatus.offlineTitle')}
      >
        <i class="car-status-dot" />
        <span class="car-status-text">
          {status?.online ? t('carStatus.online') : t('carStatus.offline')}
          {status?.online && data && (
            <small class={`car-status-fix ${fixClass}`}>{fixLabel ?? '—'}</small>
          )}
        </span>
      </button>

      {open && status?.online && data && (
        <div class="car-status-popover" role="dialog" aria-label={t('carStatus.detailAria')}>
          <div class="car-status-row">
            <span>{t('carStatus.rtk')}</span>
            <strong class={`car-status-fix ${fixClass}`}>{fixLabel ?? '—'}</strong>
          </div>
          <div class="car-status-row">
            <span>{t('carStatus.position')}</span>
            <strong>
              {data.rtk?.latitude != null && data.rtk?.longitude != null
                ? `${data.rtk.latitude.toFixed(6)}, ${data.rtk.longitude.toFixed(6)}`
                : '—'}
            </strong>
          </div>
          <div class="car-status-row">
            <span>{t('carStatus.speed')}</span>
            <strong>{data.speedMetersPerSecond != null ? `${data.speedMetersPerSecond.toFixed(2)} m/s` : '—'}</strong>
          </div>
          <div class="car-status-row">
            <span>{t('carStatus.records')}</span>
            <strong>{data.jsonl?.records ?? 0}</strong>
          </div>
          <div class="car-status-row">
            <span>{t('carStatus.roadnet')}</span>
            <strong>{data.roadnet ? `${data.roadnet.nodes ?? 0} / ${data.roadnet.edges ?? 0}` : '—'}</strong>
          </div>
          <div class="car-status-row">
            <span>{t('carStatus.updated')}</span>
            <strong>{status.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</strong>
          </div>
          <small class="car-status-hint">{t('carStatus.dashboardHint')}</small>
        </div>
      )}
    </div>
  );
}
