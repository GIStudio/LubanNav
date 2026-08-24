#!/usr/bin/env python3
"""BlueZ pairing agent for car7.

Registers org.bluez.Agent1 as the default agent and enables pairable mode,
so OS-level pairing from phones/tablets succeeds:
  - LE Just Works: confirmations are auto-accepted (no PIN needed)
  - Legacy PIN / passkey entry: answers with the fixed --pin (default 123456)

Note: Web Bluetooth GATT connections to the NUS bridge never need pairing at
all; this agent only unblocks people who pair from the OS Bluetooth page.

Usage: python3 ble_pairing_agent.py [--pin 123456]
"""

import argparse

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "org.bluez"
AGENT_INTERFACE = "org.bluez.Agent1"
AGENT_PATH = "/org/lubannav/car7/agent"
ADAPTER_PATH = "/org/bluez/hci0"
ADAPTER_INTERFACE = "org.bluez.Adapter1"


class PairingAgent(dbus.service.Object):
    def __init__(self, bus, pin):
        self.pin = pin
        dbus.service.Object.__init__(self, bus, AGENT_PATH)

    @dbus.service.method(AGENT_INTERFACE, in_signature="", out_signature="")
    def Release(self):
        print("[AGENT] released", flush=True)

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        print("[AGENT] legacy PIN requested by {} -> {}".format(device, self.pin), flush=True)
        return self.pin

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        print("[AGENT] passkey requested by {} -> {}".format(device, self.pin), flush=True)
        return dbus.UInt32(int(self.pin))

    @dbus.service.method(AGENT_INTERFACE, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        print("[AGENT] display passkey {} {} entered={}".format(device, passkey, entered), flush=True)

    @dbus.service.method(AGENT_INTERFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        print("[AGENT] auto-accepting confirmation {} {}".format(device, passkey), flush=True)

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        print("[AGENT] authorizing {}".format(device), flush=True)

    @dbus.service.method(AGENT_INTERFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        print("[AGENT] authorize service {} {}".format(device, uuid), flush=True)

    @dbus.service.method(AGENT_INTERFACE, in_signature="", out_signature="")
    def Cancel(self):
        print("[AGENT] cancelled", flush=True)


def main():
    parser = argparse.ArgumentParser(description="car7 BlueZ pairing agent with fixed PIN")
    parser.add_argument("--pin", default="123456", help="fixed PIN/passkey (default 123456)")
    args = parser.parse_args()

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    agent = PairingAgent(bus, args.pin)

    manager = dbus.Interface(
        bus.get_object(BUS_NAME, "/org/bluez"), "org.bluez.AgentManager1"
    )
    manager.RegisterAgent(
        dbus.ObjectPath(AGENT_PATH), dbus.String("KeyboardDisplay")
    )
    manager.RequestDefaultAgent(dbus.ObjectPath(AGENT_PATH))
    print("[AGENT] registered default agent, pin={}".format(args.pin), flush=True)

    adapter = dbus.Interface(
        bus.get_object(BUS_NAME, ADAPTER_PATH), "org.freedesktop.DBus.Properties"
    )
    adapter.Set(ADAPTER_INTERFACE, "Pairable", dbus.Boolean(True))
    print("[AGENT] adapter pairable=on", flush=True)

    loop = GLib.MainLoop()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            manager.UnregisterAgent(dbus.ObjectPath(AGENT_PATH))
        except dbus.exceptions.DBusException:
            pass


if __name__ == "__main__":
    main()
