import Foundation
import IOKit
import IOKit.ps
import Security

// Observation only. No assertion creation, registry writes, user-client methods,
// power-setting commands, authorization prompts, or power-source identifiers.
func booleanProperty(_ entry: io_registry_entry_t, _ key: String) -> Any {
    guard entry != 0,
          let value = IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
          CFGetTypeID(value) == CFBooleanGetTypeID() else { return NSNull() }
    return CFBooleanGetValue((value as! CFBoolean))
}

func signingObservation(_ path: String) -> [String: Any] {
    var code: SecStaticCode?
    let loaded = SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code)
    guard loaded == errSecSuccess, let code else {
        return ["status": "unavailable", "errorCode": loaded]
    }
    let valid = SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil)
    guard valid == errSecSuccess else {
        return ["status": "unavailable", "errorCode": valid]
    }
    var information: CFDictionary?
    let copied = SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
    guard copied == errSecSuccess, let info = information as? [String: Any] else {
        return ["status": "unavailable", "errorCode": copied]
    }
    let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    func declared(_ key: String) -> Bool {
        guard let value = entitlements[key] else { return false }
        return CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() && (value as? Bool) == true
    }
    let battery = declared("com.apple.private.iokit.assertonbattery")
    let lid = declared("com.apple.private.iokit.assertonlidclose")
    return [
        "status": battery && lid ? "declared-unverified" : "missing",
        "assertOnBatteryDeclared": battery,
        "assertOnLidCloseDeclared": lid
    ]
}

func batteryObservation() -> [String: Any] {
    guard let information = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let sources = IOPSCopyPowerSourcesList(information)?.takeRetainedValue() as? [CFTypeRef] else {
        return ["status": "unavailable"]
    }
    for source in sources {
        guard let description = IOPSGetPowerSourceDescription(information, source)?.takeUnretainedValue() as? [String: Any],
              description[kIOPSTypeKey] as? String == kIOPSInternalBatteryType else { continue }
        guard let current = description[kIOPSCurrentCapacityKey] as? NSNumber,
              let maximum = description[kIOPSMaxCapacityKey] as? NSNumber,
              maximum.doubleValue > 0, current.doubleValue >= 0,
              current.doubleValue <= maximum.doubleValue,
              let power = description[kIOPSPowerSourceStateKey] as? String,
              power == kIOPSBatteryPowerValue || power == kIOPSACPowerValue else {
            return ["status": "unavailable"]
        }
        return ["status": "observed", "percent": current.doubleValue / maximum.doubleValue * 100,
                "onBattery": power == kIOPSBatteryPowerValue]
    }
    return ["status": "no-internal-battery-observed"]
}

let arguments = CommandLine.arguments
if arguments.count > 2 {
    FileHandle.standardError.write(Data("Usage: inspect [app-bundle]\n".utf8))
    exit(2)
}
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
let observation: [String: Any] = [
    "schemaVersion": 1,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
    "powerControlSupported": false,
    "hardwareQualified": false,
    "assertionAuthority": signingObservation(arguments.count == 2 ? arguments[1] : "/Applications/Cat Code.app"),
    "lidClosed": booleanProperty(root, "AppleClamshellState"),
    "clamshellCausesSleep": booleanProperty(root, "AppleClamshellCausesSleep"),
    "systemSleepDisabled": booleanProperty(root, "SleepDisabled"),
    "battery": batteryObservation(),
    "thermalCategory": thermal,
    "thermalMonitoringQualified": false
]
do {
    let encoded = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("Could not encode the observation.\n".utf8))
    exit(1)
}
