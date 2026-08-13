import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CAMPUS_BOUNDS, NODE_BY_ID, PUBLIC_LOCATIONS } from '../data/campus.js';

const CATEGORY_LABELS = {
  entrance: '入口',
  academic: '教学',
  service: '服务',
  residence: '住宿',
  sports: '运动',
};

const OSM_DATA_URL = `${import.meta.env.BASE_URL}data/campus-osm.geojson`;
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

function locationLatLng(location) {
  return [location.latitude, location.longitude];
}

export function CampusMap({ route, destination, onSelectDestination }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [mapStatus, setMapStatus] = useState('loading');
  const [zoom, setZoom] = useState(17);

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
    map.createPane('routePane').style.zIndex = 430;
    map.createPane('locationPane').style.zIndex = 470;
    map.fitBounds(CAMPUS_BOUNDS, { padding: [28, 28] });
    map.on('zoomend', () => setZoom(map.getZoom()));

    mapRef.current = map;
    markerLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);

    fetch(OSM_DATA_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`OSM GeoJSON ${response.status}`);
        return response.json();
      })
      .then((data) => {
        addOsmLayers(map, data);
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
      const marker = L.circleMarker(locationLatLng(location), {
        pane: 'locationPane',
        radius: selected ? 8 : 5.5,
        color: selected ? '#071c2c' : '#79ded5',
        weight: selected ? 3 : 2,
        fillColor: selected ? '#b9f227' : '#0d3142',
        fillOpacity: 1,
      });
      marker.bindTooltip(location.name, {
        className: selected ? 'location-tooltip selected' : 'location-tooltip',
        direction: 'top',
        offset: [0, -8],
        permanent: selected,
      });
      marker.on('click', () => onSelectDestination(location.id));
      marker.addTo(layer);
    });
  }, [destination, onSelectDestination, selectedCategory]);

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
  }, [route]);

  function resetView() {
    mapRef.current?.fitBounds(CAMPUS_BOUNDS, { padding: [28, 28], animate: true });
  }

  return (
    <section class="map-panel" aria-label="OpenStreetMap 校园地图">
      <div class="map-toolbar">
        <div>
          <p class="eyebrow">OSM / WGS84</p>
          <h2>校园路径网络</h2>
        </div>
        <div class="legend" aria-label="地图图例">
          <span><i class="legend-line active" />推荐路径</span>
          <span><i class="legend-building" />建筑</span>
          <span><i class="legend-road" />道路</span>
          <span><i class="legend-water" />水域</span>
        </div>
      </div>

      <div class="category-filter" aria-label="地点分类">
        <button class={selectedCategory === 'all' ? 'active' : ''} onClick={() => setSelectedCategory('all')}>全部</button>
        {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
          <button key={id} class={selectedCategory === id ? 'active' : ''} onClick={() => setSelectedCategory(id)}>{label}</button>
        ))}
      </div>

      <div class="map-viewport osm-map-viewport">
        <div ref={containerRef} class="osm-map" role="img" aria-label="港科大广州校园 OSM 建筑、水域和道路地图" />
        {mapStatus !== 'ready' && (
          <div class={`map-loading ${mapStatus}`} role="status">
            {mapStatus === 'loading' ? '正在载入本地 OSM 数据…' : 'OSM 数据载入失败'}
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
        <div class="map-note">OSM 实际几何 · 路径仍为演示估算</div>
        <div class="zoom-controls" aria-label="地图缩放">
          <button onClick={() => mapRef.current?.zoomIn()} aria-label="放大地图">＋</button>
          <button onClick={resetView} aria-label="显示完整校园">{zoom.toFixed(1)}</button>
          <button onClick={() => mapRef.current?.zoomOut()} aria-label="缩小地图">−</button>
        </div>
      </div>
    </section>
  );
}
