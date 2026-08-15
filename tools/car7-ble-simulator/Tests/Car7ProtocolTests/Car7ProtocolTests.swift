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
