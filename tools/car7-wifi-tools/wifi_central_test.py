#!/usr/bin/env python3
"""car7 WiFi bridge closed-loop acceptance test (Mac side, stdlib only).

Connects to the car7 WebSocket bridge (10.7.181.161:8900 by default), speaks
the LubanNav JSONL robot protocol and verifies:
  1. handshake + status page
  2. streaming navigation task -> ack/accepted -> status/navigating -> positions
  3. direction commands (stop first; real motion only when --direction-motion)
  4. emergency_stop -> ack/stopped

Usage:
  python3 wifi_central_test.py [--url ws://10.7.181.161:8900] [--waypoints 8]
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import time
from datetime import datetime, timezone

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ws_frame(opcode, payload: bytes, mask=True) -> bytes:
    length = len(payload)
    header = bytearray([0x80 | opcode])
    mask_bit = 0x80 if mask else 0
    if length < 126:
        header.append(mask_bit | length)
    elif length < 65536:
        header.append(mask_bit | 126)
        header += struct.pack(">H", length)
    else:
        header.append(mask_bit | 127)
        header += struct.pack(">Q", length)
    if mask:
        mask_key = os.urandom(4)
        masked = bytearray(payload)
        for index in range(length):
            masked[index] ^= mask_key[index % 4]
        return bytes(header) + mask_key + bytes(masked)
    return bytes(header) + payload


class WsClient:
    def __init__(self, url, timeout=10.0, ca_file=None):
        assert url.startswith(("ws://", "wss://")), "only ws:// / wss:// supported"
        scheme, _, hostport = url.partition("://")
        hostport = hostport.rstrip("/")
        host, _, port = hostport.partition(":")
        port = int(port or (443 if scheme == "wss" else 80))
        self.sock = socket.create_connection((host, port), timeout=timeout)
        if scheme == "wss":
            context = ssl.create_default_context(cafile=ca_file)
            if ca_file is None:
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            self.sock = context.wrap_socket(self.sock, server_hostname=host)
        self.buffer = b""
        self._handshake(host, str(port))

    def _handshake(self, host, port):
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET / HTTP/1.1\r\n"
            "Host: {}:{}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: {}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n".format(host, port, key)
        )
        self.sock.sendall(request.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("connection closed during handshake")
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        status_line = head.decode("utf-8", errors="replace").split("\r\n")[0]
        if "101" not in status_line:
            raise RuntimeError("handshake failed: {}".format(status_line))
        expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if expected not in data.decode("utf-8", errors="replace"):
            raise RuntimeError("bad Sec-WebSocket-Accept")
        self.buffer = rest

    def send_text(self, text: str):
        self.sock.sendall(ws_frame(0x1, text.encode("utf-8"), mask=True))

    def send_command(self, obj: dict):
        """Send one protocol command as an LF-terminated JSON line."""
        self.send_text(json.dumps(obj, separators=(",", ":")) + "\n")

    def receive(self, timeout=10.0):
        """Return next text payload (or None on timeout)."""
        self.sock.settimeout(timeout)
        while True:
            while len(self.buffer) >= 2:
                first, second = self.buffer[0], self.buffer[1]
                opcode = first & 0x0F
                length = second & 0x7F
                masked = bool(second & 0x80)
                offset = 2
                if length == 126:
                    if len(self.buffer) < offset + 2:
                        break
                    length = struct.unpack(">H", self.buffer[offset:offset + 2])[0]
                    offset += 2
                elif length == 127:
                    if len(self.buffer) < offset + 8:
                        break
                    length = struct.unpack(">Q", self.buffer[offset:offset + 8])[0]
                    offset += 8
                if len(self.buffer) < offset + (4 if masked else 0) + length:
                    break
                mask = self.buffer[offset:offset + 4] if masked else None
                offset += 4 if masked else 0
                payload = bytearray(self.buffer[offset:offset + length])
                if masked:
                    for index in range(length):
                        payload[index] ^= mask[index % 4]
                self.buffer = self.buffer[offset + length:]
                if opcode == 0x1:
                    return payload.decode("utf-8")
                if opcode == 0x9:  # ping -> pong
                    self.sock.sendall(ws_frame(0xA, payload, mask=False))
                if opcode == 0x8:
                    return None
            chunk = self.sock.recv(65536)
            if not chunk:
                return None
            self.buffer += chunk

    def next_message(self, predicate, timeout=15.0, label=""):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.receive(timeout=min(5.0, deadline - time.monotonic()))
            if line is None:
                raise RuntimeError("connection closed waiting for {}".format(label or predicate))
            obj = json.loads(line)
            if predicate(obj):
                return obj
            print("  (skip {})".format(obj.get("type")))
        raise RuntimeError("timeout waiting for {}".format(label or predicate))

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def navigation_stream(task_id, count=6):
    lines = []
    lines.append({
        "protocol": "luban-nav-ble", "protocolVersion": 1,
        "type": "navigation_start", "priority": "nav", "taskId": task_id,
        "createdAt": iso_now(), "dataset": "hkustgz-layered-routing-v4",
        "route": {
            "from": "main-entrance", "to": "library", "mode": "robot",
            "coordinateSystem": "WGS84 longitude/latitude",
            "distanceMeters": 12, "durationSeconds": 30,
            "waypointSpacingMeters": 2.5, "waypointCount": count,
        },
    })
    for sequence in range(count):
        lines.append({
            "protocol": "luban-nav-ble", "protocolVersion": 1,
            "type": "waypoint", "priority": "nav", "taskId": task_id,
            "sequence": sequence, "nodeId": "w{}".format(sequence),
            "longitude": 113.47768 + sequence * 0.000012,
            "latitude": 22.88836 + sequence * 0.000010,
            "kind": "interpolated", "indoor": False, "level": None,
            "interpolated": True,
        })
    lines.append({
        "protocol": "luban-nav-ble", "protocolVersion": 1,
        "type": "navigation_end", "priority": "nav", "taskId": task_id,
        "waypointCount": count,
    })
    return lines


def main():
    parser = argparse.ArgumentParser(description="car7 WiFi bridge closed-loop test")
    parser.add_argument("--url", default="ws://10.7.181.161:8900")
    parser.add_argument("--ca", default=None,
                        help="trust this CA file for wss:// (make_car7_cert.sh 生成的 ca.crt)；"
                             "缺省时不校验证书（仅用于自测）")
    parser.add_argument("--waypoints", type=int, default=6)
    parser.add_argument("--direction-motion", action="store_true",
                        help="DANGER: also send a real forward/backward move (wheels must be safe)")
    args = parser.parse_args()

    print("[1] WebSocket handshake: {}".format(args.url))
    client = WsClient(args.url, ca_file=args.ca)
    print("    connected")

    print("[2] streaming navigation task ({} waypoints)".format(args.waypoints))
    task_id = "task-wifi-{}".format(int(time.time()))
    for line in navigation_stream(task_id, args.waypoints):
        # Protocol contract: each JSON object is one line terminated by LF.
        client.send_text(json.dumps(line, separators=(",", ":")) + "\n")
    ack = client.next_message(lambda o: o.get("type") == "ack" and o.get("status") == "accepted",
                              label="ack accepted")
    print("    ack: accepted ({})".format(ack.get("message", "")))
    status = client.next_message(lambda o: o.get("type") == "status" and o.get("status") == "navigating",
                                 label="status navigating")
    print("    status: navigating")

    print("[3] position telemetry (replay fallback while RTK has no fix)")
    seen = 0
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline and seen < 3:
        pos = client.next_message(lambda o: o.get("type") == "position", label="position")
        seen += 1
        print("    pos[{}] fix={} lat={} lon={} hdg={} acc={}".format(
            seen, pos.get("fixStatus"), pos.get("latitude"), pos.get("longitude"),
            pos.get("headingDegrees"), pos.get("accuracyMeters")))

    print("[4] direction stop (no motion)")
    client.send_command({
        "protocol": "luban-nav-ble", "protocolVersion": 1, "type": "direction",
        "priority": "ble", "commandId": "dir-stop", "direction": "stop",
        "amountMeters": None, "amountDegrees": None, "speedMetersPerSecond": None,
        "createdAt": iso_now(),
    })
    stop_ack = client.next_message(lambda o: o.get("type") == "ack" and o.get("status") == "accepted",
                                   label="direction stop ack")
    print("    ack: {}".format(stop_ack.get("status")))

    if args.direction_motion:
        print("[5] DANGER direction forward 0.10 m")
        client.send_command({
            "protocol": "luban-nav-ble", "protocolVersion": 1, "type": "direction",
            "priority": "ble", "commandId": "dir-fwd", "direction": "forward",
            "amountMeters": 0.10, "amountDegrees": None, "speedMetersPerSecond": 0.2,
            "createdAt": iso_now(),
        })
        client.next_message(lambda o: o.get("type") == "ack", label="direction forward ack")
        print("    ack: accepted (chassis should move ~10cm)")
        time.sleep(4)
        client.send_command({
            "protocol": "luban-nav-ble", "protocolVersion": 1, "type": "direction",
            "priority": "ble", "commandId": "dir-back", "direction": "backward",
            "amountMeters": 0.10, "amountDegrees": None, "speedMetersPerSecond": 0.2,
            "createdAt": iso_now(),
        })
        client.next_message(lambda o: o.get("type") == "ack", label="direction backward ack")
        print("    ack: accepted (chassis should move back ~10cm)")

    print("[6] emergency stop")
    client.send_command({
        "protocol": "luban-nav-ble", "protocolVersion": 1, "type": "emergency_stop",
        "priority": "safety", "commandId": "stop-test", "taskId": task_id,
        "createdAt": iso_now(), "reason": "operator_test",
    })
    stop = client.next_message(lambda o: o.get("type") == "ack" and o.get("status") == "stopped",
                               label="emergency stop ack")
    print("    ack: {}".format(stop.get("status")))

    client.close()
    print("\nPASS  car7 WiFi bridge closed loop verified")


if __name__ == "__main__":
    main()
