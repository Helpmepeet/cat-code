import Foundation
import Darwin
import CoreFoundation

let lidHeartbeatLimit: Double = 5
let lidRecoveryPoll: Double = 2
let lidWorkLease: Double = 10
let lidJavaScriptSafeInteger: Int64 = 9_007_199_254_740_991
let lidMaximumAllowance: Double = 7200
let lidStateDirectory = "/Library/Application Support/Cat Code/LidClosed"
let lidService = "com.catcode.lid-closed"

func lidContinuousTime() -> Double {
    var info = mach_timebase_info_data_t(); mach_timebase_info(&info)
    return Double(mach_continuous_time()) * Double(info.numer) / Double(info.denom) / 1_000_000_000
}

func lidGuardianDeadline(observationTime: Double, activationEnd: Double) -> Double {
    min(observationTime + 90, activationEnd + 15)
}
struct LidProcessIdentity: Codable, Equatable {
    var pid: Int32
    var seconds: UInt64
    var microseconds: UInt64
    static func read(_ pid: pid_t) -> LidProcessIdentity? {
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return nil }
        return LidProcessIdentity(pid: pid, seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
    }
}
struct LidLockOwner: Codable {
    var process: LidProcessIdentity
    var began: Double
}

struct LidSafety: Codable {
    var sleepDisabled: Bool?
    var lidClosed: Bool?
    var batteryPercent: Double?
    var onBattery: Bool?
    var thermal: String
    var available: Bool {
        guard let percent = batteryPercent else { return false }
        return sleepDisabled != nil && lidClosed != nil && onBattery != nil && percent.isFinite &&
            percent >= 0 && percent <= 100 && ["nominal", "fair", "serious", "critical"].contains(thermal)
    }
    var refusal: String? {
        if !available { return "monitoring-unavailable" }
        if thermal == "serious" || thermal == "critical" { return "thermal" }
        if onBattery == true && (batteryPercent ?? 0) <= 20 { return "battery-reserve" }
        return nil
    }
}

struct LidRecord: Codable {
    var version = 1
    var mode = "timed"
    var renewalSequence: Int64 = 0
    var hardDeadline: Double?
    var phase = "off"
    var draining = false
    var identity: String?
    var boot: String
    var began: Double = 0
    var deadline: Double = 0
    var allowance: Double = 0
    var clientPulse: Double = 0
    var helperPulse: Double = 0
    var sawClosed = false // Retained for the version-1 recovery journal.
    var reason: String?
    var needsRestore = false
    var sleepRequested = false
    var sleepRequestAttempted = false
    var sleepRequestSucceeded: Bool?
    var error: String?
    var thermalRestart = false
    enum CodingKeys: String, CodingKey {
        case version, mode, renewalSequence, hardDeadline, phase, draining, identity, boot, began, deadline, allowance
        case clientPulse, helperPulse, sawClosed, reason, needsRestore, sleepRequested, sleepRequestAttempted
        case sleepRequestSucceeded, error, thermalRestart
    }
    init(version: Int = 1, mode: String = "timed", renewalSequence: Int64 = 0, hardDeadline: Double? = nil,
         phase: String = "off", draining: Bool = false, identity: String? = nil, boot: String, began: Double = 0,
         deadline: Double = 0, allowance: Double = 0, clientPulse: Double = 0, helperPulse: Double = 0,
         sawClosed: Bool = false, reason: String? = nil, needsRestore: Bool = false, sleepRequested: Bool = false,
         sleepRequestAttempted: Bool = false, sleepRequestSucceeded: Bool? = nil, error: String? = nil,
         thermalRestart: Bool = false) {
        self.version = version; self.mode = mode; self.renewalSequence = renewalSequence; self.hardDeadline = hardDeadline
        self.phase = phase; self.draining = draining; self.identity = identity; self.boot = boot; self.began = began
        self.deadline = deadline; self.allowance = allowance; self.clientPulse = clientPulse; self.helperPulse = helperPulse
        self.sawClosed = sawClosed; self.reason = reason; self.needsRestore = needsRestore
        self.sleepRequested = sleepRequested; self.sleepRequestAttempted = sleepRequestAttempted
        self.sleepRequestSucceeded = sleepRequestSucceeded; self.error = error; self.thermalRestart = thermalRestart
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        let legacy = version == 1
        if legacy {
            mode = "timed"; renewalSequence = 0; hardDeadline = nil
        } else {
            mode = try values.decode(String.self, forKey: .mode)
            renewalSequence = try values.decode(Int64.self, forKey: .renewalSequence)
            hardDeadline = try values.decodeIfPresent(Double.self, forKey: .hardDeadline)
        }
        phase = try values.decode(String.self, forKey: .phase); draining = try values.decodeIfPresent(Bool.self, forKey: .draining) ?? false
        identity = try values.decodeIfPresent(String.self, forKey: .identity); boot = try values.decode(String.self, forKey: .boot)
        began = try values.decode(Double.self, forKey: .began); deadline = try values.decode(Double.self, forKey: .deadline)
        allowance = try values.decode(Double.self, forKey: .allowance); clientPulse = try values.decode(Double.self, forKey: .clientPulse)
        helperPulse = try values.decode(Double.self, forKey: .helperPulse); sawClosed = try values.decodeIfPresent(Bool.self, forKey: .sawClosed) ?? false
        reason = try values.decodeIfPresent(String.self, forKey: .reason); needsRestore = try values.decode(Bool.self, forKey: .needsRestore)
        sleepRequested = try values.decodeIfPresent(Bool.self, forKey: .sleepRequested) ?? false
        sleepRequestAttempted = try values.decodeIfPresent(Bool.self, forKey: .sleepRequestAttempted) ?? false
        sleepRequestSucceeded = try values.decodeIfPresent(Bool.self, forKey: .sleepRequestSucceeded)
        error = try values.decodeIfPresent(String.self, forKey: .error); thermalRestart = try values.decodeIfPresent(Bool.self, forKey: .thermalRestart) ?? false
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version)
        if version == 2 {
            try values.encode(mode, forKey: .mode); try values.encode(renewalSequence, forKey: .renewalSequence)
            try values.encodeIfPresent(hardDeadline, forKey: .hardDeadline)
        }
        try values.encode(phase, forKey: .phase); try values.encode(draining, forKey: .draining)
        try values.encodeIfPresent(identity, forKey: .identity); try values.encode(boot, forKey: .boot)
        try values.encode(began, forKey: .began); try values.encode(deadline, forKey: .deadline)
        try values.encode(allowance, forKey: .allowance); try values.encode(clientPulse, forKey: .clientPulse)
        try values.encode(helperPulse, forKey: .helperPulse); try values.encode(sawClosed, forKey: .sawClosed)
        try values.encodeIfPresent(reason, forKey: .reason); try values.encode(needsRestore, forKey: .needsRestore)
        try values.encode(sleepRequested, forKey: .sleepRequested); try values.encode(sleepRequestAttempted, forKey: .sleepRequestAttempted)
        try values.encodeIfPresent(sleepRequestSucceeded, forKey: .sleepRequestSucceeded)
        try values.encodeIfPresent(error, forKey: .error); try values.encode(thermalRestart, forKey: .thermalRestart)
    }
    var valid: Bool {
        let deadlineValid = hardDeadline.map {
            $0.isFinite && $0 >= began && $0 <= began + 60 && deadline <= $0
        } ?? true
        let modeValid = mode == "work"
            ? allowance == lidWorkLease && (draining ? hardDeadline != nil : hardDeadline == nil)
            : mode == "timed" && renewalSequence == 0 && hardDeadline == nil
        return (version == 1 && mode == "timed" && renewalSequence == 0 && hardDeadline == nil ||
         version == 2 && ["timed", "work"].contains(mode) && renewalSequence >= 0 &&
         renewalSequence <= lidJavaScriptSafeInteger && deadlineValid && modeValid) &&
        ["off", "starting", "active", "restoring", "unresolved", "lid-open", "ended"].contains(phase) &&
        [began, deadline, allowance, clientPulse, helperPulse].allSatisfy { $0.isFinite && $0 >= 0 } &&
        allowance <= lidMaximumAllowance && boot.count <= 128 &&
        (identity == nil || UUID(uuidString: identity!) != nil) &&
        (reason?.count ?? 0) <= 80 && (error?.count ?? 0) <= 512 &&
        (!needsRestore || identity != nil)
    }
}

struct LidSnapshot: Codable {
    var record: LidRecord
    var safety: LidSafety
    var remainingSeconds: Double
    var hardwareQualified: Bool
    var error: String?
    var restorationConfirmed: Bool {
        error == nil && record.valid && ["off", "ended", "lid-open"].contains(record.phase) &&
            !record.needsRestore && safety.sleepDisabled == false
    }
}

// Both root jobs serialize transitions with the same advisory lock. Atomic
// rename plus fsync makes the intent durable before either job can change power.
final class LidJournal {
    let directory: String
    init(_ directory: String) { self.directory = directory }
    func locked<T>(_ body: () throws -> T) throws -> T {
        let fd = open(directory + "/transition.lock", O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw LidFailure("journal-lock-unavailable") }
        defer { close(fd) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw LidFailure("transition-pending") }
        defer { flock(fd, LOCK_UN) }
        guard let process = LidProcessIdentity.read(getpid()) else { throw LidFailure("owner-identity-unavailable") }
        let owner = LidLockOwner(process: process, began: lidContinuousTime())
        try JSONEncoder().encode(owner).write(to: URL(fileURLWithPath: directory + "/lock-owner.json"), options: .atomic)
        return try body()
    }
    func read(boot: String) throws -> LidRecord {
        let path = directory + "/recovery.json"
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        if fd < 0 && errno == ENOENT { return LidRecord(boot: boot) }
        guard fd >= 0 else { throw LidFailure("journal-unreadable") }
        defer { close(fd) }
        var statBuffer = stat()
        guard fstat(fd, &statBuffer) == 0, (statBuffer.st_mode & S_IFMT) == S_IFREG,
              statBuffer.st_size <= 8192 else { throw LidFailure("journal-invalid") }
        var bytes = [UInt8](repeating: 0, count: 8193)
        let count = Darwin.read(fd, &bytes, bytes.count)
        guard count >= 0, count <= 8192 else { throw LidFailure("journal-unreadable") }
        let data = Data(bytes.prefix(count))
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let object, let versionValue = object["version"] as? NSNumber,
              CFGetTypeID(versionValue) != CFBooleanGetTypeID() else { throw LidFailure("journal-invalid") }
        guard versionValue.doubleValue == 1 || versionValue.doubleValue == 2 else { throw LidFailure("journal-invalid") }
        let version = versionValue.intValue
        let v1 = Set(["version", "phase", "draining", "identity", "boot", "began", "deadline", "allowance", "clientPulse", "helperPulse", "sawClosed", "reason", "needsRestore", "sleepRequested", "sleepRequestAttempted", "sleepRequestSucceeded", "error", "thermalRestart"])
        let v2 = v1.union(["mode", "renewalSequence", "hardDeadline"])
        let legacyRequired = Set(["version", "phase", "boot", "began", "deadline", "allowance", "clientPulse", "helperPulse", "needsRestore"])
        let objectKeys = Set(object.keys)
        let v2Required = Set(["version", "mode", "renewalSequence", "phase", "draining", "boot", "began",
                              "deadline", "allowance", "clientPulse", "helperPulse", "sawClosed", "needsRestore"])
        guard version == 1 && legacyRequired.isSubset(of: objectKeys) && objectKeys.isSubset(of: v1) ||
              version == 2 && v2Required.isSubset(of: objectKeys) && objectKeys.isSubset(of: v2) else { throw LidFailure("journal-invalid") }
        let record = try JSONDecoder().decode(LidRecord.self, from: data)
        guard record.valid else { throw LidFailure("journal-invalid") }
        return record
    }
    func write(_ record: LidRecord) throws {
        guard record.valid else { throw LidFailure("journal-invalid") }
        let data = try JSONEncoder().encode(record)
        let temp = directory + "/.recovery-" + UUID().uuidString
        let fd = open(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw LidFailure("journal-write-failed") }
        defer { close(fd); unlink(temp) }
        let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard count == data.count, fsync(fd) == 0, rename(temp, directory + "/recovery.json") == 0 else {
            throw LidFailure("journal-write-failed")
        }
        let dir = open(directory, O_RDONLY | O_DIRECTORY)
        guard dir >= 0 else { throw LidFailure("journal-write-failed") }
        defer { close(dir) }
        guard fsync(dir) == 0 else { throw LidFailure("journal-write-failed") }
    }
}

struct LidFailure: Error { let message: String; init(_ message: String) { self.message = message } }

// The helper and recovery watcher use the same transition owner and real power
// adapter. The watcher never accepts a start or refreshes client supervision.
final class LidController {
    let journal: LidJournal
    let boot: String
    let now: () -> Double
    let readSafety: () -> LidSafety
    let setDisabled: (Bool) throws -> Void
    let requestSleep: () throws -> Void
    let qualified: Bool
    init(journal: LidJournal, boot: String, qualified: Bool, now: @escaping () -> Double,
         readSafety: @escaping () -> LidSafety, setDisabled: @escaping (Bool) throws -> Void,
         requestSleep: @escaping () throws -> Void) {
        self.journal = journal; self.boot = boot; self.qualified = qualified; self.now = now
        self.readSafety = readSafety; self.setDisabled = setDisabled; self.requestSleep = requestSleep
    }
    func recoverInterrupted() throws {
        try journal.locked {
            var record = try journal.read(boot: boot)
            if record.needsRestore { try restore(&record, reason: "interrupted", sleep: record.sleepRequested || readSafety().lidClosed == true) }
        }
    }
    func retire() throws {
        try journal.locked {
            var record = try journal.read(boot: boot)
            record.draining = true; try journal.write(record)
            if record.needsRestore { try restore(&record, reason: "retired", sleep: record.sleepRequested || readSafety().lidClosed == true) }
            if record.phase == "lid-open" {
                record.phase = "ended"; record.reason = "retired"; try journal.write(record)
            }
            guard !record.needsRestore, readSafety().sleepDisabled == false else { throw LidFailure("restoration-unresolved") }
        }
    }
    func resumeAfterInstall() throws {
        try journal.locked {
            var record = try journal.read(boot: boot)
            guard !record.needsRestore, readSafety().sleepDisabled == false else { throw LidFailure("restoration-unresolved") }
            if record.version == 2 && record.mode == "work" && record.hardDeadline != nil {
                record.mode = "timed"
                record.renewalSequence = 0
                record.hardDeadline = nil
                record.allowance = 0
            }
            record.draining = false; try journal.write(record)
        }
    }
    func snapshot() -> LidSnapshot {
        let safety = readSafety()
        do {
            let record = try journal.read(boot: boot)
            return LidSnapshot(record: record, safety: safety,
                remainingSeconds: record.boot == boot ? max(0, record.deadline - now()) : 0,
                hardwareQualified: qualified, error: nil)
        } catch {
            return LidSnapshot(record: LidRecord(phase: "unresolved", boot: boot, error: "journal-unreadable"),
                safety: safety, remainingSeconds: 0, hardwareQualified: qualified, error: "journal-unreadable")
        }
    }
    func restore(_ record: inout LidRecord, reason: String, sleep: Bool = false) throws {
        var effectiveReason = reason
        var shouldSleep = sleep
        record.phase = "restoring"; record.reason = effectiveReason
        record.sleepRequested = record.sleepRequested || shouldSleep
        record.error = nil; record.helperPulse = now()
        try journal.write(record)
        do {
            // A command receipt alone is insufficient. Confirm the kernel flag
            // before settling the record or sending a separate sleep request.
            try setDisabled(false)
            let restoredSafety = readSafety()
            guard restoredSafety.sleepDisabled == false else { throw LidFailure("restoration-not-observed") }
            if effectiveReason == "work-finished", let refusal = restoredSafety.refusal {
                effectiveReason = refusal
                record.reason = refusal
                if refusal == "thermal" { record.thermalRestart = true }
            }
            shouldSleep = shouldSleep || restoredSafety.lidClosed == true || restoredSafety.thermal == "critical"
            record.sleepRequested = record.sleepRequested || shouldSleep
            record.needsRestore = false
            record.phase = effectiveReason == "lid-open" ? "lid-open" : "ended"
            if record.sleepRequested && !record.sleepRequestAttempted {
                // Recovery may repeat restoration, but must not repeat a sleep
                // request after wake merely because its receipt was interrupted.
                record.sleepRequestAttempted = true
                try journal.write(record)
                do { try requestSleep(); record.sleepRequestSucceeded = true }
                catch { record.sleepRequestSucceeded = false; record.error = "sleep-request-failed" }
            }
            try journal.write(record)
        } catch {
            record.phase = "unresolved"; record.needsRestore = true
            record.reason = effectiveReason; record.error = "restoration-failed"
            try journal.write(record)
        }
    }
    func commandSnapshot(_ record: LidRecord) -> LidSnapshot {
        LidSnapshot(record: record, safety: readSafety(),
            remainingSeconds: record.boot == boot ? max(0, record.deadline - now()) : 0,
            hardwareQualified: qualified, error: nil)
    }
    func tick(watcher: Bool = false) throws {
        try journal.locked {
            var record = try journal.read(boot: boot)
            let time = now()
            if record.needsRestore && record.phase != "active" {
                try restore(&record, reason: record.reason ?? "interrupted", sleep: record.sleepRequested)
                return
            }
            guard record.phase == "active" else {
                if record.phase == "lid-open" && (record.boot != boot || time >= record.deadline) {
                    record.phase = "ended"; record.reason = "expired"; try journal.write(record)
                }
                return
            }
            let safety = readSafety()
            let reason: String?
            if record.boot != boot { reason = "interrupted" }
            else if time - record.clientPulse > lidHeartbeatLimit { reason = "supervision-lost" }
            else if watcher && time - record.helperPulse > lidHeartbeatLimit { reason = "helper-lost" }
            else if time >= record.deadline || record.mode == "work" && record.hardDeadline.map({ time >= $0 }) == true {
                reason = record.mode == "work" ? "work-expired" : "expired"
            }
            else if let refusal = safety.refusal { reason = refusal }
            else if safety.sleepDisabled != true { reason = "override-conflict" }
            else { reason = nil }
            if let reason {
                if safety.thermal == "serious" || safety.thermal == "critical" { record.thermalRestart = true }
                try restore(&record, reason: reason, sleep: safety.lidClosed == true || safety.thermal == "critical")
            } else if !watcher {
                record.helperPulse = time
                record.sawClosed = record.sawClosed || safety.lidClosed == true
                try journal.write(record)
            }
        }
    }
    func command(_ input: [String: Any], experiment: Bool = false, applicationTrial: Bool = false) throws -> LidSnapshot {
        guard let op = input["op"] as? String,
              Set(input.keys).isSubset(of: Set(["op", "identity", "allowance", "scenario", "sequence"])) else { throw LidFailure("invalid-command") }
        let id = input["identity"] as? String
        let exactKeys: Set<String> = ["op", "identity"]
        if ["start-work", "finish-work"].contains(op) {
            guard Set(input.keys) == exactKeys, let id, UUID(uuidString: id) != nil else { throw LidFailure("invalid-command") }
        }
        if op == "renew-work" {
            guard Set(input.keys) == exactKeys.union(["sequence"]), let id, UUID(uuidString: id) != nil,
                  let number = input["sequence"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
                  number.doubleValue >= 0, number.int64Value <= lidJavaScriptSafeInteger,
                  number.doubleValue == Double(number.int64Value) else { throw LidFailure("invalid-command") }
        }
        let noArguments = ["status", "retry", "dismiss"].contains(op)
        if noArguments && input.count != 1 { throw LidFailure("invalid-command") }
        if op == "status" { return snapshot() }
        try journal.locked {
            var record = try journal.read(boot: boot)
            let time = now()
            let safety = readSafety()
            switch op {
            case "start-work":
                guard !experiment else { throw LidFailure("work-mode-unavailable-in-experiment") }
                guard qualified else { throw LidFailure("hardware-unqualified") }
                guard !record.draining, !record.needsRestore,
                      !["active", "starting", "restoring", "unresolved"].contains(record.phase) else { throw LidFailure("start-refused") }
                guard safety.sleepDisabled == false else { throw LidFailure("override-in-use") }
                guard safety.lidClosed == false else { throw LidFailure("open-lid-required") }
                if let refusal = safety.refusal { throw LidFailure(refusal) }
                if record.thermalRestart && safety.thermal != "nominal" { throw LidFailure("thermal-restart-refused") }
                let hardDeadline = applicationTrial ? time + 60 : nil
                record = LidRecord(version: 2, mode: "work", renewalSequence: 0,
                    hardDeadline: hardDeadline, phase: "starting",
                    draining: experiment || applicationTrial, identity: id, boot: boot, began: time,
                    deadline: time, allowance: lidWorkLease, clientPulse: time, helperPulse: time,
                    sawClosed: false, needsRestore: true)
                try journal.write(record)
                do {
                    try setDisabled(true)
                    let confirmed = readSafety()
                    guard confirmed.sleepDisabled == true else { throw LidFailure("activation-not-observed") }
                    if let refusal = confirmed.refusal { throw LidFailure(refusal) }
                    let activeAt = now()
                    record.clientPulse = activeAt; record.helperPulse = activeAt
                    record.deadline = min(activeAt + lidWorkLease, hardDeadline ?? .greatestFiniteMagnitude)
                    guard activeAt < (record.hardDeadline ?? .greatestFiniteMagnitude) else { throw LidFailure("activation-expired") }
                    record.phase = "active"; try journal.write(record)
                } catch {
                    let reason = record.hardDeadline.map({ now() >= $0 }) == true ? "work-expired" : "start-failed"
                    try restore(&record, reason: reason, sleep: safety.lidClosed == true)
                }
            case "renew-work":
                guard record.version == 2, record.mode == "work", record.phase == "active",
                      record.identity == id, record.boot == boot else { throw LidFailure("lease-not-active") }
                let sequence = (input["sequence"] as! NSNumber).int64Value
                let safety = readSafety()
                let failure: String?
                if time >= record.deadline || record.hardDeadline.map({ time >= $0 }) == true { failure = "work-expired" }
                else if time - record.clientPulse > lidHeartbeatLimit { failure = "supervision-lost" }
                else if let refusal = safety.refusal { failure = refusal }
                else if safety.sleepDisabled != true { failure = "override-conflict" }
                else { failure = nil }
                if let failure {
                    try restore(&record, reason: failure, sleep: safety.lidClosed == true || safety.thermal == "critical")
                    return
                }
                guard sequence > record.renewalSequence else { throw LidFailure("renewal-sequence-invalid") }
                record.renewalSequence = sequence
                record.clientPulse = time
                record.deadline = min(time + lidWorkLease, record.hardDeadline ?? .greatestFiniteMagnitude)
                try journal.write(record)
            case "finish-work":
                guard record.version == 2, record.mode == "work", record.phase == "active",
                      record.identity == id, record.boot == boot else { throw LidFailure("lease-not-active") }
                let safety = readSafety()
                let reason: String
                if time >= record.deadline || record.hardDeadline.map({ time >= $0 }) == true { reason = "work-expired" }
                else if time - record.clientPulse > lidHeartbeatLimit { reason = "supervision-lost" }
                else if let refusal = safety.refusal { reason = refusal }
                else if safety.sleepDisabled != true { reason = "override-conflict" }
                else { reason = "work-finished" }
                try restore(&record, reason: reason, sleep: safety.lidClosed == true || safety.thermal == "critical")
            case "start":
                guard !record.draining, !record.needsRestore, !["active", "starting", "restoring", "unresolved"].contains(record.phase),
                      let id, UUID(uuidString: id) != nil, input.count == 3,
                      let number = input["allowance"] as? NSNumber,
                      case let seconds = number.doubleValue, seconds.isFinite,
                      experiment ? (seconds >= 10 && seconds <= 60) : [300.0, 900, 1800, 3600, 7200].contains(seconds) else {
                    throw LidFailure("start-refused")
                }
                guard experiment || qualified else { throw LidFailure("hardware-unqualified") }
                guard safety.sleepDisabled == false else { throw LidFailure("override-in-use") }
                guard safety.lidClosed == false else { throw LidFailure("open-lid-required") }
                if let refusal = safety.refusal { throw LidFailure(refusal) }
                if record.thermalRestart && safety.thermal != "nominal" { throw LidFailure("thermal-restart-refused") }
                // Experimental setup admits one activation, including a failed
                // attempt. Consume admission durably before changing power;
                // ongoing pulses and restoration remain available while drained.
                let duration = applicationTrial ? min(seconds, 60) : seconds
                record = LidRecord(version: 2, mode: "timed", phase: "starting", draining: experiment || applicationTrial, identity: id, boot: boot, began: time,
                    deadline: time + duration, allowance: seconds, clientPulse: time, helperPulse: time,
                    sawClosed: safety.lidClosed == true, needsRestore: true)
                try journal.write(record)
                do {
                    try setDisabled(true)
                    guard readSafety().sleepDisabled == true else { throw LidFailure("activation-not-observed") }
                    let confirmed = readSafety()
                    if let refusal = confirmed.refusal { throw LidFailure(refusal) }
                    if !applicationTrial { record.began = now() }
                    record.deadline = record.began + duration
                    guard now() < record.deadline else { throw LidFailure("activation-expired") }
                    record.clientPulse = record.began; record.helperPulse = record.began
                    record.phase = "active"; try journal.write(record)
                } catch { try restore(&record, reason: "start-failed", sleep: safety.lidClosed == true) }
            case "pulse":
                guard input.count == 2, record.phase == "active", record.mode == "timed", record.identity == id, record.boot == boot else { throw LidFailure("lease-not-active") }
                // A heartbeat cannot revive an expired or stale lease, including
                // when a request sat queued behind another transition.
                guard time < record.deadline, time - record.clientPulse <= lidHeartbeatLimit else {
                    try restore(&record, reason: time >= record.deadline ? "expired" : "supervision-lost", sleep: safety.lidClosed == true); return
                }
                record.clientPulse = time; try journal.write(record)
            case "adjust":
                guard (!record.draining || applicationTrial), !experiment, input.count == 3, record.mode == "timed", record.phase == "active", record.identity == id,
                      let number = input["allowance"] as? NSNumber,
                      case let seconds = number.doubleValue, [300.0, 900, 1800, 3600, 7200].contains(seconds) else { throw LidFailure("adjust-refused") }
                guard record.boot == boot, time < record.deadline, time - record.clientPulse <= lidHeartbeatLimit else {
                    try restore(&record, reason: time >= record.deadline ? (record.mode == "work" ? "work-expired" : "expired") : "supervision-lost", sleep: safety.lidClosed == true); return
                }
                record.allowance = seconds; record.deadline = record.began + (applicationTrial ? min(seconds, 60) : seconds)
                try journal.write(record)
                if time >= record.deadline { try restore(&record, reason: "expired", sleep: safety.lidClosed == true) }
            case "stop", "sleep":
                guard input.count == 2, record.identity == id else { throw LidFailure("identity-mismatch") }
                guard record.needsRestore || record.phase == "lid-open" else { throw LidFailure("lease-not-active") }
                try restore(&record, reason: op == "sleep" ? "sleep-requested" : "stopped", sleep: op == "sleep" || safety.lidClosed == true)
            case "retry":
                guard record.needsRestore else { throw LidFailure("nothing-to-restore") }
                let recoverySafety = readSafety()
                let reason = recoverySafety.refusal ?? record.reason ?? "recovered"
                let sleep = record.sleepRequested || recoverySafety.lidClosed == true || recoverySafety.thermal == "critical"
                try restore(&record, reason: reason, sleep: sleep)
            case "dismiss":
                guard !record.needsRestore, ["ended", "lid-open"].contains(record.phase), safety.sleepDisabled == false else { throw LidFailure("dismiss-refused") }
                record.phase = "off"; record.identity = nil; record.deadline = 0; record.allowance = 0
                if record.version == 2 {
                    record.mode = "timed"; record.renewalSequence = 0; record.hardDeadline = nil
                }
                try journal.write(record)
            case "exercise-protection":
                guard experiment, input.count == 3, record.phase == "active", record.identity == id,
                      let reason = input["scenario"] as? String, ["thermal", "battery-reserve", "monitoring-unavailable"].contains(reason) else { throw LidFailure("exercise-refused") }
                try restore(&record, reason: reason, sleep: safety.lidClosed == true)
            default: throw LidFailure("invalid-command")
            }
        }
        return commandSnapshot(try journal.read(boot: boot))
    }
}

struct LidPowerChild: Codable {
    var version = 1
    var process: LidProcessIdentity
    var parent: LidProcessIdentity
    var action: String
    var began: Double
}
func lidProcessRunning(_ identity: LidProcessIdentity) -> Bool {
    guard LidProcessIdentity.read(identity.pid) == identity else { return false }
    var info = proc_bsdinfo()
    guard proc_pidinfo(identity.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return false }
    // Darwin's SZOMB process state cannot execute another power mutation.
    return info.pbi_status != 5
}
func lidDurableData(_ data: Data, _ path: String) throws {
    let temp = path + "." + UUID().uuidString
    let fd = open(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw LidFailure("command-journal-unavailable") }
    defer { close(fd); unlink(temp) }
    let count = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
    guard count == data.count, fsync(fd) == 0, rename(temp, path) == 0 else { throw LidFailure("command-journal-unavailable") }
    let dir = open(URL(fileURLWithPath: path).deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY)
    guard dir >= 0 else { throw LidFailure("command-journal-unavailable") }
    defer { close(dir) }
    guard fsync(dir) == 0 else { throw LidFailure("command-journal-unavailable") }
}
final class LidPowerTracker {
    let path: String
    let trusted: (LidProcessIdentity) -> Bool
    init(directory: String, trusted: @escaping (LidProcessIdentity) -> Bool) {
        path = directory + "/power-child.json"; self.trusted = trusted
    }
    func readChild() throws -> LidPowerChild? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw LidFailure("command-journal-unavailable") }
        defer { close(fd) }
        var buffer = [UInt8](repeating: 0, count: 1025)
        let count = Darwin.read(fd, &buffer, buffer.count)
        guard count > 0, count <= 1024 else { throw LidFailure("command-journal-invalid") }
        let child = try JSONDecoder().decode(LidPowerChild.self, from: Data(buffer.prefix(count)))
        guard child.version == 1, ["enable", "restore", "sleep"].contains(child.action), child.began.isFinite else { throw LidFailure("command-journal-invalid") }
        return child
    }
    func record(_ pid: pid_t, action: String) throws {
        guard let process = LidProcessIdentity.read(pid), let parent = LidProcessIdentity.read(getpid()) else { throw LidFailure("command-identity-unavailable") }
        try lidDurableData(JSONEncoder().encode(LidPowerChild(process: process, parent: parent, action: action, began: lidContinuousTime())), path)
    }
    func retire() throws {
        guard let child = try readChild() else { return }
        if lidProcessRunning(child.process) {
            guard trusted(child.process) else { throw LidFailure("command-owner-unverified") }
            guard kill(child.process.pid, SIGKILL) == 0 || errno == ESRCH else { throw LidFailure("command-retirement-failed") }
            let until = lidContinuousTime() + 1
            while lidProcessRunning(child.process) && lidContinuousTime() < until { usleep(20_000) }
            guard !lidProcessRunning(child.process) else { throw LidFailure("command-retirement-unconfirmed") }
        }
        guard unlink(path) == 0 || errno == ENOENT else { throw LidFailure("command-journal-unavailable") }
        let directory = open(URL(fileURLWithPath: path).deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY)
        guard directory >= 0 else { throw LidFailure("command-journal-unavailable") }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw LidFailure("command-journal-unavailable") }
    }
}
func lidAwaitPowerCommit() throws {
    var byte: UInt8 = 0
    guard read(STDIN_FILENO, &byte, 1) == 1 && byte == 71 else { throw LidFailure("command-not-committed") }
}

enum LidExperimentSignal: String { case none, sleep, cancel }
func lidReadExperimentSignal() throws -> LidExperimentSignal {
    var input = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
    let available = poll(&input, 1, 0)
    guard available >= 0 else { throw LidFailure("experiment-input-failed") }
    if available == 0 { return .none }
    var byte: UInt8 = 0
    let count = read(STDIN_FILENO, &byte, 1)
    if count == 0 { return .cancel }
    guard count == 1 else { throw LidFailure("experiment-input-failed") }
    switch byte {
    case 83: return .sleep
    case 67: return .cancel
    case 10, 13: return .none
    default: throw LidFailure("invalid-experiment-signal")
    }
}
