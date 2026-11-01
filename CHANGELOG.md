# Changelog

## 0.5.0

Smooth first-run onboarding.

- `tap auth login` offers to open the API keys settings page, then verifies the pasted key
  against TAP with a cheap read call before saving. Clear messages for a bad format, a 401,
  and a network failure.
- Removed stale "Agency tier" wording from the login copy — scoped keys work the same way
  regardless of tier.
- New `tap mcp setup` (alias `tap connect`) prints — or, with `--write`, writes — MCP client
  config for Claude Code, Claude Desktop, and Cursor from the stored key. Existing config
  files are backed up before any write; other registered servers are left untouched. The
  full key is never printed to stdout.
- New `tap doctor` checks Node version, stored key, TAP reachability, and whether the
  `@totalaudiopromo/tap-mcp` package resolves on npm, with a green/red checklist.
- README quick start trimmed to three steps: mint a key, `tap auth login`, `tap mcp setup`.

## 0.4.0

Pitch drafts now go through OpenRouter instead of calling Anthropic directly.
