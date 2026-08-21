import asyncio, time
from bleak import BleakScanner

async def main():
    count = 0
    first = last = None
    def cb(device, adv):
        global count, first, last
        nonlocal_dummy = None
        if device.name == "car7":
            count += 1
            if first is None: first = time.time()
            last = time.time()
    scanner = BleakScanner(detection_callback=cb, scanning_mode="active", allow_duplicates=True)
    await scanner.start()
    await asyncio.sleep(60)
    await scanner.stop()
    if count:
        dur = last - first
        print(f"60s 内收到 {count} 条 car7 广告; 首见 {first%100:.1f}s, 末见 {last%100:.1f}s, 跨度 {dur:.1f}s")
        print(f"平均速率: {count/dur:.1f} 条/秒" if dur > 0 else "瞬时")
    else:
        print("60s 未收到任何 car7 广告")

asyncio.run(main())
