# tap-cli

Terminal interface for the Total Audio Platform. Manage campaigns, contacts, pitches, outcomes,
and workspace skills from the command line. Published on npm as `@totalaudiopromo/tap-cli`
(v0.3.1). Part of the agent-native suite that wraps TAP (`totalaudiopromo.com`) for CLI and
agent consumers. Auth routes through the TAP REST v1 API using workspace-scoped `tap_ak_*` keys.

## Stack

TypeScript + ESM, built with tsup, Node >= 20. Single package.

## Commands that matter

```bash
pnpm dev          # tsx src/cli.ts (no build step)
pnpm build        # tsup → dist/cli.js
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm lint         # eslint src/
```

The `prepublishOnly` hook runs `pnpm test && pnpm build` automatically.

## CLI commands (`tap <cmd>`)

- `auth` — log in / out, manage workspace API key (`tap_ak_*`)
- `campaigns list` / `campaigns show <id>`
- `contacts search <query>` / `contacts add`
- `pitch <campaign-id>` — draft a pitch
- `outcome <campaign-id> <contact-id> <type>` — log an outcome
- `queue` — view the approval queue
- `stats` — campaign statistics
- `open [id]` — open a record in the browser
- `send` — propose a send (goes into approval queue, not direct send)
- `discover` — contact discovery
- `import` — bulk import contacts
- `skill` — run a TAP skill
- `watch` — watch for activity

## Publish flow (npm)

Published as `@totalaudiopromo/tap-cli` (scoped). Requires npm account with write access to
the `@totalaudiopromo` org.

**2FA gotcha**: interactive `npm publish` prompts for a one-time code even on scoped packages,
blocking non-interactive runs. Use a granular **automation token** (npm account → Access
Tokens → Generate New Token → Automation) in `~/.npmrc` as
`//registry.npmjs.org/:_authToken=<automation-token>`. Check token type before publishing.
The `prepublishOnly` hook also runs the full test + build cycle, so failures surface early.

## House standards

UK spelling, GBP currency, `feat:`/`fix:` commit prefixes. Calm professional tone.

## PR watching

Subscribe to PR events + arm exactly ONE fallback check-in 2-4 hours out. Never chain
hourly re-arms — an hourly send_later loop re-reads the whole session context every fire
to learn "still green" (22 Jul 2026 audit found these chains burning in this repo). On
merge/close: unsubscribe and delete any pending trigger. Full rule:
total-audio-platform/.claude/rules/pr-watching.md.
