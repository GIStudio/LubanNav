import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CAMPUS_BOUNDS, NODE_BY_ID, PUBLIC_LOCATIONS } from '../data/campus.js';
import { getLocationBinding } from '../lib/pathfinding.js';
import { useI18n, localizedName } from '../lib/i18n.js';

const CATEGORY_IDS = ['entrance', 'academic', 'indoor', 'service', 'residence', 'sports'];

const OSM_DATA_URL = `${import.meta.env.BASE_URL}data/campus-osm.geojson`;
const INDOOR_DATA_URL = `${import.meta.env.BASE_URL}data/campus-indoor.geojson`;
const CAMPUS_CENTER = [22.8902, 113.4791];

function roadWeight(highway) {
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(highway)) return 5;
  if (['residential', 'unclassified'].includes(highway)) return 3.8;
  if (['service', 'pedestrian'].includes(highway)) return 3;
  return 2;
}

function roadColor(highway) {
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(highway)) return '#73888b';
  if (['footway', 'path', 'steps', 'pedestrian'].includes(highway)) return '#5f8f8a';
  return '#526f74';
}

function tooltipName(feature) {
  return feature.properties.name ?? feature.properties['name:en'] ?? feature.properties.ref;
}

function addOsmLayers(map, data) {
  const canvas = L.canvas({ padding: 0.5, tolerance: 5 });
  const isClass = (featureClass) => (feature) => feature.properties.featureClass === featureClass;
  const bindTooltip = (feature, layer) => {
    const name = tooltipName(feature);
    if (name) layer.bindTooltip(name, { className: 'osm-feature-tooltip', sticky: true });
  };

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'waterPane',
    filter: isClass('water'),
    style: {
      fillColor: '#145869',
      fillOpacity: 0.72,
      color: '#23798a',
      opacity: 0.8,
      weight: 1.2,
    },
    onEachFeature: bindTooltip,
  }).addTo(map);

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'roadPane',
    filter: isClass('waterway'),
    style: {
      color: '#277b89',
      opacity: 0.76,
      weight: 3,
    },
    onEachFeature: bindTooltip,
  }).addTo(map);

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'roadPane',
    filter: isClass('road'),
    style: (feature) => ({
      color: '#061722',
      opacity: 0.78,
      weight: roadWeight(feature.properties.highway) + 3.4,
      lineCap: 'round',
      lineJoin: 'round',
    }),
  }).addTo(map);

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'roadDetailPane',
    filter: isClass('road'),
    style: (feature) => ({
      color: roadColor(feature.properties.highway),
      opacity: feature.properties.tunnel === 'yes' ? 0.36 : 0.92,
      weight: roadWeight(feature.properties.highway),
      dashArray: ['footway', 'path', 'steps'].includes(feature.properties.highway) ? '5 6' : null,
      lineCap: 'round',
      lineJoin: 'round',
    }),
    onEachFeature: bindTooltip,
  }).addTo(map);

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'buildingPane',
    filter: isClass('building'),
    style: (feature) => ({
      fillColor: feature.properties.building === 'dormitory' ? '#173f50' : '#1a4655',
      fillOpacity: 0.92,
      color: '#4f7880',
      opacity: 0.94,
      weight: 1.1,
    }),
    onEachFeature: bindTooltip,
  }).addTo(map);
}

function addIndoorLayers(map, data) {
  const canvas = L.canvas({ padding: 0.5, tolerance: 7 });
  L.geoJSON(data, {
    renderer: canvas,
    pane: 'indoorPane',
    filter: (feature) => ['indoorPath', 'indoorNetworkLink'].includes(feature.properties.featureClass),
    style: (feature) => ({
      color: feature.properties.highway === 'elevator' ? '#ff9d63' : '#79ded5',
      opacity: 0.82,
      weight: feature.properties.highway === 'elevator' ? 5 : 3,
      dashArray: feature.properties.highway === 'elevator' ? null : '3 5',
      lineCap: 'round',
      lineJoin: 'round',
    }),
    onEachFeature: (feature, layer) => {
      const level = feature.properties.level ?? '?';
      layer.bindTooltip(`${feature.properties.name} · level ${level} · 待核验`, {
        className: 'osm-feature-tooltip',
        sticky: true,
      });
    },
  }).addTo(map);

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'indoorPane',
    filter: (feature) => feature.properties.featureClass === 'indoorVerticalConnector',
    pointToLayer: (feature, latLng) => L.circleMarker(latLng, {
      radius: 6,
      color: '#071c2c',
      weight: 2,
      fillColor: '#ff9d63',
      fillOpacity: 0.96,
    }),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(
        `${feature.properties.name} · ${feature.properties.levels.join('–')}F · 位置待核验`,
        { className: 'osm-feature-tooltip', direction: 'top', offset: [0, -7] },
      );
    },
  }).addTo(map);
}

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

export function CampusMap({ route, destination, robotPosition, onSelectDestination }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
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
  }, [destination, lang, onSelectDestination, robotPosition, route?.request.mode, selectedCategory]);

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
        <div class="zoom-controls" aria-label={t('map.zoomAria')}>
          <button onClick={() => mapRef.current?.zoomIn()} aria-label={t('map.zoomIn')}>＋</button>
          <button onClick={resetView} aria-label={t('map.zoomReset')}>{zoom.toFixed(1)}</button>
          <button onClick={() => mapRef.current?.zoomOut()} aria-label={t('map.zoomOut')}>−</button>
        </div>
      </div>
    </section>
  );
}
