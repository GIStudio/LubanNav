#!/usr/bin/env python3
"""car7 BLE bridge — Linux/BlueZ port of LubanNav tools/car7-ble-simulator.

Exposes the LubanNav Web Bluetooth robot protocol (NUS GATT server) on the
real car7 NUC through BlueZ, so the LubanNav web page (or any Web Bluetooth
central) can connect to the actual machine.

Telemetry-only by design: received routes are replayed as position telemetry.
This process NEVER publishes ROS2 /cmd_vel and never drives motors. It only
optionally writes a campusCar waypoint JSON that a human must feed to
gps_navigator.py after wheel-lift checks (see docs/car7-local-ble-test.md).

CLI parity with the macOS simulator:
  --name NAME                advertised BLE name (default: car7)
  --step-ms MILLISECONDS     delay between simulated waypoints (default: 750)
  --loop                     repeat the received route until STOP/disconnect
  --campuscar-export PATH    write campusCar gps_navigator waypoint JSON
  -h, --help                 show help
"""

import argparse
import os
import queue
import socket
import sys
import tempfile
import threading
import time
from typing import Optional

try:
    import dbus
    import dbus.mainloop.glib
    import dbus.service
    from gi.repository import GLib
except ImportError as exc:  # pragma: no cover
    print("car7-ble-bridge: missing dependency: {}".format(exc), file=sys.stderr)
    print("install with: sudo apt install python3-dbus python3-gi", file=sys.stderr)
    sys.exit(1)

from car7_protocol import (
    COMMAND_UUID,
    SERVICE_UUID,
    TELEMETRY_UUID,
    Car7CommandError,
    DirectionCommand,
    EmergencyStop,
    FramingError,
    JSONLineFramer,
    NavigationEnd,
    NavigationRoute,
    NavigationStart,
    NavigationTask,
    WaypointLine,
    acknowledgement,
    bearing_degrees,
    campuscar_waypoint_file,
    encode_line,
    encode_pretty,
    iso8601_now,
    parse_command,
    position_message,
    status_message,
)

BLUEZ_SERVICE_NAME = "org.bluez"
ADAPTER_IFACE = "org.bluez.Adapter1"
DEVICE_IFACE = "org.bluez.Device1"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
LE_AD_IFACE = "org.bluez.LEAdvertisement1"
LE_AD_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

ADAPTER_PATH = "/org/bluez/hci0"
APP_PATH = "/org/lubannav/car7"
SERVICE_PATH = APP_PATH + "/service0"
COMMAND_CHRC_PATH = SERVICE_PATH + "/char0"
TELEMETRY_CHRC_PATH = SERVICE_PATH + "/char1"
AD_PATH = APP_PATH + "/advertisement0"

DEFAULT_CHUNK = 20
POSITION_ACCURACY_METERS = 1.5
MOVE_EXECUTOR_PORT = 9099
MOVE_TEST_DISTANCE_METERS = 0.10
MOVE_REPLY_TIMEOUT_S = 30.0


class MoveClient(threading.Thread):
    """Background client for the in-container move executor (127.0.0.1:9099).

    Commands are queued from the GLib thread; replies are delivered back with
    GLib.idle_add so the mainloop (BLE notifications) never blocks.
    """

    def __init__(self, host, port, on_reply):
        super().__init__(name="move-client", daemon=True)
        self.host = host
        self.port = port
        self.on_reply = on_reply  # called in mainloop thread via idle_add
        self.queue = queue.Queue()
        self.stop_all = threading.Event()
        self.stop_now_flag = threading.Event()  # interrupt the active command
        self.discard_until_stop = threading.Event()  # drop queued commands until STOP
        self.conn = None

    def submit(self, command, argument=None, speed=None):
        self.queue.put((command, argument, speed))

    def stop_now(self):
        """Immediate stop: drop queued moves and send STOP to the executor."""
        self.stop_now_flag.set()
        self.discard_until_stop.set()
        self.queue.put(("STOP", None, None))  # queued commands before it are discarded

    def close(self):
        self.stop_all.set()
        self.submit("__EXIT__", None)

    def _ensure_conn(self):
        if self.conn is not None:
            return True
        try:
            sock = socket.create_connection((self.host, self.port), timeout=3.0)
            sock.settimeout(0.2)
            self.conn = sock
            return True
        except OSError as exc:
            self._deliver("ERR", "executor unreachable: {}".format(exc))
            return False

    def _deliver(self, payload, detail=None):
        GLib.idle_add(self.on_reply, payload, detail)

    def _send(self, text):
        try:
            self.conn.sendall(text.encode("utf-8") + b"\n")
            print("[EXEC] -> {}".format(text.strip()), flush=True)
            return True
        except OSError:
            self.conn = None
            print("[EXEC] send failed: {}".format(text.strip()), flush=True)
            return False

    def run(self):
        while not self.stop_all.is_set():
            command, argument, speed = self.queue.get()
            if command == "__EXIT__":
                break
            if self.discard_until_stop.is_set() and command != "STOP":
                # Discard every command queued before the stop: they must not
                # run after the operator cleared the joystick queue.
                print("[EXEC] discard queued {}".format(command), flush=True)
                continue
            if command == "STOP":
                self.discard_until_stop.clear()
                self.stop_now_flag.clear()
                if self._ensure_conn():
                    self._send("STOP")
                    self._await_reply(command)  # drain exactly one reply line
                continue
            if not self._ensure_conn():
                continue
            parts = [command, argument] if argument is not None else [command]
            if speed is not None:
                parts.append(speed)
            self._send(" ".join(str(part) for part in parts))
            self._await_reply(command)

    def _await_reply(self, command):
        deadline = time.monotonic() + MOVE_REPLY_TIMEOUT_S
        buffer = b""
        while time.monotonic() < deadline and not self.stop_all.is_set():
            if self.stop_now_flag.is_set():
                self.stop_now_flag.clear()
                self._send("STOP")  # executor answers STOPPED/OK; lines are drained below
            try:
                chunk = self.conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                self.conn = None
                self._deliver("ERR", "executor connection lost")
                return
            if chunk == b"":
                self.conn = None
                self._deliver("ERR", "executor closed connection")
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                kind, detail = self._parse_line(line)
                print("[EXEC] <- {} {}".format(kind, detail if detail is not None else ""), flush=True)
                if command in ("FORWARD", "BACKWARD", "LEFT", "RIGHT"):
                    # "OK" is the acceptance line; keep waiting for the result line.
                    if kind in ("DONE", "STOPPED", "TIMEOUT", "ERR"):
                        self._deliver(kind, detail)
                        return
                    continue
                # STOP: any single line (OK or STOPPED) completes the command.
                self._deliver(kind, detail)
                return
        else:
            self._deliver("ERR", "executor reply timeout")
            self.conn = None

    @staticmethod
    def _parse_line(line):
        parts = line.decode("utf-8", errors="replace").strip().split()
        if not parts:
            return "OK", None
        kind = parts[0].upper()
        detail = None
        if len(parts) > 1:
            try:
                detail = float(parts[1])
            except ValueError:
                detail = parts[1]
        return kind, detail


class InvalidArgs(dbus.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class NotPermitted(dbus.DBusException):
    _dbus_error_name = "org.bluez.Error.NotPermitted"


def to_bytes(value) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):  # defensive; 'ay' normally arrives as byte array
        return value.encode("utf-8")
    return bytes(bytearray(value))


class Characteristic(dbus.service.Object):
    """Base GATT characteristic with the BlueZ GattCharacteristic1 interface."""

    def __init__(self, bus, index, uuid, flags, service):
        self.path = service.path + "/char" + str(index)
        self.bus = bus
        self.uuid = uuid
        self.flags = flags
        self.service = service
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    def props(self) -> dict:
        return {
            "Service": self.service.get_path(),
            "UUID": self.uuid,
            "Flags": dbus.Array(self.flags, signature="s"),
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgs()
        return self.props()

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        return dbus.ByteArray(b"")

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        raise NotPermitted()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        raise NotPermitted()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        pass

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


class CommandCharacteristic(Characteristic):
    """Command / RX — Write and Write Without Response feed the parser."""

    def __init__(self, bus, service, bridge):
        super().__init__(bus, 0, COMMAND_UUID, ["write", "write-without-response"], service)
        self.bridge = bridge

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        self.bridge.receive(to_bytes(value))


class TelemetryCharacteristic(Characteristic):
    """Telemetry / TX — Notify carries ack/status/position JSON lines."""

    def __init__(self, bus, service, bridge):
        super().__init__(bus, 1, TELEMETRY_UUID, ["notify"], service)
        self.bridge = bridge

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.bridge.on_subscribe()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.bridge.on_unsubscribe()

    def notify_value(self, chunk: bytes):
        self.PropertiesChanged(GATT_CHRC_IFACE, {"Value": dbus.ByteArray(chunk)}, [])


class Service(dbus.service.Object):
    def __init__(self, bus, bridge):
        self.path = SERVICE_PATH
        self.bus = bus
        self.uuid = SERVICE_UUID
        self.primary = True
        self.command_characteristic = CommandCharacteristic(bus, self, bridge)
        self.telemetry_characteristic = TelemetryCharacteristic(bus, self, bridge)
        self.characteristics = [
            self.command_characteristic,
            self.telemetry_characteristic,
        ]
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    def props(self) -> dict:
        return {
            "UUID": self.uuid,
            "Primary": self.primary,
            "Characteristics": dbus.Array(
                [chrc.get_path() for chrc in self.characteristics], signature="o"
            ),
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgs()
        return self.props()


class Application(dbus.service.Object):
    def __init__(self, bus):
        self.path = APP_PATH
        self.bus = bus
        self.service = None
        dbus.service.Object.__init__(self, bus, self.path)

    def set_service(self, service):
        self.service = service

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        if self.service is None:
            return {}
        response = {self.service.get_path(): {GATT_SERVICE_IFACE: self.service.props()}}
        for chrc in self.service.characteristics:
            response[chrc.get_path()] = {GATT_CHRC_IFACE: chrc.props()}
        return response


class Advertisement(dbus.service.Object):
    def __init__(self, bus, name):
        self.path = AD_PATH
        self.bus = bus
        self.name = name
        self.service_uuids = [SERVICE_UUID]
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self) -> dbus.ObjectPath:
        return dbus.ObjectPath(self.path)

    def props(self) -> dict:
        return {
            "Type": "peripheral",
            "ServiceUUIDs": dbus.Array(self.service_uuids, signature="s"),
            "LocalName": dbus.String(self.name),
            # 必须声明 Discoverable，BlueZ 才会在广播中携带 AD Flags
            # (LE General Discoverable)，否则多数扫描器不上报该设备，
            # 部分 BlueZ 版本甚至完全不发送广播包。
            "Discoverable": dbus.Boolean(True),
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_AD_IFACE:
            raise InvalidArgs()
        return self.props()

    @dbus.service.method(LE_AD_IFACE, in_signature="", out_signature="")
    def Release(self):
        self.log("BLE", "advertisement released")


class Car7BLEBridge:
    """Owns protocol state and bridges D-Bus callbacks to simulator behavior."""

    def __init__(self, bus, options, loop):
        self.bus = bus
        self.options = options
        self.loop = loop
        self.framer = JSONLineFramer()
        self.application = Application(bus)
        self.service = Service(bus, self)
        self.application.set_service(self.service)
        self.advertisement = Advertisement(bus, options.name)

        self.adapter_iface = dbus.Interface(
            bus.get_object(BLUEZ_SERVICE_NAME, ADAPTER_PATH), ADAPTER_IFACE
        )
        self.gatt_manager = dbus.Interface(
            bus.get_object(BLUEZ_SERVICE_NAME, ADAPTER_PATH), GATT_MANAGER_IFACE
        )
        self.ad_manager = dbus.Interface(
            bus.get_object(BLUEZ_SERVICE_NAME, ADAPTER_PATH), LE_AD_MANAGER_IFACE
        )

        self.registered = False
        self.notifying = False
        self.pending_notifications = []
        self.active_task = None
        self.streaming = None  # {"expected_count": int, "completed": bool}
        self.next_waypoint_index = 0
        self.playback_source_id = None
        self._mtu = None

        self.move_client = None
        self.move_test_step = -1
        self.move_test_stopped = False
        if options.move_test or options.direction:
            self.move_client = MoveClient("127.0.0.1", options.executor_port, self.on_move_reply)

    # ── logging ────────────────────────────────────────────────────────────

    @staticmethod
    def log(category, message):
        print("[{}] {}".format(category, message), flush=True)

    # ── lifecycle ──────────────────────────────────────────────────────────

    def start(self):
        if self.options.move_test:
            self.log("BOOT", "telemetry + MOVE-TEST mode; drives chassis: fwd 10cm -> stop -> back 10cm")
        elif self.options.direction:
            self.log("BOOT", "telemetry + DIRECTION mode; executes web joystick steps on the real chassis")
        else:
            self.log("BOOT", "telemetry-only mode; no motor or ROS2 output (Linux/BlueZ port)")
        if self.move_client is not None:
            self.move_client.start()
        self.bus.add_signal_receiver(
            self._on_adapter_properties_changed,
            dbus_interface=DBUS_PROP_IFACE,
            signal_name="PropertiesChanged",
            path=ADAPTER_PATH,
        )
        # BlueZ on this NUC intermittently stops advertising after central
        # connect/disconnect attempts; bounce the advertisement periodically
        # so the peripheral is always discoverable again.
        GLib.timeout_add_seconds(30, self._ad_keepalive)
        self._sync_adapter_state()

    def _ad_keepalive(self):
        # 广告保持注册即可；unregister/re-register 会造成周期性不可见窗口。
        # 仅做幂等补注册：若 BlueZ 因故丢失广告则恢复；已注册时返回
        # Already Exists 错误，属预期，忽略。
        if not self.registered:
            return True
        try:
            self.ad_manager.RegisterAdvertisement(
                dbus.ObjectPath(AD_PATH),
                dbus.Dictionary({}, signature="sv"),
                reply_handler=lambda: self.log("BLE", "advertisement re-registered (keepalive recovery)"),
                error_handler=lambda exc: None,
            )
        except dbus.exceptions.DBusException:
            pass
        return True  # repeat

    def _sync_adapter_state(self):
        props = dbus.Interface(
            self.bus.get_object(BLUEZ_SERVICE_NAME, ADAPTER_PATH), DBUS_PROP_IFACE
        ).GetAll(ADAPTER_IFACE)
        powered = bool(props.get("Powered", False))
        if powered:
            self._on_adapter_powered_on()
        else:
            self.log("BLE", "adapter powered off")
            self.suspend_service()

    def _on_adapter_properties_changed(self, interface, changed, invalidated):
        if interface != ADAPTER_IFACE or "Powered" not in changed:
            return
        if bool(changed["Powered"]):
            self._on_adapter_powered_on()
        else:
            self.log("BLE", "adapter powered off")
            self.suspend_service()

    def _on_adapter_powered_on(self):
        self.log("BLE", "adapter powered on")
        self.register_service()

    def register_service(self):
        if self.registered:
            return
        try:
            self.gatt_manager.RegisterApplication(
                dbus.ObjectPath(APP_PATH),
                dbus.Dictionary({}, signature="sv"),
                reply_handler=self._on_application_registered,
                error_handler=self._on_register_error,
            )
        except dbus.exceptions.DBusException as exc:
            self._on_register_error(exc)

    def _on_application_registered(self):
        try:
            self.ad_manager.RegisterAdvertisement(
                dbus.ObjectPath(AD_PATH),
                dbus.Dictionary({}, signature="sv"),
                reply_handler=self._on_advertisement_registered,
                error_handler=self._on_register_error,
            )
        except dbus.exceptions.DBusException as exc:
            self._on_register_error(exc)

    def _on_advertisement_registered(self):
        self.registered = True
        self.log(
            "READY",
            "advertising {} with NUS service {}".format(self.options.name, SERVICE_UUID.lower()),
        )
        self.log("READY", "open https://gistudio.github.io/LubanNav/?mode=robot in Android Chrome")

    def _on_register_error(self, exc):
        message = exc.get_dbus_message() if isinstance(exc, dbus.exceptions.DBusException) else str(exc)
        name = exc.get_dbus_name() if isinstance(exc, dbus.exceptions.DBusException) else ""
        self.log("ERROR", "registration failed: {} ({})".format(message, name))
        self.loop.quit()

    def suspend_service(self):
        if self.registered:
            try:
                self.ad_manager.UnregisterAdvertisement(
                    dbus.ObjectPath(AD_PATH), reply_handler=lambda: None, error_handler=lambda e: None
                )
            except dbus.exceptions.DBusException:
                pass
            try:
                self.gatt_manager.UnregisterApplication(
                    dbus.ObjectPath(APP_PATH), reply_handler=lambda: None, error_handler=lambda e: None
                )
            except dbus.exceptions.DBusException:
                pass
            self.registered = False
        self.notifying = False
        self.pending_notifications = []
        self.stop_playback(reason="Bluetooth unavailable")

    def shutdown(self):
        self.suspend_service()
        if self.move_client is not None:
            self.move_client.close()

    # ── GATT callbacks ─────────────────────────────────────────────────────

    def _negotiated_mtu(self) -> int:
        try:
            objects = dbus.Interface(
                self.bus.get_object(BLUEZ_SERVICE_NAME, "/"), DBUS_OM_IFACE
            ).GetManagedObjects()
            fallback = None
            for path, ifaces in objects.items():
                device = ifaces.get(DEVICE_IFACE)
                if not device or not device.get("Connected"):
                    continue
                mtu = device.get("MTU")
                uuids = {str(uuid).upper() for uuid in device.get("UUIDs", [])}
                if mtu is not None:
                    value = int(mtu)
                    if SERVICE_UUID.upper() in uuids:
                        return value
                    fallback = value if fallback is None else min(fallback, value)
            if fallback is not None:
                return fallback
        except dbus.exceptions.DBusException as exc:
            self.log("ERROR", "could not read negotiated MTU: {}".format(exc.get_dbus_message()))
        return DEFAULT_CHUNK

    def on_subscribe(self):
        if not self.notifying:
            self.notifying = True
            self._mtu = self._negotiated_mtu()
            self.log("LINK", "phone subscribed to telemetry; mtu={}".format(self._mtu))
            self.send(status_message(None, "ready", message="car7 NUC BLE bridge"))

    def on_unsubscribe(self):
        if self.notifying:
            self.notifying = False
            self.log("LINK", "phone unsubscribed from telemetry")
            self.pending_notifications = []
            self.stop_playback(reason="BLE central disconnected")
        # 断开连接不主动 unregister 广告：BlueZ 在 GATT 应用保持注册期间
        # 会持续广播（unregister/re-register 反而制造不可见窗口）。
        # 罕见丢失由 _ad_keepalive 的幂等补注册兜底。

    def bounce_advertisement(self):
        if not self.registered:
            return

        def re_register():
            if not self.registered:
                return
            try:
                self.ad_manager.RegisterAdvertisement(
                    dbus.ObjectPath(AD_PATH),
                    dbus.Dictionary({}, signature="sv"),
                    reply_handler=lambda: self.log("BLE", "advertisement re-registered"),
                    error_handler=lambda exc: self.log("ERROR", "advertisement re-register failed: {}".format(exc)),
                )
            except dbus.exceptions.DBusException as exc:
                self.log("ERROR", "advertisement re-register failed: {}".format(exc))

        try:
            self.ad_manager.UnregisterAdvertisement(
                dbus.ObjectPath(AD_PATH),
                reply_handler=lambda *args: re_register(),
                error_handler=lambda exc: re_register(),
            )
        except dbus.exceptions.DBusException:
            re_register()

    # ── command receive path ───────────────────────────────────────────────

    def receive(self, chunk: bytes):
        try:
            frames = self.framer.append(chunk)
        except FramingError as exc:
            self.log("DROP", str(exc))
            return
        for frame in frames:
            try:
                self.handle(parse_command(frame))
            except (Car7CommandError, ValueError) as exc:
                # A leading LF intentionally discards an interrupted
                # navigation-task line before STOP.
                detail = exc.description() if isinstance(exc, Car7CommandError) else str(exc)
                self.log("DROP", "ignored invalid JSON line: {}".format(detail))

    def handle(self, command):
        if isinstance(command, NavigationStart):
            self.begin_streaming(command)
        elif isinstance(command, WaypointLine):
            self.append_waypoint(command)
        elif isinstance(command, NavigationEnd):
            self.finish_streaming(command)
        elif isinstance(command, NavigationTask):
            self.start_playback(command)
        elif isinstance(command, EmergencyStop):
            stopped_task_id = command.task_id
            if stopped_task_id is None and self.active_task is not None:
                stopped_task_id = self.active_task.task_id
            self.stop_playback(reason="emergency_stop {}".format(command.command_id))
            if self.move_client is not None:
                self.move_client.stop_now()  # executor stops the chassis immediately
                self.move_test_stopped = True
            self.send(acknowledgement(stopped_task_id, "stopped"))
            self.send(status_message(stopped_task_id, "stopped", message=command.reason))
        elif isinstance(command, DirectionCommand):
            self.handle_direction(command)

    def handle_direction(self, command: DirectionCommand):
        if self.move_client is None:
            self.log("TASK", "direction ignored: bridge started without --direction")
            self.send(acknowledgement(None, "rejected", message="direction control disabled"))
            return
        if command.direction == "stop":
            self.move_client.stop_now()
            self.log("TASK", "direction stop {}".format(command.command_id))
            self.send(acknowledgement(None, "accepted", message="stop sent"))
            return
        mapping = {
            "forward": ("FORWARD", command.amount_meters),
            "backward": ("BACKWARD", command.amount_meters),
            "left": ("LEFT", command.amount_degrees),
            "right": ("RIGHT", command.amount_degrees),
        }
        executor_command, amount = mapping[command.direction]
        self.log(
            "TASK",
            "direction {}: {} {} speed={} m/s".format(
                command.command_id,
                executor_command,
                amount,
                command.speed_meters_per_second if command.speed_meters_per_second is not None else "default",
            ),
        )
        self.move_client.submit(executor_command, amount, command.speed_meters_per_second)
        self.send(acknowledgement(None, "accepted", message=command.direction))

    # ── playback ───────────────────────────────────────────────────────────

    def start_playback(self, task: NavigationTask):
        """Legacy single-document `navigation_task`: all waypoints arrive in
        one line, so the task is complete from the start."""
        self.stop_playback(reason=None)
        self.active_task = task
        self.streaming = {
            "expected_count": len(task.route.waypoints),
            "completed": True,
        }
        self.next_waypoint_index = 0
        self.log(
            "TASK",
            "accepted {}: {} -> {}, {} waypoints".format(
                task.task_id, task.route.origin, task.route.destination, len(task.route.waypoints)
            ),
        )
        if self.move_client is not None:
            self.start_move_test(task)
            return
        self.export_campuscar_route(task)
        self.send(acknowledgement(task.task_id, "accepted"))
        self.send(status_message(task.task_id, "navigating"))
        self.send_next_waypoint()
        if self.active_task is not None:
            self.playback_source_id = GLib.timeout_add(self.options.step_ms, self._on_tick)

    # ── streaming route delivery (JSONL: navigation_start → waypoint* → navigation_end) ──

    def begin_streaming(self, start: NavigationStart):
        """Acknowledge the route header immediately and prepare the waypoint
        buffer. The robot must NOT wait for the whole document: every waypoint
        line is parsed and appended as it arrives."""
        self.stop_playback(reason=None)
        task = NavigationTask(
            task_id=start.task_id,
            created_at=start.created_at,
            dataset=start.dataset,
            route=NavigationRoute(
                origin=start.origin,
                destination=start.destination,
                mode=start.mode,
                coordinate_system=start.coordinate_system,
                distance_meters=start.distance_meters,
                duration_seconds=start.duration_seconds,
                waypoints=[],
            ),
        )
        self.active_task = task
        self.streaming = {"expected_count": start.waypoint_count, "completed": False}
        self.next_waypoint_index = 0
        self.log(
            "TASK",
            "streaming {}: {} -> {}, expecting {} waypoints".format(
                task.task_id, start.origin, start.destination, start.waypoint_count
            ),
        )
        self.send(
            acknowledgement(
                task.task_id,
                "accepted",
                message="streaming {} waypoints".format(start.waypoint_count),
            )
        )

    def append_waypoint(self, line: WaypointLine):
        """Append one streaming waypoint as it arrives and start telemetry
        playback as soon as the first waypoint is in hand."""
        if self.active_task is None or self.streaming is None:
            self.log("DROP", "waypoint without navigation_start")
            return
        task = self.active_task
        if line.task_id != task.task_id:
            self.log(
                "DROP",
                "waypoint taskId mismatch: got {} expected {}".format(
                    line.task_id, task.task_id
                ),
            )
            return
        if self.streaming["completed"]:
            self.log(
                "DROP",
                "waypoint after navigation_end: sequence {}".format(line.waypoint.sequence),
            )
            return
        waypoints = task.route.waypoints
        if line.waypoint.sequence != len(waypoints):
            self.log(
                "DROP",
                "waypoint sequence gap: expected {} got {}".format(
                    len(waypoints), line.waypoint.sequence
                ),
            )
            return
        waypoints.append(line.waypoint)
        if len(waypoints) == 1 and self.move_client is None:
            # First waypoint in hand: start navigating immediately.
            self.send(status_message(task.task_id, "navigating"))
            self.send_next_waypoint()
            if self.active_task is not None:
                self.playback_source_id = GLib.timeout_add(
                    self.options.step_ms, self._on_tick
                )
        if len(waypoints) >= self.streaming["expected_count"]:
            self.complete_streaming()

    def finish_streaming(self, end: NavigationEnd):
        if self.active_task is None or self.streaming is None:
            self.log("DROP", "navigation_end without navigation_start")
            return
        task = self.active_task
        if end.task_id != task.task_id:
            self.log(
                "DROP",
                "navigation_end taskId mismatch: got {} expected {}".format(
                    end.task_id, task.task_id
                ),
            )
            return
        received = len(task.route.waypoints)
        expected = self.streaming["expected_count"]
        if received != expected:
            self.log(
                "ERROR",
                "route incomplete {}: received {} / expected {} waypoints".format(
                    task.task_id, received, expected
                ),
            )
            self.send(status_message(task.task_id, "fault", message="incomplete route"))
            self.stop_playback(reason="incomplete route")
            return
        self.complete_streaming()

    def complete_streaming(self):
        """Mark the stream complete (idempotent) once every expected waypoint
        has arrived; export the route and start chassis tests only here."""
        if self.active_task is None or self.streaming is None or self.streaming["completed"]:
            return
        task = self.active_task
        received = len(task.route.waypoints)
        if received < self.streaming["expected_count"]:
            return  # still waiting for more waypoint lines
        self.streaming["completed"] = True
        self.log(
            "TASK",
            "route complete {}: {} waypoints".format(task.task_id, received),
        )
        self.export_campuscar_route(task)
        if self.move_client is not None:
            self.start_move_test(task)

    # ── move-test sequence (real chassis) ─────────────────────────────────

    MOVE_TEST_SEQUENCE = [
        ("FORWARD", MOVE_TEST_DISTANCE_METERS),
        ("STOP", None),
        ("BACKWARD", MOVE_TEST_DISTANCE_METERS),
        ("STOP", None),
    ]

    def start_move_test(self, task: NavigationTask):
        self.move_test_step = -1
        self.move_test_stopped = False
        self.send(acknowledgement(task.task_id, "accepted"))
        self.send(status_message(task.task_id, "navigating"))
        self.send_move_test_position(task)
        self.move_test_advance()

    def send_move_test_position(self, task: NavigationTask):
        waypoints = task.route.waypoints
        if waypoints:
            first = waypoints[0]
            self.send(
                position_message(
                    task.task_id,
                    first.longitude,
                    first.latitude,
                    0.0,
                    POSITION_ACCURACY_METERS,
                    iso8601_now(),
                )
            )

    def move_test_advance(self):
        if self.move_test_stopped:
            return
        self.move_test_step += 1
        if self.move_test_step >= len(self.MOVE_TEST_SEQUENCE):
            self.send_move_test_position(self.active_task)
            self.send(status_message(self.active_task.task_id, "arrived"))
            self.log("TASK", "arrived {} (move-test complete)".format(self.active_task.task_id))
            self.stop_playback(reason=None)
            return
        command, argument = self.MOVE_TEST_SEQUENCE[self.move_test_step]
        self.log("TASK", "move-test step {}/{}: {} {}".format(
            self.move_test_step + 1, len(self.MOVE_TEST_SEQUENCE), command, argument or ""))
        self.move_client.submit(command, argument)

    def on_move_reply(self, kind, detail):
        """Runs in the GLib mainloop thread (via idle_add)."""
        task = self.active_task
        if task is None:
            # Manual direction step (no active navigation task): log only.
            if kind not in ("OK",):
                self.log("TASK", "direction step done: {} {}".format(kind, detail or ""))
            return False
        if kind in ("DONE", "STOPPED", "OK"):
            if kind != "OK":
                self.log("TASK", "move step done: {} traveled={:.4f} m".format(kind, detail or 0.0))
            else:
                self.log("TASK", "move step done: STOP acknowledged")
            self.send_move_test_position(task)
            self.move_test_advance()
        elif kind in ("TIMEOUT", "ERR"):
            message = "move executor {} {}".format(kind, detail if detail else "")
            self.log("ERROR", message)
            self.move_client.submit("STOP", None)
            self.send(status_message(task.task_id, "fault", message=message))
            self.stop_playback(reason="move-test fault")
        return False

    def _on_tick(self):
        self.send_next_waypoint()
        return self.active_task is not None  # keep timer alive only while playing

    def send_next_waypoint(self):
        task = self.active_task
        if task is None:
            return
        waypoints = task.route.waypoints
        completed = bool(self.streaming and self.streaming["completed"])
        if self.next_waypoint_index >= len(waypoints):
            if not completed:
                # Streaming: the buffer is still growing; wait for the next
                # waypoint line instead of declaring arrival.
                return
            if self.options.loop:
                self.next_waypoint_index = 0
            else:
                self.send(status_message(task.task_id, "arrived"))
                self.log("TASK", "arrived {}".format(task.task_id))
                self.stop_playback(reason=None)
                return

        index = self.next_waypoint_index
        waypoint = waypoints[index]
        if len(waypoints) < 2:
            heading = None
        elif index + 1 < len(waypoints):
            heading = bearing_degrees(
                waypoint.latitude,
                waypoint.longitude,
                waypoints[index + 1].latitude,
                waypoints[index + 1].longitude,
            )
        else:
            heading = bearing_degrees(
                waypoints[index - 1].latitude,
                waypoints[index - 1].longitude,
                waypoint.latitude,
                waypoint.longitude,
            )
        self.send(
            position_message(
                task.task_id,
                waypoint.longitude,
                waypoint.latitude,
                heading,
                POSITION_ACCURACY_METERS,
                iso8601_now(),
            )
        )
        self.log(
            "POS",
            "{}/{} lat={} lon={}".format(
                index + 1, len(waypoints), waypoint.latitude, waypoint.longitude
            ),
        )
        self.next_waypoint_index += 1

        if self.next_waypoint_index >= len(waypoints) and completed and not self.options.loop:
            self.send(status_message(task.task_id, "arrived"))
            self.log("TASK", "arrived {}".format(task.task_id))
            self.stop_playback(reason=None)

    def stop_playback(self, reason: Optional[str]):
        if self.playback_source_id is not None:
            GLib.source_remove(self.playback_source_id)
            self.playback_source_id = None
        if reason and self.active_task is not None:
            self.log("TASK", "stopped: {}".format(reason))
        self.active_task = None
        self.streaming = None
        self.next_waypoint_index = 0

    # ── campusCar export ───────────────────────────────────────────────────

    def export_campuscar_route(self, task: NavigationTask):
        raw_path = self.options.campuscar_export
        if not raw_path:
            return
        path = os.path.abspath(os.path.expanduser(raw_path))
        directory = os.path.dirname(path)
        try:
            os.makedirs(directory, exist_ok=True)
            payload = encode_pretty(campuscar_waypoint_file(task))
            fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".lubannav-", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(payload)
                os.replace(tmp_path, path)  # atomic on POSIX
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            self.log("EXPORT", "campusCar waypoint file: {}".format(path))
        except OSError as exc:
            self.log("ERROR", "campusCar export failed: {}".format(exc))

    # ── telemetry send path ────────────────────────────────────────────────

    def send(self, message: dict):
        self.enqueue_notification(encode_line(message))

    def enqueue_notification(self, data: bytes):
        if not self.notifying:
            self.log("DROP", "telemetry dropped because no phone is subscribed")
            return
        chunk_size = max(DEFAULT_CHUNK, (self._mtu or DEFAULT_CHUNK) - 3)
        offset = 0
        while offset < len(data):
            end = min(offset + chunk_size, len(data))
            self.pending_notifications.append(data[offset:end])
            offset = end
        self.flush_notifications()

    def flush_notifications(self):
        while self.pending_notifications and self.notifying:
            chunk = self.pending_notifications.pop(0)
            self.service.telemetry_characteristic.notify_value(chunk)


def parse_options(argv):
    parser = argparse.ArgumentParser(
        prog="car7-ble-bridge",
        description="Linux/BlueZ port of the LubanNav car7 BLE simulator (telemetry-only).",
    )
    parser.add_argument("--name", default="car7", help="advertised BLE name (default: car7)")
    parser.add_argument(
        "--step-ms",
        type=int,
        default=750,
        help="delay between simulated waypoints (default: 750, range 100-60000)",
    )
    parser.add_argument("--loop", action="store_true", help="repeat the received route until STOP/disconnect")
    parser.add_argument(
        "--campuscar-export",
        default=None,
        help="write campusCar gps_navigator waypoint JSON on every accepted route",
    )
    parser.add_argument(
        "--move-test",
        action="store_true",
        help=(
            "DANGER: on each navigation_task, drive the real chassis through the fixed "
            "acceptance sequence: forward 10cm, immediate stop, backward 10cm (via the "
            "in-container move executor on 127.0.0.1). Default off (telemetry-only)."
        ),
    )
    parser.add_argument(
        "--direction",
        action="store_true",
        help=(
            "DANGER: execute manual direction commands (forward/backward/left/right/stop) "
            "from the web joystick pad on the real chassis via the move executor. Each "
            "command moves one fixed step. Default off (telemetry-only)."
        ),
    )
    parser.add_argument(
        "--executor-port",
        type=int,
        default=MOVE_EXECUTOR_PORT,
        help="move executor TCP port (default: 9099)",
    )
    options = parser.parse_args(argv)

    if not options.name or not options.name.strip():
        parser.error("--name cannot be empty")
    if not (100 <= options.step_ms <= 60000):
        parser.error("--step-ms must be between 100 and 60000")
    return options


def main(argv=None):
    options = parse_options(sys.argv[1:] if argv is None else argv)
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    loop = GLib.MainLoop()
    bridge = Car7BLEBridge(bus, options, loop)
    bridge.start()

    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.shutdown()


if __name__ == "__main__":
    main()
