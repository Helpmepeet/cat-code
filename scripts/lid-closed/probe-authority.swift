import Foundation
import IOKit.pwr_mgt

// This executable changes live power assertions if the OS grants authority.
// It requires explicit operator authorization; never run it as part of tests.
guard CommandLine.arguments == [CommandLine.arguments[0], "--probe-authority"] else {
    FileHandle.standardError.write(Data("Explicit --probe-authority is required.\n".utf8))
    exit(2)
}
let properties: [String: Any] = [
    kIOPMAssertionTypeKey: kIOPMAssertionTypePreventSystemSleep,
    kIOPMAssertionNameKey: "Cat Code lid-closed authority probe",
    kIOPMAssertionLevelKey: kIOPMAssertionLevelOn,
    kIOPMAssertionTimeoutKey: 2.0,
    kIOPMAssertionTimeoutActionKey: kIOPMAssertionTimeoutActionRelease,
    "AppliesToLimitedPower": true,
    "AppliesOnLidClose": true
]
var assertion: IOPMAssertionID = 0
let created = IOPMAssertionCreateWithProperties(properties as CFDictionary, &assertion)
var observation: [String: Any] = [
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "createResult": String(format: "0x%08x", created),
    "created": created == kIOReturnSuccess,
    "hardwareQualified": false
]
if created == kIOReturnSuccess {
    let released = IOPMAssertionRelease(assertion)
    observation["releaseResult"] = String(format: "0x%08x", released)
    observation["releaseSucceeded"] = released == kIOReturnSuccess
    // Successful creation and release still establish neither closed-lid progress
    // nor observed sleep. Requested timeout and process exit are cleanup paths;
    // their installed-OS behavior remains unqualified.
    if released != kIOReturnSuccess { exitWithObservation(observation, code: 1) }
}
exitWithObservation(observation, code: 0)

func exitWithObservation(_ observation: [String: Any], code: Int32) -> Never {
    do {
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("Could not encode the probe result.\n".utf8))
        exit(1)
    }
    exit(code)
}
