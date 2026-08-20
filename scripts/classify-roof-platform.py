#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.3.2",
#   "pillow==11.3.0",
# ]
# ///
"""Fine-grained two-class surface classification of a roof platform region.

For the HKUST(GZ) Lecture Hall ABC roof platform (the outdoor 3F platform used
for the August robot demo), distinguish:

  - walkable-tile    浅灰/米色砖石地板砖  -> robot-walkable
  - green-nonwalkable 绿色铺装（绿地/绿色面层） -> NOT robot-walkable

Classification is hue/value/saturation rule based inside a region polygon from
a GeoJSON feature. Outputs are WGS84 polygons (tiles are already georeferenced),
per-class masks with worldfiles, an overlay preview and a summary.

All features are evidence-bounded: `verificationStatus=image-derived-unverified`,
`routingEnabled=false` until field review.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "extract_paved_from_tiles", _HERE / "extract-paved-from-tiles.py"
)
_ext = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_ext)

SCHEMA_VERSION = "1.0"


# --------------------------------------------------------------------- utils

def hsv_array(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vectorized RGB (N,3) float32 0..1 -> hue(0..1), saturation, value."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    chroma = mx - mn
    sat = np.divide(chroma, mx, out=np.zeros_like(chroma), where=mx > 0)
    hue = np.zeros_like(sat)
    nz = chroma > 0
    max_r = nz & (mx == r)
    max_g = nz & (mx == g)
    max_b = nz & (mx == b)
    hue[max_r] = ((g[max_r] - b[max_r]) / chroma[max_r]) % 6.0
    hue[max_g] = (b[max_g] - r[max_g]) / chroma[max_g] + 2.0
    hue[max_b] = (r[max_b] - g[max_b]) / chroma[max_b] + 4.0
    return hue / 6.0, sat, mx


def rasterize_polygons(polygons: list, size: tuple[int, int], zoom: int, tile_x0: int, tile_y0: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for ring in polygons:
        points = []
        for lon, lat in ring:
            gx, gy = _ext.wgs84_to_pixel(lon, lat, zoom)
            points.append((gx - tile_x0 * 256, gy - tile_y0 * 256))
        if len(points) >= 3:
            draw.polygon(points, fill=255)
    return mask


# -------------------------------------------------------------------- main

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/roof-platforms"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    zoom = int(config.get("zoom", 18))
    x0, y0 = config["tileOrigin"]  # 瓦片原点 (x0, y0)，与 extract:paved 的 tileRange 一致

    mosaic_path = Path(config["mosaic"])
    if not mosaic_path.exists():
        sys.exit(f"缺少 mosaic: {mosaic_path}（请先运行 npm run extract:paved）")
    image = Image.open(mosaic_path).convert("RGB")
    size = image.size

    # 区域多边形（演讲厅屋顶）
    region_cfg = config["regionFeature"]
    geo = json.loads(Path(region_cfg["file"]).read_text(encoding="utf-8"))
    feature = next(f for f in geo["features"] if f["id"] == region_cfg["id"])
    geometry = feature["geometry"]
    if geometry["type"] == "Polygon":
        rings = geometry["coordinates"]
    else:
        rings = geometry["coordinates"][0]
    region_mask = rasterize_polygons(rings, size, zoom, x0, y0)
    erode = int(config.get("erodeRegionPx", 2))
    if erode:
        region_mask = region_mask.filter(ImageFilter.MinFilter(erode * 2 + 1))
    region = np.asarray(region_mask) > 0

    rgb = np.asarray(image, dtype=np.float32) / 255.0
    hue, sat, val = hsv_array(rgb)

    classes = config["classes"]
    # 按 priority 升序依次判定（数字小的优先，先判定的类不会被后类覆盖）
    order = sorted(classes.items(), key=lambda item: item[1].get("priority", 99))
    labels = {key: cls["label"] for key, cls in classes.items()}
    class_index = {key: idx for idx, (key, _) in enumerate(order)}
    out = np.full(rgb.shape[:2], -1, dtype=np.int16)

    for idx, (key, cls) in enumerate(order):
        mask = np.ones(rgb.shape[:2], dtype=bool)
        if "hueMin" in cls:
            mask &= hue >= cls["hueMin"]
        if "hueMax" in cls:
            mask &= hue <= cls["hueMax"]
        if "minSaturation" in cls:
            mask &= sat >= cls["minSaturation"]
        if "maxSaturation" in cls:
            mask &= sat <= cls["maxSaturation"]
        if "minValue" in cls:
            mask &= val >= cls["minValue"]
        if "maxValue" in cls:
            mask &= val <= cls["maxValue"]
        free = out == -1
        out[free & mask & region] = idx

    # 逐类形态学清理 + 矢量化
    features: list[dict] = []
    per_class: dict[str, dict] = {}
    for idx, (key, cls) in enumerate(order):
        class_mask = Image.fromarray(np.where(out == idx, 255, 0).astype(np.uint8))
        morph = config.get("morphology", {})
        close_size = int(morph.get("closeSize", 3))
        open_size = int(morph.get("openSize", 3))
        if close_size:
            class_mask = class_mask.filter(ImageFilter.MaxFilter(close_size)).filter(ImageFilter.MinFilter(close_size))
        if open_size:
            class_mask = class_mask.filter(ImageFilter.MinFilter(open_size)).filter(ImageFilter.MaxFilter(open_size))
        class_array = np.asarray(class_mask) > 0

        per_class[key] = {
            "label": cls.get("label", key),
            "robotWalkable": bool(cls.get("robotWalkable", False)),
            "mask": class_mask,
            "pixels": int(class_array.sum()),
        }

        vector_step = int(config.get("vectorStep", 2))
        min_area_pixels = int(config.get("minAreaPixels", 80))
        res = _ext.resolution_m_per_px(zoom)
        grid_w = math.ceil(size[0] / vector_step)
        grid_h = math.ceil(size[1] / vector_step)
        grid = np.asarray(class_mask.resize((grid_w, grid_h), Image.Resampling.NEAREST)) > 0
        min_cells = max(1, math.ceil(min_area_pixels / (vector_step * vector_step)))
        for index, cells in enumerate(_ext._walk.component_cells(grid, min_cells), start=1):
            loops = [_ext._walk.simplify_loop(loop) for loop in _ext._walk.boundary_loops(cells)]
            outer = [loop for loop in loops if _ext._walk.signed_area(loop) > 0]
            holes = [loop for loop in loops if _ext._walk.signed_area(loop) < 0]
            if not outer:
                continue
            outer.sort(key=lambda ring: abs(_ext._walk.signed_area(ring)), reverse=True)
            coordinates = []
            for ring in [outer[0], *holes]:
                converted = []
                for gx, gy in ring:
                    px = (gx + 0.5) * (size[0] / grid_w) + x0 * 256
                    py = (gy + 0.5) * (size[1] / grid_h) + y0 * 256
                    mx, my = _ext.pixel_to_mercator(px, py, zoom)
                    lon, lat = _ext.mercator_to_wgs84(mx, my)
                    converted.append([round(lon, 7), round(lat, 7)])
                coordinates.append(converted)
            area_sqm = len(cells) * vector_step * vector_step * res * res
            features.append(
                {
                    "type": "Feature",
                    "id": f"lecture-hall-abc/{key}/{index}",
                    "properties": {
                        "featureClass": "platformSurface",
                        "surfaceClass": key,
                        "label": cls.get("label", key),
                        "robotWalkable": bool(cls.get("robotWalkable", False)),
                        "level": "3",
                        "coordinateSpace": "wgs84",
                        "source": "esri-world-imagery-z18",
                        "evidence": "hsv-rule-classification",
                        "verificationStatus": "image-derived-unverified",
                        "routingEnabled": False,
                        "pixelAreaApprox": len(cells) * vector_step * vector_step,
                        "areaSqmApprox": round(area_sqm, 1),
                    },
                    "geometry": {"type": "Polygon", "coordinates": coordinates},
                }
            )

    # 输出
    args.output_dir.mkdir(parents=True, exist_ok=True)
    res = _ext.resolution_m_per_px(zoom)
    for key, info in per_class.items():
        info["mask"].save(args.output_dir / f"mask-{key}.png", optimize=True)
        mx0, my0 = _ext.pixel_to_mercator(x0 * 256 + 0.5, y0 * 256 + 0.5, zoom)
        (args.output_dir / f"mask-{key}.pgw").write_text(
            f"{res:.10f}\n0.0\n0.0\n{-res:.10f}\n{mx0:.6f}\n{my0:.6f}\n", encoding="utf-8"
        )

    base = image.convert("RGBA")
    walkable = Image.new("L", size, 0)
    blocked = Image.new("L", size, 0)
    for key, info in per_class.items():
        if info["robotWalkable"]:
            walkable = info["mask"]
        else:
            blocked = Image.composite(
                Image.new("L", size, 255), blocked, info["mask"]
            ) if blocked.getbbox() else info["mask"]
    mint = Image.new("RGBA", size, (57, 232, 179, 0))
    mint.putalpha(walkable.point(lambda v: 110 if v else 0))
    red = Image.new("RGBA", size, (255, 82, 82, 0))
    red.putalpha(blocked.point(lambda v: 120 if v else 0))
    overlay = Image.alpha_composite(Image.alpha_composite(base, mint), red)
    # 区域轮廓
    outline = ImageDraw.Draw(overlay)
    ring_px = []
    for lon, lat in rings[0]:
        gx, gy = _ext.wgs84_to_pixel(lon, lat, zoom)
        ring_px.append((gx - x0 * 256, gy - y0 * 256))
    outline.line(ring_px + [ring_px[0]], fill=(255, 255, 255, 200), width=3)
    overlay.save(args.output_dir / "platform-classes-overlay.png", optimize=True)

    geojson = {
        "type": "FeatureCollection",
        "schemaVersion": SCHEMA_VERSION,
        "name": "HKUST(GZ) Lecture Hall ABC roof platform surface classes",
        "coordinateSpace": "wgs84",
        "regionFeature": region_cfg,
        "classes": {key: {"label": cls.get("label"), "robotWalkable": cls.get("robotWalkable")} for key, cls in classes.items()},
        "disclaimer": "Rule-based color classification from ortho imagery identifies candidate surfaces only. Field verification required before robot routing.",
        "features": features,
    }
    (args.output_dir / "platform-classes.wgs84.geojson").write_text(
        json.dumps(geojson, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "regionFeature": region_cfg,
        "mosaic": str(mosaic_path),
        "resolutionMetersPerPixel": round(res, 6),
        "regionPixelCount": int(region.sum()),
        "classes": {
            key: {
                "label": info["label"],
                "robotWalkable": info["robotWalkable"],
                "pixelRatio": round(info["pixels"] / int(region.sum()), 6),
                "areaSqmApprox": round(info["pixels"] * res * res, 1),
            }
            for key, info in per_class.items()
        },
        "unclassifiedPixelRatio": round(float((out[region] == -1).mean()), 6),
        "polygonCount": len(features),
        "routingEnabled": False,
    }
    (args.output_dir / "platform-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
