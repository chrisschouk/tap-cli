/**
 * What happens to an approval request once it exists, as one flow with a
 * closed set of endings. Key and signal handlers never end the command: they
 * press `StopRequest`, and the flow turns that into an ending. The caller
 * renders the ending and derives the exit code from it, in one place.
 */

import {
  EXIT_CODE,
  isFinal,
  readApprovalRequest,
  waitForAnswer,
  withdrawApprovalRequest,
  type ApprovalRequest,
  type CreatedRequest,
} from "./approval-requests.js";
import { TapApiError } from "./rest.js";
import { LostTouch, type RetryHooks } from "./retry.js";

/** What the CLI knows about a request. `status` reads one by id alone until its first read lands. */
export interface RequestRef {
  id: string;
  code: string | null;
  url: string | null;
  expires_at: string | null;
}

export type Ending =
  /** TAP reports a final status: approved, partial, declined, interrupted, expired, cancelled in TAP, superseded. */
  | { kind: "answered"; request: ApprovalRequest }
  /** The person stopped and TAP confirmed the withdrawal. */
  | { kind: "withdrawn"; request: ApprovalRequest }
  /** Still waiting by choice: --no-wait, or `status` without --wait. `request` is the read, when there was one. */
  | { kind: "open"; request: ApprovalRequest | null }
  /** TAP has no such request (404). */
  | { kind: "gone" }
  /** Anything else. The request may still be answered, so the person is told how to read it. */
  | { kind: "left_open"; reason: string; stopped: boolean };

export function refOf(request: Pick<ApprovalRequest, "id" | "code" | "url" | "expires_at">): RequestRef {
  return { id: request.id, code: request.code, url: request.url, expires_at: request.expires_at };
}

const approvedAny = (request: ApprovalRequest) => (request.result?.approved.length ?? 0) > 0;

/** The exit code for each ending, in one table. */
const EXIT_FOR: { [K in Ending["kind"]]: (ending: Extract<Ending, { kind: K }>) => number } = {
  answered: (e) => (approvedAny(e.request) ? EXIT_CODE.approved : EXIT_CODE.notApproved),
  withdrawn: () => EXIT_CODE.interrupted,
  open: () => EXIT_CODE.approved,
  gone: () => EXIT_CODE.notApproved,
  left_open: (e) => (e.stopped ? EXIT_CODE.interrupted : EXIT_CODE.notApproved),
};

export function exitCodeOf(ending: Ending): number {
  return (EXIT_FOR[ending.kind] as (e: Ending) => number)(ending);
}

/**
 * The person's intent to stop. The first press stops waiting and withdraws;
 * the second gives up on the withdrawal too. Pressing never exits.
 */
export class StopRequest {
  private readonly first = new AbortController();
  private readonly second = new AbortController();
  /** Aborted by the first press. */
  readonly signal = this.first.signal;
  /** Aborted by the second press. */
  readonly quit = this.second.signal;

  press(): void {
    (this.first.signal.aborted ? this.second : this.first).abort();
  }

  get requested(): boolean {
    return this.first.signal.aborted;
  }
}

export interface SessionView {
  hooks: RetryHooks;
  /** Replace the status line, or clear it with null. */
  note(text: string | null): void;
  /** Runs before the wait, inside the flow, so a stop or a failure here ends it the same way. */
  prelude?: (signal: AbortSignal, hooks: RetryHooks) => Promise<void>;
}

const QUIT_REASON = "You quit before TAP confirmed an answer or a withdrawal.";

function reasonOf(err: unknown): string {
  if (err instanceof LostTouch) return err.reason;
  if (err instanceof TapApiError) return `TAP refused with ${err.status}: ${err.message.replace(/\.$/, "")}`;
  return err instanceof Error ? err.message.replace(/\.$/, "") : String(err);
}

function endingFor(err: unknown, stop: StopRequest): Ending {
  if (err instanceof TapApiError && err.status === 404) return { kind: "gone" };
  if (stop.quit.aborted) return { kind: "left_open", reason: QUIT_REASON, stopped: true };
  const outcome = stop.requested ? "Could not withdraw the request." : "Stopped waiting for the answer.";
  return { kind: "left_open", stopped: stop.requested, reason: `${reasonOf(err)}. ${outcome}` };
}

/** The value, or null when `signal` stopped it. Other failures propagate. */
async function unlessStopped<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  try {
    return await run(signal);
  } catch (err) {
    if (signal.aborted) return null;
    throw err;
  }
}

async function withdraw(created: CreatedRequest, stop: StopRequest, view: SessionView): Promise<Ending> {
  view.note("Withdrawing the request. Press Ctrl+C again to quit at once");
  const request = await withdrawApprovalRequest(created, { ...view.hooks, signal: stop.quit });
  if (request.status === "cancelled") return { kind: "withdrawn", request };
  if (isFinal(request)) return { kind: "answered", request };
  view.note("Someone is answering in TAP. Waiting for their answer. Press Ctrl+C again to quit");
  const answer = await unlessStopped(stop.quit, (signal) => waitForAnswer(created, { ...view.hooks, signal }));
  return answer ? { kind: "answered", request: answer } : { kind: "left_open", reason: QUIT_REASON, stopped: true };
}

/** Wait for the answer; on a stop, withdraw. Never throws: every way out is an Ending. */
export async function settle(created: CreatedRequest, stop: StopRequest, view: SessionView): Promise<Ending> {
  try {
    const answer = await unlessStopped(stop.signal, async (signal) => {
      await view.prelude?.(signal, view.hooks);
      return waitForAnswer(created, { ...view.hooks, signal });
    });
    return answer ? { kind: "answered", request: answer } : await withdraw(created, stop, view);
  } catch (err) {
    return endingFor(err, stop);
  }
}

/** `tap approve status`: read, and with `wait` follow until answered. A stop ends the watch and withdraws nothing. */
export async function follow(id: string, opts: { wait: boolean; stop: StopRequest; hooks?: RetryHooks }): Promise<{ ref: RequestRef; ending: Ending }> {
  let ref: RequestRef = { id, code: null, url: null, expires_at: null };
  try {
    const first = await readApprovalRequest(id, 0, opts.stop.signal);
    ref = refOf(first);
    if (isFinal(first)) return { ref, ending: { kind: "answered", request: first } };
    if (!opts.wait) return { ref, ending: { kind: "open", request: first } };
    return { ref, ending: { kind: "answered", request: await waitForAnswer(first, { ...opts.hooks, signal: opts.stop.signal }) } };
  } catch (err) {
    if (opts.stop.requested) return { ref, ending: { kind: "left_open", reason: "You stopped watching. The request was not withdrawn.", stopped: true } };
    return { ref, ending: endingFor(err, opts.stop) };
  }
}
