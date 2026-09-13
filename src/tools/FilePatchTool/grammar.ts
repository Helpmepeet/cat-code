/**
 * Canonical free-form apply_patch grammar.
 *
 * This is intentionally a generation grammar, not a replacement for the
 * runtime parser. The latter remains responsible for source spans, marker
 * attachment, historical wrappers, and useful validation errors.
 */
// Path terminals require at least one non-whitespace character after their
// required separator, matching parsePath in parser.ts.
export const FILE_PATCH_LARK_GRAMMAR = String.raw`
start: BEGIN _NL operation+ END _NL?

?operation: update | add | delete

update: UPDATE _NL (MOVE _NL)? hunk+
add: ADD _NL add_line*
   | ADD _NL add_line* add_line_no_newline
delete: DELETE _NL

hunk: hunk_header+ (hunk_line+ (EOF_MARKER _NL)? | EOF_MARKER _NL)
hunk_header: HUNK_HEADER _NL
hunk_line: PATCH_LINE _NL no_newline?
add_line: ADD_LINE _NL
add_line_no_newline: ADD_LINE _NL no_newline
no_newline: NO_NEWLINE _NL

BEGIN: "*** Begin Patch"
END: "*** End Patch"
UPDATE: /\*\*\* Update File: [^\r\n]*\S[^\r\n]*/
ADD: /\*\*\* Add File: [^\r\n]*\S[^\r\n]*/
DELETE: /\*\*\* Delete File: [^\r\n]*\S[^\r\n]*/
MOVE: /\*\*\* Move to: [^\r\n]*\S[^\r\n]*/
HUNK_HEADER: /@@(?: [^\r\n]*)?/
EOF_MARKER: "*** End of File"
NO_NEWLINE: "\\ No newline at end of file"
ADD_LINE: /\+[^\r\n]*/
PATCH_LINE: / [^\r\n]*/ | /-[^\r\n]*/ | /\+[^\r\n]*/

_NL: /\r?\n/
`;

// A descriptive alias keeps callers independent of the implementation name.
export const FILE_PATCH_GRAMMAR = FILE_PATCH_LARK_GRAMMAR
