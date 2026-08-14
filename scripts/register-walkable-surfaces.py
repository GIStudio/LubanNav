#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy==2.3.2",
#   "pillow==11.3.0",
# ]
# ///
"""Register render-derived surface polygons to WGS84 using eight campus buildings."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


METERS_PER_LATITUDE_DEGREE = 110_540.0
METERS_PER_LONGITUDE_DEGREE = 111_320.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--image-surfaces", required=True, type=Path)
    parser.add_argument("--osm", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def polygon_centroid(ring: list[list[float]]) -> list[float]:
    area_twice = 0.0
    longitude_sum = 0.0
    latitude_sum = 0.0
    for start, end in zip(ring, ring[1:]):
        cross = start[0] * end[1] - end[0] * start[1]
        area_twice += cross
        longitude_sum += (start[0] + end[0]) * cross
        latitude_sum += (start[1] + end[1]) * cross
    if abs(area_twice) < 1e-14:
        coordinates = np.asarray(ring[:-1], dtype=float)
        return coordinates.mean(axis=0).tolist()
    return [
        longitude_sum / (3 * area_twice),
        latitude_sum / (3 * area_twice),
    ]


def building_targets(osm: dict, names: list[str]) -> tuple[dict[str, dict], list[float]]:
    selected = {
        feature.get("properties", {}).get("name"): feature
        for feature in osm["features"]
        if feature.get("properties", {}).get("name") in names
        and feature.get("geometry", {}).get("type") == "Polygon"
    }
    missing = sorted(set(names) - set(selected))
    if missing:
        raise ValueError(f"Missing OSM building polygons: {', '.join(missing)}")
    centroids = [polygon_centroid(selected[name]["geometry"]["coordinates"][0]) for name in names]
    reference = np.asarray(centroids, dtype=float).mean(axis=0).tolist()
    return selected, reference


def wgs84_to_local(coordinates: np.ndarray, reference: list[float]) -> np.ndarray:
    longitude_scale = METERS_PER_LONGITUDE_DEGREE * math.cos(math.radians(reference[1]))
    result = coordinates.copy().astype(float)
    result[:, 0] = (result[:, 0] - reference[0]) * longitude_scale
    result[:, 1] = (result[:, 1] - reference[1]) * METERS_PER_LATITUDE_DEGREE
    return result


def local_to_wgs84(coordinates: np.ndarray, reference: list[float]) -> np.ndarray:
    longitude_scale = METERS_PER_LONGITUDE_DEGREE * math.cos(math.radians(reference[1]))
    result = coordinates.copy().astype(float)
    result[:, 0] = result[:, 0] / longitude_scale + reference[0]
    result[:, 1] = result[:, 1] / METERS_PER_LATITUDE_DEGREE + reference[1]
    return result


def fit_homography(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    rows = []
    values = []
    for (x, y), (target_x, target_y) in zip(source, target):
        rows.append([x, y, 1, 0, 0, 0, -x * target_x, -y * target_x])
        values.append(target_x)
        rows.append([0, 0, 0, x, y, 1, -x * target_y, -y * target_y])
        values.append(target_y)
    solution, _, rank, _ = np.linalg.lstsq(np.asarray(rows), np.asarray(values), rcond=None)
    if rank < 8:
        raise ValueError(f"Degenerate control-point geometry: homography rank {rank}")
    return np.asarray([*solution, 1.0]).reshape(3, 3)


def apply_homography(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    homogeneous = np.column_stack([points, np.ones(len(points))])
    projected = homogeneous @ matrix.T
    if np.any(np.abs(projected[:, 2]) < 1e-12):
        raise ValueError("Homography projected a coordinate to infinity")
    return projected[:, :2] / projected[:, 2, None]


def transform_ring(ring: list[list[float]], matrix: np.ndarray, reference: list[float]) -> list[list[float]]:
    local = apply_homography(matrix, np.asarray(ring, dtype=float))
    wgs84 = local_to_wgs84(local, reference)
    return [[round(longitude, 7), round(latitude, 7)] for longitude, latitude in wgs84]


def transform_geometry(geometry: dict, matrix: np.ndarray, reference: list[float]) -> dict:
    if geometry["type"] == "Polygon":
        coordinates = [transform_ring(ring, matrix, reference) for ring in geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        coordinates = [
            [transform_ring(ring, matrix, reference) for ring in polygon]
            for polygon in geometry["coordinates"]
        ]
    else:
        raise ValueError(f"Unsupported surface geometry: {geometry['type']}")
    return {"type": geometry["type"], "coordinates": coordinates}


def coordinate_iter(geometry: dict):
    polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    for polygon in polygons:
        for ring in polygon:
            yield from ring


def registration_metrics(
    image_points: np.ndarray,
    target_points: np.ndarray,
    matrix: np.ndarray,
    labels: list[str],
    image_size: tuple[int, int],
) -> tuple[list[dict], dict]:
    predicted_targets = apply_homography(matrix, image_points)
    target_residuals = np.linalg.norm(predicted_targets - target_points, axis=1)
    inverse = np.linalg.inv(matrix)
    predicted_images = apply_homography(inverse, target_points)
    pixel_scale = np.asarray(image_size, dtype=float)
    pixel_residuals = np.linalg.norm((predicted_images - image_points) * pixel_scale, axis=1)
    leave_one_out = []
    for index in range(len(labels)):
        keep = np.arange(len(labels)) != index
        fitted = fit_homography(image_points[keep], target_points[keep])
        prediction = apply_homography(fitted, image_points[index : index + 1])[0]
        leave_one_out.append(float(np.linalg.norm(prediction - target_points[index])))
    controls = []
    for index, label in enumerate(labels):
        controls.append(
            {
                "building": label,
                "fitResidualMeters": round(float(target_residuals[index]), 3),
                "reprojectionResidualPixels": round(float(pixel_residuals[index]), 3),
                "leaveOneOutResidualMeters": round(leave_one_out[index], 3),
            }
        )
    metrics = {
        "fitRmseMeters": round(float(np.sqrt(np.mean(target_residuals**2))), 3),
        "fitMaxResidualMeters": round(float(target_residuals.max()), 3),
        "reprojectionRmsePixels": round(float(np.sqrt(np.mean(pixel_residuals**2))), 3),
        "reprojectionMaxResidualPixels": round(float(pixel_residuals.max()), 3),
        "leaveOneOutRmseMeters": round(float(np.sqrt(np.mean(np.asarray(leave_one_out) ** 2))), 3),
        "leaveOneOutMaxResidualMeters": round(max(leave_one_out), 3),
    }
    return controls, metrics


def draw_preview(
    image: Image.Image,
    output: Path,
    features: dict[str, dict],
    labels: list[str],
    reference: list[float],
    inverse: np.ndarray,
    configured_pixels: np.ndarray,
) -> None:
    preview = image.convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    colors = {"W": (121, 222, 213, 240), "E": (185, 242, 39, 240)}
    font = ImageFont.load_default(size=18)
    for index, label in enumerate(labels):
        ring = np.asarray(features[label]["geometry"]["coordinates"][0], dtype=float)
        local = wgs84_to_local(ring, reference)
        normalized = apply_homography(inverse, local)
        pixels = [(round(x * image.width), round(y * image.height)) for x, y in normalized]
        color = colors[label[0]]
        draw.line(pixels, fill=color, width=5, joint="curve")
        x, y = configured_pixels[index]
        radius = 8
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(255, 157, 99, 255), outline=(7, 28, 44, 255), width=2)
        draw.text((x + 12, y - 18), label, fill=color, font=font, stroke_width=2, stroke_fill=(7, 28, 44, 255))
    Image.alpha_composite(preview, overlay).convert("RGB").save(output, quality=92)


def main() -> None:
    args = parse_args()
    config = read_json(args.config)
    surfaces = read_json(args.image_surfaces)
    osm = read_json(args.osm)
    image = Image.open(args.image).convert("RGB")
    image_sha256 = hashlib.sha256(args.image.read_bytes()).hexdigest()
    if image_sha256 != config["sourceImageSha256"]:
        raise ValueError("Registration config does not match the source image SHA-256")
    if surfaces.get("sourceImageSha256") != image_sha256:
        raise ValueError("Surface candidates and registration image have different SHA-256 values")

    labels = [item["building"] for item in config["controlPoints"]]
    if len(labels) != 8 or len(set(labels)) != 8:
        raise ValueError("Exactly eight unique building control points are required")
    target_features, reference = building_targets(osm, labels)
    target_wgs84 = np.asarray(
        [polygon_centroid(target_features[label]["geometry"]["coordinates"][0]) for label in labels]
    )
    target_local = wgs84_to_local(target_wgs84, reference)
    configured_pixels = np.asarray([item["image"] for item in config["controlPoints"]], dtype=float)
    image_points = configured_pixels / np.asarray(image.size, dtype=float)
    matrix = fit_homography(image_points, target_local)
    controls, metrics = registration_metrics(image_points, target_local, matrix, labels, image.size)
    acceptance = config["acceptance"]
    accepted = (
        metrics["fitMaxResidualMeters"] <= acceptance["maxFitResidualMeters"]
        and metrics["leaveOneOutMaxResidualMeters"] <= acceptance["maxLeaveOneOutResidualMeters"]
    )

    registered_features = []
    for feature in surfaces["features"]:
        properties = {
            **feature["properties"],
            "coordinateSpace": "WGS84",
            "registrationModel": config["model"],
            "registrationStatus": "control-fit-accepted-review-pending" if accepted else "control-fit-rejected",
            "routingEnabled": False,
        }
        registered_features.append(
            {
                **feature,
                "id": feature["id"].replace("render/", "registered-render/"),
                "properties": properties,
                "geometry": transform_geometry(feature["geometry"], matrix, reference),
            }
        )

    all_coordinates = [coordinate for feature in registered_features for coordinate in coordinate_iter(feature["geometry"])]
    longitudes = [coordinate[0] for coordinate in all_coordinates]
    latitudes = [coordinate[1] for coordinate in all_coordinates]
    report = {
        "schemaVersion": "1.0",
        "model": config["model"],
        "status": "accepted-review-pending" if accepted else "rejected",
        "sourceImage": args.image.name,
        "sourceImageSha256": image_sha256,
        "referenceLongitudeLatitude": [round(reference[0], 7), round(reference[1], 7)],
        "imageSize": list(image.size),
        "homographyImageNormalizedToLocalMeters": [[round(float(value), 9) for value in row] for row in matrix],
        "metrics": metrics,
        "acceptance": acceptance,
        "controls": [
            {
                **config["controlPoints"][index],
                "osmFeatureId": target_features[label]["id"],
                "targetCentroid": [round(float(value), 7) for value in target_wgs84[index]],
                **controls[index],
            }
            for index, label in enumerate(labels)
        ],
        "limitations": [
            "Manual roof centroids require visual review.",
            "A single rendered view cannot distinguish roofs, ground planes and facades with full reliability.",
            "Registration does not establish walkability or vertical connectivity.",
        ],
        "routingEnabled": False,
    }
    output = {
        "type": "FeatureCollection",
        "schemaVersion": "1.0",
        "name": "HKUST(GZ) registered render-derived concrete surface candidates",
        "coordinateSpace": "WGS84",
        "bbox": [min(longitudes), min(latitudes), max(longitudes), max(latitudes)],
        "registration": {
            "model": config["model"],
            "status": report["status"],
            "fitRmseMeters": metrics["fitRmseMeters"],
            "leaveOneOutRmseMeters": metrics["leaveOneOutRmseMeters"],
            "controlBuildings": labels,
        },
        "reviewRequired": surfaces["reviewRequired"],
        "disclaimer": surfaces["disclaimer"],
        "features": registered_features,
    }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "walkable-surfaces.wgs84.geojson").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / "registration-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    draw_preview(
        image,
        args.output_dir / "eight-building-registration-preview.jpg",
        target_features,
        labels,
        reference,
        np.linalg.inv(matrix),
        configured_pixels,
    )
    print(json.dumps({"status": report["status"], **metrics}, ensure_ascii=False))


if __name__ == "__main__":
    main()
