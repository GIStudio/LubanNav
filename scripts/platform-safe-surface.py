#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.3.2",
#   "pillow==11.3.0",
# ]
# ///
"""Compute the robot-safe walkable surface of the Lecture Hall ABC 3F platform.

Combines:
  1. the platform walkable surface classified from Esri ortho tiles
     (light gray/beige tile; green paving and shadows treated non-walkable,
      with a shadow-recovery rule for dark neutral pixels),
  2. bridge corridors drawn by the user in QGIS (GeoPackage line layer,
     expanded to a configurable width, default 4 m),

then erodes the union inward by `edgeBufferMeters` (default 1 m:
0.5 m greenery margin + 0.5 m RTK/antenna offset). The eroded result is the
robot-safe walkable area; the removed ring is the edge buffer zone.

Outputs (WGS84, tiles are already georeferenced):
  - safe-walkable.wgs84.geojson        robot-safe polygons
  - edge-buffer-zone.wgs84.geojson     the inset 1 m ring (non-walkable)
  - mask-*.png + .pgw                  raster masks (EPSG:3857)
  - platform-safe-overlay.png          visual check (mint=walkable, red=buffer)
  - platform-safe-summary.json         areas / counts
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sqlite3
import struct
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


# ------------------------------------------------------------------ geo utils

def hsv_array(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
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


def disk_erode(mask: np.ndarray, radius: int) -> np.ndarray:
    """Erode with a circular kernel of the given pixel radius."""
    out = mask.copy()
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy <= radius * radius + 1e-9:
                out &= np.roll(np.roll(mask, -dy, axis=0), -dx, axis=1)
    return out


def parse_wkb(blob: bytes) -> list[list[list[float]]]:
    """Minimal WKB parser: LineString / MultiLineString -> [line][point][lon,lat]."""
    if not blob or len(blob) < 5:
        return []
    if blob[:2] == b"GP":  # extended WKB (GeoPackage): 'GP'+version+flags+srid+envelope
        for off in range(8, min(len(blob) - 4, 160)):
            if blob[off] == 1 and blob[off + 1] in (2, 6) and blob[off + 2 : off + 5] == b"\x00\x00\x00":
                blob = blob[off:]
                break
    if len(blob) < 5:
        return []
    order = "<" if blob[0] == 1 else ">"
    gtype = struct.unpack(order + "I", blob[1:5])[0]
    base = gtype & 0x0FFFFFFF
    if base == 2:  # LineString
        n = struct.unpack(order + "I", blob[5:9])[0]
        vals = struct.unpack(order + "%dd" % (2 * n), blob[9 : 9 + 16 * n])
        return [[[vals[i], vals[i + 1]] for i in range(0, 2 * n, 2)]]
    if base == 6:  # MultiLineString
        m = struct.unpack(order + "I", blob[5:9])[0]
        off = 9
        lines = []
        for _ in range(m):
            n = struct.unpack(order + "I", blob[off + 5 : off + 9])[0]
            vals = struct.unpack(order + "%dd" % (2 * n), blob[off + 9 : off + 9 + 16 * n])
            lines.append([[vals[i], vals[i + 1]] for i in range(0, 2 * n, 2)])
            off += 9 + 16 * n
        return lines
    return []


def read_bridge_lines(path: Path, layer: str) -> list[list[list[float]]]:
    if not path.exists():
        print(f"警告: 桥梁文件不存在 {path}")
        return []
    con = sqlite3.connect(str(path))
    try:
        geom_col = con.execute(
            "SELECT column_name FROM gpkg_geometry_columns WHERE table_name=?", (layer,)
        ).fetchone()
        geom_col = geom_col[0] if geom_col else "geom"
        rows = con.execute(f'SELECT "{geom_col}" FROM "{layer}"').fetchall()
    except sqlite3.Error as exc:
        print(f"警告: 读取桥梁失败: {exc}")
        return []
    finally:
        con.close()
    lines = []
    for (blob,) in rows:
        if blob:
            lines.extend(parse_wkb(bytes(blob)))
    return lines


# -------------------------------------------------------------------- main

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/roof-platforms/lecture-hall-abc"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    zoom = int(config.get("zoom", 18))
    x0, y0 = config["tileOrigin"]

    mosaic_path = Path(config["mosaic"])
    if not mosaic_path.exists():
        sys.exit(f"缺少 mosaic: {mosaic_path}（请先运行 npm run extract:paved）")
    image = Image.open(mosaic_path).convert("RGB")
    size = image.size
    height, width = size[1], size[0]
    res = _ext.resolution_m_per_px(zoom)

    # ---- 区域（演讲厅屋顶）
    region_cfg = config["regionFeature"]
    geo = json.loads(Path(region_cfg["file"]).read_text(encoding="utf-8"))
    feature = next(f for f in geo["features"] if f["id"] == region_cfg["id"])
    geometry = feature["geometry"]
    rings = geometry["coordinates"] if geometry["type"] == "Polygon" else geometry["coordinates"][0]
    region_mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(region_mask)
    points = []
    for lon, lat in rings[0]:
        gx, gy = _ext.wgs84_to_pixel(lon, lat, zoom)
        points.append((gx - x0 * 256, gy - y0 * 256))
    draw.polygon(points, fill=255)
    erode = int(config.get("erodeRegionPx", 2))
    if erode:
        region_mask = region_mask.filter(ImageFilter.MinFilter(erode * 2 + 1))
    region = np.asarray(region_mask) > 0

    # ---- 分类
    rgb = np.asarray(image, dtype=np.float32) / 255.0
    hue, sat, val = hsv_array(rgb)
    classes = config["classes"]
    order = sorted(classes.items(), key=lambda item: item[1].get("priority", 99))
    out = np.full((height, width), -1, dtype=np.int16)
    for idx, (key, cls) in enumerate(order):
        mask = np.ones((height, width), dtype=bool)
        for attr, lo, hi in (("hue", "hueMin", "hueMax"), ("sat", "minSaturation", "maxSaturation"), ("val", "minValue", "maxValue")):
            arr = {"hue": hue, "sat": sat, "val": val}[attr]
            if lo in cls:
                mask &= arr >= cls[lo]
            if hi in cls:
                mask &= arr <= cls[hi]
        free = out == -1
        out[free & mask & region] = idx

    walkable = np.zeros((height, width), dtype=bool)
    for idx, (key, cls) in enumerate(order):
        if cls.get("robotWalkable"):
            walkable |= out == idx
    print(f"分类: { {k: int((out == i).sum()) for i, (k, _) in enumerate(order)} }")

    # ---- 天桥（用户绘制中心线 + 宽度）
    bridges_cfg = config.get("bridges", {})
    lines = read_bridge_lines(Path(bridges_cfg.get("file", "")), bridges_cfg.get("layer", "lines"))
    bridge_width = float(bridges_cfg.get("widthMeters", 4.0))
    print(f"天桥: {len(lines)} 条中心线，宽度 {bridge_width} m")
    if lines:
        bridge_mask = Image.new("L", size, 0)
        bd = ImageDraw.Draw(bridge_mask)
        line_px = max(3, round(bridge_width / res) | 1)  # 奇数像素宽
        for line in lines:
            pts = []
            for lon, lat in line:
                gx, gy = _ext.wgs84_to_pixel(lon, lat, zoom)
                pts.append((gx - x0 * 256, gy - y0 * 256))
            if len(pts) >= 2:
                bd.line(pts, fill=255, width=line_px)
        walkable |= np.asarray(bridge_mask) > 0

    # 形态学清理
    morph = config.get("morphology", {})
    close_size = int(morph.get("closeSize", 3))
    open_size = int(morph.get("openSize", 3))
    walkable_img = Image.fromarray(np.where(walkable, 255, 0).astype(np.uint8))
    if close_size:
        walkable_img = walkable_img.filter(ImageFilter.MaxFilter(close_size)).filter(ImageFilter.MinFilter(close_size))
    if open_size:
        walkable_img = walkable_img.filter(ImageFilter.MinFilter(open_size)).filter(ImageFilter.MaxFilter(open_size))
    walkable = np.asarray(walkable_img) > 0

    # ---- 边缘内收 edgeBufferMeters
    buffer_m = float(config.get("edgeBufferMeters", 1.0))
    radius = max(1, math.ceil(buffer_m / res))
    safe = disk_erode(walkable, radius)
    ring = walkable & ~safe
    print(f"边缘内收: {buffer_m} m (半径 {radius} px = {radius * res:.2f} m)，安全区 {int(safe.sum())} px，缓冲区 {int(ring.sum())} px")

    # ---- 矢量化
    def vectorize(mask_arr: np.ndarray, prefix: str, walkable_flag: bool, min_area_pixels: int | None = None) -> list[dict]:
        mask_img = Image.fromarray(np.where(mask_arr, 255, 0).astype(np.uint8))
        vector_step = int(config.get("vectorStep", 2))
        if min_area_pixels is None:
            min_area_pixels = int(config.get("minAreaPixels", 80))
        grid_w = math.ceil(size[0] / vector_step)
        grid_h = math.ceil(size[1] / vector_step)
        grid = np.asarray(mask_img.resize((grid_w, grid_h), Image.Resampling.NEAREST)) > 0
        min_cells = max(1, math.ceil(min_area_pixels / (vector_step * vector_step)))
        features = []
        for index, cells in enumerate(_ext._walk.component_cells(grid, min_cells), start=1):
            loops = [_ext._walk.simplify_loop(loop) for loop in _ext._walk.boundary_loops(cells)]
            outer = [loop for loop in loops if _ext._walk.signed_area(loop) > 0]
            holes = [loop for loop in loops if _ext._walk.signed_area(loop) < 0]
            if not outer:
                continue
            outer.sort(key=lambda ring: abs(_ext._walk.signed_area(ring)), reverse=True)
            coordinates = []
            for ring_pts in [outer[0], *holes]:
                converted = []
                for gx, gy in ring_pts:
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
                    "id": f"{prefix}/{index}",
                    "properties": {
                        "featureClass": "platformSurface",
                        "surfaceClass": prefix,
                        "robotWalkable": walkable_flag,
                        "level": "3",
                        "coordinateSpace": "wgs84",
                        "source": "esri-world-imagery-z18 + qgis-lines",
                        "verificationStatus": "image-derived-unverified",
                        "edgeBufferMeters": buffer_m if walkable_flag else None,
                        "routingEnabled": False,
                        "pixelAreaApprox": len(cells) * vector_step * vector_step,
                        "areaSqmApprox": round(area_sqm, 1),
                    },
                    "geometry": {"type": "Polygon", "coordinates": coordinates},
                }
            )
        return features

    safe_features = vectorize(safe, "safe-walkable", True)
    ring_features = vectorize(ring, "edge-buffer-zone", False, min_area_pixels=24)

    # ---- 输出
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, arr in (("walkable", walkable), ("safe", safe), ("buffer-zone", ring)):
        Image.fromarray(np.where(arr, 255, 0).astype(np.uint8)).save(
            args.output_dir / f"mask-{name}.png", optimize=True
        )
        mx0, my0 = _ext.pixel_to_mercator(x0 * 256 + 0.5, y0 * 256 + 0.5, zoom)
        (args.output_dir / f"mask-{name}.pgw").write_text(
            f"{res:.10f}\n0.0\n0.0\n{-res:.10f}\n{mx0:.6f}\n{my0:.6f}\n", encoding="utf-8"
        )

    base = image.convert("RGBA")
    mint = Image.new("RGBA", size, (57, 232, 179, 0))
    mint.putalpha(Image.fromarray(np.where(safe, 110, 0).astype(np.uint8)))
    red = Image.new("RGBA", size, (255, 82, 82, 0))
    red.putalpha(Image.fromarray(np.where(ring, 120, 0).astype(np.uint8)))
    overlay = Image.alpha_composite(Image.alpha_composite(base, mint), red)
    outline = ImageDraw.Draw(overlay)
    outline.line(points + [points[0]], fill=(255, 255, 255, 200), width=3)
    if lines:
        for line in lines:
            pts = []
            for lon, lat in line:
                gx, gy = _ext.wgs84_to_pixel(lon, lat, zoom)
                pts.append((gx - x0 * 256, gy - y0 * 256))
            outline.line(pts, fill=(255, 200, 0, 255), width=3)
    overlay.save(args.output_dir / "platform-safe-overlay.png", optimize=True)

    def feature_collection(name: str, feats: list[dict]) -> dict:
        return {
            "type": "FeatureCollection",
            "schemaVersion": SCHEMA_VERSION,
            "name": name,
            "coordinateSpace": "wgs84",
            "edgeBufferMeters": buffer_m,
            "bridgeWidthMeters": bridge_width,
            "features": feats,
        }

    (args.output_dir / "safe-walkable.wgs84.geojson").write_text(
        json.dumps(feature_collection("HKUST(GZ) Lecture Hall ABC 3F platform robot-safe walkable area", safe_features), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / "edge-buffer-zone.wgs84.geojson").write_text(
        json.dumps(feature_collection("HKUST(GZ) Lecture Hall ABC 3F platform 1m edge buffer zone", ring_features), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "regionFeature": region_cfg,
        "bridges": {"count": len(lines), "widthMeters": bridge_width, "file": bridges_cfg.get("file", "")},
        "edgeBufferMeters": buffer_m,
        "resolutionMetersPerPixel": round(res, 6),
        "walkableAreaSqm": round(int(walkable.sum()) * res * res, 1),
        "safeAreaSqm": round(int(safe.sum()) * res * res, 1),
        "bufferZoneAreaSqm": round(int(ring.sum()) * res * res, 1),
        "safePolygonCount": len(safe_features),
        "bufferPolygonCount": len(ring_features),
        "routingEnabled": False,
    }
    (args.output_dir / "platform-safe-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
