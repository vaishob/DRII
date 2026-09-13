export const SLACK_STARTUP_TIMEOUT_MS = 30_000;

export class StartupError extends Error {
  constructor(readonly stage: string) {
    super(
      `Startup failed during ${stage}. Run npm run doctor for setup checks.`,
    );
  }
}

/** Release every acquired resource, including after partially completed startup. */
export class RuntimeResources {
  private readonly cleanups: (() => Promise<unknown>)[] = [];
  private closing: Promise<void> | undefined;

  defer(cleanup: () => Promise<unknown>): void {
    if (this.closing) throw new Error('Runtime is already shutting down');
    this.cleanups.push(cleanup);
  }

  async stage<T>(
    name: string,
    action: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (timeoutMs === undefined) return await action();
      return await Promise.race([
        action(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new StartupError(name)),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      // Never attach provider responses or credentials to the public error.
      throw new StartupError(name);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.release();
    return this.closing;
  }

  private async release(): Promise<void> {
    let failed = false;
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new Error('One or more runtime resources failed to close');
  }
}
