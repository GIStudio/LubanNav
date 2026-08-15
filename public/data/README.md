# Campus OSM snapshot

`campus-osm.geojson` is a filtered extract of OpenStreetMap data for the HKUST(GZ) campus area. It contains only buildings, roads, water polygons, and waterways.

- Source: [OpenStreetMap way 894157108 and surrounding features](https://www.openstreetmap.org/way/894157108)
- Attribution: © OpenStreetMap contributors
- Data license: [Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- Refresh command: `npm run refresh:osm`

The main application displays the required attribution directly on the browsable map. Navigation topology, route costs, and destination aliases remain application data and are not asserted to be survey-grade OSM routing data.

## Render-derived concrete surface candidates

`walkable-surfaces/` contains a color-derived mask and normalized-image GeoJSON extracted from a 2351×1280 rendered campus overview. The extraction selects neutral, concrete-like pixels and vectorizes connected surface candidates. It intentionally does **not** claim that every selected face is walkable.

- Coordinate space: both normalized image coordinates and an initial WGS84 registration.
- Current classification: ground, roof and facade are not yet separated.
- Routing status: disabled for every feature.
- Registration anchors: OSM E1–E4 and W1–W4 building centroids matched to the rendered roofs.
- Required before routing: control-point review, ground/roof/facade review, verified elevation, and explicit stairs/lift/ramp connectors.

Reproduce with the original local image:

```bash
npm run extract:walkable -- \
  --input /absolute/path/to/campus-render.jpg \
  --output-dir artifacts/walkable-surfaces
```

The checked-in mask and GeoJSON are review artifacts, not robot control data.

## Local indoor routing overlay

`campus-indoor.geojson` supplements missing OSM indoor data with provenance-marked local features. It currently contains the library corridor, W2/E2 lobby entrances, W2/E2 elevators serving floors 1–5, the shared level-3 central POI (`third-floor-platform`), the platform restaurant, and the central level-2 elevator approach. These locations are approximate user-supplied geometry, not surveyed floor-plan data.

`indoorNetworkNode`, `indoorNetworkLink`, and `indoorVerticalConnector` features are expanded into the generated A* graph. Unverified indoor features permit pedestrian routing only; robot access requires an explicit field validation and `robotValidated=true`.

Register an extracted image-space GeoJSON with the eight-building control configuration:

```bash
npm run register:walkable -- \
  --image /absolute/path/to/campus-render.jpg \
  --output-dir artifacts/walkable-surfaces-registration
```

The registration command writes `walkable-surfaces.wgs84.geojson`, a per-building error report and an outline overlay preview. A numerically accepted fit remains review-pending and cannot enable routing by itself.
