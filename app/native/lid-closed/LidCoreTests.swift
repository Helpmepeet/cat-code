import Foundation
import Darwin

@main struct LidCoreTests {
    static func main() throws {
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--signal-child" {
            print(try lidReadExperimentSignal().rawValue)
            return
        }
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--gate-child" {
            try lidAwaitPowerCommit()
            try Data("committed".utf8).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
            Thread.sleep(forTimeInterval: 30)
            return
        }
        let root = CommandLine.arguments[1]
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: root) }
        // Real stdin/EOF boundary for the explicit Sleep cue. An untouched
        // open pipe cannot request sleep; disconnect means cancel.
        for (bytes, closeInput, expected) in [(Data([83]), false, "sleep"), (Data([67]), false, "cancel"), (Data(), true, "cancel"), (Data(), false, "none")] {
            let reader = Process(); reader.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            reader.arguments = ["--signal-child"]
            let input = Pipe(); let output = Pipe(); reader.standardInput = input; reader.standardOutput = output
            try input.fileHandleForWriting.write(contentsOf: bytes)
            if closeInput { try input.fileHandleForWriting.close() }
            try reader.run(); reader.waitUntilExit()
            let value = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
            precondition(reader.terminationStatus == 0 && value == expected + "\n", "operator signal or EOF misclassified")
            if !closeInput { try input.fileHandleForWriting.close() }
        }
        var time: Double = 100
        var safety = LidSafety(sleepDisabled: false, lidClosed: false, batteryPercent: 70, onBattery: true, thermal: "nominal")
        var failRestore = false
        var failStart = false
        var activationDelay: Double = 0
        var thermalOnRestore = false
        var sleeps = 0
        var mutations = 0
        let journal = LidJournal(root)
        let controller = LidController(journal: journal, boot: "boot-a", qualified: true, now: { time },
            readSafety: { safety }, setDisabled: { value in
                mutations += 1
                let before = try journal.read(boot: "boot-a")
                precondition(before.needsRestore && ["starting", "restoring"].contains(before.phase), "power change without durable intent")
                if !value && failRestore { throw LidFailure("test-restoration-failure") }
                safety.sleepDisabled = value
                if !value && thermalOnRestore {
                    thermalOnRestore = false
                    safety.thermal = "critical"
                }
                if value && failStart { throw LidFailure("test-partial-activation") }
                if value { time += activationDelay }
            }, requestSleep: {
                precondition(safety.sleepDisabled == false, "sleep requested before restoration")
                let settled = try journal.read(boot: "boot-a")
                precondition(!settled.needsRestore && settled.sleepRequestAttempted, "sleep requested without durable settlement")
                sleeps += 1
            })
        let legacyJournal = root + "/legacy"
        try FileManager.default.createDirectory(atPath: legacyJournal, withIntermediateDirectories: true)
        let legacyJSON = """
        {"version":1,"phase":"active","identity":"\(UUID().uuidString)","boot":"boot-a","began":1,"deadline":20,"allowance":300,"clientPulse":2,"helperPulse":3,"needsRestore":true}
        """
        try Data(legacyJSON.utf8).write(to: URL(fileURLWithPath: legacyJournal + "/recovery.json"))
        let legacy = LidJournal(legacyJournal)
        let decodedLegacy = try legacy.read(boot: "boot-a")
        precondition(decodedLegacy.version == 1 && decodedLegacy.mode == "timed" && decodedLegacy.renewalSequence == 0 && decodedLegacy.hardDeadline == nil)
        var restoredLegacy = decodedLegacy
        restoredLegacy.needsRestore = false
        restoredLegacy.phase = "ended"
        try legacy.write(restoredLegacy)
        let preservedLegacy = try String(contentsOfFile: legacyJournal + "/recovery.json", encoding: .utf8)
        precondition(!preservedLegacy.contains("\"mode\"") && !preservedLegacy.contains("\"renewalSequence\""),
                     "writing recovered v1 changed its serialized shape")
        let unknownJournal = root + "/unknown-version"
        try FileManager.default.createDirectory(atPath: unknownJournal, withIntermediateDirectories: true)
        let unknownJSON = "{\"version\":3,\"phase\":\"active\"}"
        try Data(unknownJSON.utf8).write(to: URL(fileURLWithPath: unknownJournal + "/recovery.json"))
        do {
            _ = try LidJournal(unknownJournal).read(boot: "boot-a")
            preconditionFailure("unknown journal version was accepted")
        } catch {}
        let preservedUnknown = try String(contentsOfFile: unknownJournal + "/recovery.json", encoding: .utf8)
        precondition(preservedUnknown == unknownJSON,
                     "unknown journal version was deleted or rewritten")
        let unresolvedUnknown = LidController(journal: LidJournal(unknownJournal), boot: "boot-a", qualified: true,
            now: { time }, readSafety: { safety }, setDisabled: { _ in preconditionFailure("unknown journal changed power") },
            requestSleep: { preconditionFailure("unknown journal requested sleep") }).snapshot()
        precondition(unresolvedUnknown.record.phase == "unresolved" && unresolvedUnknown.error != nil &&
                     !unresolvedUnknown.restorationConfirmed,
                     "unknown journal version did not remain unresolved")
        let workID = UUID().uuidString
        func startWork(_ trial: Bool = false) throws {
            _ = try controller.command(["op": "start-work", "identity": workID], applicationTrial: trial)
        }
        func renewWork(_ sequence: Int64) throws {
            _ = try controller.command(["op": "renew-work", "identity": workID, "sequence": sequence])
        }
        try startWork()
        var work = controller.snapshot().record
        precondition(work.version == 2 && work.mode == "work" && work.phase == "active" && work.renewalSequence == 0 &&
                     work.deadline == time + lidWorkLease && work.hardDeadline == nil)
        let helperPulse = work.helperPulse
        time += 4; try renewWork(1)
        work = controller.snapshot().record
        precondition(work.deadline == time + lidWorkLease && work.clientPulse == time &&
                     work.helperPulse == helperPulse && work.renewalSequence == 1,
                     "work renewal failed to extend only client lease")
        reject(["op": "renew-work", "identity": workID, "sequence": 1])
        reject(["op": "renew-work", "identity": workID, "sequence": 1.5])
        reject(["op": "renew-work", "identity": workID, "sequence": true])
        reject(["op": "renew-work", "identity": workID, "sequence": 9_007_199_254_740_992.0])
        reject(["op": "renew-work", "identity": workID, "sequence": 2, "deadline": time + 100])
        reject(["op": "renew-work", "identity": workID, "sequence": 2, "duration": 100])
        reject(["op": "pulse", "identity": workID])
        reject(["op": "adjust", "identity": workID, "allowance": 900])
        time = work.deadline
        try renewWork(2)
        precondition(controller.snapshot().record.reason == "work-expired" && safety.sleepDisabled == false,
                     "late work renewal revived an expired lease")
        try startWork()
        time += lidHeartbeatLimit + 1
        try renewWork(1)
        precondition(controller.snapshot().record.reason == "supervision-lost" && safety.sleepDisabled == false,
                     "late work renewal revived lost supervision")
        try startWork()
        safety.lidClosed = true
        let sleepsBeforeClosedRecovery = sleeps
        _ = try controller.command(["op": "retry"])
        work = controller.snapshot().record
        precondition(work.reason == "recovered" && work.sleepRequested &&
                     work.sleepRequestAttempted && work.sleepRequestSucceeded == true &&
                     sleeps == sleepsBeforeClosedRecovery + 1 && safety.sleepDisabled == false,
                     "closed-lid recovery did not restore before requesting sleep")
        safety.lidClosed = false
        let longWorkBegan = time
        try startWork()
        for sequence in 1...1470 {
            time += 4.9
            try renewWork(Int64(sequence))
        }
        work = controller.snapshot().record
        precondition(time - longWorkBegan > 7_200 && work.phase == "active" &&
                     work.mode == "work" && work.hardDeadline == nil,
                     "healthy production work stopped at the old two-hour limit")
        _ = try controller.command(["op": "finish-work", "identity": workID])
        precondition(controller.snapshot().record.reason == "work-finished" && safety.sleepDisabled == false)
        let trialAdmission = time
        activationDelay = 3
        try startWork(true)
        activationDelay = 0
        work = controller.snapshot().record
        precondition(work.began == trialAdmission && work.hardDeadline == trialAdmission + 60 &&
                     work.deadline == time + lidWorkLease,
                     "startup delay shifted the immutable trial hard deadline")
        let hardDeadline = work.hardDeadline!
        let trialGuardian = lidGuardianDeadline(observationTime: trialAdmission + 10, activationEnd: hardDeadline)
        let renewableGuardian = lidGuardianDeadline(observationTime: trialAdmission + 10, activationEnd: work.deadline)
        precondition(trialGuardian == trialAdmission + 75 && trialGuardian > renewableGuardian,
                     "trial guardian used the renewable deadline")
        for sequence in 1...25 {
            time += 2
            try renewWork(Int64(sequence))
        }
        work = controller.snapshot().record
        precondition(work.deadline == hardDeadline && work.phase == "active" && work.renewalSequence == 25 &&
                     time < hardDeadline,
                     "trial work renewal exceeded hard deadline: \(work)")
        time = hardDeadline
        let hardCappedLease = try LidJournal(root).read(boot: "boot-a")
        precondition(hardCappedLease.deadline == hardDeadline && hardCappedLease.phase == "active")
        _ = try controller.command(["op": "finish-work", "identity": workID])
        precondition(controller.snapshot().record.reason == "work-expired" && safety.sleepDisabled == false)
        do {
            try startWork(true)
            preconditionFailure("consumed work trial admitted a second activation")
        } catch {}
        try controller.resumeAfterInstall()
        try startWork()
        _ = try controller.command(["op": "finish-work", "identity": workID])
        precondition(controller.snapshot().record.reason == "work-finished" && controller.snapshot().restorationConfirmed)
        try startWork()
        time += 6
        _ = try controller.command(["op": "finish-work", "identity": workID])
        precondition(controller.snapshot().record.reason == "supervision-lost" && safety.sleepDisabled == false,
                     "finish-work overwrote prior supervision failure")
        time += 1
        try startWork()
        thermalOnRestore = true
        let priorThermalSleeps = sleeps
        _ = try controller.command(["op": "finish-work", "identity": workID])
        precondition(controller.snapshot().record.reason == "thermal" && sleeps == priorThermalSleeps + 1 &&
                     safety.sleepDisabled == false, "simultaneous thermal protection lost to work completion")
        safety.thermal = "nominal"
        let id = UUID().uuidString
        func start(_ seconds: Double = 900) throws { _ = try controller.command(["op": "start", "identity": id, "allowance": seconds]) }
        func reject(_ input: [String: Any]) {
            do { _ = try controller.command(input); preconditionFailure("invalid command accepted") } catch {}
        }
        let mutationsBeforeInvalidStarts = mutations
        reject(["op": "start", "identity": id, "allowance": 30])
        reject(["op": "start", "identity": id, "allowance": 900, "path": "/tmp/arbitrary"])
        precondition(mutations == mutationsBeforeInvalidStarts, "refused Start changed power")
        safety.sleepDisabled = true; reject(["op": "start", "identity": id, "allowance": 900])
        precondition(mutations == mutationsBeforeInvalidStarts && safety.sleepDisabled == true, "pre-existing override changed")
        safety.sleepDisabled = false
        safety.lidClosed = true
        reject(["op": "start", "identity": id, "allowance": 900])
        precondition(mutations == mutationsBeforeInvalidStarts && !controller.snapshot().record.needsRestore,
                     "closed-lid Start changed power or admitted intent")
        safety.lidClosed = false
        try start(300)
        precondition(controller.snapshot().record.allowance == 300 && controller.snapshot().record.deadline == time + 300, "five-minute Start did not reach native authority")
        for _ in 0..<75 { time += 4; _ = try controller.command(["op": "pulse", "identity": id]) }
        precondition(controller.snapshot().record.reason == "expired" && safety.sleepDisabled == false, "five-minute lease did not expire and restore")
        try start()
        let shortBegan = time
        time += 4
        _ = try controller.command(["op": "adjust", "identity": id, "allowance": 300])
        precondition(controller.snapshot().record.deadline == shortBegan + 300, "five-minute adjustment reset elapsed time")
        reject(["op": "adjust", "identity": id, "allowance": 600])
        _ = try controller.command(["op": "stop", "identity": id])
        try start()
        precondition(controller.snapshot().record.phase == "active")
        let original = controller.snapshot().record.deadline
        safety.lidClosed = true; time += 1; try controller.tick()
        safety.lidClosed = false; time += 1; try controller.tick()
        precondition(controller.snapshot().record.phase == "active" && safety.sleepDisabled == true, "opening the lid ended the manual timed lease")
        precondition(controller.snapshot().record.deadline == original, "opening the lid reset the deadline")
        time += 6
        _ = try controller.command(["op": "pulse", "identity": id])
        precondition(controller.snapshot().record.phase == "ended" && safety.sleepDisabled == false, "late heartbeat revived stale lease")
        try start()
        time += 6; try controller.tick(watcher: true)
        precondition(controller.snapshot().record.reason == "supervision-lost" && safety.sleepDisabled == false)
        try start()
        time += 4; _ = try controller.command(["op": "pulse", "identity": id])
        time += 2; try controller.tick(watcher: true)
        precondition(controller.snapshot().record.reason == "helper-lost" && safety.sleepDisabled == false, "fresh client defeated stalled-helper recovery")
        failStart = true; try start()
        precondition(controller.snapshot().record.phase == "ended" && safety.sleepDisabled == false)
        failStart = false; try start(); failRestore = true
        _ = try controller.command(["op": "stop", "identity": id])
        precondition(controller.snapshot().record.phase == "unresolved" && controller.snapshot().record.needsRestore)
        reject(["op": "start", "identity": UUID().uuidString, "allowance": 900])
        let revived = LidController(journal: journal, boot: "boot-a", qualified: true, now: { time },
            readSafety: { safety }, setDisabled: { value in
                if failRestore { throw LidFailure("test-restoration-failure") }; safety.sleepDisabled = value
            }, requestSleep: { sleeps += 1 })
        try revived.tick(watcher: true)
        precondition(revived.snapshot().record.phase == "unresolved", "restart lost unresolved restoration")
        failRestore = false
        _ = try revived.command(["op": "retry"])
        precondition(revived.snapshot().record.phase == "ended" && safety.sleepDisabled == false)
        let priorThermalSleepCount = sleeps
        try start(); safety.lidClosed = true; safety.thermal = "serious"; time += 1; try controller.tick()
        precondition(controller.snapshot().record.reason == "thermal" && sleeps == priorThermalSleepCount + 1 && safety.sleepDisabled == false)
        safety.thermal = "fair"; reject(["op": "start", "identity": id, "allowance": 900])
        safety.thermal = "nominal"; safety.lidClosed = false; try start()
        safety.batteryPercent = 20; time += 1; try controller.tick()
        precondition(controller.snapshot().record.reason == "battery-reserve" && safety.sleepDisabled == false)
        safety.batteryPercent = 70; try start(); safety.onBattery = nil; time += 1; try controller.tick()
        precondition(controller.snapshot().record.reason == "monitoring-unavailable" && safety.sleepDisabled == false)
        safety.onBattery = true; try start()
        let began = controller.snapshot().record.began
        for _ in 0..<151 { time += 4; _ = try controller.command(["op": "pulse", "identity": id]) }
        _ = try controller.command(["op": "adjust", "identity": id, "allowance": 1800])
        precondition(controller.snapshot().record.deadline == began + 1800, "adjustment reset elapsed time")
        let committedSleepCount = sleeps
        _ = try controller.command(["op": "sleep", "identity": id])
        precondition(sleeps == committedSleepCount + 1 && controller.snapshot().record.needsRestore == false)
        // Interrupted receipt after a committed sleep must not request sleep
        // again on wake. Restoration remains independently retryable.
        var interruptedSleep = try journal.read(boot: "boot-a")
        interruptedSleep.needsRestore = true; interruptedSleep.phase = "restoring"
        interruptedSleep.sleepRequestSucceeded = nil
        try journal.write(interruptedSleep)
        try controller.recoverInterrupted()
        precondition(sleeps == committedSleepCount + 1, "recovery repeated committed sleep")
        precondition(!controller.snapshot().record.needsRestore, "interrupted restoration remained pending")
        // Daemon restart must end even a freshly supervised lease.
        try start(); try controller.recoverInterrupted()
        precondition(controller.snapshot().record.reason == "interrupted" && safety.sleepDisabled == false, "restart preserved active override")
        // A queued adjustment may not resurrect an already consumed deadline.
        try start(); time = controller.snapshot().record.deadline
        _ = try controller.command(["op": "adjust", "identity": id, "allowance": 1800])
        precondition(controller.snapshot().record.phase == "ended" && controller.snapshot().record.reason == "expired", "expired adjustment revived lease")
        // A fresh heartbeat arriving at the deadline is expiry, not loss of
        // supervision. The native driver emits the same fresh-pulse sequence.
        try start()
        for _ in 0..<225 { time += 4; _ = try controller.command(["op": "pulse", "identity": id]) }
        precondition(controller.snapshot().record.reason == "expired" && safety.sleepDisabled == false, "fresh deadline pulse mislabeled expiry")
        let priorSleeps = sleeps
        try start(); safety.thermal = "critical"; time += 1; try controller.tick()
        precondition(sleeps == priorSleeps + 1 && safety.sleepDisabled == false && controller.snapshot().record.reason == "thermal", "critical thermal state did not request sleep with lid open")
        safety.thermal = "nominal"
        try start(); try controller.retire()
        reject(["op": "start", "identity": id, "allowance": 900])
        precondition(controller.snapshot().record.draining && safety.sleepDisabled == false)
        try controller.resumeAfterInstall(); try start()
        _ = try controller.command(["op": "stop", "identity": id])
        // The experimental admission is single-use independently of guardian
        // scheduling. Pulses still supervise its one admitted lease.
        func experimentStart() throws {
            _ = try controller.command(["op": "start", "identity": id, "allowance": 60], experiment: true)
        }
        func rejectExperimentStart() {
            do { try experimentStart(); preconditionFailure("second experimental lease accepted") } catch {}
        }
        try experimentStart()
        precondition(controller.snapshot().record.draining)
        time += 1; _ = try controller.command(["op": "pulse", "identity": id], experiment: true)
        safety.lidClosed = true; try controller.tick()
        safety.lidClosed = false; time += 1; try controller.tick()
        reject(["op": "continue", "identity": id])
        rejectExperimentStart()
        _ = try controller.command(["op": "stop", "identity": id], experiment: true)
        try controller.resumeAfterInstall()
        try experimentStart()
        _ = try controller.command(["op": "stop", "identity": id], experiment: true)
        rejectExperimentStart()
        try controller.resumeAfterInstall()
        failStart = true; try experimentStart(); failStart = false
        precondition(safety.sleepDisabled == false)
        rejectExperimentStart()
        try controller.resumeAfterInstall()
        do {
            _ = try controller.command(["op": "start", "identity": id, "allowance": 60], applicationTrial: true)
            preconditionFailure("app trial weakened production preset validation")
        } catch {}
        let trialBegan = time
        activationDelay = 3
        _ = try controller.command(["op": "start", "identity": id, "allowance": 900], applicationTrial: true)
        activationDelay = 0
        let trialDeadline = controller.snapshot().record.deadline
        precondition(trialDeadline == trialBegan + 60, "app trial deadline includes activation delay")
        _ = try controller.command(["op": "adjust", "identity": id, "allowance": 7200], applicationTrial: true)
        precondition(controller.snapshot().record.deadline == trialDeadline, "preset adjustment escaped trial cap")
        safety.lidClosed = true; try controller.tick()
        safety.lidClosed = false; time += 1; try controller.tick()
        precondition(controller.snapshot().record.phase == "active" && controller.snapshot().record.deadline == trialDeadline, "lid change escaped trial cap")
        while time < trialDeadline { time = min(time + 1, trialDeadline); _ = try controller.command(["op": "pulse", "identity": id], applicationTrial: true) }
        precondition(controller.snapshot().record.reason == "expired" && controller.snapshot().restorationConfirmed, "trial did not restore on expiry")
        do {
            _ = try controller.command(["op": "start", "identity": UUID().uuidString, "allowance": 900], applicationTrial: true)
            preconditionFailure("second app trial lease admitted without administrator reset")
        } catch {}
        try controller.resumeAfterInstall()
        _ = try controller.command(["op": "start", "identity": id, "allowance": 900], applicationTrial: true)
        safety.lidClosed = true; try controller.tick()
        safety.lidClosed = false; time += 1; try controller.tick()
        try controller.retire()
        do {
            _ = try controller.command(["op": "start", "identity": id, "allowance": 900], applicationTrial: true)
            preconditionFailure("retired trial Start accepted")
        } catch {}
        precondition(controller.snapshot().restorationConfirmed && safety.sleepDisabled == false, "retired trial reactivated")
        // Real native child/pipe/process owner, with a harmless effect. Closing
        // an uncommitted gate forbids the effect; durable tracking then permits
        // precise retirement before another mutation can run.
        let effectPath = root + "/child-effect"
        let child = Process(); child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--gate-child", effectPath]; child.standardError = FileHandle.nullDevice
        let gate = Pipe(); child.standardInput = gate
        try child.run(); try gate.fileHandleForWriting.close(); child.waitUntilExit()
        precondition(child.terminationStatus != 0 && !FileManager.default.fileExists(atPath: effectPath))
        let tracked = Process(); tracked.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        tracked.arguments = ["--gate-child", effectPath]; tracked.standardError = FileHandle.nullDevice
        let committedGate = Pipe(); tracked.standardInput = committedGate
        try tracked.run()
        let tracker = LidPowerTracker(directory: root, trusted: { identity in
            identity.pid == tracked.processIdentifier && LidProcessIdentity.read(identity.pid) == identity
        })
        try tracker.record(tracked.processIdentifier, action: "enable")
        try committedGate.fileHandleForWriting.write(contentsOf: Data([71]))
        try committedGate.fileHandleForWriting.close()
        let until = lidContinuousTime() + 2
        while !FileManager.default.fileExists(atPath: effectPath) && lidContinuousTime() < until { usleep(10_000) }
        precondition(FileManager.default.fileExists(atPath: effectPath))
        try tracker.retire(); tracked.waitUntilExit()
        precondition(tracked.terminationReason == .uncaughtSignal && tracked.terminationStatus == SIGKILL, "tracked child survived retirement")
        let retiredChild = try tracker.readChild(); precondition(retiredChild == nil)
        let fd = open(root + "/transition.lock", O_RDWR)
        precondition(fd >= 0 && flock(fd, LOCK_EX | LOCK_NB) == 0)
        reject(["op": "start", "identity": id, "allowance": 900])
        flock(fd, LOCK_UN); close(fd)
        try Data("{\"version\":999}".utf8).write(to: URL(fileURLWithPath: root + "/recovery.json"))
        precondition(controller.snapshot().record.phase == "unresolved")
        precondition(!controller.snapshot().restorationConfirmed, "unreadable journal reported restored from kernel flag alone")
        reject(["op": "start", "identity": id, "allowance": 900])
        print("PASS: durable activation, partial failure, fixed deadlines, stale pulse, watcher recovery, retry, protections, sleep ordering, lock and corrupt journal")
    }
}
