/**
 * Fake TAP for the `tap approve` demo (scripts/demos/approve.tape). A person
 * "answers on their phone" APPROVE_AFTER_MS after each request is created,
 * approving every pitch, or declining with APPROVE_ANSWER=decline.
 *
 *   pnpm tsx scripts/demos/approve-server.ts        # listens on 4777
 *   DRAFTS_ONLY=1 ...                               # nothing waits; drafts only
 *   TTL_MS=20000 ...                                # requests expire sooner
 *   STATE_FILE=/tmp/tap.json ...                    # keep requests across a restart, as TAP's database does
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { startFakeTap } from "../../src/__tests__/fake-tap.js";

const port = Number(process.env.PORT ?? 4777);
const delay = Number(process.env.APPROVE_AFTER_MS ?? 9000);
const answer = process.env.APPROVE_ANSWER === "decline" ? "decline" : {};

const tap = await startFakeTap({}, port);
const scheduled = new Set<string>();
if (process.env.TTL_MS) tap.state.approvalCtl.ttlMs = Number(process.env.TTL_MS);

const stateFile = process.env.STATE_FILE;
type Saved = { approvals: Array<[string, unknown]>; states: Array<[string, string]> };
if (stateFile && existsSync(stateFile)) {
  const saved = JSON.parse(readFileSync(stateFile, "utf-8")) as Saved;
  for (const [id, approval] of saved.approvals) tap.state.approvals.set(id, approval as never);
  const states = new Map(saved.states);
  for (const row of tap.state.queue) row.state = states.get(row.id) ?? row.state;
}
if (stateFile) {
  setInterval(() => {
    const saved: Saved = { approvals: [...tap.state.approvals], states: tap.state.queue.map((r) => [r.id, r.state]) };
    writeFileSync(stateFile, JSON.stringify(saved));
  }, 100);
}
if (process.env.DRAFTS_ONLY) {
  for (const row of tap.state.queue) if (row.state === "pending_approval") row.state = "draft";
}

setInterval(() => {
  for (const request of tap.state.approvals.values()) {
    if (request.status !== "pending" || scheduled.has(request.id)) continue;
    scheduled.add(request.id);
    setTimeout(() => {
      if (request.status === "pending") tap.state.answerApproval(request.id, answer);
    }, delay);
  }
}, 200);

console.log(`fake TAP on ${tap.url}`);
