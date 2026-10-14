import Foundation
import IOKit
import IOKit.ps
import Security
import AppKit
import Darwin

func lidBootID() throws -> String {
    var size = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0, size < 128 else { throw LidFailure("boot-identity-unavailable") }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else { throw LidFailure("boot-identity-unavailable") }
    return String(cString: bytes)
}
func lidBoolean(_ entry: io_registry_entry_t, _ key: String) -> Bool? {
    guard entry != 0, let value = IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
          CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return CFBooleanGetValue((value as! CFBoolean))
}
func lidReadSafety() -> LidSafety {
    let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    defer { if root != 0 { IOObjectRelease(root) } }
    let thermal: String
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: thermal = "nominal"
    case .fair: thermal = "fair"
    case .serious: thermal = "serious"
    case .critical: thermal = "critical"
    @unknown default: thermal = "unknown"
    }
    var percent: Double?
    var batteryPower: Bool?
    if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
       let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] {
        for source in sources {
            guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let current = d[kIOPSCurrentCapacityKey] as? NSNumber,
                  let max = d[kIOPSMaxCapacityKey] as? NSNumber, max.doubleValue > 0,
                  let power = d[kIOPSPowerSourceStateKey] as? String,
                  [kIOPSBatteryPowerValue, kIOPSACPowerValue].contains(power) else { continue }
            percent = current.doubleValue / max.doubleValue * 100
            batteryPower = power == kIOPSBatteryPowerValue
            break
        }
    }
    return LidSafety(sleepDisabled: lidBoolean(root, "SleepDisabled"),
        lidClosed: lidBoolean(root, "AppleClamshellState"), batteryPercent: percent, onBattery: batteryPower, thermal: thermal)
}

// Fixed executable and argument vocabulary. Each spawned power command gets a
// three-second exit deadline; never pass a path or shell string from a client.
func lidPmset(_ arguments: [String]) throws {
    guard arguments == ["-a", "disablesleep", "0"] || arguments == ["-a", "disablesleep", "1"] || arguments == ["sleepnow"] else {
        throw LidFailure("invalid-power-operation")
    }
    let configuration = try lidConfiguration()
    let tracker = lidPowerTracker(configuration)
    // Never restore or settle while an older activation process can still run.
    try tracker.retire()
    let action = arguments == ["sleepnow"] ? "sleep" : arguments.last == "1" ? "enable" : "restore"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/Library/PrivilegedHelperTools/com.catcode.lid-closed")
    process.arguments = ["--power-command", action]
    process.environment = ["PATH": "/usr/bin:/bin", "LANG": "C"]
    let gate = Pipe(); process.standardInput = gate
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    try process.run()
    do {
        try tracker.record(process.processIdentifier, action: action)
        // Child cannot exec pmset until its identity is durably recoverable.
        try gate.fileHandleForWriting.write(contentsOf: Data([71]))
        try gate.fileHandleForWriting.close()
        if finished.wait(timeout: .now() + 3) == .timedOut {
            try tracker.retire()
            throw LidFailure("power-operation-timed-out")
        }
        try tracker.retire()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else { throw LidFailure("power-operation-failed") }
    } catch {
        try? gate.fileHandleForWriting.close()
        // If recording failed, EOF at the gate forbids the mutation. Any child
        // that received the commit byte already has a durable identity.
        if let child = try? tracker.readChild(), child.process.pid == process.processIdentifier { try? tracker.retire() }
        throw error
    }

}

struct LidParent: Codable {
    var path: String
    var requirement: String
    var experiment: Bool
}
struct LidConfiguration: Codable {
    var version: Int
    var uid: UInt32
    var bridgeRequirement: String
    var parents: [LidParent]
    var experimentUntil: Double
    var qualifiedBoot: String?
    var qualifiedOS: String?
    var qualificationEvidence: String?
    var qualified: Bool {
        qualifiedBoot == (try? lidBootID()) && qualifiedOS == ProcessInfo.processInfo.operatingSystemVersionString &&
            (qualificationEvidence?.count ?? 0) >= 16
    }
}
func lidConfiguration() throws -> LidConfiguration {
    var statBuffer = stat()
    guard lstat(lidStateDirectory, &statBuffer) == 0, statBuffer.st_uid == 0,
          (statBuffer.st_mode & S_IFMT) == S_IFDIR, (statBuffer.st_mode & 0o077) == 0 else { throw LidFailure("configuration-unavailable") }
    let path = lidStateDirectory + "/configuration.json"
    guard lstat(path, &statBuffer) == 0, statBuffer.st_uid == 0,
          (statBuffer.st_mode & S_IFMT) == S_IFREG, (statBuffer.st_mode & 0o077) == 0,
          statBuffer.st_size <= 8192 else { throw LidFailure("configuration-unavailable") }
    let value = try JSONDecoder().decode(LidConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    guard value.version == 1, value.uid > 0, value.parents.count <= 3,
          value.bridgeRequirement.count < 512, value.experimentUntil.isFinite else { throw LidFailure("configuration-invalid") }
    return value
}
func lidExecutablePath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return String(cString: buffer)
}
func lidMatchesCode(_ pid: pid_t, _ requirementText: String) -> Bool {
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &guest) == errSecSuccess,
          let guest else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess else { return false }
    return SecCodeCheckValidity(guest, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess
}
func lidAuthenticatedRole(_ connection: NSXPCConnection, _ config: LidConfiguration) -> Bool? {
    let pid = connection.processIdentifier
    guard connection.effectiveUserIdentifier == config.uid,
          lidExecutablePath(pid) == "/Library/PrivilegedHelperTools/com.catcode.lid-closed",
          lidMatchesCode(pid, config.bridgeRequirement) else { return nil }
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return nil }
    let parent = pid_t(info.pbi_ppid)
    guard let path = lidExecutablePath(parent), let allowed = config.parents.first(where: {
        $0.path == path && lidMatchesCode(parent, $0.requirement)
    }) else { return nil }
    if !allowed.experiment {
        guard let app = NSRunningApplication(processIdentifier: parent),
              app.bundleIdentifier == "com.catcode.desktop" || app.bundleIdentifier == "com.catcode.desktop.dev",
              app.activationPolicy == .regular, app.executableURL?.path == path else { return nil }
    }
    if allowed.experiment && Date().timeIntervalSince1970 >= config.experimentUntil { return nil }
    return allowed.experiment
}
func lidProductionController(_ configuration: LidConfiguration) throws -> LidController {
    return LidController(journal: LidJournal(lidStateDirectory), boot: try lidBootID(), qualified: configuration.qualified,
        now: lidContinuousTime, readSafety: lidReadSafety,
        setDisabled: { disabled in try lidPmset(["-a", "disablesleep", disabled ? "1" : "0"]) },
        requestSleep: { try lidPmset(["sleepnow"]) })
}

func lidRegisterJob(_ role: String) throws {
    guard let identity = LidProcessIdentity.read(getpid()), ["daemon", "watcher"].contains(role) else { throw LidFailure("owner-identity-unavailable") }
    try JSONEncoder().encode(identity).write(to: URL(fileURLWithPath: lidStateDirectory + "/" + role + "-owner.json"), options: .atomic)
}
func lidRetireStalledOwner(_ configuration: LidConfiguration) {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: lidStateDirectory + "/lock-owner.json")), data.count <= 1024,
          let owner = try? JSONDecoder().decode(LidLockOwner.self, from: data), owner.process.pid != getpid(),
          owner.began.isFinite, lidContinuousTime() - owner.began > lidHeartbeatLimit,
          LidProcessIdentity.read(owner.process.pid) == owner.process,
          lidExecutablePath(owner.process.pid) == "/Library/PrivilegedHelperTools/com.catcode.lid-closed",
          lidMatchesCode(owner.process.pid, configuration.bridgeRequirement) else { return }
    var process = proc_bsdinfo()
    guard proc_pidinfo(owner.process.pid, PROC_PIDTBSDINFO, 0, &process, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          process.pbi_uid == 0 else { return }
    let registered = ["daemon", "watcher"].contains { role in
        guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: lidStateDirectory + "/" + role + "-owner.json")), bytes.count <= 1024,
              let identity = try? JSONDecoder().decode(LidProcessIdentity.self, from: bytes) else { return false }
        return identity == owner.process
    }
    guard registered else { return }
    // PID plus kernel birth time, pinned executable and root-owned job marker
    // prevent killing a reused PID or an unrelated process with the same name.
    kill(owner.process.pid, SIGKILL)
}

func lidRecoverBeforeListening(_ configuration: LidConfiguration, _ controller: LidController) throws {
    let deadline = lidContinuousTime() + 15
    while true {
        do {
            try controller.journal.locked { try lidPowerTracker(configuration).retire() }
            try controller.recoverInterrupted()
            return
        } catch {
            guard (error as? LidFailure)?.message == "transition-pending", lidContinuousTime() < deadline else { throw error }
            // Startup must participate in stalled-owner recovery too: its
            // regular recovery timer does not exist until the listener starts.
            lidRetireStalledOwner(configuration)
            usleep(250_000)
        }
    }
}

func lidPowerTracker(_ configuration: LidConfiguration) -> LidPowerTracker {
    LidPowerTracker(directory: lidStateDirectory, trusted: { identity in
        guard LidProcessIdentity.read(identity.pid) == identity else { return false }
        var info = proc_bsdinfo()
        guard proc_pidinfo(identity.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
              info.pbi_uid == 0, let path = lidExecutablePath(identity.pid) else { return false }
        if path == "/usr/bin/pmset" { return lidMatchesCode(identity.pid, "anchor apple") }
        return path == "/Library/PrivilegedHelperTools/com.catcode.lid-closed" && lidMatchesCode(identity.pid, configuration.bridgeRequirement)
    })
}
func lidRetireOrphanCommand(_ configuration: LidConfiguration) throws {
    // Record, commit, and retirement share the controller transition lock.
    // Otherwise stale retirement can unlink a newer command's recovery record.
    try LidJournal(lidStateDirectory).locked {
        let tracker = lidPowerTracker(configuration)
        guard let child = try tracker.readChild() else { return }
        if !lidProcessRunning(child.parent) || lidContinuousTime() - child.began > lidHeartbeatLimit {
            try tracker.retire()
        }
    }
}
func lidExecPowerCommand(_ action: String) throws {
    let arguments: [String]
    switch action {
    case "enable": arguments = ["/usr/bin/pmset", "-a", "disablesleep", "1"]
    case "restore": arguments = ["/usr/bin/pmset", "-a", "disablesleep", "0"]
    case "sleep": arguments = ["/usr/bin/pmset", "sleepnow"]
    default: throw LidFailure("invalid-power-operation")
    }
    try lidAwaitPowerCommit()
    let strings = arguments.map { strdup($0) }
    defer { strings.forEach { free($0) } }
    var argv = strings + [nil]
    argv.withUnsafeMutableBufferPointer { buffer in _ = execv("/usr/bin/pmset", buffer.baseAddress!) }
    throw LidFailure("power-exec-failed")
}
