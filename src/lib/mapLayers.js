import L from 'leaflet';
import { translate } from './i18n.js';

/**
 * Pure Leaflet layer construction for the campus map. These builders never
 * touch React: they receive the GeoJSON data and a translation accessor and
 * return nothing (layers are added directly to the given map).
 *
 * Indoor tooltips are bound as *functions*, which Leaflet re-evaluates every
 * time a tooltip opens — so `t` must read the current language at call time
 * (the default `translate` from `./i18n.js` does exactly that, which is what
 * makes the tooltips follow the zh/en switch without re-building the layers).
 */

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

export function addOsmLayers(map, data) {
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

/**
 * The imported global-nav outdoor walking network (campus-local-nav.geojson):
 * footway edges rendered as a bright teal overlay so the updated walking
 * paths are visible on top of the OSM base map.
 */
export function addLocalNavLayers(map, data) {
  const canvas = L.canvas({ padding: 0.5, tolerance: 5 });
  L.geoJSON(data, {
    renderer: canvas,
    pane: 'roadPane',
    style: {
      color: '#061722',
      opacity: 0.82,
      weight: 6,
      lineCap: 'round',
      lineJoin: 'round',
    },
  }).addTo(map);

  L.geoJSON(data, {
    renderer: canvas,
    pane: 'roadDetailPane',
    style: {
      color: '#2fb3a8',
      opacity: 0.9,
      weight: 2.6,
      lineCap: 'round',
      lineJoin: 'round',
    },
  }).addTo(map);
}

export function addIndoorLayers(map, data, t = translate, { indoorDashedViewed = false } = {}) {
  const canvas = L.canvas({ padding: 0.5, tolerance: 7 });
  // 室内虚线路径(indoorPath/indoorNetworkLink): 杂乱, 放入独立图层, 默认不显示, 由前端开关控制
  const dashedLayer = L.layerGroup();
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
      layer.bindTooltip(() => t('map.indoorPathTooltip', { name: feature.properties.name, level }), {
        className: 'osm-feature-tooltip',
        sticky: true,
      });
    },
  }).addTo(dashedLayer);
  if (indoorDashedViewed) dashedLayer.addTo(map);

  // 室内垂直连接(保留显示)
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
      const levels = Array.isArray(feature.properties.levels)
        ? feature.properties.levels.join('–')
        : '';
      layer.bindTooltip(
        () => t('map.indoorConnectorTooltip', { name: feature.properties.name, levels }),
        { className: 'osm-feature-tooltip', direction: 'top', offset: [0, -7] },
      );
    },
  }).addTo(map);
  return dashedLayer;
}
