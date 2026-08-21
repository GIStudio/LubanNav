#!/usr/bin/env python3
"""Closed-loop BLE acceptance test: this Mac (central) <-> car7 NUS peripheral.

Connects to the BlueZ GATT server exported by car7_ble_bridge.py on the real
machine, then walks the same acceptance flow as the LubanNav web page:

  1. subscribe telemetry        -> expect status "ready"
  2. write navigation_task      -> expect ack accepted, status navigating,
                                   >=2 position lines, status arrived
  3. write navigation_task again, then a leading-LF emergency_stop mid-route
                                -> expect ack stopped + status stopped

Requires: pip install bleak  (macOS CoreBluetooth backend; grant the host
app Bluetooth permission in System Settings > Privacy & Security > Bluetooth)

Usage:
  python3 macos_ble_central_test.py [--name car7] [--address AA:BB:..]
"""

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
COMMAND_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TELEMETRY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

WRITE_CHUNK = 20
WRITE_GAP_S = 0.012
SCAN_TIMEOUT_S = 10


def log(tag, message):
    print("[{}] {}".format(tag, message), flush=True)


def build_task(task_id, waypoints):
    return {
        "protocol": "luban-nav-ble",
        "protocolVersion": 1,
        "type": "navigation_task",
        "taskId": task_id,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "dataset": "macos-acceptance-test",
        "route": {
            "from": "test-start",
            "to": "test-end",
            "mode": "robot",
            "coordinateSystem": "WGS84 longitude/latitude",
            "distanceMeters": 20,
            "durationSeconds": 30,
            "waypointSpacingMeters": 2.5,
            "waypoints": [
                {"sequence": i, "nodeId": None, "longitude": lon, "latitude": lat,
                 "kind": "interpolated", "indoor": False, "level": None,
                 "interpolated": True}
                for i, (lon, lat) in enumerate(waypoints)
            ],
        },
    }


def build_stop(command_id, task_id):
    return {
        "protocol": "luban-nav-ble",
        "protocolVersion": 1,
        "type": "emergency_stop",
        "commandId": command_id,
        "taskId": task_id,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "reason": "operator_request",
    }


class Receiver:
    def __init__(self):
        self.lines = []
        self.seen = []
        self._buffer = b""
        self._wake = asyncio.Event()

    def feed(self, data: bytearray):
        # 流式重组：遥测 JSON 可能跨多个 GATT 包，按 LF 切分并保留半行
        self._buffer += bytes(data)
        while b"\n" in self._buffer:
            line, self._buffer = self._buffer.split(b"\n", 1)
            line = line.strip(b"\r")
            if line:
                self.lines.append(line)
        self._wake.set()

    async def next_line(self, predicate, timeout=10.0, label=""):
        async def wait():
            while True:
                for index in range(len(self.seen), len(self.lines)):
                    line = self.lines[index]
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        log("RX?", "non-JSON line: {!r}".format(line[:60]))
                        self.seen.append(line)
                        continue
                    if predicate(obj):
                        self.seen.append(line)
                        return obj
                self._wake.clear()
                await self._wake.wait()

        try:
            return await asyncio.wait_for(wait(), timeout)
        except asyncio.TimeoutError:
            raise AssertionError("timed out waiting for {}".format(label or predicate))

    def handler(self, sender, data):
        self.feed(data)
        self._wake.set()


async def chunked_write(client, characteristic, payload: bytes):
    for offset in range(0, len(payload), WRITE_CHUNK):
        chunk = payload[offset : offset + WRITE_CHUNK]
        await client.write_gatt_char(characteristic, chunk, response=False)
        await asyncio.sleep(WRITE_GAP_S)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="car7")
    parser.add_argument("--address", default=None)
    args = parser.parse_args()

    address = args.address
    if address is None:
        log("SCAN", "scanning {}s for BLE name starting with {!r}".format(SCAN_TIMEOUT_S, args.name))
        devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT_S)
        matches = [d for d in devices if d.name and d.name.startswith(args.name)]
        if not matches:
            log("FAIL", "no device named {!r} found; nearby devices: {}".format(
                args.name, ", ".join("{} ({})".format(d.name, d.address) for d in devices) or "none"))
            sys.exit(1)
        device = matches[0]
        address = device.address
        log("SCAN", "found {!r} at {}".format(device.name, address))

    receiver = Receiver()
    log("CONNECT", "connecting to {}".format(address))
    async with BleakClient(address, timeout=20.0) as client:
        service = None
        for candidate in client.services:
            if candidate.uuid.lower() == SERVICE_UUID:
                service = candidate
                break
        assert service is not None, "NUS service not found"
        command_char = next(c for c in service.characteristics if c.uuid.lower() == COMMAND_UUID)
        telemetry_char = next(c for c in service.characteristics if c.uuid.lower() == TELEMETRY_UUID)
        log("GATT", "service + command/telemetry characteristics found")

        await client.start_notify(telemetry_char, receiver.handler)
        ready = await receiver.next_line(
            lambda o: o.get("type") == "status" and o.get("status") == "ready", 10.0, "status ready")
        log("RX", "subscribe -> {}".format(json.dumps(ready)))

        # ── phase 1: navigation task, expect full replay to arrived ────────
        waypoints = [
            (113.4776815, 22.8883663),
            (113.4777049, 22.8884435),
            (113.4777200, 22.8885000),
        ]
        task = build_task("task-mac-1", waypoints)
        payload = (json.dumps(task) + "\n").encode("utf-8")
        log("TX", "writing navigation_task ({} bytes, {}-byte chunks)".format(len(payload), WRITE_CHUNK))
        await chunked_write(client, command_char, payload)

        ack = await receiver.next_line(
            lambda o: o.get("type") == "ack" and o.get("taskId") == "task-mac-1", 10.0, "ack accepted")
        log("RX", "ack -> {}".format(json.dumps(ack)))
        assert ack.get("status") == "accepted", ack

        nav = await receiver.next_line(
            lambda o: o.get("type") == "status" and o.get("status") == "navigating", 10.0, "status navigating")
        log("RX", "status -> {}".format(json.dumps(nav)))

        positions = []
        arrived = None
        for _ in range(len(waypoints) + 1):
            line = await receiver.next_line(
                lambda o: o.get("type") in ("position", "status"), 15.0, "position/status")
            log("RX", "telemetry -> {}".format(json.dumps(line)))
            if line.get("type") == "position":
                positions.append(line)
            elif line.get("type") == "status" and line.get("status") == "arrived":
                arrived = line
                break
        assert len(positions) >= 2, "expected >=2 positions, got {}".format(len(positions))
        assert arrived is not None, "expected status arrived"
        lat0, lon0 = positions[0]["latitude"], positions[0]["longitude"]
        assert abs(lat0 - waypoints[0][1]) < 1e-6 and abs(lon0 - waypoints[0][0]) < 1e-6
        log("PASS", "phase 1: accepted -> navigating -> {} positions -> arrived".format(len(positions)))

        # ── phase 2: leading-LF emergency_stop mid-route ────────────────────
        task2 = build_task("task-mac-2", waypoints)
        payload2 = (json.dumps(task2) + "\n").encode("utf-8")
        log("TX", "writing second navigation_task")
        await chunked_write(client, command_char, payload2)
        await receiver.next_line(
            lambda o: o.get("type") == "position" and o.get("taskId") == "task-mac-2", 15.0, "first position")
        log("TX", "writing LF + emergency_stop mid-route")
        stop = build_stop("stop-mac-1", "task-mac-2")
        await chunked_write(client, command_char, b"\n" + json.dumps(stop).encode("utf-8") + b"\n")

        stop_ack = await receiver.next_line(
            lambda o: o.get("type") == "ack" and o.get("status") == "stopped", 10.0, "ack stopped")
        log("RX", "ack -> {}".format(json.dumps(stop_ack)))
        stop_status = await receiver.next_line(
            lambda o: o.get("type") == "status" and o.get("status") == "stopped", 10.0, "status stopped")
        log("RX", "status -> {}".format(json.dumps(stop_status)))
        log("PASS", "phase 2: STOP accepted with leading-LF resync")

        await asyncio.sleep(1.0)
        await client.stop_notify(telemetry_char)

    log("PASS", "BLE closed loop verified: Mac central <-> car7 NUS peripheral")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as exc:
        log("FAIL", str(exc))
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        log("FAIL", "{}: {}".format(type(exc).__name__, exc))
        sys.exit(1)
