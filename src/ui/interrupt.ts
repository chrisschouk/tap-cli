/**
 * One handler for Ctrl+C, SIGTERM, SIGHUP and closed output across the CLI.
 * By default a signal restores the cursor and exits 130, and closed output
 * (`tap ... | head -1`) exits 0 without a word. A command that must clean up
 * first (withdrawing an approval request) takes the interrupts until it
 * releases them, and turns each into intent rather than an exit.
 */

/**
 * Interactive mode swaps `process.exit` for a throwing version while a
 * command runs. A signal handler has no caller to catch that, so it keeps the
 * real one.
 */
const realExit = process.exit.bind(process);

/** A signal is the person asking to stop. Closed output is the reader going away. */
export type InterruptCause = "signal" | "output_closed";

let takeover: ((cause: InterruptCause) => void) | null = null;

export function onInterrupt(handler: (cause: InterruptCause) => void): () => void {
  takeover = handler;
  return () => {
    if (takeover === handler) takeover = null;
  };
}

function exitInterrupted(): never {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  process.stdout.write("\x1B[?25h");
  return realExit(130);
}

export function interrupt(cause: InterruptCause = "signal"): void {
  if (takeover) return takeover(cause);
  if (cause === "output_closed") return void realExit(0);
  exitInterrupted();
}

type Out = NodeJS.WriteStream;

let closed = false;
/** A write that never calls back (a stubbed or wedged stream) must not hold the exit. */
const FLUSH_WAIT_MS = 500;

/**
 * Wait until what has been written to stdout has left the process, then say
 * whether any output stream failed. A write to a closed pipe fails after it
 * returns, so a command that exits at once would never learn of it.
 */
export const outputClosed = (): boolean => closed;

export async function outputLost(): Promise<boolean> {
  await new Promise<void>((resolve) => {
    const giveUp = setTimeout(resolve, FLUSH_WAIT_MS);
    process.stdout.write("", () => (clearTimeout(giveUp), resolve()));
  });
  await new Promise((resolve) => setImmediate(resolve));
  return closed;
}

/**
 * A write to a closed pipe or terminal fails with an 'error' event, which
 * would crash the CLI with a request still open. Once a stream fails its
 * writes go to the other stream while that one works, and to nowhere after,
 * and the first failure interrupts as `output_closed`.
 */
export function guardOutput(streams: [Out, Out] = [process.stdout, process.stderr]): void {
  const write = new Map(streams.map((s) => [s, s.write.bind(s)] as const));
  const dead = new Set<Out>();
  const divert = ((chunk: never, ...rest: never[]) => {
    const live = streams.find((s) => !dead.has(s));
    if (live) return write.get(live)!(chunk, ...rest);
    const done = rest.find((arg): arg is never => typeof arg === "function") as (() => void) | undefined;
    if (done) queueMicrotask(done);
    return true;
  }) as Out["write"];
  for (const stream of streams) {
    stream.on("error", () => {
      const first = dead.size === 0;
      closed = true;
      dead.add(stream);
      stream.write = divert;
      if (first) interrupt("output_closed");
    });
  }
}
