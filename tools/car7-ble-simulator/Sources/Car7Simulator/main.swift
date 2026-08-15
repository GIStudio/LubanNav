import Car7Protocol
import CoreBluetooth
import Darwin
import Foundation

private struct SimulatorOptions {
    let name: String
    let stepMilliseconds: Int
    let loopRoute: Bool
    let campusCarExportPath: String?

    static func parse(_ arguments: [String]) throws -> SimulatorOptions {
        var name = "car7"
        var stepMilliseconds = 750
        var loopRoute = false
        var campusCarExportPath: String?
        var index = 0

        while index < arguments.count {
            switch arguments[index] {
            case "--name":
                index += 1
                guard index < arguments.count else { throw OptionError.missingValue("--name") }
                name = arguments[index]
            case "--step-ms":
                index += 1
                guard index < arguments.count,
                      let value = Int(arguments[index]),
                      (100 ... 60_000).contains(value) else {
                    throw OptionError.invalidValue("--step-ms must be between 100 and 60000")
                }
                stepMilliseconds = value
            case "--loop":
                loopRoute = true
            case "--campuscar-export":
                index += 1
                guard index < arguments.count else {
                    throw OptionError.missingValue("--campuscar-export")
                }
                campusCarExportPath = arguments[index]
            case "--help", "-h":
                printUsage()
                exit(EXIT_SUCCESS)
            default:
                throw OptionError.invalidValue("unknown option: \(arguments[index])")
            }
            index += 1
        }

        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw OptionError.invalidValue("--name cannot be empty")
        }
        return SimulatorOptions(
            name: name,
            stepMilliseconds: stepMilliseconds,
            loopRoute: loopRoute,
            campusCarExportPath: campusCarExportPath
        )
    }

    enum OptionError: Error, LocalizedError {
        case missingValue(String)
        case invalidValue(String)

        var errorDescription: String? {
            switch self {
            case .missingValue(let option): "missing value for \(option)"
            case .invalidValue(let message): message
            }
        }
    }
}

private func printUsage() {
    print("""
    car7-ble-simulator [options]

      --name NAME                advertised BLE name (default: car7)
      --step-ms MILLISECONDS     delay between simulated waypoints (default: 750)
      --loop                     repeat the received route until STOP/disconnect
      --campuscar-export PATH    write campusCar gps_navigator waypoint JSON
      -h, --help                 show this help

    This process simulates telemetry only. It never publishes ROS2 /cmd_vel or drives motors.
    """)
}

private final class Car7PeripheralSimulator: NSObject, CBPeripheralManagerDelegate {
    private let options: SimulatorOptions
    private var manager: CBPeripheralManager!
    private var commandCharacteristic: CBMutableCharacteristic?
    private var telemetryCharacteristic: CBMutableCharacteristic?
    private var didRegisterService = false
    private var framer = JSONLineFramer()
    private var subscribers = Set<UUID>()
    private var subscriberMTUs: [UUID: Int] = [:]
    private var pendingNotifications: [Data] = []
    private var activeTask: NavigationTask?
    private var nextWaypointIndex = 0
    private var playbackTimer: Timer?
    private let timestampFormatter = ISO8601DateFormatter()

    init(options: SimulatorOptions) {
        self.options = options
        timestampFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        super.init()
    }

    func start() {
        log("BOOT", "telemetry-only mode; no motor or ROS2 output")
        manager = CBPeripheralManager(
            delegate: self,
            queue: DispatchQueue.main,
            options: [CBPeripheralManagerOptionShowPowerAlertKey: true]
        )
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            log("BLE", "adapter powered on")
            registerServiceIfNeeded()
        case .poweredOff:
            log("BLE", "adapter powered off")
            suspendService()
        case .unauthorized:
            log("ERROR", "Bluetooth permission denied; enable it for Terminal/Codex in System Settings > Privacy & Security > Bluetooth")
        case .unsupported:
            log("ERROR", "this Mac does not support CoreBluetooth peripheral mode")
        case .resetting:
            log("BLE", "adapter resetting")
            suspendService()
        case .unknown:
            log("BLE", "adapter state unknown")
        @unknown default:
            log("ERROR", "unrecognized Bluetooth adapter state")
        }
    }

    private func registerServiceIfNeeded() {
        guard !didRegisterService else { return }
        let command = CBMutableCharacteristic(
            type: CBUUID(string: Car7ProtocolConstants.commandUUID),
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        let telemetry = CBMutableCharacteristic(
            type: CBUUID(string: Car7ProtocolConstants.telemetryUUID),
            properties: [.notify],
            value: nil,
            permissions: []
        )
        let service = CBMutableService(
            type: CBUUID(string: Car7ProtocolConstants.serviceUUID),
            primary: true
        )
        service.characteristics = [command, telemetry]
        commandCharacteristic = command
        telemetryCharacteristic = telemetry
        didRegisterService = true
        manager.add(service)
    }

    private func suspendService() {
        manager?.stopAdvertising()
        manager?.removeAllServices()
        didRegisterService = false
        subscribers.removeAll()
        subscriberMTUs.removeAll()
        pendingNotifications.removeAll()
        stopPlayback(reason: "Bluetooth unavailable")
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didAdd service: CBService,
        error: Error?
    ) {
        if let error {
            didRegisterService = false
            log("ERROR", "could not add GATT service: \(error.localizedDescription)")
            return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataLocalNameKey: options.name,
            CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: Car7ProtocolConstants.serviceUUID)],
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            log("ERROR", "advertising failed: \(error.localizedDescription)")
            return
        }
        log("READY", "advertising \(options.name) with NUS service \(Car7ProtocolConstants.serviceUUID.lowercased())")
        log("READY", "open https://gistudio.github.io/LubanNav/?mode=robot in Android Chrome")
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didSubscribeTo characteristic: CBCharacteristic
    ) {
        guard characteristic.uuid == CBUUID(string: Car7ProtocolConstants.telemetryUUID) else { return }
        subscribers.insert(central.identifier)
        subscriberMTUs[central.identifier] = central.maximumUpdateValueLength
        log("LINK", "phone subscribed to telemetry; mtu=\(central.maximumUpdateValueLength)")
        send(StatusMessage(taskId: nil, status: "ready", message: "car7 macOS simulator"))
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didUnsubscribeFrom characteristic: CBCharacteristic
    ) {
        subscribers.remove(central.identifier)
        subscriberMTUs.removeValue(forKey: central.identifier)
        log("LINK", "phone unsubscribed from telemetry")
        if subscribers.isEmpty {
            pendingNotifications.removeAll()
            stopPlayback(reason: "BLE central disconnected")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            guard request.characteristic.uuid == CBUUID(string: Car7ProtocolConstants.commandUUID) else {
                peripheral.respond(to: request, withResult: .requestNotSupported)
                continue
            }
            guard let value = request.value else {
                peripheral.respond(to: request, withResult: .invalidAttributeValueLength)
                continue
            }
            peripheral.respond(to: request, withResult: .success)
            receive(value)
        }
    }

    private func receive(_ chunk: Data) {
        do {
            for frame in try framer.append(chunk) {
                do {
                    handle(try Car7CommandParser.parse(frame))
                } catch {
                    // A leading LF intentionally discards an interrupted navigation-task line before STOP.
                    log("DROP", "ignored invalid JSON line: \(error.localizedDescription)")
                }
            }
        } catch {
            log("DROP", error.localizedDescription)
        }
    }

    private func handle(_ command: Car7Command) {
        switch command {
        case .navigationTask(let task):
            startPlayback(task)
        case .emergencyStop(let stop):
            let stoppedTaskId = stop.taskId ?? activeTask?.taskId
            stopPlayback(reason: "emergency_stop \(stop.commandId)")
            send(Acknowledgement(taskId: stoppedTaskId, status: "stopped"))
            send(StatusMessage(taskId: stoppedTaskId, status: "stopped", message: stop.reason))
        }
    }

    private func startPlayback(_ task: NavigationTask) {
        stopPlayback(reason: nil)
        activeTask = task
        nextWaypointIndex = 0
        log(
            "TASK",
            "accepted \(task.taskId): \(task.route.from) -> \(task.route.to), \(task.route.waypoints.count) waypoints"
        )
        exportCampusCarRoute(task)
        send(Acknowledgement(taskId: task.taskId, status: "accepted"))
        send(StatusMessage(taskId: task.taskId, status: "navigating"))
        sendNextWaypoint()
        if activeTask != nil {
            playbackTimer = Timer.scheduledTimer(
                withTimeInterval: Double(options.stepMilliseconds) / 1_000,
                repeats: true
            ) { [weak self] _ in
                self?.sendNextWaypoint()
            }
        }
    }

    private func sendNextWaypoint() {
        guard let task = activeTask else { return }
        let waypoints = task.route.waypoints
        if nextWaypointIndex >= waypoints.count {
            if options.loopRoute {
                nextWaypointIndex = 0
            } else {
                send(StatusMessage(taskId: task.taskId, status: "arrived"))
                log("TASK", "arrived \(task.taskId)")
                stopPlayback(reason: nil)
                return
            }
        }

        let index = nextWaypointIndex
        let waypoint = waypoints[index]
        let heading: Double?
        if waypoints.count < 2 {
            heading = nil
        } else if index + 1 < waypoints.count {
            heading = bearingDegrees(from: waypoint, to: waypoints[index + 1])
        } else {
            heading = bearingDegrees(from: waypoints[index - 1], to: waypoint)
        }
        send(PositionMessage(
            taskId: task.taskId,
            longitude: waypoint.longitude,
            latitude: waypoint.latitude,
            headingDegrees: heading,
            accuracyMeters: 1.5,
            timestamp: timestampFormatter.string(from: Date())
        ))
        log("POS", "\(index + 1)/\(waypoints.count) lat=\(waypoint.latitude) lon=\(waypoint.longitude)")
        nextWaypointIndex += 1

        if nextWaypointIndex >= waypoints.count, !options.loopRoute {
            send(StatusMessage(taskId: task.taskId, status: "arrived"))
            log("TASK", "arrived \(task.taskId)")
            stopPlayback(reason: nil)
        }
    }

    private func stopPlayback(reason: String?) {
        playbackTimer?.invalidate()
        playbackTimer = nil
        if let reason, activeTask != nil {
            log("TASK", "stopped: \(reason)")
        }
        activeTask = nil
        nextWaypointIndex = 0
    }

    private func exportCampusCarRoute(_ task: NavigationTask) {
        guard let rawPath = options.campusCarExportPath else { return }
        do {
            let url = URL(fileURLWithPath: rawPath).standardizedFileURL
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try Car7JSONEncoder.pretty(CampusCarWaypointFile(task: task))
                .write(to: url, options: .atomic)
            log("EXPORT", "campusCar waypoint file: \(url.path)")
        } catch {
            log("ERROR", "campusCar export failed: \(error.localizedDescription)")
        }
    }

    private func send<T: Encodable>(_ message: T) {
        do {
            enqueueNotification(try Car7JSONEncoder.line(message))
        } catch {
            log("ERROR", "could not encode telemetry: \(error.localizedDescription)")
        }
    }

    private func enqueueNotification(_ data: Data) {
        guard !subscribers.isEmpty else {
            log("DROP", "telemetry dropped because no phone is subscribed")
            return
        }
        let chunkSize = max(20, subscriberMTUs.values.min() ?? 20)
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunkSize, data.count)
            pendingNotifications.append(Data(data[offset ..< end]))
            offset = end
        }
        flushNotifications()
    }

    private func flushNotifications() {
        guard let telemetryCharacteristic else { return }
        while let chunk = pendingNotifications.first {
            guard manager.updateValue(
                chunk,
                for: telemetryCharacteristic,
                onSubscribedCentrals: nil
            ) else { return }
            pendingNotifications.removeFirst()
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        flushNotifications()
    }

    private func log(_ category: String, _ message: String) {
        print("[\(category)] \(message)")
        fflush(stdout)
    }
}

do {
    let options = try SimulatorOptions.parse(Array(CommandLine.arguments.dropFirst()))
    let simulator = Car7PeripheralSimulator(options: options)
    simulator.start()
    RunLoop.main.run()
} catch {
    fputs("car7-ble-simulator: \(error.localizedDescription)\n", stderr)
    printUsage()
    exit(EXIT_FAILURE)
}
