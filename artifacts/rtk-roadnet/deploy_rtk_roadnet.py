#!/usr/bin/env python3
"""Deploy RTK road-network logger/builder to car7 and commit on fe-ble-bridge.

Mirrors deploy_car7.py: two people share the car; our git operations live in
the isolated worktree /home/pc/campusCar-fe (branch fe-ble-bridge, identity
wsqstar). This uploads the RTK roadnet files to the RUN directory
(src/rtk_tools/), copies them into the worktree, and commits.

Usage:
  python3 deploy_rtk_roadnet.py --commit "feat(rtk): persistent Fixed log + auto road network"
"""

import argparse
import os
import paramiko

HOST = "10.7.181.161"
USER = "pc"
PASSWORD = "1"

RUN_DIR = "/home/pc/campusCar/src/rtk_tools"
WORKTREE_DIR = "/home/pc/campusCar-fe/src/rtk_tools"
LOCAL_DIR = os.path.dirname(os.path.abspath(__file__))

DEFAULT_FILES = [
    "rtk_fixed_logger.py",
    "roadnet_builder.py",
    "test_roadnet_builder.py",
    "rtk_fixed_logger_run.sh",
    "rtk_roadnet_start.sh",
    "rtk-fixed-logger.service",
    "rtk-roadnet-builder.service",
    "car7-rtk-backup.service",
    "car7-rtk-backup.timer",
    "rtk_serial_probe.py",
    "test_rtk_serial_probe.py",
    "rtk_nmea_start.sh",
    "car7-nmea-driver.service",
    "README.md",
]


def main():
    parser = argparse.ArgumentParser(description="Deploy RTK roadnet files and commit on fe-ble-bridge")
    parser.add_argument("--commit", required=True, help="commit message")
    parser.add_argument("--files", nargs="*", default=DEFAULT_FILES, help="files to deploy")
    parser.add_argument("--no-commit", action="store_true", help="upload only, no git commit")
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
    # 可执行位
    sftp.chmod(RUN_DIR + "/rtk_roadnet_start.sh", 0o755)
    sftp.chmod(RUN_DIR + "/rtk_fixed_logger_run.sh", 0o755)

    def run(cmd, timeout=30):
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        return stdout.read().decode(), stderr.read().decode()

    out, err = run(
        "mkdir -p {} && ".format(WORKTREE_DIR) +
        " ".join("cp {} {} &&".format(RUN_DIR + "/" + n, WORKTREE_DIR + "/" + n) for n in args.files) +
        " chmod +x {} {} && echo copied-to-worktree".format(
            WORKTREE_DIR + "/rtk_roadnet_start.sh", WORKTREE_DIR + "/rtk_fixed_logger_run.sh"),
        timeout=20,
    )
    print(out, err)

    if not args.no_commit:
        message = args.commit.replace("\\n", "\n")
        out, err = run(
            "cd {} && git add -A && git -c user.name=wsqstar -c user.email=wsqstar@users.noreply.github.com "
            "commit -m \"{}\" && git log --format='%h | %an <%ae> | %s' -1".format(
                "/home/pc/campusCar-fe", message
            ),
            timeout=30,
        )
        print(out, err)

    out, err = run("git -C /home/pc/campusCar branch --show-current", timeout=20)
    print("main worktree:", out, err)
    client.close()


if __name__ == "__main__":
    main()
