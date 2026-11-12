/**
 * One handler for Ctrl+C, SIGTERM and SIGHUP across the CLI. By default an
 * interrupt restores the cursor and exits 130. A command that must clean up
 * first (withdrawing an approval request) takes the interrupts until it
 * releases them, and turns each into intent rather than an exit.
 */

/**
 * Interactive mode swaps `process.exit` for a throwing version while a
 * command runs. A signal handler has no caller to catch that, so it keeps the
 * real one.
 */
const realExit = process.exit.bind(process);

let takeover: (() => void) | null = null;

export function onInterrupt(handler: () => void): () => void {
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

export function interrupt(): void {
  if (takeover) return takeover();
  exitInterrupted();
}
