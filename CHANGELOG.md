# Changelog

## Unreleased

The CLI talks to TAP only through the REST v1 API with a `tap_ak_` key. The legacy
direct-Supabase mode is gone.

- Removed `tap auth login --legacy`, the Supabase client, the `supabaseUrl` and `supabaseKey`
  config fields, the `SUPABASE_*` environment fallbacks and the `@supabase/supabase-js`
  dependency. Old config files keep working for their `apiKey`; the Supabase fields are ignored.
- `tap send <campaign-id>` no longer sends. It lists the campaign's pitches that still need you
  and prints (with `--open`, opens) the TAP page where you approve and send them.
- `tap stats`, `tap watch` and `tap discover` print the TAP page that has their data, because
  the API has no endpoint for it yet.
- `tap contacts history` and `tap contacts enrich` and interactive mode now run over the API.
- `tap outcome` uses the outcome types the API accepts. Older words still work as aliases.
- `tap queue` reads the action list in the shape the API returns.
- Removed the unused `-w, --workspace` flag and the `workspaceId` setting: the key sets the
  workspace. Removed `tap pitch --hook`, which the API does not accept; `--tone` is now sent.
- API errors show TAP's message, including the year-plan message on a 402.

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
