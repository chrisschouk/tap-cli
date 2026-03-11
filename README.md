# tap-cli

Terminal interface for [Total Audio Platform](https://tap.totalaudiopromo.com) — manage campaigns, contacts, and pitches without leaving the command line.

## Install

```bash
npm install -g tap-cli
# or
pnpm add -g tap-cli
```

## Auth

Before using any commands, authenticate with your TAP workspace:

```bash
tap auth login
```

You'll be prompted for your Supabase URL and service role key, both available in your TAP workspace settings.

Alternatively, set environment variables:

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_KEY=your-service-role-key
export TAP_WORKSPACE_ID=your-workspace-id   # optional
```

Credentials are stored at `~/.tap/config.json` (chmod 600).

## Commands

### Auth

```bash
tap auth login          # Store credentials interactively
tap auth status         # Check current auth state
```

### Campaigns

```bash
tap campaigns list                          # List all campaigns
tap campaigns list --status active          # Filter by status
tap campaigns list --json                   # JSON output
tap campaigns create --name "Q2 Radio Push" --artist "Artist Name"
tap campaigns create -n "Release" -a "Artist" -r "EP Title" -d 2026-04-01
tap campaigns status <id> active            # Change campaign status
```

### Contacts

```bash
tap contacts list                           # List contacts
tap contacts list --bbc                     # Only BBC contacts
tap contacts list --warm                    # Warm/hot contacts
tap contacts list --genre "Indie"           # Filter by genre
tap contacts list -l 50                     # Limit results
tap contacts search "Radio 1"               # Search by name/email/outlet
tap contacts enrich <id>                    # Queue contact for enrichment
tap contacts import contacts.csv            # Import from CSV (opens web UI)
```

### Queue

```bash
tap queue                   # Show today's action queue (follow-ups, enrichment, unpitched)
tap queue --json            # JSON output
```

### Stats

```bash
tap stats                   # Workspace overview (contacts, campaigns, outcomes, pitches)
tap stats --json            # JSON output
```

## Workspace flag

All commands accept `--workspace <id>` to target a specific workspace. Without it, the CLI uses the workspace from your config or auto-resolves the first one on the account.

```bash
tap campaigns list --workspace abc123
```

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` / `TAP_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` / `TAP_SUPABASE_KEY` | Supabase service role key |
| `SUPABASE_SERVICE_ROLE_KEY` | Alternative service role key env name |
| `TAP_WORKSPACE_ID` | Default workspace ID |

## Licence

MIT — see [LICENSE](LICENSE).
