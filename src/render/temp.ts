/**
 * A temporary file that must not outlive the process: the render's raw H.264
 * stream (hundreds of MB in tmpdir). The caller removes it itself when the
 * render ends; this covers the ends it does not see: process.exit() and an
 * interrupt (Ctrl+C, a CI cancel).
 */
import { unlinkSync } from "node:fs";

/** Remove `path` if the process exits or is interrupted before the returned
 *  dispose function is called. An interrupt is passed on after the cleanup,
 *  so the process still ends the way the signal asked. */
export function removeOnExit(path: string): () => void {
  const remove = (): void => {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    remove();
    dispose();
    // with no listener left, the re-raised signal takes its default action
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const dispose = (): void => {
    process.off("exit", remove);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  process.on("exit", remove);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return dispose;
}
