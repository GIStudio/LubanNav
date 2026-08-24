"""Port of Car7ProtocolTests.swift — run with: python3 -m unittest test_car7_protocol -v"""

import json
import math
import unittest

from car7_protocol import (
    Car7CommandError,
    FramingError,
    JSONLineFramer,
    NavigationEnd,
    NavigationStart,
    NavigationTask,
    WaypointLine,
    acknowledgement,
    bearing_degrees,
    campuscar_waypoint_file,
    encode_line,
    parse_command,
)

TASK_JSON = (
    '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_task",'
    '"taskId":"task-test","createdAt":"2026-08-15T00:00:00Z","dataset":"test",'
    '"route":{"from":"main-entrance","to":"library","mode":"robot",'
    '"coordinateSystem":"WGS84 longitude/latitude","distanceMeters":10,'
    '"durationSeconds":20,'
    '"waypoints":[{"sequence":0,"nodeId":"a","longitude":113.477,"latitude":22.888},'
    '{"sequence":1,"nodeId":"b","longitude":113.478,"latitude":22.889}]}}'
)

STREAM_START_JSON = (
    '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_start",'
    '"taskId":"task-stream","createdAt":"2026-08-17T00:00:00Z","dataset":"test",'
    '"route":{"from":"main-entrance","to":"library","mode":"robot",'
    '"coordinateSystem":"WGS84 longitude/latitude","distanceMeters":10,'
    '"durationSeconds":20,"waypointSpacingMeters":2.5,"waypointCount":2}}'
)

WAYPOINT_LINE_JSON = (
    '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"waypoint",'
    '"taskId":"task-stream","sequence":0,"nodeId":"a","longitude":113.477,'
    '"latitude":22.888,"kind":"entrance","indoor":false,"level":null,'
    '"interpolated":false,"distanceMeters":0}'
)

NAV_END_JSON = (
    '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"navigation_end",'
    '"taskId":"task-stream","waypointCount":2}'
)


class TestFramingAndParsing(unittest.TestCase):
    def test_frames_fragmented_navigation_task(self):
        framer = JSONLineFramer()
        data = (TASK_JSON + "\n").encode("utf-8")
        self.assertEqual(framer.append(data[:17]), [])
        frames = framer.append(data[17:])
        self.assertEqual(len(frames), 1)
        task = parse_command(frames[0])
        self.assertIsInstance(task, NavigationTask)
        self.assertEqual(task.task_id, "task-test")
        self.assertEqual(len(task.route.waypoints), 2)

    def test_leading_delimiter_resynchronizes_emergency_stop(self):
        framer = JSONLineFramer()
        self.assertEqual(framer.append(b'{"partial":'), [])
        stop = (
            '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"emergency_stop",'
            '"commandId":"stop-test","taskId":"task-test","reason":"operator_request"}'
        )
        frames = framer.append(("\n" + stop + "\n").encode("utf-8"))
        self.assertEqual(len(frames), 2)
        with self.assertRaises((Car7CommandError, ValueError)):
            parse_command(frames[0])
        command = parse_command(frames[1])
        self.assertEqual(command.command_id, "stop-test")


class TestEncodingAndExport(unittest.TestCase):
    def test_emits_browser_compatible_telemetry_and_campuscar_route(self):
        task = parse_command(TASK_JSON.encode("utf-8"))
        self.assertIsInstance(task, NavigationTask)

        line = encode_line(acknowledgement(task_id=task.task_id, status="accepted"))
        self.assertEqual(line[-1], 0x0A)
        obj = json.loads(line[:-1].decode("utf-8"))
        self.assertEqual(obj["protocol"], "luban-nav-ble")
        self.assertEqual(obj["type"], "ack")

        export = campuscar_waypoint_file(task)
        self.assertEqual(export["origin"]["lat"], 22.888)
        self.assertEqual(export["waypoints"][1]["lon"], 113.478)
        self.assertTrue(
            math.isfinite(
                bearing_degrees(
                    task.route.waypoints[0].latitude,
                    task.route.waypoints[0].longitude,
                    task.route.waypoints[1].latitude,
                    task.route.waypoints[1].longitude,
                )
            )
        )


class TestRejections(unittest.TestCase):
    def test_rejects_pedestrian_tasks_and_invalid_coordinates(self):
        pedestrian = TASK_JSON.replace('"mode":"robot"', '"mode":"pedestrian"')
        with self.assertRaises(Car7CommandError) as ctx:
            parse_command(pedestrian.encode("utf-8"))
        self.assertEqual(ctx.exception.kind, "invalidMode")

        invalid = TASK_JSON.replace("113.478", "213.478")
        with self.assertRaises(Car7CommandError) as ctx:
            parse_command(invalid.encode("utf-8"))
        self.assertEqual(ctx.exception.kind, "invalidWaypoint")
        self.assertEqual(ctx.exception.detail, 1)


class TestDirection(unittest.TestCase):
    def test_parses_stepped_direction_commands(self):
        forward = parse_command(
            ('{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
             '"commandId":"dir-1","direction":"forward","amountMeters":0.15,'
             '"amountDegrees":null,"createdAt":"2026-08-17T08:00:00Z"}').encode("utf-8")
        )
        self.assertEqual(forward.direction, "forward")
        self.assertEqual(forward.amount_meters, 0.15)
        self.assertIsNone(forward.amount_degrees)

        turn = parse_command(
            ('{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
             '"commandId":"dir-2","direction":"right","amountMeters":null,'
             '"amountDegrees":20}').encode("utf-8")
        )
        self.assertEqual(turn.direction, "right")
        self.assertEqual(turn.amount_degrees, 20.0)

        stop = parse_command(
            ('{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
             '"commandId":"dir-3","direction":"stop","amountMeters":null,'
             '"amountDegrees":null}').encode("utf-8")
        )
        self.assertEqual(stop.direction, "stop")

        fast = parse_command(
            ('{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
             '"commandId":"dir-6","direction":"forward","amountMeters":0.15,'
             '"amountDegrees":null,"speedMetersPerSecond":0.2}').encode("utf-8")
        )
        self.assertEqual(fast.speed_meters_per_second, 0.2)

    def test_rejects_invalid_direction_amounts(self):
        bad_direction = (
            '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
            '"commandId":"dir-4","direction":"forward","amountMeters":5}'
        )
        with self.assertRaises(ValueError):
            parse_command(bad_direction.encode("utf-8"))

        unknown = (
            '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
            '"commandId":"dir-5","direction":"diagonal"}'
        )
        with self.assertRaises(ValueError):
            parse_command(unknown.encode("utf-8"))

        fast_too_fast = (
            '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
            '"commandId":"dir-7","direction":"forward","amountMeters":0.15,'
            '"speedMetersPerSecond":9}'
        )
        with self.assertRaises(ValueError):
            parse_command(fast_too_fast.encode("utf-8"))

    def test_accepts_ros_derived_default_speed(self):
        # Web default is 2.0 m/s (half of the 4.0 m/s ROS max); the bridge
        # must accept it and clamp only beyond the ROS envelope.
        two_mps = (
            '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
            '"commandId":"dir-8","direction":"forward","amountMeters":0.15,'
            '"speedMetersPerSecond":2.0}'
        )
        command = parse_command(two_mps.encode("utf-8"))
        self.assertEqual(command.speed_meters_per_second, 2.0)

        envelope_max = (
            '{"protocol":"luban-nav-ble","protocolVersion":1,"type":"direction",'
            '"commandId":"dir-9","direction":"forward","amountMeters":0.15,'
            '"speedMetersPerSecond":4.0}'
        )
        self.assertEqual(
            parse_command(envelope_max.encode("utf-8")).speed_meters_per_second, 4.0
        )


class TestStreamingParsing(unittest.TestCase):
    def test_parses_streaming_header_waypoints_and_end_as_separate_lines(self):
        start = parse_command(STREAM_START_JSON.encode("utf-8"))
        self.assertIsInstance(start, NavigationStart)
        self.assertEqual(start.task_id, "task-stream")
        self.assertEqual(start.origin, "main-entrance")
        self.assertEqual(start.destination, "library")
        self.assertEqual(start.mode, "robot")
        self.assertEqual(start.waypoint_count, 2)
        self.assertEqual(start.waypoint_spacing_meters, 2.5)

        waypoint = parse_command(WAYPOINT_LINE_JSON.encode("utf-8"))
        self.assertIsInstance(waypoint, WaypointLine)
        self.assertEqual(waypoint.task_id, "task-stream")
        self.assertEqual(waypoint.waypoint.sequence, 0)
        self.assertEqual(waypoint.waypoint.node_id, "a")
        self.assertEqual(waypoint.waypoint.kind, "entrance")
        self.assertFalse(waypoint.waypoint.interpolated)
        self.assertEqual(waypoint.waypoint.distance_meters, 0.0)

        end = parse_command(NAV_END_JSON.encode("utf-8"))
        self.assertIsInstance(end, NavigationEnd)
        self.assertEqual(end.task_id, "task-stream")
        self.assertEqual(end.waypoint_count, 2)

    def test_stream_lines_are_independently_parseable_without_buffering(self):
        framer = JSONLineFramer()
        frames = framer.append(
            "\n".join([STREAM_START_JSON, WAYPOINT_LINE_JSON, NAV_END_JSON]).encode("utf-8")
            + b"\n"
        )
        self.assertEqual(len(frames), 3)
        self.assertIsInstance(parse_command(frames[0]), NavigationStart)
        self.assertIsInstance(parse_command(frames[1]), WaypointLine)
        self.assertIsInstance(parse_command(frames[2]), NavigationEnd)

    def test_rejects_bad_streaming_lines(self):
        with self.assertRaises(Car7CommandError) as ctx:
            parse_command(
                STREAM_START_JSON.replace('"waypointCount":2', '"waypointCount":0').encode("utf-8")
            )
        self.assertEqual(ctx.exception.kind, "invalidWaypointCount")

        with self.assertRaises(Car7CommandError) as ctx:
            parse_command(
                WAYPOINT_LINE_JSON.replace("113.477", "213.477").encode("utf-8")
            )
        self.assertEqual(ctx.exception.kind, "invalidWaypoint")

        with self.assertRaises(Car7CommandError) as ctx:
            parse_command(
                STREAM_START_JSON.replace('"mode":"robot"', '"mode":"pedestrian"').encode("utf-8")
            )
        self.assertEqual(ctx.exception.kind, "invalidMode")

        with self.assertRaises(Car7CommandError) as ctx:
            parse_command(NAV_END_JSON.replace('"waypointCount":2', '"waypointCount":-1').encode("utf-8"))
        self.assertEqual(ctx.exception.kind, "invalidWaypointCount")


class TestFramerLimit(unittest.TestCase):
    def test_buffer_limit_resets(self):
        framer = JSONLineFramer(maximum_buffer_bytes=16)
        with self.assertRaises(FramingError):
            framer.append(b"x" * 32)
        self.assertEqual(framer.buffer, bytearray())


if __name__ == "__main__":
    unittest.main()
