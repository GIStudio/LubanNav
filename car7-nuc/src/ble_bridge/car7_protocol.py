"""LubanNav Car7Protocol — Linux/BlueZ port of the macOS simulator protocol layer.

Faithful port of
tools/car7-ble-simulator/Sources/Car7Protocol/Car7Protocol.swift
(protocol model, parser, JSON-line framer, encoder, campusCar export, bearing).
Pure Python 3 standard library; no third-party dependencies.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional, Union

PROTOCOL_NAME = "luban-nav-ble"
PROTOCOL_VERSION = 1
SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
COMMAND_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
TELEMETRY_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"


class Car7CommandError(Exception):
    """Mirrors Car7CommandError in Car7Protocol.swift."""

    def __init__(self, kind: str, detail=None):
        self.kind = kind
        self.detail = detail
        super().__init__(self.description())

    def description(self) -> str:
        if self.kind == "invalidProtocol":
            return "unsupported protocol {}".format(self.detail)
        if self.kind == "invalidVersion":
            return "unsupported protocol version {}".format(self.detail)
        if self.kind == "unsupportedType":
            return "unsupported command type {}".format(self.detail)
        if self.kind == "emptyRoute":
            return "navigation route contains no waypoints"
        if self.kind == "invalidMode":
            return "navigation route mode must be robot, got {}".format(self.detail)
        if self.kind == "invalidWaypoint":
            return "waypoint {} is outside WGS84 bounds or is not finite".format(self.detail)
        if self.kind == "invalidWaypointCount":
            return "navigation waypoint count must be a positive integer, got {}".format(self.detail)
        return self.kind


@dataclass(frozen=True)
class NavigationWaypoint:
    sequence: int
    node_id: Optional[str]
    longitude: float
    latitude: float
    kind: Optional[str] = None
    indoor: bool = False
    level: Optional[str] = None
    interpolated: bool = False
    distance_meters: Optional[float] = None


@dataclass(frozen=True)
class NavigationRoute:
    origin: str  # "from"
    destination: str  # "to"
    mode: str
    coordinate_system: Optional[str]
    distance_meters: Optional[float]
    duration_seconds: Optional[float]
    waypoints: List[NavigationWaypoint]


@dataclass(frozen=True)
class NavigationTask:
    task_id: str
    created_at: Optional[str]
    dataset: Optional[str]
    route: NavigationRoute


@dataclass(frozen=True)
class NavigationStart:
    """`navigation_start` — header line of the streaming JSONL route delivery."""

    task_id: str
    created_at: Optional[str]
    dataset: Optional[str]
    origin: str
    destination: str
    mode: str
    coordinate_system: Optional[str]
    distance_meters: Optional[float]
    duration_seconds: Optional[float]
    waypoint_spacing_meters: Optional[float]
    waypoint_count: int


@dataclass(frozen=True)
class WaypointLine:
    """`waypoint` — one dense route waypoint, delivered as its own JSON line."""

    task_id: str
    waypoint: NavigationWaypoint


@dataclass(frozen=True)
class NavigationEnd:
    """`navigation_end` — closes a streaming route; validates waypointCount."""

    task_id: str
    waypoint_count: int


@dataclass(frozen=True)
class EmergencyStop:
    command_id: str
    task_id: Optional[str]
    created_at: Optional[str]
    reason: Optional[str]


@dataclass(frozen=True)
class DirectionCommand:
    command_id: str
    direction: str  # forward | backward | left | right | stop
    amount_meters: Optional[float]
    amount_degrees: Optional[float]
    speed_meters_per_second: Optional[float]
    created_at: Optional[str]
    continuous: bool = False  # continuous drive: publish /cmd_vel until stop


@dataclass(frozen=True)
class GotoTarget:
    """`goto_target` — send the car to ONE WGS84 waypoint (next-step nav).

    The bridge writes a single-waypoint campusCar file and (with --drive)
    launches gps_navigator for RTK closed-loop tracking of that target.
    """

    command_id: str
    longitude: float
    latitude: float
    task_id: Optional[str]
    speed_meters_per_second: Optional[float]
    arrival_radius_meters: Optional[float]
    created_at: Optional[str]


Command = Union[
    NavigationTask,
    NavigationStart,
    WaypointLine,
    NavigationEnd,
    EmergencyStop,
    DirectionCommand,
    GotoTarget,
]


def _require_string(obj: dict, key: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str):
        raise ValueError("field {} must be a string".format(key))
    return value


def _optional_string(obj: dict, key: str) -> Optional[str]:
    value = obj.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("field {} must be a string or null".format(key))
    return value


def _optional_number(obj: dict, key: str) -> Optional[float]:
    value = obj.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("field {} must be a number or null".format(key))
    return float(value)


def _parse_waypoint(raw) -> NavigationWaypoint:
    if not isinstance(raw, dict):
        raise ValueError("waypoint must be a JSON object")
    sequence = raw.get("sequence")
    if isinstance(sequence, bool) or not isinstance(sequence, int):
        raise ValueError("waypoint sequence must be an integer")
    node_id = _optional_string(raw, "nodeId")
    longitude = raw.get("longitude")
    latitude = raw.get("latitude")
    if (
        isinstance(longitude, bool)
        or isinstance(latitude, bool)
        or not isinstance(longitude, (int, float))
        or not isinstance(latitude, (int, float))
    ):
        raise Car7CommandError("invalidWaypoint", sequence)
    if not (
        math.isfinite(longitude)
        and math.isfinite(latitude)
        and -180.0 <= longitude <= 180.0
        and -90.0 <= latitude <= 90.0
    ):
        raise Car7CommandError("invalidWaypoint", sequence)
    return NavigationWaypoint(
        sequence=sequence,
        node_id=node_id,
        longitude=float(longitude),
        latitude=float(latitude),
        kind=_optional_string(raw, "kind"),
        indoor=raw.get("indoor") is True,
        level=_optional_string(raw, "level"),
        interpolated=raw.get("interpolated") is True,
        distance_meters=_optional_number(raw, "distanceMeters"),
    )


def _parse_navigation_task(obj: dict) -> NavigationTask:
    task_id = _require_string(obj, "taskId")
    created_at = _optional_string(obj, "createdAt")
    dataset = _optional_string(obj, "dataset")
    route_raw = obj.get("route")
    if not isinstance(route_raw, dict):
        raise ValueError("navigation route must be a JSON object")
    origin = _require_string(route_raw, "from")
    destination = _require_string(route_raw, "to")
    mode = _require_string(route_raw, "mode")
    if mode != "robot":
        raise Car7CommandError("invalidMode", mode)
    coordinate_system = _optional_string(route_raw, "coordinateSystem")
    distance_meters = _optional_number(route_raw, "distanceMeters")
    duration_seconds = _optional_number(route_raw, "durationSeconds")
    waypoints_raw = route_raw.get("waypoints")
    if not isinstance(waypoints_raw, list) or not waypoints_raw:
        raise Car7CommandError("emptyRoute")
    waypoints = [_parse_waypoint(raw) for raw in waypoints_raw]
    return NavigationTask(
        task_id=task_id,
        created_at=created_at,
        dataset=dataset,
        route=NavigationRoute(
            origin=origin,
            destination=destination,
            mode=mode,
            coordinate_system=coordinate_system,
            distance_meters=distance_meters,
            duration_seconds=duration_seconds,
            waypoints=waypoints,
        ),
    )


def _parse_navigation_start(obj: dict) -> NavigationStart:
    """Header line of the streaming route: metadata + waypointCount only."""
    task_id = _require_string(obj, "taskId")
    created_at = _optional_string(obj, "createdAt")
    dataset = _optional_string(obj, "dataset")
    route_raw = obj.get("route")
    if not isinstance(route_raw, dict):
        raise ValueError("navigation_start route must be a JSON object")
    origin = _require_string(route_raw, "from")
    destination = _require_string(route_raw, "to")
    mode = _require_string(route_raw, "mode")
    if mode != "robot":
        raise Car7CommandError("invalidMode", mode)
    waypoint_count = route_raw.get("waypointCount")
    if isinstance(waypoint_count, bool) or not isinstance(waypoint_count, int):
        raise ValueError("navigation route waypointCount must be an integer")
    if waypoint_count < 1:
        raise Car7CommandError("invalidWaypointCount", waypoint_count)
    return NavigationStart(
        task_id=task_id,
        created_at=created_at,
        dataset=dataset,
        origin=origin,
        destination=destination,
        mode=mode,
        coordinate_system=_optional_string(route_raw, "coordinateSystem"),
        distance_meters=_optional_number(route_raw, "distanceMeters"),
        duration_seconds=_optional_number(route_raw, "durationSeconds"),
        waypoint_spacing_meters=_optional_number(route_raw, "waypointSpacingMeters"),
        waypoint_count=waypoint_count,
    )


def _parse_waypoint_line(obj: dict) -> WaypointLine:
    """One streaming waypoint line; waypoint fields live at the top level."""
    task_id = _require_string(obj, "taskId")
    return WaypointLine(task_id=task_id, waypoint=_parse_waypoint(obj))


def _parse_navigation_end(obj: dict) -> NavigationEnd:
    task_id = _require_string(obj, "taskId")
    waypoint_count = obj.get("waypointCount")
    if isinstance(waypoint_count, bool) or not isinstance(waypoint_count, int):
        raise ValueError("navigation_end waypointCount must be an integer")
    if waypoint_count < 1:
        raise Car7CommandError("invalidWaypointCount", waypoint_count)
    return NavigationEnd(task_id=task_id, waypoint_count=waypoint_count)


def _parse_emergency_stop(obj: dict) -> EmergencyStop:
    command_id = _require_string(obj, "commandId")
    return EmergencyStop(
        command_id=command_id,
        task_id=_optional_string(obj, "taskId"),
        created_at=_optional_string(obj, "createdAt"),
        reason=_optional_string(obj, "reason"),
    )


DIRECTION_NAMES = ("forward", "backward", "left", "right", "stop")


def _parse_direction(obj: dict) -> DirectionCommand:
    command_id = _require_string(obj, "commandId")
    direction = obj.get("direction")
    if direction not in DIRECTION_NAMES:
        raise ValueError("unknown direction: {!r}".format(direction))
    amount_meters = obj.get("amountMeters")
    amount_degrees = obj.get("amountDegrees")
    speed = obj.get("speedMetersPerSecond")
    continuous = obj.get("continuous") is True
    if continuous:
        # 连续模式：不需要步长，速度即目标速度（m/s）；amount 字段可为 null。
        if speed is not None:
            if isinstance(speed, bool) or not isinstance(speed, (int, float)):
                raise ValueError("direction speedMetersPerSecond must be a number")
            speed = float(speed)
            if not (math.isfinite(speed) and 0.01 <= speed <= 8.0):
                raise ValueError("direction speedMetersPerSecond must be in [0.01, 8.0]")
        return DirectionCommand(
            command_id=command_id,
            direction=direction,
            amount_meters=None,
            amount_degrees=None,
            speed_meters_per_second=speed,
            created_at=_optional_string(obj, "createdAt"),
            continuous=True,
        )
    if direction in ("forward", "backward"):
        if isinstance(amount_meters, bool) or not isinstance(amount_meters, (int, float)):
            raise ValueError("direction amountMeters must be a number")
        amount_meters = float(amount_meters)
        if not (math.isfinite(amount_meters) and 0.0 < amount_meters <= 1.0):
            raise ValueError("direction amountMeters must be in (0, 1]")
        amount_degrees = None
    elif direction in ("left", "right"):
        if isinstance(amount_degrees, bool) or not isinstance(amount_degrees, (int, float)):
            raise ValueError("direction amountDegrees must be a number")
        amount_degrees = float(amount_degrees)
        if not (math.isfinite(amount_degrees) and 0.0 < amount_degrees <= 90.0):
            raise ValueError("direction amountDegrees must be in (0, 90]")
        amount_meters = None
    else:  # stop
        amount_meters = None
        amount_degrees = None
    if speed is not None:
        if isinstance(speed, bool) or not isinstance(speed, (int, float)):
            raise ValueError("direction speedMetersPerSecond must be a number")
        speed = float(speed)
        # Ceiling mirrors the ROS-side linear max (web default 2.0 = half of
        # the 4.0 m/s ROS max); per-step distance is bounded separately by
        # amountMeters, so a high speed only shortens each step's duration.
        if not (math.isfinite(speed) and 0.01 <= speed <= 4.0):
            raise ValueError("direction speedMetersPerSecond must be in [0.01, 4.0]")
    return DirectionCommand(
        command_id=command_id,
        direction=direction,
        amount_meters=amount_meters,
        amount_degrees=amount_degrees,
        speed_meters_per_second=speed,
        created_at=_optional_string(obj, "createdAt"),
        continuous=False,
    )


def _parse_goto_target(obj: dict) -> GotoTarget:
    command_id = _require_string(obj, "commandId")
    longitude = obj.get("longitude")
    latitude = obj.get("latitude")
    if (
        isinstance(longitude, bool)
        or isinstance(latitude, bool)
        or not isinstance(longitude, (int, float))
        or not isinstance(latitude, (int, float))
    ):
        raise Car7CommandError("invalidWaypoint", command_id)
    if not (
        math.isfinite(longitude)
        and math.isfinite(latitude)
        and -180.0 <= longitude <= 180.0
        and -90.0 <= latitude <= 90.0
    ):
        raise Car7CommandError("invalidWaypoint", command_id)
    speed = _optional_number(obj, "speedMetersPerSecond")
    if speed is not None and not (0.01 <= speed <= 4.0):
        raise ValueError("goto speedMetersPerSecond must be in [0.01, 4.0]")
    radius = _optional_number(obj, "arrivalRadiusMeters")
    if radius is not None and not (0.1 <= radius <= 10.0):
        raise ValueError("goto arrivalRadiusMeters must be in [0.1, 10.0]")
    return GotoTarget(
        command_id=command_id,
        longitude=float(longitude),
        latitude=float(latitude),
        task_id=_optional_string(obj, "taskId"),
        speed_meters_per_second=speed,
        arrival_radius_meters=radius,
        created_at=_optional_string(obj, "createdAt"),
    )


def parse_command(data: bytes) -> Command:
    """Parse one complete JSON line into a command.

    Raises Car7CommandError for protocol-level rejection and ValueError for
    malformed JSON / wrong field types (both are logged as [DROP] upstream).
    """
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid JSON line") from exc
    if not isinstance(obj, dict):
        raise ValueError("command must be a JSON object")
    protocol = obj.get("protocol")
    if protocol != PROTOCOL_NAME:
        raise Car7CommandError("invalidProtocol", protocol)
    version = obj.get("protocolVersion")
    if version != PROTOCOL_VERSION:
        raise Car7CommandError("invalidVersion", version)
    cmd_type = obj.get("type")
    if cmd_type == "navigation_task":
        return _parse_navigation_task(obj)
    if cmd_type == "navigation_start":
        return _parse_navigation_start(obj)
    if cmd_type == "waypoint":
        return _parse_waypoint_line(obj)
    if cmd_type == "navigation_end":
        return _parse_navigation_end(obj)
    if cmd_type == "emergency_stop":
        return _parse_emergency_stop(obj)
    if cmd_type == "direction":
        return _parse_direction(obj)
    if cmd_type == "goto_target":
        return _parse_goto_target(obj)
    raise Car7CommandError("unsupportedType", cmd_type)


class FramingError(Exception):
    pass


class JSONLineFramer:
    """Byte-stream reassembly; splits complete lines on LF (0x0A)."""

    def __init__(self, maximum_buffer_bytes: int = 1_048_576):
        self.maximum_buffer_bytes = maximum_buffer_bytes
        self.buffer = bytearray()

    def append(self, chunk: bytes) -> List[bytes]:
        self.buffer += chunk
        if len(self.buffer) > self.maximum_buffer_bytes:
            self.buffer.clear()
            raise FramingError(
                "command buffer exceeded {} bytes and was reset".format(
                    self.maximum_buffer_bytes
                )
            )
        frames: List[bytes] = []
        while True:
            newline = self.buffer.find(b"\n")
            if newline < 0:
                break
            line = bytes(self.buffer[:newline])
            del self.buffer[: newline + 1]
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                frames.append(text.encode("utf-8"))
        return frames

    def reset(self) -> None:
        self.buffer.clear()


def make_message(type_: str, **fields) -> dict:
    """Base message: sortedKeys JSON object root with protocol header."""
    obj = {"protocol": PROTOCOL_NAME, "protocolVersion": PROTOCOL_VERSION, "type": type_}
    obj.update(fields)
    return obj


def acknowledgement(task_id: Optional[str], status: str, message: Optional[str] = None) -> dict:
    obj = make_message("ack", taskId=task_id, status=status)
    if message is not None:
        obj["message"] = message
    return obj


def status_message(task_id: Optional[str], status: str, message: Optional[str] = None) -> dict:
    obj = make_message("status", taskId=task_id, status=status)
    if message is not None:
        obj["message"] = message
    return obj


def position_message(
    task_id: str,
    longitude: float,
    latitude: float,
    heading_degrees: Optional[float],
    accuracy_meters: float,
    timestamp: str,
) -> dict:
    obj = make_message(
        "position",
        taskId=task_id,
        longitude=longitude,
        latitude=latitude,
        accuracyMeters=accuracy_meters,
        timestamp=timestamp,
    )
    if heading_degrees is not None:
        obj["headingDegrees"] = heading_degrees
    return obj


def encode_line(obj: dict) -> bytes:
    """JSON (sorted keys, compact, no slash escaping) + LF — matches Car7JSONEncoder.line."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def encode_pretty(obj: dict) -> bytes:
    return json.dumps(obj, indent=2, sort_keys=True).encode("utf-8")


def campuscar_waypoint_file(task: NavigationTask) -> dict:
    """campusCar gps_navigator.py waypoint format: {origin, waypoints[{lat,lon,alt:0}]}."""
    waypoints = [
        {"lat": wp.latitude, "lon": wp.longitude, "alt": 0}
        for wp in task.route.waypoints
    ]
    return {"origin": dict(waypoints[0]), "waypoints": waypoints}


def bearing_degrees(
    from_latitude: float,
    from_longitude: float,
    to_latitude: float,
    to_longitude: float,
) -> float:
    """Great-circle initial bearing in degrees (0-360)."""
    latitude1 = math.radians(from_latitude)
    latitude2 = math.radians(to_latitude)
    longitude_delta = math.radians(to_longitude - from_longitude)
    y = math.sin(longitude_delta) * math.cos(latitude2)
    x = math.cos(latitude1) * math.sin(latitude2) - math.sin(latitude1) * math.cos(
        latitude2
    ) * math.cos(longitude_delta)
    degrees = math.degrees(math.atan2(y, x))
    return degrees if degrees >= 0 else degrees + 360


def iso8601_now() -> str:
    """ISO8601 with fractional seconds (milliseconds), Z suffix — matches the
    Swift simulator's ISO8601DateFormatter withFractionalSeconds output."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )
