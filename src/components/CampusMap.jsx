import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CAMPUS_BOUNDS, PUBLIC_LOCATIONS } from '../data/campus.js';
import { addIndoorLayers, addLocalNavLayers, addOsmLayers } from '../lib/mapLayers.js';
import { getLocationBinding } from '../lib/pathfinding.js';
import { useI18n, localizedName } from '../lib/i18n.js';

const CATEGORY_IDS = ['entrance', 'academic', 'indoor', 'service', 'residence', 'sports'];

const OSM_DATA_URL = `${import.meta.env.BASE_URL}data/campus-osm.geojson`;
const INDOOR_DATA_URL = `${import.meta.env.BASE_URL}data/campus-indoor.geojson`;
const LOCAL_NAV_DATA_URL = `${import.meta.env.BASE_URL}data/campus-local-nav.geojson`;
const CAMPUS_CENTER = [22.8902, 113.4791];

function locationLatLng(location, modeId) {
  const binding = getLocationBinding(location.id);
  if (binding?.indoorRoute?.modes.includes(modeId) && binding.destination) {
    return [binding.destination.latitude, binding.destination.longitude];
  }
  if (binding) return [binding.entrance.latitude, binding.entrance.longitude];
  return [location.latitude, location.longitude];
}

function indoorRoutePoints(path) {
  const indoorIndexes = path
    .map((point, index) => (point.indoor === true ? index : -1))
    .filter((index) => index >= 0);
  if (!indoorIndexes.length) return [];
  const start = Math.max(0, Math.min(...indoorIndexes) - 1);
  const end = Math.min(path.length, Math.max(...indoorIndexes) + 2);
  return path.slice(start, end);
}

export function CampusMap({
  route,
  destination,
  robotPosition,
  browserPosition,
  positionSource,
  onSelectDestination,
  trajectory,          // [{lat, lon, t}] — the car's recorded RTK trajectory line
  trajectoryPlaying,   // boolean — highlight a point along the trajectory
  trajectoryIndex,     // number — index into trajectory to highlight
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const trajectoryLayerRef = useRef(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [mapStatus, setMapStatus] = useState('loading');
  const [zoom, setZoom] = useState(17);
  const { t, lang } = useI18n();

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;

    const map = L.map(containerRef.current, {
      attributionControl: false,
      center: CAMPUS_CENTER,
      zoom: 17,
      minZoom: 16,
      maxZoom: 21,
      zoomControl: false,
      preferCanvas: true,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
      maxBounds: L.latLngBounds(CAMPUS_BOUNDS).pad(0.2),
    });
    map.createPane('waterPane').style.zIndex = 220;
    map.createPane('roadPane').style.zIndex = 260;
    map.createPane('roadDetailPane').style.zIndex = 270;
    map.createPane('buildingPane').style.zIndex = 320;
    map.createPane('indoorPane').style.zIndex = 380;
    map.createPane('routePane').style.zIndex = 430;
    map.createPane('locationPane').style.zIndex = 470;
    map.fitBounds(CAMPUS_BOUNDS, { padding: [28, 28] });
    map.on('zoomend', () => setZoom(map.getZoom()));

    mapRef.current = map;
    markerLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    trajectoryLayerRef.current = L.layerGroup().addTo(map);

    Promise.all(
      [OSM_DATA_URL, INDOOR_DATA_URL, LOCAL_NAV_DATA_URL].map((url) =>
        fetch(url).then((response) => {
          if (!response.ok) throw new Error(`${url} ${response.status}`);
          return response.json();
        }),
      ),
    )
      .then(([osmData, indoorData, localNavData]) => {
        addOsmLayers(map, osmData);
        addIndoorLayers(map, indoorData);
        addLocalNavLayers(map, localNavData);
        setMapStatus('ready');
      })
      .catch((error) => {
        console.error(error);
        setMapStatus('error');
      });

    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    PUBLIC_LOCATIONS.filter(
      (location) => selectedCategory === 'all' || location.category === selectedCategory,
    ).forEach((location) => {
      const selected = destination === location.id;
      const elevator = location.poiType === 'elevator';
      const platform = location.poiType === 'platform';
      const marker = L.circleMarker(locationLatLng(location, route?.request.mode), {
        pane: 'locationPane',
        radius: selected ? 8.5 : (elevator ? 7 : 5.5),
        color: selected || elevator ? '#071c2c' : '#79ded5',
        weight: selected ? 3 : 2,
        fillColor: selected ? '#b9f227' : (elevator ? '#ff9d63' : (platform ? '#d7ff6d' : '#0d3142')),
        fillOpacity: 1,
      });
      marker.bindTooltip(localizedName(location, lang), {
        className: selected ? 'location-tooltip selected' : 'location-tooltip',
        direction: 'top',
        offset: [0, -8],
        permanent: selected,
      });
      marker.on('click', () => onSelectDestination(location.id));
      marker.addTo(layer);
    });

    if (robotPosition) {
      const robotMarker = L.circleMarker(
        [robotPosition.latitude, robotPosition.longitude],
        {
          pane: 'locationPane',
          radius: 9,
          color: '#071c2c',
          weight: 3,
          fillColor: '#ff9d63',
          fillOpacity: 1,
        },
      );
      robotMarker
        .bindTooltip(
          `${t('map.robotHere')}${robotPosition.headingDegrees == null ? '' : ` · ${Math.round(robotPosition.headingDegrees)}°`}`,
          {
            className: 'location-tooltip robot',
            direction: 'top',
            offset: [0, -10],
            permanent: true,
          },
        )
        .addTo(layer);
    }

    if (browserPosition) {
      const browserMarker = L.circleMarker(
        [browserPosition.latitude, browserPosition.longitude],
        {
          pane: 'locationPane',
          radius: 7,
          color: '#3a86ff',
          weight: 2,
          fillColor: '#3a86ff',
          fillOpacity: 0.45,
          dashArray: '3 3',
        },
      );
      browserMarker
        .bindTooltip(t('map.browserHere'), {
          className: 'location-tooltip browser',
          direction: 'bottom',
          offset: [0, 10],
          permanent: true,
        })
        .addTo(layer);
    }
  }, [browserPosition, destination, lang, onSelectDestination, positionSource, robotPosition, route?.request.mode, selectedCategory]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = routeLayerRef.current;
    if (!map || !layer || !route?.path.length) return;
    layer.clearLayers();

    const latLngs = route.path.map((node) => [node.latitude, node.longitude]);
    L.polyline(latLngs, {
      pane: 'routePane',
      color: '#b9f227',
      opacity: 0.2,
      weight: 16,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(layer);

    L.polyline(latLngs, {
      pane: 'routePane',
      color: '#b9f227',
      opacity: 1,
      weight: 5,
      dashArray: '12 9',
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(layer);
    const indoorPoints = indoorRoutePoints(route.path);
    if (indoorPoints.length) {
      const indoorLatLngs = indoorPoints.map((point) => [point.latitude, point.longitude]);
      L.polyline(indoorLatLngs, {
        pane: 'routePane',
        color: '#79ded5',
        opacity: 0.34,
        weight: 14,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      }).addTo(layer);
      L.polyline(indoorLatLngs, {
        pane: 'routePane',
        color: '#b9f227',
        opacity: 1,
        weight: 6,
        lineCap: 'round',
        lineJoin: 'round',
      })
        .bindTooltip(
          t('map.indoorTooltip', {
            level: route.routing.destination.selectedDestination.level ?? route.routing.origin.selectedDestination.level ?? '?',
          }),
          { className: 'osm-feature-tooltip', sticky: true },
        )
        .addTo(layer);
    }
    L.circleMarker(latLngs[0], {
      pane: 'routePane',
      radius: 8,
      color: '#071c2c',
      weight: 3,
      fillColor: '#79ded5',
      fillOpacity: 1,
      interactive: false,
    }).addTo(layer);
    L.circleMarker(latLngs[latLngs.length - 1], {
      pane: 'routePane',
      radius: 9,
      color: '#071c2c',
      weight: 3,
      fillColor: '#b9f227',
      fillOpacity: 1,
      interactive: false,
    }).addTo(layer);

    map.fitBounds(L.latLngBounds(latLngs), {
      paddingTopLeft: [55, 70],
      paddingBottomRight: [55, 70],
      maxZoom: 18.25,
      animate: true,
    });
  }, [route, lang]);

  // Car's recorded RTK trajectory (green line) + optional live replay point.
  useEffect(() => {
    const map = mapRef.current;
    const layer = trajectoryLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!trajectory?.length) return;
    const latLngs = trajectory.map((point) => [point.lat, point.lon]);
    L.polyline(latLngs, {
      pane: 'locationPane',
      color: '#3ecf8e',
      opacity: 0.3,
      weight: 14,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(layer);
    L.polyline(latLngs, {
      pane: 'locationPane',
      color: '#3ecf8e',
      opacity: 1,
      weight: 4,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(layer);
    L.circleMarker(latLngs[0], {
      pane: 'locationPane',
      radius: 7,
      color: '#071c2c',
      weight: 3,
      fillColor: '#3ecf8e',
      fillOpacity: 1,
      interactive: false,
    }).addTo(layer);
    L.circleMarker(latLngs[latLngs.length - 1], {
      pane: 'locationPane',
      radius: 8,
      color: '#071c2c',
      weight: 3,
      fillColor: '#e35d6a',
      fillOpacity: 1,
      interactive: false,
    }).addTo(layer);
    // highlight the current replay point
    if (trajectoryPlaying && trajectoryIndex != null && trajectory[trajectoryIndex]) {
      const point = trajectory[trajectoryIndex];
      L.circleMarker([point.lat, point.lon], {
        pane: 'locationPane',
        radius: 6,
        color: '#071c2c',
        weight: 3,
        fillColor: '#ffb454',
        fillOpacity: 1,
        interactive: false,
      }).addTo(layer);
    }
  }, [trajectory, trajectoryPlaying, trajectoryIndex]);

  function resetView() {
    mapRef.current?.fitBounds(CAMPUS_BOUNDS, { padding: [28, 28], animate: true });
  }

  return (
    <section class="map-panel" aria-label={t('map.aria')}>
      <div class="map-toolbar">
        <div>
          <p class="eyebrow">OSM / WGS84</p>
          <h2>{t('map.title')}</h2>
        </div>
        <div class="legend" aria-label={t('map.legendAria')}>
          <span><i class="legend-line active" />{t('map.legend.route')}</span>
          <span><i class="legend-robot" />{t('map.legend.robot')}</span>
          <span><i class="legend-building" />{t('map.legend.building')}</span>
          <span><i class="legend-road" />{t('map.legend.road')}</span>
          <span><i class="legend-indoor" />{t('map.legend.indoor')}</span>
          <span><i class="legend-water" />{t('map.legend.water')}</span>
        </div>
      </div>

      <div class="category-filter" aria-label={t('map.categoryAria')}>
        <button class={selectedCategory === 'all' ? 'active' : ''} onClick={() => setSelectedCategory('all')}>{t('map.categories.all')}</button>
        {CATEGORY_IDS.map((id) => (
          <button key={id} class={selectedCategory === id ? 'active' : ''} onClick={() => setSelectedCategory(id)}>{t(`map.categories.${id}`)}</button>
        ))}
      </div>

      <div class="map-viewport osm-map-viewport">
        <div ref={containerRef} class="osm-map" role="img" aria-label={t('map.imgAria')} />
        {mapStatus !== 'ready' && (
          <div class={`map-loading ${mapStatus}`} role="status">
            {mapStatus === 'loading' ? t('map.loading') : t('map.loadError')}
          </div>
        )}
        <a
          class="osm-attribution"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap contributors · ODbL
        </a>
        <div class="map-note">
          {route?.summary.indoorDistanceMeters > 0
            ? t('map.noteIndoor', {
              distance: route.summary.indoorDistanceMeters,
              levels: [
                ...new Set(route.path.filter((point) => point.indoor).map((point) => point.level).filter(Boolean)),
              ].map((level) => `${level}F`).join(' / '),
            })
            : t('map.noteOutdoor')}
        </div>
        {positionSource && (
          <div class={`position-source-chip ${positionSource === 'robot' ? 'rtk' : 'browser'}`} role="status">
            <i />
            {t(`map.positionSources.${positionSource}`)}
          </div>
        )}
        <div class="zoom-controls" aria-label={t('map.zoomAria')}>
          <button onClick={() => mapRef.current?.zoomIn()} aria-label={t('map.zoomIn')}>＋</button>
          <button onClick={resetView} aria-label={t('map.zoomReset')}>{zoom.toFixed(1)}</button>
          <button onClick={() => mapRef.current?.zoomOut()} aria-label={t('map.zoomOut')}>−</button>
        </div>
      </div>
    </section>
  );
}
