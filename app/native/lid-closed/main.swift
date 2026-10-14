import Foundation
import Darwin
import CryptoKit

@objc protocol LidControl {
    func command(_ request: Data, reply: @escaping (Data) -> Void)
}
func lidResponse(_ snapshot: LidSnapshot?, _ error: String? = nil) -> Data {
    var result: [String: Any] = ["ok": error == nil]
    if let snapshot, let data = try? JSONEncoder().encode(snapshot), let object = try? JSONSerialization.jsonObject(with: data) {
        result["snapshot"] = object
    }
    if let error { result["error"] = error }
    return (try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"encoding-failed\"}".utf8)
}

final class LidEndpoint: NSObject, LidControl {
    weak var connection: NSXPCConnection?
    let controller: LidController
    let configuration: LidConfiguration
    let queue: DispatchQueue
    var rateWindow = Date(); var count = 0
    init(_ connection: NSXPCConnection, _ controller: LidController, _ configuration: LidConfiguration, _ queue: DispatchQueue) {
        self.connection = connection; self.controller = controller; self.configuration = configuration; self.queue = queue
    }
    func command(_ request: Data, reply: @escaping (Data) -> Void) {
        queue.async {
            if Date().timeIntervalSince(self.rateWindow) > 1 { self.rateWindow = Date(); self.count = 0 }
            self.count += 1
            guard request.count <= 1024, self.count <= 8, let connection = self.connection,
                  let experiment = lidAuthenticatedRole(connection, self.configuration) else {
                reply(lidResponse(nil, "caller-refused")); return
            }
            do {
                guard let object = try JSONSerialization.jsonObject(with: request) as? [String: Any] else { throw LidFailure("invalid-command") }
                reply(lidResponse(try self.controller.command(object, experiment: experiment)))
            } catch {
                reply(lidResponse(self.controller.snapshot(), (error as? LidFailure)?.message ?? "operation-failed"))
            }
        }
    }
}
final class LidListener: NSObject, NSXPCListenerDelegate {
    let configuration: LidConfiguration
    let controller: LidController
    let queue = DispatchQueue(label: "com.catcode.lid.transitions")
    init(_ configuration: LidConfiguration, _ controller: LidController) { self.configuration = configuration; self.controller = controller }
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard lidAuthenticatedRole(connection, configuration) != nil else { return false }
        connection.exportedInterface = NSXPCInterface(with: LidControl.self)
        connection.exportedObject = LidEndpoint(connection, controller, configuration, queue)
        // Native bridge EOF and main loss stop fresh heartbeats. The independent
        // watcher observes the same five-second limit even if this daemon stalls.
        connection.invalidationHandler = { [weak self] in self?.queue.async { try? self?.controller.tick() } }
        connection.resume()
        return true
    }
}

func lidClient() throws {
    let connection = NSXPCConnection(machServiceName: lidService, options: [.privileged])
    connection.remoteObjectInterface = NSXPCInterface(with: LidControl.self)
    connection.resume()
    defer { connection.invalidate() }
    // Bounded byte-at-a-time framing avoids readLine allocating an arbitrary
    // length before the privileged message boundary checks it.
    var line = Data()
    var byte: UInt8 = 0
    while read(STDIN_FILENO, &byte, 1) == 1 {
        if byte != 10 {
            guard line.count < 1024 else { throw LidFailure("request-too-large") }
            line.append(byte); continue
        }
        let request = line; line.removeAll(keepingCapacity: true)
        let done = DispatchSemaphore(value: 0)
        var response = lidResponse(nil, "helper-unavailable")
        let proxy = connection.remoteObjectProxyWithErrorHandler { _ in done.signal() }
        guard let control = proxy as? LidControl else { throw LidFailure("helper-unavailable") }
        control.command(request) { data in if data.count <= 16384 { response = data }; done.signal() }
        guard done.wait(timeout: .now() + 10) == .success else { throw LidFailure("helper-unavailable") }
        FileHandle.standardOutput.write(response); FileHandle.standardOutput.write(Data([10]))
    }
}

func lidExperiment(_ scenario: String) throws {
    guard ["progress", "supervision", "sleep", "thermal", "battery-reserve", "monitoring-unavailable"].contains(scenario) else { throw LidFailure("invalid-scenario") }
    let child = Process(); child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); child.arguments = ["--client"]
    let input = Pipe(); let output = Pipe()
    child.standardInput = input; child.standardOutput = output; child.standardError = FileHandle.standardError
    try child.run()
    defer { try? input.fileHandleForWriting.close(); if child.isRunning { child.terminate() } }
    func command(_ value: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: value)
        try input.fileHandleForWriting.write(contentsOf: data + Data([10]))
        var result = Data()
        let readDeadline = lidContinuousTime() + 12
        while true {
            var fd = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
            guard lidContinuousTime() < readDeadline, poll(&fd, 1, 1000) >= 0 else { throw LidFailure("bridge-timeout") }
            if fd.revents == 0 { continue }
            guard let next = try output.fileHandleForReading.read(upToCount: 1), !next.isEmpty else { throw LidFailure("bridge-disconnected") }
            if next[0] == 10 { break }
            guard result.count < 16384 else { throw LidFailure("reply-too-large") }; result.append(next)
        }
        guard let response = try JSONSerialization.jsonObject(with: result) as? [String: Any] else { throw LidFailure("invalid-reply") }
        return response
    }
    let id = UUID().uuidString
    defer { _ = try? command(["op": "stop", "identity": id]) }
    let begin = try command(["op": "start", "identity": id, "allowance": 60.0])
    print(String(data: try JSONSerialization.data(withJSONObject: begin), encoding: .utf8)!)
    guard begin["ok"] as? Bool == true, let startedSnapshot = begin["snapshot"] as? [String: Any],
          let startedRecord = startedSnapshot["record"] as? [String: Any],
          let startedSafety = startedSnapshot["safety"] as? [String: Any],
          startedRecord["phase"] as? String == "active", startedRecord["identity"] as? String == id,
          startedRecord["needsRestore"] as? Bool == true, startedSafety["sleepDisabled"] as? Bool == true else {
        throw LidFailure("experiment-start-refused")
    }
    let started = lidContinuousTime()
    var sequence = 0
    var protectionSent = false
    while lidContinuousTime() - started < 75 {
        let elapsed = lidContinuousTime() - started
        let response: [String: Any]
        if scenario == "sleep" {
            switch try lidReadExperimentSignal() {
            case .sleep: response = try command(["op": "sleep", "identity": id])
            case .cancel: response = try command(["op": "stop", "identity": id])
            case .none: response = try command(["op": "pulse", "identity": id])
            }
        }
        else if elapsed < 10 || scenario == "progress" { response = try command(["op": "pulse", "identity": id]) }
        else if ["thermal", "battery-reserve", "monitoring-unavailable"].contains(scenario) && !protectionSent {
            protectionSent = true
            response = try command(["op": "exercise-protection", "identity": id, "scenario": scenario])
        } else { response = try command(["op": "status"]) }
        // Experimental auto-removal can close XPC before the next sample.
        // That loses status visibility; it does not prove restoration failed.
        guard let rawSnapshot = response["snapshot"] else { throw LidFailure("experiment-status-unavailable") }
        let observed = try JSONDecoder().decode(LidSnapshot.self, from: JSONSerialization.data(withJSONObject: rawSnapshot))
        let sample: [String: Any] = ["observedAt": ISO8601DateFormatter().string(from: Date()),
            "elapsedSeconds": elapsed, "progressSequence": sequence,
            "workBytesHashed": (sequence + 1) * 65536,
            "workDigest": SHA256.hash(data: Data(repeating: UInt8(truncatingIfNeeded: sequence), count: 65536)).map { String(format: "%02x", $0) }.joined(),
            "response": response]
        print(String(data: try JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys]), encoding: .utf8)!)
        fflush(stdout)
        if observed.restorationConfirmed { return }
        sequence += 1; Thread.sleep(forTimeInterval: 1)
    }
    let final = try command(["op": "status"])
    guard let rawSnapshot = final["snapshot"] else { throw LidFailure("experiment-status-unavailable") }
    let observed = try JSONDecoder().decode(LidSnapshot.self, from: JSONSerialization.data(withJSONObject: rawSnapshot))
    guard observed.restorationConfirmed else { throw LidFailure("experiment-restoration-unresolved") }
}

let args = CommandLine.arguments
 do {
    guard args.count >= 2 else { throw LidFailure("operation-required") }
    switch args[1] {
    case "--power-command":
        guard args.count == 3, geteuid() == 0 else { throw LidFailure("root-required") }
        try lidExecPowerCommand(args[2])
    case "--client": guard args.count == 2, geteuid() != 0 else { throw LidFailure("invalid-client") }; try lidClient()
    case "--experiment":
        guard args.count == 3, geteuid() != 0 else { throw LidFailure("invalid-experiment") }; try lidExperiment(args[2])
    case "--daemon":
        guard args.count == 2, geteuid() == 0 else { throw LidFailure("root-required") }
        let configuration = try lidConfiguration(); let controller = try lidProductionController(configuration)
        try lidRegisterJob("daemon")
        // Interrupted recovery is attempted before accepting any new work.
        try lidRecoverBeforeListening(configuration, controller)
        let delegate = LidListener(configuration, controller)
        let listener = NSXPCListener(machServiceName: lidService); listener.delegate = delegate
        let timer = DispatchSource.makeTimerSource(queue: delegate.queue)
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler {
            do { try lidRetireOrphanCommand(configuration); try controller.tick() }
            catch { if (error as? LidFailure)?.message == "transition-pending" { lidRetireStalledOwner(configuration) } }
        }; timer.resume()
        listener.resume(); RunLoop.current.run()
    case "--watch":
        guard args.count == 2, geteuid() == 0 else { throw LidFailure("root-required") }
        let configuration = try lidConfiguration()
        let controller = try lidProductionController(configuration)
        try lidRegisterJob("watcher")
        while true {
            do { try lidRetireOrphanCommand(configuration); try controller.tick(watcher: true) }
            catch { if (error as? LidFailure)?.message == "transition-pending" { lidRetireStalledOwner(configuration) }; FileHandle.standardError.write(Data("recovery-unresolved\n".utf8)) }
            Thread.sleep(forTimeInterval: lidRecoveryPoll)
        }
    case "--recover":
        guard args.count == 2, geteuid() == 0 else { throw LidFailure("root-required") }
        let configuration = try lidConfiguration(); let controller = try lidProductionController(configuration)
        try controller.tick(watcher: true)
    case "--observe":
        guard args.count == 3, geteuid() == 0, let seconds = Int(args[2]), (1...90).contains(seconds) else { throw LidFailure("invalid-observer") }
        let controller = try lidProductionController(lidConfiguration())
        let deadline = lidContinuousTime() + Double(seconds)
        while lidContinuousTime() < deadline {
            let output: [String: Any] = ["observedAt": ISO8601DateFormatter().string(from: Date()),
                "continuousSeconds": lidContinuousTime(), "response": try JSONSerialization.jsonObject(with: lidResponse(controller.snapshot()))]
            print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
            fflush(stdout); Thread.sleep(forTimeInterval: 1)
        }
    case "--restore-for-uninstall":
        guard args.count == 2, geteuid() == 0 else { throw LidFailure("root-required") }
        let controller = try lidProductionController(lidConfiguration())
        try controller.retire()
    case "--resume-after-install":
        guard args.count == 2, geteuid() == 0 else { throw LidFailure("root-required") }
        let controller = try lidProductionController(lidConfiguration())
        try controller.resumeAfterInstall()
    case "--guard-experiment":
        guard args.count == 2, geteuid() == 0 else { throw LidFailure("root-required") }
        try lidGuardExperiment()
    default: throw LidFailure("invalid-operation")
    }
} catch {
    FileHandle.standardError.write(Data(((error as? LidFailure)?.message ?? "operation-failed").utf8) + Data([10]))
    exit(1)
}
