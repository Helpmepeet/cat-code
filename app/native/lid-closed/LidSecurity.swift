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
