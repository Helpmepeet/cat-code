import Foundation
import Security
import Darwin

// Mode bits alone do not exclude an ACL that grants another user write access.
// Conservatively refuse every write-granting allow entry, including inherited
// entries. Deny entries (for example deletion protection) need not be removed.
func lidReadOnlyACL(_ path: String) -> Bool {
    guard let acl = acl_get_file(path, ACL_TYPE_EXTENDED) else {
        // APFS reports ENOENT for an existing object with no extended ACL.
        guard errno == ENOENT else { return false }
        var info = stat()
        return lstat(path, &info) == 0
    }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    guard acl_valid(acl) == 0 else { return false }
    var entry: acl_entry_t?
    var key = Int32(ACL_FIRST_ENTRY.rawValue)
    while acl_get_entry(acl, key, &entry) == 0 {
        key = Int32(ACL_NEXT_ENTRY.rawValue)
        guard let entry else { return false }
        var tag = ACL_UNDEFINED_TAG
        var permissions: acl_permset_t?
        guard acl_get_tag_type(entry, &tag) == 0, acl_get_permset(entry, &permissions) == 0,
              let permissions else { return false }
        if tag == ACL_EXTENDED_ALLOW {
            for bit in [ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_DELETE, ACL_DELETE_CHILD,
                        ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER] {
                if acl_get_perm_np(permissions, bit) != 0 { return false }
            }
        }
    }
    return true
}

// Apple codesign's version-1 library constraint encoding. Compare the whole
// signed blob, not a caller-authored claim that an allowlist was installed.
// An OS encoding change fails closed and needs qualification again.
func lidLibraryConstraint(_ hashes: [Data]) -> Data {
    func der(_ tag: UInt8, _ value: Data) -> Data {
        let count = value.count
        let length: [UInt8] = count < 128 ? [UInt8(count)] :
            count < 256 ? [0x81, UInt8(count)] : [0x82, UInt8(count >> 8), UInt8(count & 255)]
        return Data([tag] + length) + value
    }
    func text(_ value: String) -> Data { der(0x0c, Data(value.utf8)) }
    func entry(_ key: String, _ value: Data) -> Data { der(0x30, text(key) + value) }
    let list = hashes.sorted { $0.lexicographicallyPrecedes($1) }.reduce(Data()) { $0 + der(0x04, $1) }
    let membership = der(0xb0, entry("$in", der(0x30, list)))
    let requirements = der(0xb0, entry("cdhash", membership))
    let dictionary = der(0xb0, entry("ccat", Data([2, 1, 0])) + entry("comp", Data([2, 1, 1])) +
        entry("reqs", requirements) + entry("vers", Data([2, 1, 1])))
    let value = der(0x70, Data([2, 1, 1]) + dictionary)
    let size = UInt32(value.count + 8)
    return Data([0xfa, 0xde, 0x81, 0x81, UInt8(size >> 24), UInt8((size >> 16) & 255),
        UInt8((size >> 8) & 255), UInt8(size & 255)]) + value
}

func lidConstrainedLibraries(_ bundle: URL, _ code: SecStaticCode) -> Bool {
    let paths = [
        "Electron Framework.framework/Versions/A/Electron Framework",
        "Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
        "Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib",
        "Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
        "Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib",
        "Mantle.framework/Versions/A/Mantle", "ReactiveObjC.framework/Versions/A/ReactiveObjC",
        "Squirrel.framework/Versions/A/Squirrel",
    ]
    var hashes: [Data] = []
    for path in paths {
        var library: SecStaticCode?
        let url = bundle.appendingPathComponent("Contents/Frameworks/" + path)
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &library) == errSecSuccess, let library,
              SecStaticCodeCheckValidity(library, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else { return false }
        var signing: CFDictionary?
        guard SecCodeCopySigningInformation(library, SecCSFlags(rawValue: kSecCSSigningInformation), &signing) == errSecSuccess,
              let hash = (signing as? [String: Any])?[kSecCodeInfoUnique as String] as? Data, hash.count == 20 else { return false }
        hashes.append(hash)
    }
    var signing: CFDictionary?
    // Security exposes the embedded constraint through its internal-info
    // dictionary on the qualified OS. Missing/changed SPI is a refusal.
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSInternalInformation), &signing) == errSecSuccess,
          let blob = (signing as? [String: Any])?["LibraryConstraints"] as? Data else { return false }
    return blob == lidLibraryConstraint(hashes)
}

func lidUndebuggedCode(_ pid: pid_t) -> Bool {
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &guest) == errSecSuccess,
          let guest else { return false }
    var signing: CFDictionary?
    // This C API accepts dynamic SecCode references as well as SecStaticCode.
    guard SecCodeCopySigningInformation(unsafeBitCast(guest, to: SecStaticCode.self),
        SecCSFlags(rawValue: kSecCSDynamicInformation), &signing) == errSecSuccess,
        let status = (signing as? [String: Any])?[kSecCodeInfoStatus as String] as? NSNumber else { return false }
    let required = SecCodeStatus.valid.rawValue | SecCodeStatus.hard.rawValue | SecCodeStatus.kill.rawValue
    return status.uint32Value & required == required && status.uint32Value & SecCodeStatus.debugged.rawValue == 0
}

func lidSafeApplicationArguments(_ pid: pid_t) -> Bool {
    // Chromium debugging and V8 startup switches can change behavior without
    // changing the executable signature. Admit only ordinary app launches and
    // a separate Chromium state directory. Never retain/log the environment.
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 1_048_576
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, UInt32(mib.count), &bytes, &size, nil, 0) == 0, size > 4 else { return false }
    let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard argc >= 1, argc <= 8 else { return false }
    var cursor = 4
    func string() -> String? {
        let start = cursor
        while cursor < size && bytes[cursor] != 0 { cursor += 1 }
        guard cursor < size, cursor - start < 8192 else { return nil }
        let value = String(bytes: bytes[start..<cursor], encoding: .utf8)
        cursor += 1
        return value
    }
    guard string() != nil else { return false }
    while cursor < size && bytes[cursor] == 0 { cursor += 1 }
    guard string() != nil else { return false } // argv[0]
    for _ in 1..<argc {
        guard let argument = string(), argument.hasPrefix("--user-data-dir=/") ||
              argument.range(of: #"^-psn_[0-9]+_[0-9]+$"#, options: .regularExpression) != nil else { return false }
    }
    return true
}
