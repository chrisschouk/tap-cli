/**
 * One SIGINT handler for the whole CLI. By default Ctrl+C restores the cursor
 * and exits 130; a command that must clean up first (withdrawing an approval
 * request) takes over until it releases the handler.
 */

let takeover: (() => void) | null = null;

export function onInterrupt(handler: () => void): () => void {
  takeover = handler;
  return () => {
    if (takeover === handler) takeover = null;
  };
}

export function interrupt(): void {
  if (takeover) return takeover();
  process.stdout.write("\x1B[?25h");
  process.exit(130);
}
