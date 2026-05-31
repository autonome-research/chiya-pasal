/**
 * Shared graceful-shutdown wiring for systemd/cron-style one-shot runners.
 *
 * thread-phase's JobRunner cancellation only reaches in-flight inference calls
 * when phase code also plumbs an AbortSignal. Entry points can combine this
 * helper with their own AbortController to cover both layers:
 *   - abort local phase/inference work via ctx.signal
 *   - mark the persisted job failed/cancelled via runner.cancel(...)
 */

function exitCodeFor(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

export function installShutdownHandlers(
  label: string,
  onShutdown: (signal: NodeJS.Signals) => void,
): () => void {
  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.error(`[${label}] received ${signal} again; exiting immediately`);
      process.exit(exitCodeFor(signal));
    }
    shuttingDown = true;
    console.warn(`[${label}] received ${signal}; requesting graceful cancellation`);
    onShutdown(signal);
  };

  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);

  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
