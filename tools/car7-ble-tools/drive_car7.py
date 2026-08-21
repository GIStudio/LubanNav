#!/usr/bin/env python3
"""通过完整 BLE 链路驱动 car7：connect -> subscribe -> direction 序列"""
import asyncio, json, sys
from datetime import datetime, timezone
from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
COMMAND_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TELEMETRY_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

class RX:
    def __init__(self):
        self.lines, self.buf, self._wake = [], b"", asyncio.Event()
    def feed(self, data):
        self.buf += bytes(data)
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            line = line.strip(b"\r")
            if line: self.lines.append(line)
        self._wake.set()
    async def wait_ack(self, timeout=8):
        end = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < end:
            while self.lines:
                try: obj = json.loads(self.lines.pop(0))
                except Exception: continue
                if obj.get("type") == "ack": return obj
            self._wake.clear()
            try: await asyncio.wait_for(self._wake.wait(), 2)
            except asyncio.TimeoutError: pass
        raise TimeoutError("no ack")

def msg(type_, **kw):
    return {**{"protocol":"luban-nav-ble","protocolVersion":1,"type":type_}, **kw}

def dir_cmd(direction, amount=None):
    m = msg("direction", commandId=f"dir-{datetime.now(timezone.utc).timestamp():.0f}",
            direction=direction, createdAt=datetime.now(timezone.utc).isoformat().replace("+00:00","Z"))
    if direction in ("forward","backward"): m["amountMeters"] = amount if amount is not None else 0.15
    if direction in ("left","right"): m["amountDegrees"] = amount if amount is not None else 15
    m["speedMetersPerSecond"] = 0.06 if direction in ("forward","backward") else None
    return m

async def write_json(client, obj):
    payload = (json.dumps(obj) + "\n").encode()
    for i in range(0, len(payload), 20):
        await client.write_gatt_char(COMMAND_UUID, payload[i:i+20])

async def main():
    print("[SCAN] 扫描 car7 ...")
    dev = None
    for attempt in range(3):
        dev = await BleakScanner.find_device_by_name("car7", timeout=30)
        if dev: break
        print(f"[SCAN] 第 {attempt+1} 轮未找到，重试...")
    if not dev: print("❌ 3 轮扫描仍未找到 car7"); return
    print(f"[CONNECT] {dev.address}")
    rx = RX()
    async with BleakClient(dev) as client:
        await client.start_notify(TELEMETRY_UUID, rx.feed)
        await asyncio.sleep(0.5)
        print("[READY] 订阅完成")
        seq = [("forward", 0.3), ("left", 30), ("backward", 0.3), ("stop", None)]
        for direction, amount in seq:
            await write_json(client, dir_cmd(direction, amount))
            ack = await rx.wait_ack()
            print(f"[{direction:8s}] ack -> {ack.get('status')} ({ack.get('message')})")
            await asyncio.sleep(1.2)
        print("[DONE] 序列结束（最后已发送 stop）")

asyncio.run(main())
