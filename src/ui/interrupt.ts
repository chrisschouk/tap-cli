/**
 * One handler for Ctrl+C, SIGTERM and SIGHUP across the CLI. By default an
 * interrupt restores the cursor and exits 130; a command that must clean up
 * first (withdrawing an approval request) takes over until it releases.
 */

let takeover: (() => void) | null = null;

export function onInterrupt(handler: () => void): () => void {
  takeover = handler;
  return () => {
    if (takeover === handler) takeover = null;
  };
}

export function exitInterrupted(): never {
  process.stdout.write("\x1B[?25h");
  process.exit(130);
}

export function interrupt(): void {
  if (takeover) return takeover();
  exitInterrupted();
}

export interface InterruptHold {
  /** True once the person interrupted: Ctrl+C, SIGTERM, SIGHUP, or `trigger()`. */
  readonly interrupted: boolean;
  /** Pass interrupts to `handler` from now on. One that came earlier reaches it at once. */
  handle(handler: () => void): void;
  /** Interrupt as a key press would. */
  trigger(): void;
  release(): void;
}

/**
 * Hold interrupts from before an approval request exists, so one that lands
 * while the request is being created is acted on once its id is known,
 * instead of exiting and leaving it open. A second interrupt with nothing
 * handling it yet exits at once.
 */
export function holdInterrupts(): InterruptHold {
  let interrupted = false;
  let held = false;
  let handler: (() => void) | null = null;
  const trigger = () => {
    interrupted = true;
    if (handler) return handler();
    if (held) exitInterrupted();
    held = true;
    console.error("  Stopping. The request will be withdrawn. Press Ctrl+C again to quit at once.");
  };
  const release = onInterrupt(trigger);
  return {
    get interrupted() {
      return interrupted;
    },
    handle(next) {
      handler = next;
      if (!held) return;
      held = false;
      next();
    },
    trigger,
    release,
  };
}
