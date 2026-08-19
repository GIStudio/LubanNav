import Foundation

public enum Car7ProtocolConstants {
    public static let protocolName = "luban-nav-ble"
    public static let protocolVersion = 1
    public static let serviceUUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
    public static let commandUUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
    public static let telemetryUUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
}

public enum Car7Command: Equatable {
    case navigationTask(NavigationTask)
    case emergencyStop(EmergencyStop)
    case navigationStart(NavigationStart)
    case streamWaypoint(StreamWaypoint)
    case navigationEnd(NavigationEnd)

    public var taskId: String? {
        switch self {
        case .navigationTask(let task): task.taskId
        case .emergencyStop(let command): command.taskId
        case .navigationStart(let start): start.taskId
        case .streamWaypoint(let line): line.taskId
        case .navigationEnd(let end): end.taskId
        }
    }
}

public struct NavigationTask: Decodable, Equatable {
    public let protocolName: String
    public let protocolVersion: Int
    public let type: String
    public let taskId: String
    public let createdAt: String?
    public let dataset: String?
    public let route: NavigationRoute

    public init(
        protocolName: String,
        protocolVersion: Int,
        type: String,
        taskId: String,
        createdAt: String?,
        dataset: String?,
        route: NavigationRoute
    ) {
        self.protocolName = protocolName
        self.protocolVersion = protocolVersion
        self.type = type
        self.taskId = taskId
        self.createdAt = createdAt
        self.dataset = dataset
        self.route = route
    }

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId, createdAt, dataset, route
    }
}

public struct NavigationRoute: Decodable, Equatable {
    public let from: String
    public let to: String
    public let mode: String
    public let coordinateSystem: String?
    public let distanceMeters: Double?
    public let durationSeconds: Double?
    public let waypoints: [NavigationWaypoint]

    public init(
        from: String,
        to: String,
        mode: String,
        coordinateSystem: String?,
        distanceMeters: Double?,
        durationSeconds: Double?,
        waypoints: [NavigationWaypoint]
    ) {
        self.from = from
        self.to = to
        self.mode = mode
        self.coordinateSystem = coordinateSystem
        self.distanceMeters = distanceMeters
        self.durationSeconds = durationSeconds
        self.waypoints = waypoints
    }
}

public struct NavigationWaypoint: Decodable, Equatable {
    public let sequence: Int
    public let nodeId: String?
    public let longitude: Double
    public let latitude: Double
    public let kind: String?
    public let indoor: Bool?
    public let level: String?
    public let interpolated: Bool?
    public let distanceMeters: Double?

    public init(
        sequence: Int,
        nodeId: String?,
        longitude: Double,
        latitude: Double,
        kind: String? = nil,
        indoor: Bool? = nil,
        level: String? = nil,
        interpolated: Bool? = nil,
        distanceMeters: Double? = nil
    ) {
        self.sequence = sequence
        self.nodeId = nodeId
        self.longitude = longitude
        self.latitude = latitude
        self.kind = kind
        self.indoor = indoor
        self.level = level
        self.interpolated = interpolated
        self.distanceMeters = distanceMeters
    }
}

/// `navigation_start` — header line of the streaming JSONL route delivery.
public struct NavigationStart: Decodable, Equatable {
    public let protocolName: String
    public let protocolVersion: Int
    public let type: String
    public let taskId: String
    public let createdAt: String?
    public let dataset: String?
    public let route: NavigationStartRoute

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId, createdAt, dataset, route
    }
}

public struct NavigationStartRoute: Decodable, Equatable {
    public let from: String
    public let to: String
    public let mode: String
    public let coordinateSystem: String?
    public let distanceMeters: Double?
    public let durationSeconds: Double?
    public let waypointSpacingMeters: Double?
    public let waypointCount: Int
}

/// `waypoint` — one dense route waypoint, delivered as its own JSON line.
public struct StreamWaypoint: Decodable, Equatable {
    public let protocolName: String
    public let protocolVersion: Int
    public let type: String
    public let taskId: String
    public let waypoint: NavigationWaypoint

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        protocolName = try container.decode(String.self, forKey: .protocolName)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        type = try container.decode(String.self, forKey: .type)
        taskId = try container.decode(String.self, forKey: .taskId)
        waypoint = try NavigationWaypoint(from: decoder)
    }
}

/// `navigation_end` — closes a streaming route; validates waypointCount.
public struct NavigationEnd: Decodable, Equatable {
    public let protocolName: String
    public let protocolVersion: Int
    public let type: String
    public let taskId: String
    public let waypointCount: Int

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId, waypointCount
    }
}

public struct EmergencyStop: Decodable, Equatable {
    public let protocolName: String
    public let protocolVersion: Int
    public let type: String
    public let commandId: String
    public let taskId: String?
    public let createdAt: String?
    public let reason: String?

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, commandId, taskId, createdAt, reason
    }
}

private struct CommandEnvelope: Decodable {
    let protocolName: String
    let protocolVersion: Int
    let type: String

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type
    }
}

public enum Car7CommandError: Error, LocalizedError, Equatable {
    case invalidProtocol(String)
    case invalidVersion(Int)
    case unsupportedType(String)
    case emptyRoute
    case invalidMode(String)
    case invalidWaypoint(sequence: Int)
    case invalidWaypointCount(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidProtocol(let name):
            "unsupported protocol \(name)"
        case .invalidVersion(let version):
            "unsupported protocol version \(version)"
        case .unsupportedType(let type):
            "unsupported command type \(type)"
        case .emptyRoute:
            "navigation route contains no waypoints"
        case .invalidMode(let mode):
            "navigation route mode must be robot, got \(mode)"
        case .invalidWaypoint(let sequence):
            "waypoint \(sequence) is outside WGS84 bounds or is not finite"
        case .invalidWaypointCount(let count):
            "navigation waypoint count must be a positive integer, got \(count)"
        }
    }
}

public enum Car7CommandParser {
    private static func validate(_ waypoints: [NavigationWaypoint]) throws {
        for waypoint in waypoints {
            guard waypoint.longitude.isFinite,
                  waypoint.latitude.isFinite,
                  (-180.0 ... 180.0).contains(waypoint.longitude),
                  (-90.0 ... 90.0).contains(waypoint.latitude) else {
                throw Car7CommandError.invalidWaypoint(sequence: waypoint.sequence)
            }
        }
    }

    public static func parse(_ data: Data) throws -> Car7Command {
        let decoder = JSONDecoder()
        let envelope = try decoder.decode(CommandEnvelope.self, from: data)
        guard envelope.protocolName == Car7ProtocolConstants.protocolName else {
            throw Car7CommandError.invalidProtocol(envelope.protocolName)
        }
        guard envelope.protocolVersion == Car7ProtocolConstants.protocolVersion else {
            throw Car7CommandError.invalidVersion(envelope.protocolVersion)
        }

        switch envelope.type {
        case "navigation_task":
            let task = try decoder.decode(NavigationTask.self, from: data)
            guard task.route.mode == "robot" else {
                throw Car7CommandError.invalidMode(task.route.mode)
            }
            guard !task.route.waypoints.isEmpty else {
                throw Car7CommandError.emptyRoute
            }
            try validate(task.route.waypoints)
            return .navigationTask(task)
        case "navigation_start":
            let start = try decoder.decode(NavigationStart.self, from: data)
            guard start.route.mode == "robot" else {
                throw Car7CommandError.invalidMode(start.route.mode)
            }
            guard start.route.waypointCount > 0 else {
                throw Car7CommandError.invalidWaypointCount(start.route.waypointCount)
            }
            return .navigationStart(start)
        case "waypoint":
            let line = try decoder.decode(StreamWaypoint.self, from: data)
            try validate([line.waypoint])
            return .streamWaypoint(line)
        case "navigation_end":
            let end = try decoder.decode(NavigationEnd.self, from: data)
            guard end.waypointCount > 0 else {
                throw Car7CommandError.invalidWaypointCount(end.waypointCount)
            }
            return .navigationEnd(end)
        case "emergency_stop":
            return .emergencyStop(try decoder.decode(EmergencyStop.self, from: data))
        default:
            throw Car7CommandError.unsupportedType(envelope.type)
        }
    }
}

public struct JSONLineFramer {
    private var buffer = Data()
    private let maximumBufferBytes: Int

    public init(maximumBufferBytes: Int = 1_048_576) {
        self.maximumBufferBytes = maximumBufferBytes
    }

    public mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        guard buffer.count <= maximumBufferBytes else {
            buffer.removeAll(keepingCapacity: false)
            throw FramingError.bufferLimitExceeded(maximumBufferBytes)
        }

        var frames: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(buffer.startIndex ... newline)
            let text = String(decoding: line, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                frames.append(Data(text.utf8))
            }
        }
        return frames
    }

    public mutating func reset() {
        buffer.removeAll(keepingCapacity: false)
    }

    public enum FramingError: Error, LocalizedError {
        case bufferLimitExceeded(Int)

        public var errorDescription: String? {
            switch self {
            case .bufferLimitExceeded(let bytes):
                "command buffer exceeded \(bytes) bytes and was reset"
            }
        }
    }
}

public struct Acknowledgement: Encodable, Equatable {
    public let protocolName = Car7ProtocolConstants.protocolName
    public let protocolVersion = Car7ProtocolConstants.protocolVersion
    public let type = "ack"
    public let taskId: String?
    public let status: String
    public let message: String?

    public init(taskId: String?, status: String, message: String? = nil) {
        self.taskId = taskId
        self.status = status
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId, status, message
    }
}

public struct StatusMessage: Encodable, Equatable {
    public let protocolName = Car7ProtocolConstants.protocolName
    public let protocolVersion = Car7ProtocolConstants.protocolVersion
    public let type = "status"
    public let taskId: String?
    public let status: String
    public let message: String?

    public init(taskId: String?, status: String, message: String? = nil) {
        self.taskId = taskId
        self.status = status
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId, status, message
    }
}

public struct PositionMessage: Encodable, Equatable {
    public let protocolName = Car7ProtocolConstants.protocolName
    public let protocolVersion = Car7ProtocolConstants.protocolVersion
    public let type = "position"
    public let taskId: String
    public let longitude: Double
    public let latitude: Double
    public let headingDegrees: Double?
    public let accuracyMeters: Double
    public let timestamp: String

    public init(
        taskId: String,
        longitude: Double,
        latitude: Double,
        headingDegrees: Double?,
        accuracyMeters: Double,
        timestamp: String
    ) {
        self.taskId = taskId
        self.longitude = longitude
        self.latitude = latitude
        self.headingDegrees = headingDegrees
        self.accuracyMeters = accuracyMeters
        self.timestamp = timestamp
    }

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case protocolVersion, type, taskId, longitude, latitude
        case headingDegrees, accuracyMeters, timestamp
    }
}

public enum Car7JSONEncoder {
    public static func line<T: Encodable>(_ message: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(message)
        data.append(0x0A)
        return data
    }

    public static func pretty<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
}

public struct CampusCarWaypointFile: Encodable, Equatable {
    public struct Coordinate: Encodable, Equatable {
        public let lat: Double
        public let lon: Double
        public let alt: Double
    }

    public let origin: Coordinate
    public let waypoints: [Coordinate]

    public init(task: NavigationTask) {
        waypoints = task.route.waypoints.map {
            Coordinate(lat: $0.latitude, lon: $0.longitude, alt: 0)
        }
        origin = waypoints[0]
    }
}

public func bearingDegrees(from: NavigationWaypoint, to: NavigationWaypoint) -> Double {
    let latitude1 = from.latitude * .pi / 180
    let latitude2 = to.latitude * .pi / 180
    let longitudeDelta = (to.longitude - from.longitude) * .pi / 180
    let y = sin(longitudeDelta) * cos(latitude2)
    let x = cos(latitude1) * sin(latitude2)
        - sin(latitude1) * cos(latitude2) * cos(longitudeDelta)
    let degrees = atan2(y, x) * 180 / .pi
    return degrees >= 0 ? degrees : degrees + 360
}
