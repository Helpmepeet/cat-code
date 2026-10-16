import Foundation
import IOKit
import IOKit.ps
import Security
import AppKit
import Darwin

let lidQualificationEvidence = "2026-10-15/Mac16,8/25G83/battery-lid-and-sleep"
func lidHardwareString(_ key: String) -> String? {
    var size = 0
    guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 0, size < 128 else { return nil }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname(key, &bytes, &size, nil, 0) == 0 else { return nil }
    return String(cString: bytes)
}
func lidHardwareQualified() -> Bool {
    lidHardwareString("hw.model") == "Mac16,8" && lidHardwareString("kern.osversion") == "25G83"
}

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
    var setupOnly: Bool?
}
struct LidConfiguration: Codable {
    var version: Int
    var uid: UInt32
    var bridgeRequirement: String
    var parents: [LidParent]
    var experimentUntil: Double
    var applicationTrialUntil: Double?
    var qualifiedBoot: String?
    var qualifiedOS: String?
    var qualificationEvidence: String?
    var qualified: Bool {
        lidHardwareQualified() && qualificationEvidence == lidQualificationEvidence
    }
    var applicationTrial: Bool { applicationTrialUntil != nil }
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
    guard value.version == 2, value.uid > 0, value.parents.count <= 3,
          value.bridgeRequirement.count < 512, value.experimentUntil.isFinite,
          value.applicationTrialUntil == nil || (value.applicationTrialUntil!.isFinite && value.applicationTrialUntil! > 0 && value.parents.allSatisfy({ !$0.experiment })) else { throw LidFailure("configuration-invalid") }
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
// A signed generic Electron executable is not an application identity. Require
// the sealed payload, exact kernel library allowlist and startup fuses. The
// caller's live validity and sticky debugger status are checked on every RPC.
func lidSealedApplication(_ executable: String, _ requirementText: String? = nil) -> Bool {
    let url = URL(fileURLWithPath: executable)
    let bundle = url.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard bundle.pathExtension == "app", executable == bundle.appendingPathComponent("Contents/MacOS/" + url.lastPathComponent).path,
          let info = NSDictionary(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")),
          ["com.catcode.desktop", "com.catcode.desktop.dev"].contains(info["CFBundleIdentifier"] as? String ?? ""),
          let integrity = info["ElectronAsarIntegrity"] as? [String: Any], integrity["Resources/app.asar"] != nil,
          FileManager.default.fileExists(atPath: bundle.appendingPathComponent("Contents/Resources/app.asar").path) else { return false }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else { return false }
    var requirement: SecRequirement?
    if let requirementText {
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess else { return false }
    }
    guard SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures), requirement) == errSecSuccess else { return false }
    var signing: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &signing) == errSecSuccess,
          let details = signing as? [String: Any], let flags = details[kSecCodeInfoFlags as String] as? NSNumber,
          flags.uint32Value & (SecCodeStatus.hard.rawValue | SecCodeStatus.kill.rawValue) == (SecCodeStatus.hard.rawValue | SecCodeStatus.kill.rawValue),
          lidConstrainedLibraries(bundle, code) else { return false }
    let entitlements = details[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    guard entitlements.isEmpty else { return false }
    let framework = bundle.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Electron Framework")
    guard let bytes = try? Data(contentsOf: framework, options: .mappedIfSafe),
          let sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".data(using: .utf8),
          let range = bytes.range(of: sentinel) else { return false }
    let offset = range.upperBound
    guard bytes.count > offset + 7, bytes[offset] == 1, bytes[offset + 1] >= 6 else { return false }
    // Electron fuse V1: runAsNode, nodeOptions, CLI inspector off; ASAR
    // integrity and exclusive ASAR loading on. Cookie policy is unchanged.
    return [0, 2, 3].allSatisfy { bytes[offset + 2 + $0] == 48 } &&
        [4, 5].allSatisfy { bytes[offset + 2 + $0] == 49 }
}
func lidHardenedNative(_ executable: String) -> Bool {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: executable) as CFURL, [], &code) == errSecSuccess,
          let code, SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else { return false }
    var signing: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &signing) == errSecSuccess,
          let details = signing as? [String: Any], let flags = details[kSecCodeInfoFlags as String] as? NSNumber,
          flags.uint32Value & 0x10000 != 0 else { return false }
    // This binary links only system libraries and needs no runtime exceptions.
    return (details[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]).isEmpty
}
enum LidCallerRole { case application, experiment, setup }
func lidProtectedRootNode(_ path: String, directory: Bool) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && info.st_uid == 0 &&
        info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) &&
        info.st_mode & 0o022 == 0 && lidReadOnlyACL(path)
}
func lidSecureInstallationPaths() -> Bool {
    let directories = ["/", "/Library", "/Library/PrivilegedHelperTools", "/Library/LaunchDaemons",
        "/Library/Application Support", "/Library/Application Support/Cat Code", lidStateDirectory, lidAuthorizedDirectory]
    let files = ["/Library/PrivilegedHelperTools/com.catcode.lid-closed",
        "/Library/LaunchDaemons/com.catcode.lid-closed.plist", "/Library/LaunchDaemons/com.catcode.lid-closed.recovery.plist",
        lidStateDirectory + "/configuration.json", lidStateDirectory + "/uninstall.sh"]
    for (paths, directory) in [(directories, true), (files, false)] {
        for path in paths {
            var info = stat()
            if lstat(path, &info) != 0 {
                guard errno == ENOENT else { return false }
                continue
            }
            guard lidProtectedRootNode(path, directory: directory) else { return false }
        }
    }
    return true
}
func lidProtectedApplication() -> Bool {
    for path in ["/", "/Library", "/Library/PrivilegedHelperTools", lidAuthorizedDirectory, lidAuthorizedApplication] {
        guard lidProtectedRootNode(path, directory: true) else { return false }
    }
    let root = URL(fileURLWithPath: lidAuthorizedApplication).resolvingSymlinksInPath().path
    var unreadable = false
    guard root == lidAuthorizedApplication,
          let files = FileManager.default.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil,
              errorHandler: { _, _ in unreadable = true; return false }) else { return false }
    var count = 0
    while let url = files.nextObject() as? URL {
        count += 1
        guard count <= 20_000 else { return false }
        let path = url.path
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == 0 else { return false }
        if info.st_mode & S_IFMT == S_IFLNK {
            let target = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            guard target.hasPrefix(root + "/") else { return false }
        } else {
            guard [S_IFREG, S_IFDIR].contains(info.st_mode & S_IFMT), info.st_mode & 0o022 == 0,
                  lidReadOnlyACL(path) else { return false }
        }
    }
    return !unreadable
}
func lidAuthorizedAppRunning() -> Bool {
    let count = proc_listallpids(nil, 0)
    guard count > 0, count < 100_000 else { return true }
    var pids = [pid_t](repeating: 0, count: Int(count) + 1024)
    let found = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    guard found > 0, found <= pids.count else { return true }
    return pids.prefix(Int(found)).contains { pid in
        if pid == getpid() { return false }
        guard let path = lidExecutablePath(pid) else { return false }
        return path.hasPrefix(lidAuthorizedApplication + "/")
    }
}
func lidAuthenticatedRole(_ connection: NSXPCConnection, _ config: LidConfiguration, verifyApplication: Bool = true) -> LidCallerRole? {
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
        guard lidUndebuggedCode(parent), lidSafeApplicationArguments(parent), let app = NSRunningApplication(processIdentifier: parent),
              app.bundleIdentifier == "com.catcode.desktop" || app.bundleIdentifier == "com.catcode.desktop.dev",
              app.activationPolicy == .regular, app.executableURL?.path == path,
              !verifyApplication || lidSealedApplication(path, allowed.requirement) else { return nil }
        if allowed.setupOnly == true { return .setup }
        guard path == lidAuthorizedExecutable, !verifyApplication || lidProtectedApplication() else { return nil }
    }
    if allowed.experiment && Date().timeIntervalSince1970 >= config.experimentUntil { return nil }
    return allowed.experiment ? .experiment : .application
}
func lidProductionController(_ configuration: LidConfiguration) throws -> LidController {
    return LidController(journal: LidJournal(lidStateDirectory), boot: try lidBootID(), qualified: configuration.qualified,
        now: lidContinuousTime, readSafety: lidReadSafety,
        setDisabled: { disabled in try lidPmset(["-a", "disablesleep", disabled ? "1" : "0"]) },
        requestSleep: { try lidPmset(["sleepnow"]) })
}

func lidRegisterJob(_ role: String) throws {
    guard let identity = LidProcessIdentity.read(getpid()), ["daemon", "watcher", "experiment-guard"].contains(role) else { throw LidFailure("owner-identity-unavailable") }
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
    let registered = ["daemon", "watcher", "experiment-guard"].contains { role in
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

// Temporary proof setup gets one lease per installation. This root process
// removes authority independently of the operator's shell and authentication
// dialog, including when coordination never starts or the driver is cancelled.
func lidGuardExperiment() throws {
    let config = try lidConfiguration()
    guard !config.parents.isEmpty, config.applicationTrial || config.parents.allSatisfy({ $0.experiment }) else { throw LidFailure("not-experiment-setup") }
    try lidRegisterJob("experiment-guard")
    let controller = try lidProductionController(config)
    var deadline = lidContinuousTime() + 30
    var sawLease = false
    while lidContinuousTime() < deadline {
        let snapshot = controller.snapshot()
        // resumeAfterInstall clears draining before launch. Experimental start
        // consumes it under the transition lock, even if this process starts
        // after the lease has already ended. Never infer admission from polling.
        if !sawLease, snapshot.record.draining {
            sawLease = true
            deadline = min(lidContinuousTime() + 90, snapshot.record.deadline + 15)
        }
        if sawLease, !snapshot.record.needsRestore,
           (config.applicationTrial ? ["ended", "off"] : ["ended", "lid-open", "off"]).contains(snapshot.record.phase),
           !snapshot.record.sleepRequested || snapshot.record.sleepRequestSucceeded != nil { break }
        Thread.sleep(forTimeInterval: 0.25)
    }
    let cleanupDeadline = lidContinuousTime() + 15
    while true {
        do {
            try controller.journal.locked { try lidPowerTracker(config).retire() }
            try controller.retire(); break
        }
        catch {
            if (error as? LidFailure)?.message == "transition-pending", lidContinuousTime() < cleanupDeadline {
                lidRetireStalledOwner(config); usleep(250_000); continue
            }
            // Retire any pending command before fallback so an orphan enable
            // cannot execute after the restoration observation.
            guard sawLease || controller.snapshot().record.needsRestore else { throw error }
            try controller.journal.locked {
                try lidPowerTracker(config).retire()
                try lidPmset(["-a", "disablesleep", "0"])
            }
            try controller.retire()
            break
        }
    }
    guard controller.snapshot().safety.sleepDisabled == false else { throw LidFailure("restoration-unresolved") }
    let snapshot = try JSONEncoder().encode(controller.snapshot())
    FileHandle.standardOutput.write(snapshot + Data([10]))
    let removal = Process(); removal.executableURL = URL(fileURLWithPath: "/bin/bash")
    removal.arguments = [lidStateDirectory + "/uninstall.sh"]
    let finished = DispatchSemaphore(value: 0)
    removal.terminationHandler = { _ in finished.signal() }
    try removal.run()
    let removalIdentity = LidProcessIdentity.read(removal.processIdentifier)
    guard finished.wait(timeout: .now() + 30) == .success else {
        if let identity = removalIdentity, lidProcessRunning(identity) { kill(identity.pid, SIGKILL) }
        throw LidFailure("experiment-uninstall-timed-out")
    }
    guard removal.terminationStatus == 0 else { throw LidFailure("experiment-uninstall-failed") }
}
