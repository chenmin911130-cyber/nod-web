// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NodSplash",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "NodSplash",
            targets: ["NodSplashPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
    ],
    targets: [
        .target(
            name: "NodSplashPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/NodSplashPlugin"
        )
    ]
)
