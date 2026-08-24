#!/usr/bin/env python3
"""Direction joystick acceptance test: Mac central -> car7 bridge -> executor.

Connects to the car7 NUS peripheral and sends stepped direction commands:
  forward 0.15 m -> left 15 deg -> right 15 deg -> backward 0.15 m -> stop
Each command expects an ack; the executor must stop by itself after every step.

Requires: pip install bleak (run with /opt/homebrew/bin/python3.13)
"""

import argparse
import asyncio
import json
import sys

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
COMMAND_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TELEMETRY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

WRITE_CHUNK = 20
WRITE_GAP_S = 0.012
SCAN_TIMEOUT_S = 10


def log(tag, message):
    print("[{}] {}".format(tag, message), flush=True)


def direction_command(direction, **amounts):
    return {
        "protocol": "luban-nav-ble",
        "protocolVersion": 1,
        "type": "direction",
        "commandId": "dir-{}".format(direction),
        "direction": direction,
        "amountMeters": amounts.get("amountMeters"),
        "amountDegrees": amounts.get("amountDegrees"),
        "createdAt": "2026-08-17T09:00:00Z",
    }


class Receiver:
    def __init__(self):
        self.lines = []
        self.seen = 0
        self.buffer = bytearray()
        self.wake = asyncio.Event()

    def handler(self, sender, data):
        self.buffer += bytes(data)
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
        await client.write_gatt_char(characteristic, payload[offset : offset + WRITE_CHUNK], response=False)
        await asyncio.sleep(WRITE_GAP_S)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="car7")
    parser.add_argument("--address", default=None)
    parser.add_argument("--meters", type=float, default=0.15)
    parser.add_argument("--degrees", type=float, default=15)
    args = parser.parse_args()

    address = args.address
    if address is None:
        for round_no in range(1, 4):
            log("SCAN", "round {}: scanning {}s for {!r}".format(round_no, SCAN_TIMEOUT_S, args.name))
            devices = await BleakScanner.discover(timeout=SCAN_TIMEOUT_S)
            matches = [d for d in devices if d.name and d.name.startswith(args.name)]
            if matches:
                address = matches[0].address
                log("SCAN", "found {!r} at {}".format(matches[0].name, address))
                break
            await asyncio.sleep(3)
        if address is None:
            log("FAIL", "no {!r} found after 3 rounds".format(args.name))
            sys.exit(1)

    receiver = Receiver()
    client = BleakClient(address, timeout=20.0)
    for attempt in range(4):
        try:
            await client.connect()
            break
        except Exception as exc:
            log("CONNECT", "attempt {} failed: {}".format(attempt + 1, exc))
            if attempt == 3:
                raise
            await asyncio.sleep(2)

    async with client:
        service = next((s for s in client.services if s.uuid.lower() == SERVICE_UUID), None)
        assert service is not None, "NUS service not found"
        command_char = next(c for c in service.characteristics if c.uuid.lower() == COMMAND_UUID)
        telemetry_char = next(c for c in service.characteristics if c.uuid.lower() == TELEMETRY_UUID)
        await client.start_notify(telemetry_char, receiver.handler)
        await receiver.next_line(
            lambda o: o.get("type") == "status" and o.get("status") == "ready", 10.0, "status ready")
        log("PASS", "connected and subscribed")

        steps = [
            ("forward", {"amountMeters": args.meters}),
            ("left", {"amountDegrees": args.degrees}),
            ("right", {"amountDegrees": args.degrees}),
            ("backward", {"amountMeters": args.meters}),
        ]
        ack_counter = [0]

        def ack_predicate(_obj):
            ack_counter[0] += 1
            return _obj.get("type") == "ack"

        for direction, amounts in steps:
            command = direction_command(direction, **amounts)
            payload = (json.dumps(command) + "\n").encode("utf-8")
            log("TX", "direction {}".format(direction))
            await chunked_write(client, command_char, payload)
            ack = await receiver.next_line(ack_predicate, 10.0, "ack for " + direction)
            assert ack.get("status") == "accepted", ack
            log("PASS", "{} accepted (ack #{})".format(direction, ack_counter[0]))
            await asyncio.sleep(1.0)  # let the step finish on the chassis

        log("TX", "direction stop")
        await chunked_write(client, command_char, (json.dumps(direction_command("stop")) + "\n").encode("utf-8"))
        stop_ack = await receiver.next_line(ack_predicate, 10.0, "ack for stop")
        assert stop_ack.get("status") == "accepted", stop_ack
        log("PASS", "stop accepted")
        await client.stop_notify(telemetry_char)

    log("PASS", "direction joystick sequence verified (fwd {:.2f} m, turns {:.0f} deg, back, stop)".format(
        args.meters, args.degrees))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as exc:
        log("FAIL", str(exc))
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        log("FAIL", "{}: {}".format(type(exc).__name__, exc))
        sys.exit(1)
