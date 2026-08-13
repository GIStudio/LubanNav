#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.3.2",
#   "pillow==11.3.0",
# ]
# ///
"""Extract concrete-colored candidate walkable surfaces from a rendered campus image.

The output is deliberately evidence-bounded: color and planarity visible in one
render can identify candidate surfaces, but cannot prove access or vertical
connectivity. Coordinates in the GeoJSON are normalized image coordinates
(0..1, origin at the image top-left) until ground-control points are supplied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


SCHEMA_VERSION = "1.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Rendered campus image")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--config", type=Path, help="Optional JSON review regions")
    parser.add_argument("--max-width", type=int, default=1176)
    parser.add_argument("--vector-step", type=int, default=4)
    parser.add_argument("--min-area-pixels", type=int, default=140)
    return parser.parse_args()


def load_config(path: Path | None) -> dict:
    if path is None:
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_polygon_mask(size: tuple[int, int], polygons: list[list[list[float]]]) -> Image.Image:
    width, height = size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for polygon in polygons:
        points = [(round(x * width), round(y * height)) for x, y in polygon]
        if len(points) >= 3:
            draw.polygon(points, fill=255)
    return mask


def concrete_candidate_mask(image: Image.Image, config: dict) -> Image.Image:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    chroma = maximum - minimum
    saturation = np.divide(chroma, maximum, out=np.zeros_like(chroma), where=maximum > 0)
    luminance = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722

    thresholds = {
        "maxSaturation": 0.27,
        "maxChroma": 0.24,
        "minLuminance": 0.22,
        **config.get("thresholds", {}),
    }
    candidate = (
        (saturation <= thresholds["maxSaturation"])
        & (chroma <= thresholds["maxChroma"])
        & (luminance >= thresholds["minLuminance"])
    )

    mask = Image.fromarray(np.where(candidate, 255, 0).astype(np.uint8))
    # Close small material seams, then remove isolated linework and JPEG noise.
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))

    excluded = normalized_polygon_mask(image.size, config.get("excludeRegions", []))
    mask_array = np.asarray(mask) > 0
    mask_array &= np.asarray(excluded) == 0
    return Image.fromarray(np.where(mask_array, 255, 0).astype(np.uint8))


def component_cells(mask: np.ndarray, min_cells: int) -> list[list[tuple[int, int]]]:
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    components: list[list[tuple[int, int]]] = []
    for y in range(height):
        for x in range(width):
            if not mask[y, x] or seen[y, x]:
                continue
            queue = deque([(x, y)])
            seen[y, x] = True
            cells: list[tuple[int, int]] = []
            while queue:
                cx, cy = queue.popleft()
                cells.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < width and 0 <= ny < height and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((nx, ny))
            if len(cells) >= min_cells:
                components.append(cells)
    return components


def boundary_loops(cells: list[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    filled = set(cells)
    edges: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    for x, y in cells:
        if (x, y - 1) not in filled:
            edges.add(((x, y), (x + 1, y)))
        if (x + 1, y) not in filled:
            edges.add(((x + 1, y), (x + 1, y + 1)))
        if (x, y + 1) not in filled:
            edges.add(((x + 1, y + 1), (x, y + 1)))
        if (x - 1, y) not in filled:
            edges.add(((x, y + 1), (x, y)))

    outgoing: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    for start, end in edges:
        outgoing[start].append(end)

    loops: list[list[tuple[int, int]]] = []
    while edges:
        first = next(iter(edges))
        start, current = first
        loop = [start, current]
        edges.remove(first)
        while current != start:
            choices = [end for end in outgoing[current] if (current, end) in edges]
            if not choices:
                break
            previous = loop[-2]
            incoming_angle = math.atan2(current[1] - previous[1], current[0] - previous[0])
            # Prefer the tightest clockwise continuation at ambiguous vertices.
            current = min(
                choices,
                key=lambda end: (math.atan2(end[1] - loop[-1][1], end[0] - loop[-1][0]) - incoming_angle)
                % (2 * math.pi),
            )
            edge = (loop[-1], current)
            edges.remove(edge)
            loop.append(current)
        if len(loop) >= 4 and loop[-1] == start:
            loops.append(loop)
    return loops


def perpendicular_distance(point, start, end) -> float:
    if start == end:
        return math.dist(point, start)
    numerator = abs((end[1] - start[1]) * point[0] - (end[0] - start[0]) * point[1] + end[0] * start[1] - end[1] * start[0])
    return numerator / math.dist(start, end)


def simplify_open(points: list[tuple[int, int]], tolerance: float) -> list[tuple[int, int]]:
    if len(points) <= 2:
        return points
    start, end = points[0], points[-1]
    distances = [perpendicular_distance(point, start, end) for point in points[1:-1]]
    if not distances or max(distances) <= tolerance:
        return [start, end]
    split = distances.index(max(distances)) + 1
    return simplify_open(points[: split + 1], tolerance)[:-1] + simplify_open(points[split:], tolerance)


def simplify_loop(loop: list[tuple[int, int]], tolerance: float = 0.9) -> list[tuple[int, int]]:
    points = loop[:-1]
    if len(points) < 5:
        return loop
    anchor = min(range(len(points)), key=lambda index: (points[index][0], points[index][1]))
    rotated = points[anchor:] + points[:anchor] + [points[anchor]]
    middle = max(range(1, len(rotated) - 1), key=lambda index: math.dist(rotated[index], rotated[0]))
    first = simplify_open(rotated[: middle + 1], tolerance)
    second = simplify_open(rotated[middle:], tolerance)
    simplified = first[:-1] + second
    return simplified if simplified[-1] == simplified[0] else simplified + [simplified[0]]


def signed_area(ring: list[tuple[int, int]]) -> float:
    return sum(
        ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1]
        for index in range(len(ring) - 1)
    ) / 2


def vector_features(
    mask: Image.Image,
    surface_class: str,
    vector_step: int,
    min_area_pixels: int,
) -> list[dict]:
    width, height = mask.size
    grid_width = math.ceil(width / vector_step)
    grid_height = math.ceil(height / vector_step)
    grid = np.asarray(mask.resize((grid_width, grid_height), Image.Resampling.NEAREST)) > 0
    min_cells = max(1, math.ceil(min_area_pixels / (vector_step * vector_step)))
    features = []
    for index, cells in enumerate(component_cells(grid, min_cells), start=1):
        loops = [simplify_loop(loop) for loop in boundary_loops(cells)]
        outer = [loop for loop in loops if signed_area(loop) > 0]
        holes = [loop for loop in loops if signed_area(loop) < 0]
        if not outer:
            continue
        outer.sort(key=lambda ring: abs(signed_area(ring)), reverse=True)
        rings = [outer[0], *holes]
        coordinates = [
            [[round(x / grid_width, 6), round(y / grid_height, 6)] for x, y in ring]
            for ring in rings
        ]
        features.append(
            {
                "type": "Feature",
                "id": f"render/{surface_class}/{index}",
                "properties": {
                    "featureClass": "walkableSurfaceCandidate",
                    "surfaceClass": surface_class,
                    "surface": "concrete",
                    "level": "unknown",
                    "coordinateSpace": "normalized-image",
                    "origin": "top-left",
                    "evidence": "cement-color-and-visible-planarity",
                    "verificationStatus": "image-derived-unverified",
                    "routingEnabled": False,
                    "pixelAreaApprox": len(cells) * vector_step * vector_step,
                },
                "geometry": {"type": "Polygon", "coordinates": coordinates},
            }
        )
    return features


def overlay_preview(image: Image.Image, ground: Image.Image, roof: Image.Image) -> Image.Image:
    base = image.convert("RGBA")
    green = Image.new("RGBA", image.size, (39, 232, 179, 0))
    green.putalpha(ground.point(lambda value: 112 if value else 0))
    magenta = Image.new("RGBA", image.size, (255, 105, 180, 0))
    magenta.putalpha(roof.point(lambda value: 124 if value else 0))
    return Image.alpha_composite(Image.alpha_composite(base, green), magenta)


def main() -> None:
    args = parse_args()
    config = load_config(args.config)
    source = Image.open(args.input).convert("RGB")
    source_sha256 = hashlib.sha256(args.input.read_bytes()).hexdigest()
    if source.width > args.max_width:
        scale = args.max_width / source.width
        image = source.resize((args.max_width, round(source.height * scale)), Image.Resampling.LANCZOS)
    else:
        image = source

    candidate = concrete_candidate_mask(image, config)
    roof_regions = config.get("roofRegions", [])
    roof_region = normalized_polygon_mask(image.size, roof_regions)
    candidate_array = np.asarray(candidate) > 0
    roof_array = candidate_array & (np.asarray(roof_region) > 0)
    ground_array = candidate_array & ~roof_array
    roof = Image.fromarray(np.where(roof_array, 255, 0).astype(np.uint8))
    ground = Image.fromarray(np.where(ground_array, 255, 0).astype(np.uint8))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    candidate.save(args.output_dir / "walkable-surface-mask.png", optimize=True)
    if roof_regions:
        roof.save(args.output_dir / "walkable-roof-mask.png", optimize=True)
        ground.save(args.output_dir / "walkable-ground-mask.png", optimize=True)
        preview_ground = ground
        preview_roof = roof
    else:
        preview_ground = candidate
        preview_roof = Image.new("L", image.size, 0)
    overlay_preview(image, preview_ground, preview_roof).save(
        args.output_dir / "walkable-surfaces-preview.png", optimize=True
    )

    if roof_regions:
        features = vector_features(ground, "ground", args.vector_step, args.min_area_pixels)
        features += vector_features(roof, "roof", args.vector_step, args.min_area_pixels)
    else:
        features = vector_features(
            candidate,
            "ground-or-roof-unclassified",
            args.vector_step,
            args.min_area_pixels,
        )
    geojson = {
        "type": "FeatureCollection",
        "schemaVersion": SCHEMA_VERSION,
        "name": "HKUST(GZ) rendered concrete walkable surface candidates",
        "coordinateSpace": "normalized-image",
        "sourceImage": args.input.name,
        "sourceImageSha256": source_sha256,
        "sourceImageSize": [source.width, source.height],
        "processedImageSize": [image.width, image.height],
        "disclaimer": "Color and visible planarity identify candidates only. Access, load capacity, edge protection, elevation and vertical connections require field or model verification before routing.",
        "reviewRequired": [
            "separate-ground-roof-and-facade",
            "register-image-coordinates-to-WGS84",
            "add-verified-vertical-connectors",
            "field-or-source-model-verification",
        ],
        "features": features,
    }
    (args.output_dir / "walkable-surfaces.image.geojson").write_text(
        json.dumps(geojson, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "sourceImage": args.input.name,
        "sourceImageSha256": source_sha256,
        "sourceImageSize": [source.width, source.height],
        "processedImageSize": [image.width, image.height],
        "candidatePixelRatio": round(float(candidate_array.mean()), 6),
        "classificationMode": "review-regions" if roof_regions else "ground-or-roof-unclassified",
        "groundPixelRatio": round(float(ground_array.mean()), 6) if roof_regions else None,
        "roofPixelRatio": round(float(roof_array.mean()), 6) if roof_regions else None,
        "polygonCount": len(features),
        "groundPolygonCount": sum(feature["properties"]["surfaceClass"] == "ground" for feature in features),
        "roofPolygonCount": sum(feature["properties"]["surfaceClass"] == "roof" for feature in features),
        "unclassifiedPolygonCount": sum(
            feature["properties"]["surfaceClass"] == "ground-or-roof-unclassified"
            for feature in features
        ),
        "routingEnabled": False,
    }
    (args.output_dir / "walkable-surfaces-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
