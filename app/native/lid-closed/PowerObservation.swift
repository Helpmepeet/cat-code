import Foundation
import IOKit
import CoreGraphics
import Darwin

// Unprivileged observation only. This path never creates assertions or calls the
// lid-mode controller, pmset, brightness APIs, or display power controls.
func powerInternalDisplay() -> String {
    var count: UInt32 = 0
    if CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0, count <= 32 {
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        if CGGetOnlineDisplayList(count, &displays, &count) == .success {
            let internalDisplays = displays.prefix(Int(count)).filter { CGDisplayIsBuiltin($0) != 0 }
            if !internalDisplays.isEmpty {
                return internalDisplays.contains { CGDisplayIsAsleep($0) == 0 } ? "software-awake" : "software-asleep"
            }
        }
    }
    return "unknown"
}
func powerObservation(lidClosed closed: Bool?, notifications: Bool, readDisplay: () -> String = powerInternalDisplay) -> [String: Any] {
    let lid = closed.map { $0 ? "closed" : "open" } ?? "unknown"
    var display = closed == true ? "unknown" : "not-observed"
    if closed == true {
        // CoreGraphics reports WindowServer's logical state, not measured panel
        // or backlight power. Never infer physical safety from this value.
        display = readDisplay()
    }
    let thermal: String
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: thermal = "nominal"
    case .fair: thermal = "fair"
    case .serious: thermal = "serious"
    case .critical: thermal = "critical"
    @unknown default: thermal = "unknown"
    }
    return ["version": 1, "lid": lid, "display": display, "thermal": thermal,
        "lidNotifications": notifications, "physicalBacklight": "unavailable",
        "surfaceTemperature": "unavailable"]
}

final class PowerObserver {
    let root: io_registry_entry_t
    var port: IONotificationPortRef?
    var notification: io_object_t = 0
    var thermal: NSObjectProtocol?
    var displayRegistered = false
    var last = Data()
    var lastPulse = ProcessInfo.processInfo.systemUptime

    init() {
        root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    }
    deinit {
        if displayRegistered { CGDisplayRemoveReconfigurationCallback(powerDisplayChanged, Unmanaged.passUnretained(self).toOpaque()) }
        if let thermal { NotificationCenter.default.removeObserver(thermal) }
        if notification != 0 { IOObjectRelease(notification) }
        if let port { IONotificationPortDestroy(port) }
        if root != 0 { IOObjectRelease(root) }
    }
    func emit(force: Bool = false) {
        let lidClosed = lidBoolean(root, "AppleClamshellState")
        let closed = lidClosed == true
        if closed && !displayRegistered {
            displayRegistered = CGDisplayRegisterReconfigurationCallback(powerDisplayChanged, Unmanaged.passUnretained(self).toOpaque()) == .success
        } else if !closed && displayRegistered {
            CGDisplayRemoveReconfigurationCallback(powerDisplayChanged, Unmanaged.passUnretained(self).toOpaque())
            displayRegistered = false
        }
        guard let data = try? JSONSerialization.data(withJSONObject: powerObservation(lidClosed: lidClosed, notifications: notification != 0), options: [.sortedKeys]),
              force || data != last else { return }
        last = data
        FileHandle.standardOutput.write(data + Data([10]))
    }
    func run(once: Bool) {
        if once { emit(); return }
        if root != 0, let port = IONotificationPortCreate(kIOMainPortDefault) {
            self.port = port
            IONotificationPortSetDispatchQueue(port, .main)
            _ = IOServiceAddInterestNotification(port, root, kIOGeneralInterest, powerRootChanged,
                Unmanaged.passUnretained(self).toOpaque(), &notification)
        }
        thermal = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in self?.emit() }
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        input.setEventHandler { [weak self] in
            var bytes = [UInt8](repeating: 0, count: 64)
            let count = read(STDIN_FILENO, &bytes, bytes.count)
            guard count > 0, bytes.prefix(count).allSatisfy({ $0 == 10 }) else { exit(0) }
            self?.lastPulse = ProcessInfo.processInfo.systemUptime
            // Sparse reconciliation covers missed notifications and logical
            // display sleep changes that do not reconfigure a display.
            self?.emit(force: true)
        }
        input.resume()
        let watchdog = DispatchSource.makeTimerSource(queue: .main)
        watchdog.schedule(deadline: .now() + 150, repeating: 60, leeway: .seconds(5))
        watchdog.setEventHandler { [weak self] in
            guard let self, ProcessInfo.processInfo.systemUptime - self.lastPulse <= 150 else { exit(0) }
        }
        watchdog.resume()
        emit()
        withExtendedLifetime((input, watchdog, self)) { dispatchMain() }
    }
}

private let powerRootChanged: IOServiceInterestCallback = { context, _, _, _ in
    guard let context else { return }
    // Read the property rather than treating notification arguments as truth.
    Unmanaged<PowerObserver>.fromOpaque(context).takeUnretainedValue().emit()
}
private let powerDisplayChanged: CGDisplayReconfigurationCallBack = { _, _, context in
    guard let context else { return }
    // CoreGraphics may invoke callbacks off the main queue.
    DispatchQueue.main.async { Unmanaged<PowerObserver>.fromOpaque(context).takeUnretainedValue().emit() }
}
