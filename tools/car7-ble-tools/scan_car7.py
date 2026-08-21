import asyncio
from bleak import BleakScanner

TARGET = "EC:8E:77:C9:BB:65"

async def main():
    print(f"扫描 25s，寻找 car7 / {TARGET} ...")
    devices = await BleakScanner.discover(timeout=25, return_adv=True)
    found = False
    for dev, adv in devices.values():
        addr = dev.address
        name = adv.local_name or ""
        if name.startswith("car7") or addr.upper() == TARGET:
            found = True
            print(f"✅ 找到: {name} ({addr}) 服务数据={adv.service_data} ")
    if not found:
        print(f"❌ 25s 内未发现 car7/{TARGET}（共扫描到 {len(devices)} 个设备）")
    # 打印所有以 E8 开头的地址（近似车机厂商前缀）
    for dev, adv in devices.values():
        addr = dev.address
        if addr.upper().startswith("E8EA4D9C") or addr.upper().startswith("EC8E77"):
            print("  近似设备:", adv.local_name, addr)

asyncio.run(main())
