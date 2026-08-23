#!/usr/bin/env python3
"""rtk_serial_probe.py — 自动匹配 RTK 模块的 GNSS 数据串口。

背景：AirM2M 组合模块（ttyACM0-3）在 USB 重连/重启后，GNSS 数据可能换到
不同的 ACM 接口。本脚本扫描候选串口，按 NMEA 句子质量打分，自动选出
GNSS 数据口（纯规则判定，无人工/AI 参与）。

评分规则（每口）：
  +3 每条 checksum 正确的 $GNGGA/$GPGGA
  +1 每条 checksum 正确的其他 $GNxxx/$GPxxx 定位句（RMC/GSV/GSA）
  +2 额外：GGA quality>=4（RTK 固定解/浮点解）
  -1 每条 checksum 错误/截断的句子（惩罚错乱流）

用法：
  python3 rtk_serial_probe.py [--baud 115200] [--sample 2.5] [--verbose]
  输出：<设备路径>（无可用口时输出空并 exit 1）

部署位置：/home/pc/campusCar/src/rtk_tools/rtk_serial_probe.py
"""

import argparse
import glob
import os
import re
import sys
import time

GGA_RE = re.compile(r"^\$(GNGGA|GPGGA),")
ANY_NMEA_RE = re.compile(r"^\$(GN|GP|GL|GA|GB)[A-Z]{3},")


def checksum_ok(sentence: str) -> bool:
    """$...*HH 形式，校验和正确返回 True（无 * 或格式坏返回 False）。"""
    if "*" not in sentence:
        return False
    body, _, chk = sentence.partition("*")
    if not body.startswith("$") or len(chk) < 2:
        return False
    try:
        expect = int(chk[:2], 16)
    except ValueError:
        return False
    actual = 0
    for ch in body[1:]:
        actual ^= ord(ch)
    return actual == expect


def probe_port(dev: str, baud: int, sample_s: float,
              open_fn=None, read_fn=None) -> dict:
    """读 sample_s 秒，返回评分结果。open_fn/read_fn 可注入（便于单测）。"""
    open_fn = open_fn or os.open
    read_fn = read_fn or os.read
    score = 0
    gga_ok = 0
    sentences_ok = 0
    bad = 0
    max_quality = -1
    try:
        fd = open_fn(dev, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError:
        return {"dev": dev, "score": -999, "error": "open failed"}
    try:
        import termios
        attrs = termios.tcgetattr(fd)
        attrs[2] = attrs[2] | termios.CREAD
        attrs[4] = baud
        attrs[5] = baud
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except Exception:
        pass
    buffer = b""
    deadline = time.monotonic() + sample_s
    try:
        while time.monotonic() < deadline:
            try:
                chunk = read_fn(fd, 4096)
            except BlockingIOError:
                time.sleep(0.05)
                continue
            except OSError:
                break
            if not chunk:
                time.sleep(0.05)
                continue
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                text = line.decode("utf-8", errors="replace").strip()
                if not text.startswith("$"):
                    bad += 1
                    score -= 1
                    continue
                ok = checksum_ok(text)
                if GGA_RE.match(text):
                    if ok:
                        gga_ok += 1
                        score += 3
                        fields = text.split(",")
                        if len(fields) > 6 and fields[6].isdigit():
                            quality = int(fields[6])
                            max_quality = max(max_quality, quality)
                            if quality >= 4:
                                score += 2
                    else:
                        bad += 1
                        score -= 1
                elif ANY_NMEA_RE.match(text):
                    if ok:
                        sentences_ok += 1
                        score += 1
                    else:
                        bad += 1
                        score -= 1
                else:
                    bad += 1
                    score -= 1
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return {
        "dev": dev,
        "score": score,
        "gga_ok": gga_ok,
        "sentences_ok": sentences_ok,
        "bad": bad,
        "max_quality": max_quality,
    }


def candidate_devices(prefixes=("usb-AirM2M",), direct=("ttyACM",)):
    """收集候选设备：by-id 软链指向的 ACM 口（避免 ttyUSB 底盘串口）。"""
    found = set()
    for pattern in ("/dev/serial/by-id/*",):
        for link in glob.glob(pattern):
            base = os.path.basename(link)
            if any(base.startswith(p) for p in prefixes):
                found.add(link)
    if not found:
        for name in direct:
            for dev in glob.glob("/dev/{}*".format(name)):
                found.add(dev)
    return sorted(found)


def main():
    parser = argparse.ArgumentParser(description="Auto-detect the RTK GNSS serial port")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--sample", type=float, default=2.5,
                        help="seconds to sample each candidate port")
    parser.add_argument("--verbose", action="store_true")
    options = parser.parse_args()

    devices = candidate_devices()
    if not devices:
        print("", end="")
        return 1

    results = [probe_port(dev, options.baud, options.sample) for dev in devices]
    results.sort(key=lambda r: r["score"], reverse=True)
    best = results[0]

    if options.verbose:
        for r in results:
            print("{}  score={} gga={} ok={} bad={} q={}".format(
                r["dev"], r["score"], r.get("gga_ok", 0), r.get("sentences_ok", 0),
                r.get("bad", 0), r.get("max_quality", -1)), file=sys.stderr)

    if best["score"] <= 0 or best["gga_ok"] == 0:
        # 没有可靠数据口：退回默认 by-id if06（与历史一致），并提示
        default = next((d for d in devices if "if06" in d), devices[0])
        print(default)
        return 2

    print(best["dev"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
