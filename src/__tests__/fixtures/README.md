Real output from `npx -y datasink@0.4.1` for `sink-input.csv`, recorded 11 November 2026:

- `sink-wash-envelope.json`: `sink wash sink-input.csv --json -q`
- `sink-wash.json`: `sink wash sink-input.csv --format json`
- `sink-scrub.jsonl`: `sink scrub sink-input.csv --format jsonl`
- `sink-wash.csv`: `sink wash sink-input.csv --format csv`

No LLM key was set, so soak and steep did not run. The soak and steep shapes in
`contact-import.test.ts` follow `datasink/dist/types.d.ts`.
