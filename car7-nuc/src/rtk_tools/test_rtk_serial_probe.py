#!/usr/bin/env python3
"""Unit tests for rtk_serial_probe.py scoring logic (no serial hardware needed)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import rtk_serial_probe as probe

PASSED = 0
FAILED = []


def check(name, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print("PASS  {}".format(name))
    else:
        FAILED.append(name)
        print("FAIL  {}  {}".format(name, detail))


def test_checksum():
    # $GNGGA,090324.00,2253.53267915,N,11328.56693392,E,4,28,0.7,4.8501,M,-5.9432,M,1.0,1449*4D
    good = "$GNGGA,090324.00,2253.53267915,N,11328.56693392,E,4,28,0.7,4.8501,M,-5.9432,M,1.0,1449*4D"
    check("valid checksum", probe.checksum_ok(good))
    check("bad checksum", not probe.checksum_ok(good.replace("*4D", "*00")))
    check("no checksum", not probe.checksum_ok("$GNGGA,1,2,3"))
    check("short body", not probe.checksum_ok("$GNGGA*12"))


def test_scoring_good_port():
    """一个干净口（连续合法 GGA quality 4）应得高分。"""
    lines = [
        "$GNGGA,090324.00,2253.53267915,N,11328.56693392,E,4,28,0.7,4.8501,M,-5.9432,M,1.0,1449*4D\n",
        "$GNGGA,090325.00,2253.53267915,N,11328.56693392,E,4,28,0.7,4.8501,M,-5.9432,M,1.0,1449*4C\n",
    ]
    data = "".join(lines).encode()
    state = {"pos": 0}

    def fake_read(fd, n):
        if state["pos"] >= len(data):
            raise BlockingIOError
        chunk = data[state["pos"]:state["pos"] + n]
        state["pos"] += len(chunk)
        return chunk

    result = probe.probe_port("/dev/fake", 115200, 1.0,
                              open_fn=lambda *a: 99, read_fn=fake_read)
    check("good port scored", result["gga_ok"] == 2, result)
    check("quality parsed", result["max_quality"] == 4, result)


def test_scoring_corrupted_port():
    """错乱流（穿插、坏 checksum）得分低。"""
    lines = [
        "$GAGSV,2,1,08,07,53,355,37,02,21,8,18*00\n",   # bad checksum
        "$GNGGA,090324.00,2253.53*00\n",                # truncated + bad
        "garbage\n",
    ]
    data = "".join(lines).encode()
    os_read = os.read
    state = {"pos": 0}

    def fake_read(fd, n):
        if state["pos"] >= len(data):
            raise BlockingIOError
        chunk = data[state["pos"]:state["pos"] + n]
        state["pos"] += len(chunk)
        return chunk

    result = probe.probe_port("/dev/fake", 115200, 1.0,
                              open_fn=lambda *a: 99, read_fn=fake_read)
    check("corrupted port low score", result["score"] < 0, result)


if __name__ == "__main__":
    test_checksum()
    test_scoring_good_port()
    test_scoring_corrupted_port()
    print("\n{} passed, {} failed".format(PASSED, len(FAILED)))
    sys.exit(1 if FAILED else 0)
