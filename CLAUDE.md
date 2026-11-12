# tap-cli

Terminal interface for the Total Audio Platform. Manage campaigns, contacts, pitches, outcomes,
and workspace skills from the command line. Published on npm as `@totalaudiopromo/tap-cli`
(v0.4.0). Part of the agent-native suite that wraps TAP (`totalaudiopromo.com`) for CLI and
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
- `queue` — TAP's action list
- `stats` — prints the TAP Home link (no stats endpoint in v1)
- `open [id]` — open a record in the browser
- `approve [campaign-id]` — asks a signed-in person to approve pitches (approval request with code, link and QR), waits, reports per pitch. `approve status <request-id> [--wait]`. Never approves or sends: the key only creates, reads and withdraws the request. Once a request exists the command ends only through `finalise` with an `Ending` from `lib/approval-session.ts` (answered, withdrawn, open, gone, left_open); key and signal handlers press `StopRequest` and never exit. Exits 0 approved, 1 nothing approved, 130 stopped by the person.
- `send <campaign-id>` — lists pitches waiting for approval and links to where the artist approves and sends in TAP (and to `tap approve`). Never sends.
- `discover` — prints the TAP contacts link (no discovery endpoint in v1)
- `import` — bulk import contacts, including sink (`datasink`) output from a file or stdin (`-`)
- `skill` — run a TAP skill
- `watch` — prints the release Results tab link (no activity feed in v1)

Every command goes through `lib/rest.ts` `restRequest()`. There is no Supabase client. Approving and
sending a pitch are human-only in TAP: never add a CLI path that approves or sends.
`src/__tests__/rest-only.guardrail.test.ts` allowlists every route the CLI calls. Tests run the CLI
against `src/__tests__/fake-tap.ts`, whose shapes are copied from the TAP route handlers; the
`tap approve` demo tape is `scripts/demos/approve.tape` (output in the gitignored `.demo/`).

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

## Writing rule (anti-slop, standing)

Any prose written in this repo (docs, README, marketing copy, UI text) follows the voice
rules in total-audio-platform/.claude/skills/brand-voice-guide/voice-dna.md. The short
version: no em dashes, no negation-assertion ("this is not X, it is Y"), no staccato
fragment runs, no tricolons, no delve/leverage/seamless/ecosystem AI vocabulary,
first-person specific over third-person hypothetical, UK spelling. Public-facing copy
additionally passes commodity-gate + brand-voice-guide before publishing. If it reads
like a language model wrote it, rewrite it before committing.
