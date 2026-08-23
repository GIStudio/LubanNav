#!/usr/bin/env python3
"""Deploy the car7 WiFi bridge to the NUC, install its systemd unit and commit
on our fe-ble-bridge worktree (never touches the shared main worktree HEAD).

Flow:
  1. upload files to RUN dir (/home/pc/campusCar/src/ble_bridge)
  2. copy them into the worktree (/home/pc/campusCar-fe/src/ble_bridge)
  3. install the systemd unit (/etc/systemd/system via sudo) and restart it
  4. commit inside the worktree (author: wsqstar automatically)

Usage:
  python3 deploy_car7_wifi.py --commit "feat(wifi_bridge): ..." [--no-restart]
"""

import argparse
import os
import time

import paramiko

HOST = "10.7.181.161"
USER = "pc"
PASSWORD = "1"

RUN_DIR = "/home/pc/campusCar/src/ble_bridge"
WORKTREE_DIR = "/home/pc/campusCar-fe/src/ble_bridge"
LOCAL_DIR = os.path.dirname(os.path.abspath(__file__))
SERVICE_NAME = "car7-wifi-bridge"

DEFAULT_FILES = [
    "car7_wifi_bridge.py",
    "car7_teleop.py",
    "car7_protocol.py",
    "test_car7_wifi_bridge.py",
    "car7-wifi-bridge.service",
    "car7_status_server.py",
    "test_car7_status_server.py",
    "car7_navigator.py",
    "test_car7_navigator.py",
    "car7-status-server.service",
    "web_teleop.sh",
    "web_teleop.py",
    "car7-web-teleop.service",
    "car7_serial_watchdog.sh",
    "car7-serial-watchdog.service",
    "car7_selfheal.sh",
    "car7-selfheal.service",
    "README.md",
]


def main():
    parser = argparse.ArgumentParser(description="Deploy car7 WiFi bridge and commit on fe-ble-bridge")
    parser.add_argument("--commit", required=True, help="commit message (multi-line via \\n)")
    parser.add_argument("--files", nargs="*", default=DEFAULT_FILES, help="files to deploy")
    parser.add_argument("--no-restart", action="store_true", help="install files but do not restart the service")
    args = parser.parse_args()

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD,
                   look_for_keys=False, allow_agent=False, timeout=15)
    sftp = client.open_sftp()

    for name in args.files:
        local = os.path.join(LOCAL_DIR, name)
        if not os.path.exists(local):
            print("skip missing:", name)
            continue
        sftp.put(local, RUN_DIR + "/" + name)
        print("uploaded run:", name)

    def run(cmd, timeout=60):
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode()
        err = stderr.read().decode()
        code = stdout.channel.recv_exit_status()
        return code, out, err

    # copy to worktree
    copies = " && ".join(
        "cp {} {}".format(RUN_DIR + "/" + n, WORKTREE_DIR + "/" + n) for n in args.files
    )
    code, out, err = run("mkdir -p {} && {} && echo copied-to-worktree".format(WORKTREE_DIR, copies), timeout=30)
    print(out.strip(), err.strip() or "")

    # install + (re)start the systemd unit with sudo
    code, out, err = run(
        "echo 1 | sudo -S cp {}/{} /etc/systemd/system/ 2>/dev/null && "
        "echo 1 | sudo -S systemctl daemon-reload 2>/dev/null && "
        "echo 1 | sudo -S systemctl enable {} 2>/dev/null && "
        "echo 1 | sudo -S systemctl restart {} && "
        "sleep 2 && systemctl is-active {}".format(
            RUN_DIR, SERVICE_NAME + ".service", SERVICE_NAME, SERVICE_NAME, SERVICE_NAME
        ),
        timeout=60,
    )
    print("systemd:", out.strip(), err.strip() or "")

    # commit inside the worktree (wsqstar identity comes from its worktree config)
    message = args.commit.replace("\\n", "\n")
    code, out, err = run(
        "cd {} && git add -A && git -c user.name=wsqstar -c user.email=wsqstar@users.noreply.github.com "
        "commit -m \"{}\" && git log --format='%h | %an <%ae> | %s' -1".format(
            "/home/pc/campusCar-fe", message
        ),
        timeout=30,
    )
    print(out.strip(), err.strip() or "")

    code, out, err = run(
        "git -C /home/pc/campusCar branch --show-current && git -C /home/pc/campusCar status --short | head -3",
        timeout=20,
    )
    print("main worktree:", out.strip(), err.strip() or "")
    client.close()


if __name__ == "__main__":
    main()
