/**
 * Fake TAP for the `tap approve` demo (scripts/demos/approve.tape). A person
 * "answers on their phone" APPROVE_AFTER_MS after each request is created,
 * approving every pitch, or declining with APPROVE_ANSWER=decline.
 *
 *   pnpm tsx scripts/demos/approve-server.ts        # listens on 4777
 *   DRAFTS_ONLY=1 ...                               # nothing waits; drafts to queue
 */

import { startFakeTap } from "../../src/__tests__/fake-tap.js";

const port = Number(process.env.PORT ?? 4777);
const delay = Number(process.env.APPROVE_AFTER_MS ?? 9000);
const answer = process.env.APPROVE_ANSWER === "decline" ? "decline" : {};

const tap = await startFakeTap({}, port);
const scheduled = new Set<string>();
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
