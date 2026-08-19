import Foundation
import Testing
@testable import Car7Protocol

private let taskJSON = """
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_task","taskId":"task-test","createdAt":"2026-08-15T00:00:00Z","dataset":"test","route":{"from":"main-entrance","to":"library","mode":"robot","coordinateSystem":"WGS84 longitude/latitude","distanceMeters":10,"durationSeconds":20,"waypoints":[{"sequence":0,"nodeId":"a","longitude":113.477,"latitude":22.888},{"sequence":1,"nodeId":"b","longitude":113.478,"latitude":22.889}]}}
"""

@Test func framesFragmentedNavigationTask() throws {
    var framer = JSONLineFramer()
    let bytes = Data((taskJSON + "\n").utf8)
    #expect(try framer.append(bytes.prefix(17)).isEmpty)
    let frames = try framer.append(bytes.dropFirst(17))
    #expect(frames.count == 1)

    guard case .navigationTask(let task) = try Car7CommandParser.parse(frames[0]) else {
        Issue.record("expected navigation task")
        return
    }
    #expect(task.taskId == "task-test")
    #expect(task.route.waypoints.count == 2)
}

@Test func leadingDelimiterResynchronizesEmergencyStop() throws {
    var framer = JSONLineFramer()
    _ = try framer.append(Data("{\"partial\":".utf8))
    let stop = """
    {"protocol":"luban-nav-ble","protocolVersion":1,"type":"emergency_stop","commandId":"stop-test","taskId":"task-test","reason":"operator_request"}
    """
    let frames = try framer.append(Data(("\n" + stop + "\n").utf8))
    #expect(frames.count == 2)
    #expect(throws: (any Error).self) {
        try Car7CommandParser.parse(frames[0])
    }
    guard case .emergencyStop(let command) = try Car7CommandParser.parse(frames[1]) else {
        Issue.record("expected emergency stop")
        return
    }
    #expect(command.commandId == "stop-test")
}

@Test func emitsBrowserCompatibleTelemetryAndCampusCarRoute() throws {
    let task: NavigationTask
    guard case .navigationTask(let parsed) = try Car7CommandParser.parse(Data(taskJSON.utf8)) else {
        Issue.record("expected navigation task")
        return
    }
    task = parsed

    let line = try Car7JSONEncoder.line(Acknowledgement(taskId: task.taskId, status: "accepted"))
    #expect(line.last == 0x0A)
    let object = try JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any]
    #expect(object?["protocol"] as? String == "luban-nav-ble")
    #expect(object?["type"] as? String == "ack")

    let export = CampusCarWaypointFile(task: task)
    #expect(export.origin.lat == 22.888)
    #expect(export.waypoints[1].lon == 113.478)
    #expect(bearingDegrees(from: task.route.waypoints[0], to: task.route.waypoints[1]).isFinite)
}

@Test func rejectsPedestrianTasksAndInvalidCoordinates() throws {
    let pedestrian = taskJSON.replacingOccurrences(of: "\"mode\":\"robot\"", with: "\"mode\":\"pedestrian\"")
    #expect(throws: Car7CommandError.invalidMode("pedestrian")) {
        try Car7CommandParser.parse(Data(pedestrian.utf8))
    }

    let invalid = taskJSON.replacingOccurrences(of: "113.478", with: "213.478")
    #expect(throws: Car7CommandError.invalidWaypoint(sequence: 1)) {
        try Car7CommandParser.parse(Data(invalid.utf8))
    }
}

private let streamStartJSON = """
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_start","taskId":"task-stream","createdAt":"2026-08-17T00:00:00Z","dataset":"test","route":{"from":"main-entrance","to":"library","mode":"robot","coordinateSystem":"WGS84 longitude/latitude","distanceMeters":10,"durationSeconds":20,"waypointSpacingMeters":2.5,"waypointCount":2}}
"""

private let waypointLineJSON = """
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"waypoint","taskId":"task-stream","sequence":0,"nodeId":"a","longitude":113.477,"latitude":22.888,"kind":"entrance","indoor":false,"level":null,"interpolated":false,"distanceMeters":0}
"""

private let navEndJSON = """
{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_end","taskId":"task-stream","waypointCount":2}
"""

@Test func parsesStreamingHeaderWaypointsAndEndAsSeparateLines() throws {
    guard case .navigationStart(let start) = try Car7CommandParser.parse(Data(streamStartJSON.utf8)) else {
        Issue.record("expected navigation_start")
        return
    }
    #expect(start.taskId == "task-stream")
    #expect(start.route.from == "main-entrance")
    #expect(start.route.to == "library")
    #expect(start.route.mode == "robot")
    #expect(start.route.waypointSpacingMeters == 2.5)
    #expect(start.route.waypointCount == 2)

    guard case .streamWaypoint(let line) = try Car7CommandParser.parse(Data(waypointLineJSON.utf8)) else {
        Issue.record("expected waypoint line")
        return
    }
    #expect(line.taskId == "task-stream")
    #expect(line.waypoint.sequence == 0)
    #expect(line.waypoint.nodeId == "a")
    #expect(line.waypoint.kind == "entrance")
    #expect(line.waypoint.interpolated == false)
    #expect(line.waypoint.distanceMeters == 0)

    guard case .navigationEnd(let end) = try Car7CommandParser.parse(Data(navEndJSON.utf8)) else {
        Issue.record("expected navigation_end")
        return
    }
    #expect(end.taskId == "task-stream")
    #expect(end.waypointCount == 2)
}

@Test func streamLinesAreIndependentlyParseableWithoutBuffering() throws {
    var framer = JSONLineFramer()
    let payload = Data(([streamStartJSON, waypointLineJSON, navEndJSON].joined(separator: "\n") + "\n").utf8)
    let frames = try framer.append(payload)
    #expect(frames.count == 3)
    guard case .navigationStart = try Car7CommandParser.parse(frames[0]),
          case .streamWaypoint = try Car7CommandParser.parse(frames[1]),
          case .navigationEnd = try Car7CommandParser.parse(frames[2]) else {
        Issue.record("expected three independent stream commands")
        return
    }
}

@Test func rejectsBadStreamingLines() throws {
    #expect(throws: Car7CommandError.invalidWaypointCount(0)) {
        try Car7CommandParser.parse(Data(
            streamStartJSON.replacingOccurrences(of: "\"waypointCount\":2", with: "\"waypointCount\":0").utf8
        ))
    }
    #expect(throws: Car7CommandError.invalidWaypoint(sequence: 0)) {
        try Car7CommandParser.parse(Data(
            waypointLineJSON.replacingOccurrences(of: "113.477", with: "213.477").utf8
        ))
    }
    #expect(throws: Car7CommandError.invalidMode("pedestrian")) {
        try Car7CommandParser.parse(Data(
            streamStartJSON.replacingOccurrences(of: "\"mode\":\"robot\"", with: "\"mode\":\"pedestrian\"").utf8
        ))
    }
    #expect(throws: Car7CommandError.invalidWaypointCount(-1)) {
        try Car7CommandParser.parse(Data(
            navEndJSON.replacingOccurrences(of: "\"waypointCount\":2", with: "\"waypointCount\":-1").utf8
        ))
    }
}
