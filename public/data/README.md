# Campus OSM snapshot

`campus-osm.geojson` is a filtered extract of OpenStreetMap data for the HKUST(GZ) campus area. It contains only buildings, roads, water polygons, and waterways.

- Source: [OpenStreetMap way 894157108 and surrounding features](https://www.openstreetmap.org/way/894157108)
- Attribution: © OpenStreetMap contributors
- Data license: [Open Data Commons Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- Refresh command: `npm run refresh:osm`

The main application displays the required attribution directly on the browsable map. Navigation topology, route costs, and destination aliases remain application data and are not asserted to be survey-grade OSM routing data.
