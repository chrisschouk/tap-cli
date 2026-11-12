import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { guardOutput, onInterrupt, type InterruptCause } from "../ui/interrupt.js";

function stream(received: string[]): NodeJS.WriteStream {
  return new Writable({
    write(chunk, _, done) {
      received.push(String(chunk));
      done();
    },
  }) as unknown as NodeJS.WriteStream;
}

const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

describe("guardOutput", () => {
  it("interrupts once as output_closed, sends writes to the stream that works, and calls back once both are gone", async () => {
    const [toOut, toErr]: string[][] = [[], []];
    const out = stream(toOut);
    const err = stream(toErr);
    const causes: InterruptCause[] = [];
    const release = onInterrupt((cause) => void causes.push(cause));
    try {
      guardOutput([out, err]);
      out.emit("error", epipe());
      out.write("report");
      expect(toErr).toEqual(["report"]);
      err.emit("error", epipe());
      const calledBack = await new Promise<boolean>((resolve) => {
        out.write("lost", () => resolve(true));
        setTimeout(() => resolve(false), 200);
      });
      expect(calledBack).toBe(true);
      expect(causes).toEqual(["output_closed"]);
    } finally {
      release();
    }
  });
});
