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
                if value && failStart { throw LidFailure("test-partial-activation") }
            }, requestSleep: {
                precondition(safety.sleepDisabled == false, "sleep requested before restoration")
                let settled = try journal.read(boot: "boot-a")
                precondition(!settled.needsRestore && settled.sleepRequestAttempted, "sleep requested without durable settlement")
                sleeps += 1
            })
        let id = UUID().uuidString
        func start(_ seconds: Double = 900) throws { _ = try controller.command(["op": "start", "identity": id, "allowance": seconds]) }
        func reject(_ input: [String: Any]) {
            do { _ = try controller.command(input); preconditionFailure("invalid command accepted") } catch {}
        }
        reject(["op": "start", "identity": id, "allowance": 30])
        reject(["op": "start", "identity": id, "allowance": 900, "path": "/tmp/arbitrary"])
        safety.sleepDisabled = true; reject(["op": "start", "identity": id, "allowance": 900])
        precondition(mutations == 0, "pre-existing override changed")
        safety.sleepDisabled = false
        try start()
        precondition(controller.snapshot().record.phase == "active")
        let original = controller.snapshot().record.deadline
        safety.lidClosed = true; time += 1; try controller.tick()
        safety.lidClosed = false; time += 1; try controller.tick()
        precondition(controller.snapshot().record.phase == "lid-open" && safety.sleepDisabled == false)
        precondition(controller.snapshot().restorationConfirmed, "settled lid-open restoration not confirmed")
        time += 20
        _ = try controller.command(["op": "continue", "identity": id])
        precondition(controller.snapshot().record.deadline == original, "Continue renewed deadline")
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
        try start(); safety.lidClosed = true; safety.thermal = "serious"; time += 1; try controller.tick()
        precondition(controller.snapshot().record.reason == "thermal" && sleeps == 1 && safety.sleepDisabled == false)
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
        _ = try controller.command(["op": "sleep", "identity": id])
        precondition(sleeps == 2 && controller.snapshot().record.needsRestore == false)
        // Interrupted receipt after a committed sleep must not request sleep
        // again on wake. Restoration remains independently retryable.
        var interruptedSleep = try journal.read(boot: "boot-a")
        interruptedSleep.needsRestore = true; interruptedSleep.phase = "restoring"
        interruptedSleep.sleepRequestSucceeded = nil
        try journal.write(interruptedSleep)
        try controller.recoverInterrupted()
        precondition(sleeps == 2, "recovery repeated committed sleep")
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
        try controller.resumeAfterInstall()
        try experimentStart()
        _ = try controller.command(["op": "stop", "identity": id], experiment: true)
        rejectExperimentStart()
        try controller.resumeAfterInstall()
        failStart = true; try experimentStart(); failStart = false
        precondition(safety.sleepDisabled == false)
        rejectExperimentStart()
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
