#!/usr/bin/env python3
"""Export LubanNav campus data as GIS layers for manual editing in QGIS (or any GIS).

Reads the canonical data sources and writes:

    artifacts/gis/lubannav-campus.gpkg        multi-layer GeoPackage (editing master)
    artifacts/gis/geojson/<layer>.geojson     per-layer GeoJSON, EPSG:4326
    artifacts/gis/lubannav-campus.qgs         minimal QGIS project (relative datasources)

Layers:
  indoor_paths       LineString  indoor network links (campus-indoor.geojson)
  outdoor_paths      LineString  OSM road centerlines (campus-osm.geojson)
  poi_points         Point       app POI catalog + indoor POIs + OSM entrances
  building_polygons  Polygon     OSM building footprints (campus-osm.geojson)
  walkable_surfaces  Polygon     registered walkable-surface candidates (reference only)

All layers are EPSG:4326 (WGS84), matching the app data. OSM-derived layers
remain © OpenStreetMap contributors, ODbL 1.0.

Usage:  uv run --script scripts/export-gis-layers.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"
API = ROOT / "public" / "api" / "v1"
OUT = ROOT / "artifacts" / "gis"
GEOJSON_OUT = OUT / "geojson"
GPKG = OUT / "lubannav-campus.gpkg"
QGS = OUT / "lubannav-campus.qgs"

LAYER_TITLES = {
    "indoor_paths": "室内路径 (Indoor paths)",
    "outdoor_paths": "室外路径 (Outdoor paths)",
    "poi_points": "POI 点 (POI points)",
    "building_polygons": "建筑面 (Building footprints)",
    "walkable_surfaces": "可通行面候选 - 仅参考 (Walkable surface candidates - reference)",
}
LAYER_COLORS = {
    "indoor_paths": ("0,170,255,255", "line"),
    "outdoor_paths": ("255,140,0,255", "line"),
    "poi_points": ("230,25,75,255", "marker"),
    "building_polygons": ("217,217,217,255", "fill"),
    "walkable_surfaces": ("124,77,255,120", "fill"),
}


def load_json(path: Path, required: bool = True):
    if not path.exists():
        if required:
            sys.exit(f"Missing required data file: {path}")
        print(f"[warn] Skipping optional data file (not found): {path}")
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def clean_props(props: dict) -> dict:
    """Normalize JSON property values for GIS attribute tables (no nested lists)."""
    out = {}
    for k, v in props.items():
        if v is None or isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, (list, tuple)):
            out[k] = ", ".join(str(x) for x in v)
        else:
            out[k] = str(v)
    return out


def to_features(gj, props_fn):
    """Return [(feature_id, properties, geometry)] from a GeoJSON FeatureCollection."""
    out = []
    for f in gj.get("features", []):
        out.append((f.get("id"), props_fn(f.get("properties", {})), f.get("geometry")))
    return out


# ---------------------------------------------------------------- layer 1/2: paths

def build_indoor_paths():
    gj = load_json(DATA / "campus-indoor.geojson")
    keep = {"featureClass", "networkId", "fromNodeId", "toNodeId", "name", "highway",
            "level", "modes", "outdoor", "buildingFeatureId", "locationId",
            "source", "evidence", "verificationStatus"}

    def props_fn(p):
        row = {k: v for k, v in p.items() if k in keep}
        row.pop("featureClass", None)
        row["feature_id"] = None  # filled below
        row["network_id"] = row.pop("networkId", None)
        row["from_node"] = row.pop("fromNodeId", None)
        row["to_node"] = row.pop("toNodeId", None)
        row["building_feature_id"] = row.pop("buildingFeatureId", None)
        row["location_id"] = row.pop("locationId", None)
        row["verification_status"] = row.pop("verificationStatus", None)
        row["source"] = row.get("source") or "local-routing-overlay"
        return row

    feats = to_features(gj, props_fn)
    feats = [(fid, {**row, "feature_id": fid or row.get("location_id")}, geom)
             for fid, row, geom in feats
             if geom and geom.get("type") == "LineString"]
    return feats


def build_outdoor_paths():
    gj = load_json(DATA / "campus-osm.geojson")
    keep = {"osmId", "name", "name:en", "highway", "surface", "bridge", "service",
            "layer", "access"}

    def props_fn(p):
        row = {k: v for k, v in p.items() if k in keep}
        row["feature_id"] = None
        row["name_en"] = row.pop("name:en", None)
        row["source"] = "openstreetmap"
        row["_feature_class"] = p.get("featureClass")
        return row

    feats = to_features(gj, props_fn)
    # featureClass=road only (excludes waterway/water lines)
    feats = [(fid, {**row, "feature_id": fid}, geom)
             for fid, row, geom in feats
             if row.pop("_feature_class") == "road"
             and geom and geom.get("type") == "LineString"]
    return feats


def build_poi_points():
    """Union of app POI catalog + indoor POIs + OSM entrances, deduplicated."""
    indoor_gj = load_json(DATA / "campus-indoor.geojson")
    osm_gj = load_json(DATA / "campus-osm.geojson")
    locations = load_json(API / "locations.json", required=False)

    features = []

    # --- app POI catalog (authoritative destinations of the app)
    app_ids = set()
    if locations:
        for loc in locations.get("locations", []):
            r = loc.get("routing") or {}
            ent = r.get("entrance") or {}
            dst = r.get("destination") or {}
            pt = ent if ent.get("longitude") is not None else dst
            if pt.get("longitude") is None:
                print(f"[warn] location '{loc['id']}' has no coordinates; skipped")
                continue
            app_ids.add(loc["id"])
            features.append({
                "feature_id": f"location/{loc['id']}",
                "poi_source": "app-location",
                "name": loc.get("name"),
                "name_en": loc.get("en"),
                "category": loc.get("category"),
                "poi_type": loc.get("poiType"),
                "level": loc.get("level"),
                "location_id": loc["id"],
                "node_id": None,
                "building_feature_id": ent.get("osmFeatureId") or (dst.get("featureId") if dst.get("indoor") else None),
                "osm_feature_id": ent.get("osmFeatureId"),
                "entrance": ent.get("source") is not None,
                "kind": None,
                "robot_validated": None,
                "source": ent.get("source") or dst.get("source") or "app-catalog",
                "evidence": ent.get("evidence") or dst.get("evidence"),
                "verification_status": ent.get("verificationStatus") or dst.get("verificationStatus"),
                "geometry": {"type": "Point", "coordinates": [pt["longitude"], pt["latitude"]]},
            })

    # --- indoor POIs (level-aware network points)
    indoor_by_location = {}
    for fid, p, geom in to_features(indoor_gj, lambda p: p):
        if not geom or geom.get("type") != "Point":
            continue
        fc = p.get("featureClass")
        if fc not in ("entrancePoi", "indoorNetworkNode", "indoorVerticalConnector", "indoorPath"):
            continue
        row = {
            "feature_id": fid,
            "poi_source": "indoor",
            "name": p.get("name"),
            "name_en": None,
            "category": None,
            "poi_type": fc,
            "level": p.get("level"),
            "location_id": p.get("locationId"),
            "node_id": p.get("nodeId"),
            "building_feature_id": p.get("buildingFeatureId"),
            "osm_feature_id": None,
            "entrance": p.get("entrance"),
            "kind": p.get("kind"),
            "robot_validated": p.get("robotValidated"),
            "source": p.get("source") or "local-routing-overlay",
            "evidence": p.get("evidence"),
            "verification_status": p.get("verificationStatus"),
        }
        features.append({**row, "geometry": geom})
        if p.get("locationId"):
            indoor_by_location[p["locationId"]] = True

    # --- OSM entrance nodes, unless already covered by an app location
    osm_entrance_refs = set()
    if locations:
        for loc in locations.get("locations", []):
            eid = ((loc.get("routing") or {}).get("entrance") or {}).get("osmEntranceId")
            if eid:
                osm_entrance_refs.add(eid)
    for fid, p, geom in to_features(osm_gj, lambda p: p):
        if not geom or geom.get("type") != "Point" or p.get("featureClass") != "entrance":
            continue
        if fid in osm_entrance_refs:
            continue  # covered by an app-location point
        features.append({
            "feature_id": fid,
            "poi_source": "osm-entrance",
            "name": p.get("name"),
            "name_en": p.get("name:en"),
            "category": "entrance",
            "poi_type": "osm-entrance",
            "level": p.get("level"),
            "location_id": None,
            "node_id": p.get("osmId"),
            "building_feature_id": None,
            "osm_feature_id": fid,
            "entrance": p.get("entrance", True),
            "kind": None,
            "robot_validated": None,
            "source": "openstreetmap",
            "evidence": None,
            "verification_status": None,
            "geometry": geom,
        })

    # --- dedupe: drop app-location points already present as indoor POIs
    kept = []
    dropped = 0
    for f in features:
        if f["poi_source"] == "app-location" and f["location_id"] in indoor_by_location:
            dropped += 1
            continue
        kept.append(f)
    if dropped:
        print(f"[info] poi_points: dropped {dropped} app-location duplicate(s) covered by indoor POIs")
    return kept


def build_buildings():
    gj = load_json(DATA / "campus-osm.geojson")
    keep = {"osmId", "name", "name:en", "building", "building:levels", "ref"}

    def props_fn(p):
        row = {k: v for k, v in p.items() if k in keep}
        row["feature_id"] = None
        row["name_en"] = row.pop("name:en", None)
        row["building_levels"] = row.pop("building:levels", None)
        row["source"] = "openstreetmap"
        row["_feature_class"] = p.get("featureClass")
        return row

    feats = to_features(gj, props_fn)
    feats = [(fid, {**row, "feature_id": fid}, geom)
             for fid, row, geom in feats
             if row.pop("_feature_class") == "building"
             and geom and geom.get("type") == "Polygon"]
    return feats


def build_walkable_surfaces():
    gj = load_json(DATA / "walkable-surfaces" / "walkable-surfaces.wgs84.geojson")
    keep = {"surfaceClass", "surface", "level", "routingEnabled", "pixelAreaApprox",
            "registrationStatus", "registrationModel"}

    def props_fn(p):
        row = {k: v for k, v in p.items() if k in keep}
        row["feature_id"] = None
        row["surface_class"] = row.pop("surfaceClass", None)
        row["routing_enabled"] = row.pop("routingEnabled", None)
        row["pixel_area_approx"] = row.pop("pixelAreaApprox", None)
        row["registration_status"] = row.pop("registrationStatus", None)
        row["registration_model"] = row.pop("registrationModel", None)
        row["source"] = "render-derived-unverified"
        return row

    feats = to_features(gj, props_fn)
    feats = [(fid, {**row, "feature_id": fid}, geom)
             for fid, row, geom in feats
             if geom and geom.get("type") == "Polygon"]
    return feats


# ------------------------------------------------------------------ GeoJSON writers

def write_layer_geojson(name: str, features: list) -> Path:
    fc = {
        "type": "FeatureCollection",
        "name": name,
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": [
            {
                "type": "Feature",
                "properties": clean_props({k: v for k, v in f.items() if k != "geometry"}),
                "geometry": f["geometry"],
            }
            for f in features
        ],
    }
    path = GEOJSON_OUT / f"{name}.geojson"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, indent=1)
    return path


# ------------------------------------------------------------------ GeoPackage via GDAL

def assemble_gpkg(layers: list) -> None:
    ogr2ogr = shutil.which("ogr2ogr")
    if not ogr2ogr:
        print("[warn] ogr2ogr not found - skipping GeoPackage assembly "
              "(install GDAL, or use the per-layer GeoJSON files directly)")
        return
    if GPKG.exists():
        GPKG.unlink()
    for i, (name, features) in enumerate(layers):
        src = write_layer_geojson(name, features)
        geom_types = {f["geometry"]["type"] for f in features}
        nlt = {"LineString": "LINESTRING", "Point": "POINT", "Polygon": "POLYGON"}
        args = [ogr2ogr, "-f", "GPKG", str(GPKG), str(src),
                "-nln", name, "-a_srs", "EPSG:4326",
                "-lco", "SPATIAL_INDEX=YES"]
        if len(geom_types) == 1:
            args += ["-nlt", nlt[geom_types.pop()]]
        if i > 0:
            args += ["-append", "-update"]
        print(f"[run] {' '.join(args)}")
        subprocess.run(args, check=True)
    print(f"[ok] GeoPackage written: {GPKG}")


# ------------------------------------------------------------------ QGIS project file

QGS_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis projectname="{project_name}" version="3.28.0">
  <title>{project_name}</title>
  <autotransaction active="0"/>
  <projectlayers>
{maplayers}
  </projectlayers>
  <layer-tree-group name="" checked="Qt::Checked" expanded="1">
{tree_layers}
  </layer-tree-group>
  <snapping-settings enabled="1" tolerance="12" units="1" type="1" intersection-snapping="0" self-snapping="0" vertex-snap="1" segment-snap="0" snap-on-vertices="1" snap-on-visible-layers="1">
    <individual-layer-settings/>
  </snapping-settings>
  <mapcanvas>
    <units>degrees</units>
    <extent>
      <xmin>{xmin}</xmin>
      <ymin>{ymin}</ymin>
      <xmax>{xmax}</xmax>
      <ymax>{ymax}</ymax>
    </extent>
    <rotation>0</rotation>
    <destinationsrs>
      <spatialrefsys>
        <authid>EPSG:4326</authid>
        <srid>4326</srid>
        <name>WGS 84</name>
        <proj4>+proj=longlat +datum=WGS84 +no_defs</proj4>
      </spatialrefsys>
    </destinationsrs>
    <rendermaptile>0</rendermaptile>
  </mapcanvas>
  <layer-tree-canvas>
{canvas_layers}
  </layer-tree-canvas>
  <legend updateDrawingOrder="true"/>
  <visibility-presets/>
  <projectMetadata>
    <title>{project_name}</title>
    <author>LubanNav</author>
  </projectMetadata>
  <trust project="true"/>
</qgis>
"""


def symbol_xml(geom_kind: str, color: str):
    ddp = ('<data_defined_properties>\n'
           '        <Option type="Map">\n'
           '          <Option type="QString" name="name" value=""/>\n'
           '          <Option name="properties"/>\n'
           '          <Option type="QString" name="type" value="collection"/>\n'
           '        </Option>\n'
           '      </data_defined_properties>\n')
    if geom_kind == "line":
        return ('<symbol type="line" name="0" alpha="1" force_rhr="0" clip_to_extent="1">\n'
                f'      {ddp}'
                '      <layer pass="0" class="SimpleLine" locked="0">\n'
                '        <Option type="Map">\n'
                f'          <Option type="QString" name="line_color" value="{color}"/>\n'
                '          <Option type="QString" name="line_style" value="solid"/>\n'
                '          <Option type="QString" name="line_width" value="1.6"/>\n'
                '          <Option type="QString" name="line_width_unit" value="MM"/>\n'
                '        </Option>\n'
                '      </layer>\n'
                '    </symbol>')
    if geom_kind == "marker":
        return ('<symbol type="marker" name="0" alpha="1" force_rhr="0" clip_to_extent="1">\n'
                f'      {ddp}'
                '      <layer pass="0" class="SimpleMarker" locked="0">\n'
                '        <Option type="Map">\n'
                '          <Option type="QString" name="angle" value="0"/>\n'
                f'          <Option type="QString" name="color" value="{color}"/>\n'
                '          <Option type="QString" name="size" value="3"/>\n'
                '          <Option type="QString" name="size_unit" value="MM"/>\n'
                '          <Option type="QString" name="symbol_type" value="circle"/>\n'
                '          <Option type="QString" name="outline_color" value="255,255,255,255"/>\n'
                '          <Option type="QString" name="outline_style" value="solid"/>\n'
                '          <Option type="QString" name="outline_width" value="0.3"/>\n'
                '        </Option>\n'
                '      </layer>\n'
                '    </symbol>')
    # fill
    return ('<symbol type="fill" name="0" alpha="1" force_rhr="0" clip_to_extent="1">\n'
            f'      {ddp}'
            '      <layer pass="0" class="SimpleFill" locked="0">\n'
            '        <Option type="Map">\n'
            f'          <Option type="QString" name="color" value="{color}"/>\n'
            '          <Option type="QString" name="style" value="solid"/>\n'
            '          <Option type="QString" name="outline_color" value="90,90,90,255"/>\n'
            '          <Option type="QString" name="outline_style" value="solid"/>\n'
            '          <Option type="QString" name="outline_width" value="0.4"/>\n'
            '          <Option type="QString" name="outline_width_unit" value="MM"/>\n'
            '        </Option>\n'
            '      </layer>\n'
            '    </symbol>')


def write_qgs(layers: list, bbox: tuple) -> None:
    geom_kind = {
        "indoor_paths": "line", "outdoor_paths": "line",
        "poi_points": "marker",
        "building_polygons": "fill", "walkable_surfaces": "fill",
    }
    maplayers, tree_layers, canvas_layers = [], [], []
    for name, _ in layers:
        color, _kind = LAYER_COLORS[name]
        gk = geom_kind[name]
        title = escape(LAYER_TITLES[name])
        maplayers.append(
            f'    <maplayer type="vector" styleCategories="AllStyleCategories" minScale="0" '
            f'maxScale="0" geometry="{gk.capitalize()}" simplifyAlgorithm="0" '
            f'simplifyDrawingHints="1" simplifyDrawingTol="1" simplifyMaximumScale="1" '
            f'simplifyEnabled="0" hasScaleBasedVisibilityFlag="0" labelsEnabled="0" '
            f'autoRefreshEnabled="0" autoRefreshTime="0">\n'
            f'      <id>lubannav_{name}</id>\n'
            f'      <datasource>./lubannav-campus.gpkg|layername={name}</datasource>\n'
            f'      <shortname>{name}</shortname>\n'
            f'      <title>{title}</title>\n'
            f'      <abstract></abstract>\n'
            f'      <keywordList><value></value></keywordList>\n'
            f'      <layername>{name}</layername>\n'
            f'      <srs>\n'
            f'        <spatialrefsys>\n'
            f'          <authid>EPSG:4326</authid>\n'
            f'          <srid>4326</srid>\n'
            f'          <name>WGS 84</name>\n'
            f'          <proj4>+proj=longlat +datum=WGS84 +no_defs</proj4>\n'
            f'        </spatialrefsys>\n'
            f'      </srs>\n'
            f'      <provider encoding="UTF-8">ogr</provider>\n'
            f'      <vectorjoins/>\n'
            f'      <layerDependencies/>\n'
            f'      <expressionfields/>\n'
            f'      <renderer-v2 type="singleSymbol" forceraster="0" symbollevels="0" '
            f'enableorderby="0">\n'
            f'        <symbols>\n'
            f'          {symbol_xml(gk, color)}\n'
            f'        </symbols>\n'
            f'      </renderer-v2>\n'
            f'    </maplayer>'
        )
        tree_layers.append(
            f'    <layer-tree-layer id="lubannav_{name}" name="{name}" providerKey="ogr" '
            f'source="./lubannav-campus.gpkg|layername={name}" expanded="1" checked="Qt::Checked"/>'
        )
        canvas_layers.append(
            f'    <layer-tree-layer id="lubannav_{name}" name="{name}" expanded="1" checked="Qt::Checked"/>'
        )
    xmin, ymin, xmax, ymax = bbox
    xml = QGS_TEMPLATE.format(
        project_name=escape("LubanNav - HKUST(GZ) Campus"),
        maplayers="\n".join(maplayers),
        tree_layers="\n".join(tree_layers),
        canvas_layers="\n".join(canvas_layers),
        xmin=f"{xmin:.6f}", ymin=f"{ymin:.6f}", xmax=f"{xmax:.6f}", ymax=f"{ymax:.6f}",
    )
    QGS.write_text(xml, encoding="utf-8")
    import xml.dom.minidom as minidom
    minidom.parseString(xml)  # fail loudly on malformed XML
    print(f"[ok] QGIS project written: {QGS}")


def compute_bbox(layers: list) -> tuple:
    xs, ys = [], []
    for _, feats in layers:
        for f in feats:
            coords = f["geometry"]["coordinates"]
            if f["geometry"]["type"] == "Point":
                coords = [coords]
            for ring in coords:
                if isinstance(ring[0], (int, float)):
                    ring = [ring]
                for lon, lat in ring:
                    xs.append(lon)
                    ys.append(lat)
    pad = 0.0015
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def normalize(feats):
    """Convert (feature_id, props, geometry) tuples into flat feature dicts."""
    out = []
    for f in feats:
        if isinstance(f, tuple):
            fid, props, geom = f
            out.append({**props, "feature_id": props.get("feature_id") or fid,
                        "geometry": geom})
        else:
            out.append(f)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    GEOJSON_OUT.mkdir(parents=True, exist_ok=True)

    layers = [
        ("indoor_paths", normalize(build_indoor_paths())),
        ("outdoor_paths", normalize(build_outdoor_paths())),
        ("poi_points", normalize(build_poi_points())),
        ("building_polygons", normalize(build_buildings())),
        ("walkable_surfaces", normalize(build_walkable_surfaces())),
    ]
    for name, feats in layers:
        print(f"[info] {name}: {len(feats)} features")
        for f in feats:
            if not f["geometry"] or f["geometry"].get("type") not in (
                    "LineString", "Point", "Polygon"):
                sys.exit(f"[error] unexpected geometry in {name}: {f['geometry']}")

    # keep per-layer GeoJSON always; GPKG + QGS need GDAL output to exist first
    assemble_gpkg(layers)
    write_qgs(layers, compute_bbox(layers))
    print(f"\n[ok] Export complete. Open {QGS} in QGIS, or drag {GPKG} onto the canvas.")


if __name__ == "__main__":
    main()
