# Skills

- User-local skills load from `~/.cat-code/skills/` by default, or from `$CLAUDE_CONFIG_DIR/skills/` when `CLAUDE_CONFIG_DIR` is set.
- With a custom config home, compatibility loading also checks `~/.cat-code/skills/`; it does not load `~/.claude/skills/`.
- Use `skill-publisher` to publish user-authored skills across runtimes instead of relying on a Claude Code directory fallback.
- The supported user-skill format is `skill-name/SKILL.md`.
- The slash command name comes from the folder name, not the frontmatter `name`.
