// One process only. Use the SAME queue instance around the entire workflow
// read/validate/write operation. This is not a distributed database lock.
export class DecisionQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  async run<T>(
    workspaceId: string,
    decisionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([workspaceId, decisionId]);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }
}
export const decisionQueue = new DecisionQueue();
