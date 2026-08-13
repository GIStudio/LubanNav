import { useEffect, useMemo, useState } from 'preact/hooks';
import { BUILDINGS, EDGES, NODE_BY_ID, PUBLIC_LOCATIONS } from '../data/campus.js';

const CATEGORY_LABELS = {
  entrance: '入口',
  academic: '教学',
  service: '服务',
  residence: '住宿',
  sports: '运动',
};

export function CampusMap({ route, destination, onSelectDestination }) {
  const [zoom, setZoom] = useState(1);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const routeIds = useMemo(() => new Set(route?.path.map((node) => node.id) ?? []), [route]);
  const pathPoints = route?.path.map((node) => `${node.x},${node.y}`).join(' ') ?? '';

  useEffect(() => {
    setZoom(1);
  }, [route?.request.from, route?.request.to]);

  const visibleLocations = PUBLIC_LOCATIONS.filter(
    (location) => selectedCategory === 'all' || location.category === selectedCategory,
  );

  return (
    <section class="map-panel" aria-label="校园示意地图">
      <div class="map-toolbar">
        <div>
          <p class="eyebrow">SCHEMATIC / 01</p>
          <h2>校园路径网络</h2>
        </div>
        <div class="legend" aria-label="地图图例">
          <span><i class="legend-line active" />推荐路径</span>
          <span><i class="legend-dot" />可导航地点</span>
        </div>
      </div>

      <div class="category-filter" aria-label="地点分类">
        <button class={selectedCategory === 'all' ? 'active' : ''} onClick={() => setSelectedCategory('all')}>全部</button>
        {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
          <button key={id} class={selectedCategory === id ? 'active' : ''} onClick={() => setSelectedCategory(id)}>{label}</button>
        ))}
      </div>

      <div class="map-viewport">
        <svg
          class="campus-map"
          viewBox="0 0 1100 760"
          style={{ transform: `scale(${zoom})` }}
          role="img"
          aria-labelledby="map-title map-desc"
        >
          <title id="map-title">香港科技大学（广州）校园轻量示意地图</title>
          <desc id="map-desc">显示主入口、教学区、宿舍区与体育设施之间的演示路径网络。</desc>
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(136, 180, 173, .08)" stroke-width="1" />
            </pattern>
            <filter id="routeGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          <rect width="1100" height="760" fill="url(#grid)" />
          <path class="water" d="M1045 -20 C990 130 1088 278 1028 430 C986 535 1095 652 1020 790 L1140 790 L1140 -20Z" />
          <path class="campus-road" d="M15 720 H1085 M345 720 V610 M610 500 H1045 M745 492 C770 380 770 270 815 90" />
          <path class="green-loop" d="M34 610 C75 520 155 510 230 570 S330 670 410 620 S560 510 635 585" />
          <ellipse class="stadium" cx="900" cy="155" rx="120" ry="82" />
          <ellipse class="stadium-field" cx="900" cy="155" rx="91" ry="58" />
          <text class="map-area-label" x="900" y="160" text-anchor="middle">体育场</text>

          <g class="network" aria-hidden="true">
            {EDGES.map((item) => {
              const from = NODE_BY_ID[item.from];
              const to = NODE_BY_ID[item.to];
              return (
                <line
                  key={`${item.from}-${item.to}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  class={item.covered ? 'network-edge covered' : 'network-edge'}
                />
              );
            })}
          </g>

          <g class="buildings" aria-hidden="true">
            {BUILDINGS.map((building) => (
              <g key={building.id} class={routeIds.has(building.id) ? 'building route-building' : 'building'}>
                <rect
                  x={building.x}
                  y={building.y}
                  width={building.w}
                  height={building.h}
                  rx={building.round ? 36 : 7}
                />
                <text x={building.x + building.w / 2} y={building.y + building.h / 2 + 5} text-anchor="middle">
                  {building.label}
                </text>
              </g>
            ))}
          </g>

          <g class="academic-core" aria-hidden="true">
            <circle cx="365" cy="135" r="30" />
            <circle cx="365" cy="220" r="27" />
            <circle cx="365" cy="305" r="27" />
            <text x="365" y="140" text-anchor="middle">图书馆</text>
            <text x="365" y="225" text-anchor="middle">饭堂</text>
            <text x="365" y="310" text-anchor="middle">演讲厅</text>
          </g>

          {route && (
            <g class="active-route" aria-label="当前推荐路径">
              <polyline class="route-glow" points={pathPoints} />
              <polyline class="route-line" points={pathPoints} filter="url(#routeGlow)" />
              <circle class="route-start" cx={route.path[0].x} cy={route.path[0].y} r="11" />
              <circle
                class="route-end"
                cx={route.path[route.path.length - 1].x}
                cy={route.path[route.path.length - 1].y}
                r="12"
              />
            </g>
          )}

          <g class="locations">
            {visibleLocations.map((location) => (
              <g
                key={location.id}
                class={`location-marker ${destination === location.id ? 'selected' : ''}`}
                transform={`translate(${location.x} ${location.y})`}
                role="button"
                tabIndex="0"
                aria-label={`导航到${location.name}`}
                onClick={() => onSelectDestination(location.id)}
                onKeyDown={(event) => event.key === 'Enter' && onSelectDestination(location.id)}
              >
                <circle r="8" />
                <circle class="marker-pulse" r="14" />
                <title>{location.name} / {location.en}</title>
              </g>
            ))}
          </g>

          <g class="north-arrow" transform="translate(1050 65)" aria-hidden="true">
            <path d="M0 18 L10 -16 L20 18 L10 10Z" />
            <text x="10" y="34" text-anchor="middle">N</text>
          </g>
        </svg>

        <div class="map-note">非测绘图 · 距离为估算</div>
        <div class="zoom-controls" aria-label="地图缩放">
          <button onClick={() => setZoom((value) => Math.min(1.6, value + 0.15))} aria-label="放大地图">＋</button>
          <button onClick={() => setZoom(1)} aria-label="重置缩放">{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoom((value) => Math.max(0.8, value - 0.15))} aria-label="缩小地图">−</button>
        </div>
      </div>
    </section>
  );
}
