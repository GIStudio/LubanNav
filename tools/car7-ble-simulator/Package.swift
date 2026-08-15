// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Car7BLESimulator",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "Car7Protocol", targets: ["Car7Protocol"]),
        .executable(name: "car7-ble-simulator", targets: ["Car7Simulator"]),
    ],
    targets: [
        .target(name: "Car7Protocol"),
        .executableTarget(
            name: "Car7Simulator",
            dependencies: ["Car7Protocol"],
            exclude: ["Info.plist"],
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/Car7Simulator/Info.plist",
                ]),
            ]
        ),
        .testTarget(name: "Car7ProtocolTests", dependencies: ["Car7Protocol"]),
    ],
    swiftLanguageModes: [.v5]
)
