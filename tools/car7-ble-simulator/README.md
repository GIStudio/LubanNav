# car7 macOS BLE simulator

This Swift executable turns a Bluetooth-capable Mac into a `car7` BLE GATT peripheral for LubanNav phone testing. It implements the repository's Nordic UART Service-compatible UUIDs and UTF-8 JSON Lines framing.

It is deliberately telemetry-only: a received route is replayed as `position` notifications. The simulator never publishes ROS2 `/cmd_vel` and cannot move a vehicle.

## Run

From the LubanNav repository root:

```bash
npm run ble:simulator
```

Useful options can be passed after `--`:

```bash
npm run ble:simulator -- --step-ms 1000 --campuscar-export /tmp/lubannav-campuscar-route.json
```

The first launch may ask for Bluetooth access. If macOS denies access, enable Bluetooth for Terminal or Codex under **System Settings → Privacy & Security → Bluetooth**, then restart the process.

Run protocol tests with:

```bash
npm run ble:simulator:test
```

See [`../../docs/car7-local-ble-test.md`](../../docs/car7-local-ble-test.md) for the Android acceptance flow and the guarded campusCar handoff.
