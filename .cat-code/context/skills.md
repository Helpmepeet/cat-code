# Skills

- User-local skills load from `~/.cat-code/skills/` by default, or from `$CLAUDE_CONFIG_DIR/skills/` when `CLAUDE_CONFIG_DIR` is set.
- Compatibility loading still checks `~/.claude/skills/`.
- The supported user-skill format is `skill-name/SKILL.md`.
- The slash command name comes from the folder name, not the frontmatter `name`.
- `~/.cat-code/skills/cat-swarm/SKILL.md` loads as `/cat-swarm`.
