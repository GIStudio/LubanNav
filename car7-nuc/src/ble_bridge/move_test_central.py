#!/usr/bin/env python3
"""Real-chassis BLE acceptance: Mac central -> car7 bridge -> move executor.

Drives the actual acceptance sequence the operator requested:
  forward 10cm -> immediate stop -> backward 10cm
via one navigation_task over BLE, then watches telemetry until `arrived`.

Requires: pip install bleak (run with Python 3.13: /opt/homebrew/bin/python3.13)
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


def build_task(task_id):
    waypoints = [
        {"sequence": 0, "nodeId": "move-test-0", "longitude": 113.4776815, "latitude": 22.8883663,
         "kind": "test", "indoor": False, "level": None, "interpolated": False},
        {"sequence": 1, "nodeId": "move-test-1", "longitude": 113.4776900, "latitude": 22.8883763,
         "kind": "test", "indoor": False, "level": None, "interpolated": True},
    ]
    return {
        "protocol": "luban-nav-ble",
        "protocolVersion": 1,
        "type": "navigation_task",
        "taskId": task_id,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "dataset": "move-test",
        "route": {
            "from": "test-start",
            "to": "test-end",
            "mode": "robot",
            "coordinateSystem": "WGS84 longitude/latitude",
            "distanceMeters": 0.2,
            "durationSeconds": 10,
            "waypointSpacingMeters": 2.5,
            "waypoints": waypoints,
        },
    }


class Receiver:
    def __init__(self):
        self.lines = []
        self.seen = 0
        self.buffer = bytearray()
        self.wake = asyncio.Event()

    def handler(self, sender, data):
        self.buffer += data
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if line.strip():
                self.lines.append(bytes(line))
        self.wake.set()

    async def next_line(self, predicate, timeout=15.0, label=""):
        async def wait():
            while True:
                while self.seen < len(self.lines):
                    line = self.lines[self.seen]
                    self.seen += 1
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        log("RX?", "non-JSON: {!r}".format(line[:80]))
                        continue
                    log("RX", json.dumps(obj))
                    if predicate(obj):
                        return obj
                self.wake.clear()
                await self.wake.wait()

        try:
            return await asyncio.wait_for(wait(), timeout)
        except asyncio.TimeoutError:
            raise AssertionError("timed out waiting for {}".format(label))


async def chunked_write(client, characteristic, payload: bytes):
    for offset in range(0, len(payload), WRITE_CHUNK):
        await client.write_gatt_char(characteristic, payload[offset:offset + WRITE_CHUNK], response=False)
        await asyncio.sleep(WRITE_GAP_S)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="car7")
    parser.add_argument("--address", default=None)
    args = parser.parse_args()

    address = args.address
    if address is None:
        for round_no in range(1, 4):
            log("SCAN", "round {}: scanning {}s for name prefix {!r}".format(round_no, SCAN_TIMEOUT_S, args.name))
            devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT_S)
            matches = [d for d in devices if d.name and d.name.startswith(args.name)]
            if matches:
                address = matches[0].address
                log("SCAN", "found {!r} at {}".format(matches[0].name, address))
                break
            await asyncio.sleep(3)
        if address is None:
            nearby = ", ".join("{} ({})".format(d.name, d.address) for d in devices) or "none"
            log("FAIL", "no {!r} found after 3 rounds; nearby: {}".format(args.name, nearby))
            sys.exit(1)

    receiver = Receiver()
    client = None
    for attempt in range(4):
        try:
            client = BleakClient(address, timeout=20.0)
            await client.connect()
            break
        except Exception as exc:
            log("CONNECT", "attempt {} failed: {}".format(attempt + 1, exc))
            if attempt == 3:
                raise
            await asyncio.sleep(2)
            devices = await BleakScanner.discover(timeout=8)
            matches = [d for d in devices if d.name and d.name.startswith(args.name)]
            if matches:
                address = matches[0].address
                log("SCAN", "re-found {!r} at {}".format(matches[0].name, address))

    assert client is not None and client.is_connected, "could not connect"
    async with client:
        service = next((s for s in client.services if s.uuid.lower() == SERVICE_UUID), None)
        assert service is not None, "NUS service not found"
        command_char = next(c for c in service.characteristics if c.uuid.lower() == COMMAND_UUID)
        telemetry_char = next(c for c in service.characteristics if c.uuid.lower() == TELEMETRY_UUID)
        log("GATT", "NUS service + command/telemetry characteristics ready")

        await client.start_notify(telemetry_char, receiver.handler)
        ready = await receiver.next_line(
            lambda o: o.get("type") == "status" and o.get("status") == "ready", 10.0, "status ready")
        log("PASS", "subscribed; bridge reports ready (message={!r})".format(ready.get("message")))

        task = build_task("move-test-1")
        payload = (json.dumps(task) + "\n").encode("utf-8")
        log("TX", "navigation_task {} -> {} bytes in {}-byte chunks".format("move-test-1", len(payload), WRITE_CHUNK))
        await chunked_write(client, command_char, payload)

        ack = await receiver.next_line(lambda o: o.get("type") == "ack", 10.0, "ack")
        assert ack.get("status") == "accepted", ack
        await receiver.next_line(lambda o: o.get("type") == "status" and o.get("status") == "navigating",
                                 10.0, "status navigating")

        arrived = None
        positions = 0
        deadline = asyncio.get_event_loop().time() + 60.0
        while arrived is None and asyncio.get_event_loop().time() < deadline:
            line = await receiver.next_line(
                lambda o: o.get("type") in ("position", "status"), 30.0, "telemetry during move")
            if line.get("type") == "position":
                positions += 1
            elif line.get("type") == "status" and line.get("status") == "arrived":
                arrived = line
        assert arrived is not None, "no arrived status within 60s"
        assert positions >= 2, "expected position telemetry during the move"
        log("PASS", "move-test sequence finished: {} position updates + arrived".format(positions))

        await client.stop_notify(telemetry_char)

    log("PASS", "real-chassis move-test over BLE completed (fwd 10cm -> stop -> back 10cm)")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as exc:
        log("FAIL", str(exc))
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        log("FAIL", "{}: {}".format(type(exc).__name__, exc))
        sys.exit(1)
