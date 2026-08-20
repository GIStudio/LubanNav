#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.3.2",
#   "pillow==11.3.0",
# ]
# ///
"""Extract paved-surface candidates from georeferenced XYZ imagery tiles (e.g. Esri World Imagery).

The tiles are already georeferenced (EPSG:3857 Web Mercator), so the extracted
polygons are written directly in WGS84 — no separate ground-control registration
is needed. OSM building footprints can be used to automatically mask out roofs,
leaving gray paved ground (asphalt / concrete) as the candidate class.

The output is deliberately evidence-bounded: color visible in ortho imagery can
identify candidate surfaces, but cannot prove access, material, or connectivity.
All features are `verificationStatus: image-derived-unverified`,
`routingEnabled: false` until field review.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Reuse the vectorization core (components / boundary loops / simplification)
# from the render-based walkable extraction script.
_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "extract_walkable_surfaces", _HERE / "extract-walkable-surfaces.py"
)
_walk = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_walk)

SCHEMA_VERSION = "1.1"
EARTH_RADIUS = 6378137.0
WORLD = 2.0 * math.pi * EARTH_RADIUS  # Web Mercator world extent in meters
HALF_WORLD = WORLD / 2.0


# ---------------------------------------------------------------- geo helpers

def tile_range(bbox: dict, zoom: int) -> tuple[int, int, int, int]:
    n = 1 << zoom

    def tile_xy(lon: float, lat: float) -> tuple[int, int]:
        x = int((lon + 180.0) / 360.0 * n)
        lat_rad = math.radians(lat)
        y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
        return x, y

    x0, y0 = tile_xy(bbox["west"], bbox["north"])
    x1, y1 = tile_xy(bbox["east"], bbox["south"])
    return x0, y0, x1, y1


def pixel_to_mercator(px: float, py: float, zoom: int) -> tuple[float, float]:
    """Global XYZ pixel (with 0.5 center offset) -> (merc_x, merc_y) meters."""
    res = WORLD / (256.0 * (1 << zoom))
    return px * res - HALF_WORLD, HALF_WORLD - py * res


def mercator_to_wgs84(mx: float, my: float) -> tuple[float, float]:
    lon = mx / HALF_WORLD * 180.0
    lat = math.degrees(2.0 * math.atan(math.exp(my / EARTH_RADIUS)) - math.pi / 2.0)
    return lon, lat


def wgs84_to_pixel(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    mx = lon / 180.0 * HALF_WORLD
    my = EARTH_RADIUS * math.log(math.tan(math.pi / 4.0 + math.radians(lat) / 2.0))
    res = WORLD / (256.0 * (1 << zoom))
    return (mx + HALF_WORLD) / res, (HALF_WORLD - my) / res


def resolution_m_per_px(zoom: int) -> float:
    return WORLD / (256.0 * (1 << zoom))


# ------------------------------------------------------------------- download

def download_tile(url: str, target: Path, user_agent: str, retries: int = 3) -> bool:
    if target.exists() and target.stat().st_size > 0:
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": user_agent})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
            if len(data) > 256 and data[:2] == b"\xff\xd8":  # JPEG magic
                target.write_bytes(data)
                return True
        except Exception:
            pass
        time.sleep(0.6 * (attempt + 1))
    return False


def fetch_mosaic(config: dict, cache_dir: Path) -> np.ndarray:
    source = config["source"]
    bbox = config["bbox"]
    zoom = int(source["zoom"])
    user_agent = source.get("userAgent", "LubanNav/1.0")
    x0, y0, x1, y1 = tile_range(bbox, zoom)
    width = (x1 - x0 + 1) * 256
    height = (y1 - y0 + 1) * 256
    mosaic = np.zeros((height, width, 3), dtype=np.uint8)

    jobs = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    print(f"下载瓦片 {len(jobs)} 张 (z{zoom}, x {x0}..{x1}, y {y0}..{y1})", flush=True)
    missing: list[tuple[int, int]] = []

    def fetch(job: tuple[int, int]) -> tuple[tuple[int, int], bool]:
        x, y = job
        url = source["urlTemplate"].format(z=zoom, x=x, y=y)
        target = cache_dir / str(zoom) / str(x) / f"{y}.jpg"
        return job, download_tile(url, target, user_agent)

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(fetch, job) for job in jobs]
        for future in as_completed(futures):
            (x, y), ok = future.result()
            done += 1
            if ok:
                tile = Image.open(cache_dir / str(zoom) / str(x) / f"{y}.jpg").convert("RGB")
                dx, dy = (x - x0) * 256, (y - y0) * 256
                mosaic[dy : dy + 256, dx : dx + 256] = np.asarray(tile)
            else:
                missing.append((x, y))
            if done % 64 == 0 or done == len(jobs):
                print(f"  {done}/{len(jobs)}", flush=True)

    if missing:
        print(f"警告: {len(missing)} 张瓦片下载失败: {missing[:8]}{'...' if len(missing) > 8 else ''}")
    return mosaic


# -------------------------------------------------------------- classification

def paved_mask(mosaic: np.ndarray, config: dict) -> Image.Image:
    rgb = mosaic.astype(np.float32) / 255.0
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    chroma = maximum - minimum
    saturation = np.divide(chroma, maximum, out=np.zeros_like(chroma), where=maximum > 0)
    luminance = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722

    t = {
        "maxSaturation": 0.22,
        "maxChroma": 0.2,
        "minLuminance": 0.16,
        "maxLuminance": 0.85,
        **config.get("thresholds", {}),
    }
    candidate = (
        (saturation <= t["maxSaturation"])
        & (chroma <= t["maxChroma"])
        & (luminance >= t["minLuminance"])
        & (luminance <= t["maxLuminance"])
    )
    mask = Image.fromarray(np.where(candidate, 255, 0).astype(np.uint8))

    morph = config.get("morphology", {})
    close_size = int(morph.get("closeSize", 5))
    open_size = int(morph.get("openSize", 3))
    mask = mask.filter(ImageFilter.MaxFilter(close_size)).filter(ImageFilter.MinFilter(close_size))
    mask = mask.filter(ImageFilter.MinFilter(open_size)).filter(ImageFilter.MaxFilter(open_size))
    return mask


def building_exclusion_mask(
    mosaic_size: tuple[int, int],
    osm_path: Path,
    zoom: int,
    tile_x0: int,
    tile_y0: int,
    dilation_px: int,
) -> Image.Image:
    """Rasterize OSM building footprints into a pixel mask, slightly dilated."""
    width, height = mosaic_size
    mask = Image.new("L", mosaic_size, 0)
    draw = ImageDraw.Draw(mask)
    if not osm_path.exists():
        print("警告: 未找到 OSM 数据，跳过建筑排除")
        return mask
    data = json.loads(osm_path.read_text(encoding="utf-8"))
    count = 0
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        if props.get("featureClass") != "building":
            continue
        geometry = feature.get("geometry", {})
        if geometry.get("type") != "Polygon":
            continue
        rings = geometry["coordinates"]
        for ring in rings:
            points = []
            for lon, lat in ring:
                px, py = wgs84_to_pixel(lon, lat, zoom)
                points.append((px - tile_x0 * 256, py - tile_y0 * 256))
            if len(points) >= 3:
                draw.polygon(points, fill=255)
                count += 1
    if dilation_px:
        mask = mask.filter(ImageFilter.MaxFilter(dilation_px * 2 + 1))
    print(f"建筑排除: {count} 栋（膨胀 {dilation_px}px）")
    return mask


def region_exclusion_mask(mosaic_size: tuple[int, int], regions: list, zoom: int, tile_x0: int, tile_y0: int) -> Image.Image:
    mask = Image.new("L", mosaic_size, 0)
    if not regions:
        return mask
    draw = ImageDraw.Draw(mask)
    for region in regions:
        rings = region.get("coordinates", []) if isinstance(region, dict) else region
        for ring in rings:
            points = []
            for lon, lat in ring:
                px, py = wgs84_to_pixel(lon, lat, zoom)
                points.append((px - tile_x0 * 256, py - tile_y0 * 256))
            if len(points) >= 3:
                draw.polygon(points, fill=255)
    return mask


# -------------------------------------------------------------- vector output

def wgs84_features(
    mask: Image.Image,
    zoom: int,
    tile_x0: int,
    tile_y0: int,
    vector_step: int,
    min_area_pixels: int,
    source: dict,
) -> list[dict]:
    width, height = mask.size
    grid_width = math.ceil(width / vector_step)
    grid_height = math.ceil(height / vector_step)
    grid = np.asarray(mask.resize((grid_width, grid_height), Image.Resampling.NEAREST)) > 0
    min_cells = max(1, math.ceil(min_area_pixels / (vector_step * vector_step)))
    res = resolution_m_per_px(zoom)
    features = []
    for index, cells in enumerate(_walk.component_cells(grid, min_cells), start=1):
        loops = [_walk.simplify_loop(loop) for loop in _walk.boundary_loops(cells)]
        outer = [loop for loop in loops if _walk.signed_area(loop) > 0]
        holes = [loop for loop in loops if _walk.signed_area(loop) < 0]
        if not outer:
            continue
        outer.sort(key=lambda ring: abs(_walk.signed_area(ring)), reverse=True)
        rings = [outer[0], *holes]
        coordinates = []
        for ring in rings:
            converted = []
            for gx, gy in ring:
                # grid cell -> mosaic pixel center: (gx+0.5) * (width/grid_width)
                px = (gx + 0.5) * (width / grid_width) + tile_x0 * 256
                py = (gy + 0.5) * (height / grid_height) + tile_y0 * 256
                mx, my = pixel_to_mercator(px, py, zoom)
                lon, lat = mercator_to_wgs84(mx, my)
                converted.append([round(lon, 7), round(lat, 7)])
            coordinates.append(converted)
        area_sqm = len(cells) * vector_step * vector_step * res * res
        features.append(
            {
                "type": "Feature",
                "id": f"esri-tile/paved/{index}",
                "properties": {
                    "featureClass": "walkableSurfaceCandidate",
                    "surfaceClass": "paved-ground",
                    "surface": "paved",
                    "level": "ground",
                    "coordinateSpace": "wgs84",
                    "origin": "top-left-image",
                    "source": source.get("name", "esri-world-imagery"),
                    "evidence": "low-saturation-gray-in-ortho-imagery",
                    "verificationStatus": "image-derived-unverified",
                    "routingEnabled": False,
                    "pixelAreaApprox": len(cells) * vector_step * vector_step,
                    "areaSqmApprox": round(area_sqm, 1),
                },
                "geometry": {"type": "Polygon", "coordinates": coordinates},
            }
        )
    return features


# ----------------------------------------------------------------------- main

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/paved-esri"))
    parser.add_argument("--osm", type=Path, default=Path("public/data/campus-osm.geojson"))
    parser.add_argument("--no-exclude-buildings", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    source = config["source"]
    bbox = config["bbox"]
    zoom = int(source["zoom"])
    x0, y0, x1, y1 = tile_range(bbox, zoom)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = args.output_dir / "tiles"

    mosaic = fetch_mosaic(config, cache_dir)
    image = Image.fromarray(mosaic)
    image.save(args.output_dir / f"esri-z{zoom}-mosaic.png", optimize=True)

    candidate = paved_mask(mosaic, config)
    candidate_array = np.asarray(candidate) > 0

    exclusions = np.zeros_like(candidate_array)
    if not args.no_exclude_buildings and config.get("excludeBuildings", True):
        building_mask = building_exclusion_mask(
            image.size, args.osm, zoom, x0, y0, int(config.get("buildingDilationPx", 4))
        )
        exclusions |= np.asarray(building_mask) > 0
    region_mask = region_exclusion_mask(
        image.size, config.get("excludeRegions", []), zoom, x0, y0
    )
    exclusions |= np.asarray(region_mask) > 0

    paved = candidate_array & ~exclusions
    paved_image = Image.fromarray(np.where(paved, 255, 0).astype(np.uint8))
    exclusion_image = Image.fromarray(np.where(exclusions, 255, 0).astype(np.uint8))

    paved_image.save(args.output_dir / "paved-mask.png", optimize=True)
    # Worldfile so QGIS can load the mask georeferenced (EPSG:3857).
    res = resolution_m_per_px(zoom)
    mx0, my0 = pixel_to_mercator(x0 * 256 + 0.5, y0 * 256 + 0.5, zoom)
    (args.output_dir / "paved-mask.pgw").write_text(
        f"{res:.10f}\n0.0\n0.0\n{-res:.10f}\n{mx0:.6f}\n{my0:.6f}\n", encoding="utf-8"
    )
    _walk.overlay_preview(image, paved_image, exclusion_image).save(
        args.output_dir / "paved-overlay.png", optimize=True
    )

    features = wgs84_features(
        paved_image,
        zoom,
        x0,
        y0,
        int(config.get("vectorStep", 2)),
        int(config.get("minAreaPixels", 150)),
        source,
    )
    geojson = {
        "type": "FeatureCollection",
        "schemaVersion": SCHEMA_VERSION,
        "name": "HKUST(GZ) paved-surface candidates from Esri World Imagery tiles",
        "coordinateSpace": "wgs84",
        "source": source,
        "bbox": [bbox["west"], bbox["south"], bbox["east"], bbox["north"]],
        "tileRange": {"zoom": zoom, "x": [x0, x1], "y": [y0, y1]},
        "thresholds": config.get("thresholds", {}),
        "excludedBuildings": (not args.no_exclude_buildings) and config.get("excludeBuildings", True),
        "attribution": source.get("attribution", ""),
        "disclaimer": "Color visible in ortho imagery identifies candidate surfaces only. Material, access, elevation, edge protection and vertical connectivity require field or source-model verification before routing.",
        "reviewRequired": [
            "field-verification-of-material-and-access",
            "split-paved-by-material-and-function",
            "add-verified-vertical-connectors",
        ],
        "features": features,
    }
    (args.output_dir / "paved-surfaces.wgs84.geojson").write_text(
        json.dumps(geojson, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "source": source["name"],
        "zoom": zoom,
        "tileCount": (x1 - x0 + 1) * (y1 - y0 + 1),
        "tileRange": {"x": [x0, x1], "y": [y0, y1]},
        "mosaicSize": [image.width, image.height],
        "resolutionMetersPerPixel": round(res, 6),
        "candidatePixelRatio": round(float(candidate_array.mean()), 6),
        "pavedPixelRatio": round(float(paved.mean()), 6),
        "pavedAreaSqmApprox": round(int(paved.sum()) * res * res, 1),
        "excludedBuildingPixelRatio": round(float(exclusions.mean()), 6),
        "polygonCount": len(features),
        "classificationMode": "osm-building-masked" if exclusions.any() else "no-exclusion",
        "thresholds": config.get("thresholds", {}),
        "routingEnabled": False,
    }
    (args.output_dir / "paved-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
