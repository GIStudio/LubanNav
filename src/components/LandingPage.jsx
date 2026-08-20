import { useEffect, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CAMPUS_BOUNDS } from '../data/campus.js';
import { addIndoorLayers, addOsmLayers } from '../lib/mapLayers.js';
import { useI18n } from '../lib/i18n.js';
import { useTheme } from '../lib/theme.js';
import { useVoiceSession } from '../lib/voiceSession.js';
import { fetchWeather } from '../lib/weather.js';

const OSM_DATA_URL = `${import.meta.env.BASE_URL}data/campus-osm.geojson`;
const INDOOR_DATA_URL = `${import.meta.env.BASE_URL}data/campus-indoor.geojson`;
const CAMPUS_CENTER = [22.8902, 113.4791];

/** Weather-code → emoji for the landing card. */
function weatherEmoji(code, isDay) {
  if (code == null) return '🌡';
  if (code === 0) return isDay === false ? '🌙' : '☀️';
  if (code === 1) return isDay === false ? '🌙' : '🌤';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫';
  if (code === 51 || code === 53 || code === 55 || code === 56 || code === 57) return '🌦';
  if (code === 61 || code === 63 || code === 65 || code === 66 || code === 67) return '🌧';
  if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) return '🌨';
  if (code === 80 || code === 81 || code === 82) return '🌦';
  if (code >= 95) return '⛈';
  return '🌡';
}

/**
 * Voice-first welcome screen (phase 1 of the two-phase UI).
 *
 * A blurred, non-interactive Leaflet campus map sits behind a spacious hero
 * with one big microphone button; the shared voice session handles
 * recognition, so saying a destination navigates straight into the app.
 * Weather and the "bag on the robot" reminder appear as prominent cards.
 */
export function LandingPage({ onEnter, onConfigureVoice }) {
  const { t, lang, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const {
    status,
    statusMessage,
    liveTranscript,
    configured,
    supported,
    active,
    start,
    stop,
  } = useVoiceSession();
  const [weather, setWeather] = useState(null);
  const bgRef = useRef(null);
  const mapRef = useRef(null);

  // Blurred background campus map (read-only, no interactions).
  useEffect(() => {
    if (!bgRef.current || mapRef.current) return undefined;

    const map = L.map(bgRef.current, {
      attributionControl: false,
      center: CAMPUS_CENTER,
      zoom: 16.5,
      minZoom: 15,
      maxZoom: 18,
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      touchZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      preferCanvas: true,
    });
    map.createPane('waterPane').style.zIndex = 220;
    map.createPane('roadPane').style.zIndex = 260;
    map.createPane('roadDetailPane').style.zIndex = 270;
    map.createPane('buildingPane').style.zIndex = 320;
    map.createPane('indoorPane').style.zIndex = 380;
    map.fitBounds(CAMPUS_BOUNDS, { padding: [24, 24] });
    mapRef.current = map;

    Promise.all(
      [OSM_DATA_URL, INDOOR_DATA_URL].map((url) =>
        fetch(url).then((response) => {
          if (!response.ok) throw new Error(`${url} ${response.status}`);
          return response.json();
        }),
      ),
    )
      .then(([osmData, indoorData]) => {
        addOsmLayers(map, osmData);
        addIndoorLayers(map, indoorData);
      })
      .catch((error) => {
        console.error(error);
      });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWeather().then((result) => {
      if (!cancelled) setWeather(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsConfiguration = !configured || !supported;
  const headline = active
    ? (t(`voiceQuick.status.${status}`) || t('landing.micReady'))
    : (needsConfiguration ? t('landing.micConfig') : t('landing.micReady'));
  const detail = liveTranscript
    || (active ? statusMessage : '')
    || t('landing.hint');
  const actionLabel = active
    ? t('landing.micStop')
    : (needsConfiguration ? t('landing.micConfig') : t('landing.micReady'));

  function handleMic() {
    if (active) {
      stop();
      return;
    }
    if (needsConfiguration) {
      onConfigureVoice();
      return;
    }
    start();
  }

  const weatherTips = [];
  if (weather?.available) {
    if (weather.umbrella) weatherTips.push(t('landing.weatherUmbrella'));
    if (weather.sunscreen) weatherTips.push(t('landing.weatherSunscreen'));
    if (weather.thunderstorm) weatherTips.push(t('landing.weatherThunder'));
    if (weather.cold) weatherTips.push(t('landing.weatherCold'));
    if (!weatherTips.length) weatherTips.push(t('landing.weatherCalm'));
  }

  return (
    <div class="landing-page">
      <div class="landing-map-bg" aria-hidden="true" ref={bgRef} />
      <div class="landing-veil" aria-hidden="true" />

      <header class="landing-topbar">
        <a class="brand" href="./" aria-label={t('topbar.homeAria')}>
          <span class="brand-mark">LN</span>
          <span>
            <strong>LUBAN NAV</strong>
            <small>HKUST(GZ) CAMPUS</small>
          </span>
        </a>
        <div class="topbar-actions">
          <button
            type="button"
            class="pref-toggle"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={t('topbar.langToggle')}
            aria-label={t('topbar.langToggle')}
          >
            {t('topbar.langLabel')}
          </button>
          <button
            type="button"
            class="pref-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? t('topbar.themeToLight') : t('topbar.themeToDark')}
            aria-label={theme === 'dark' ? t('topbar.themeToLight') : t('topbar.themeToDark')}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
        </div>
      </header>

      <main class="landing-main">
        <div class="landing-hero">
          <p class="eyebrow">{t('landing.eyebrow')}</p>
          <h1>{t('landing.title')}</h1>
          <p>{t('landing.titleSub')}</p>
        </div>

        <div class="landing-mic-zone">
          <button
            type="button"
            class={`landing-mic ${active ? 'active' : ''} ${needsConfiguration ? 'needs-config' : ''}`}
            onClick={handleMic}
            aria-label={t('landing.micAria')}
            aria-pressed={active}
            title={actionLabel}
          >
            <span class="landing-mic-rings" aria-hidden="true" />
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75V6.25a3.75 3.75 0 0 0-7.5 0v5.25A3.75 3.75 0 0 0 12 15.25Z" />
              <path d="M5.75 11.25v.25a6.25 6.25 0 0 0 12.5 0v-.25M12 17.75v3M9.25 20.75h5.5" />
            </svg>
          </button>
          <p class="landing-mic-status" role="status" aria-live="polite">{headline}</p>
          <p class="landing-mic-detail" aria-live="polite">{detail}</p>
        </div>

        <div class="landing-cards">
          <article class="landing-card">
            <span class="landing-card-icon" aria-hidden="true">
              {weather?.available ? weatherEmoji(weather.conditionCode, weather.isDay) : '🌤'}
            </span>
            <div>
              <strong>{t('landing.weatherCard')}</strong>
              <p class="landing-card-main">
                {weather?.available
                  ? `${Math.round(weather.temperatureC)}°C · ${weather.conditionLabel}`
                  : t('landing.weatherUnavailable')}
              </p>
              {weather?.available && weatherTips.length > 0 && (
                <p class="landing-card-tip">{weatherTips.join(' · ')}</p>
              )}
            </div>
          </article>

          <article class="landing-card">
            <span class="landing-card-icon" aria-hidden="true">🎒</span>
            <div>
              <strong>{t('landing.bagTitle')}</strong>
              <p class="landing-card-main">{t('landing.bagText')}</p>
              <p class="landing-card-tip">{t('landing.bagHint')}</p>
            </div>
          </article>
        </div>

        <button type="button" class="landing-enter" onClick={onEnter} aria-label={t('landing.enterAria')}>
          {t('landing.enterDirectly')} <span aria-hidden="true">→</span>
        </button>
      </main>

      <p class="landing-footer">
        {t('footer.disclaimer')}
      </p>
    </div>
  );
}
