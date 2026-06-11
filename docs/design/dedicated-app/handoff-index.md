# Dedicated App Handoff Index

Created: 2026-06-06

## Source

- Archive: `/Users/pt/Downloads/catcode-handoff.zip`
- Archive SHA-256:
  `9bea5221d2c1c36124e99011908cf1fa70408031d89f4ae0c4e9793207b8480a`
- Archive manifest summary: 127 files, 13,152,945 bytes uncompressed.
- Bundle root: `catcode/`
- Handoff source: Claude Design (`claude.ai/design`)
- Local inspection paths used during planning:
  - `/tmp/catcode-handoff.B0QRok`
  - `/tmp/catcode-handoff.c17aJ5`

## Primary Prototype

Primary entry:

- `catcode/project/CatCode Web App v3.html`

Reason:

- `catcode/README.md` says this file was open when the user triggered the
  handoff and should be read in full first.
- It loads the current `cat-app/` folder rather than `cat-app-v2-snapshot/`.

Import order:

1. `catcode/project/cat-app/data.js`
2. `catcode/project/cat-app/Sidebar.jsx`
3. `catcode/project/cat-app/Surfaces.jsx`
4. `catcode/project/cat-app/Startup.jsx`
5. `catcode/project/cat-app/Messages.jsx`
6. `catcode/project/cat-app/Welcome.jsx`
7. `catcode/project/cat-app/Chat.jsx`
8. `catcode/project/cat-app/Pages.jsx`
9. `catcode/project/cat-app/TabBar.jsx`
10. `catcode/project/cat-app/WorkspaceLayout.jsx`
11. `catcode/project/cat-app/AppV2.jsx`

## Historical And Exploratory Files

- `catcode/project/CatCode Web App v2.html` uses `cat-app-v2-snapshot/`.
- `catcode/project/CatCode Web App.html` is an older single-workspace
  prototype.
- `catcode/project/cat-app-v2-snapshot/` is historical comparison material.
- `catcode/project/Composer Options.html`, `Menu Options.html`, and
  `Profile Options.html` are option boards.
- `catcode/project/launcher-explore/` is exploratory launcher/welcome placement
  work.
- `catcode/project/cat-app/composer-variants.jsx`,
  `menu-variants.jsx`, `profile-variants.jsx`, and `design-canvas.jsx` are
  option-board support files, not production entrypoints.

## Uploaded Requirement Documents

The handoff includes design and requirements documents under
`catcode/project/uploads/`. The canonical filenames without content hashes are:

- `2026-05-03-dedicated-app-prototype-brief.md`
- `2026-05-17-dedicated-app-figma-prototype-brief.md`
- `2026-05-17-dedicated-app-figma-screen-inventory.md`
- `2026-05-17-dedicated-app-figma-user-flows.md`
- `2026-05-17-dedicated-app-ui-requirements.md`
- `2026-05-17-dedicated-app-ux-reinterpretation-rules.md`

The same folder also contains hash-suffixed duplicates of these files. Use the
canonical names above for references unless investigating archive provenance.

These docs are not currently checked into the repo outside the ZIP.

## Reproducibility Commands

Use these commands to verify the local handoff archive before refreshing this
index:

```bash
shasum -a 256 /Users/pt/Downloads/catcode-handoff.zip
unzip -l /Users/pt/Downloads/catcode-handoff.zip | tail -n 3
```

Expected SHA-256:

```text
9bea5221d2c1c36124e99011908cf1fa70408031d89f4ae0c4e9793207b8480a
```

## Audit Document

The archive includes:

- `catcode/project/audit/2026-05-17-feature-coverage-audit.md`

This audit is useful for scope classification because it maps requirements to
the proposed app shell, inspector, command palette, and status surfaces.

## Current Interpretation

Treat `cat-app/` and the uploaded requirement documents as design evidence.
Do not copy their mock state, browser-global component structure, or stubbed
interactions into production. Production implementation must start from Cat
Code runtime contracts, current web architecture, and app-native components.
