import { randomUUID } from "node:crypto";
import { MAX_STORED_RUNS, RUN_TTL_MS } from "../config/limits.js";
import type { DecisionView, Meeting } from "../contracts/intake.js";
import { IntakeError } from "./errors.js";

export interface Run {
  id: string;
  key: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  createdAt: number;
  status: "RECEIVED" | "TRANSCRIBING" | "ANALYZING" | "COMPLETED" | "FAILED";
  messageTs?: string;
  meeting?: Meeting;
  result?: DecisionView;
}

export interface RunStore {
  claim(
    key: string,
    context: Pick<Run, "workspaceId" | "channelId" | "threadTs">,
  ): Run | undefined;
  save(run: Run): void;
  get(id: string): Run | undefined;
}

// Temporary adapter for the first UI slice. Vaishob replaces this with durable storage.
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>();
  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    for (const [id, run] of this.runs) {
      const finished = run.status === "COMPLETED" || run.status === "FAILED";
      if (finished && this.now() - run.createdAt >= RUN_TTL_MS)
        this.runs.delete(id);
    }
  }

  claim(
    key: string,
    context: Pick<Run, "workspaceId" | "channelId" | "threadTs">,
  ): Run | undefined {
    this.prune();
    if ([...this.runs.values()].some((run) => run.key === key))
      return undefined;
    if (this.runs.size >= MAX_STORED_RUNS)
      throw new IntakeError(
        "CAPACITY",
        "The demo session is full. Wait for older runs to expire before starting another review.",
      );
    const run: Run = {
      ...context,
      id: randomUUID(),
      key,
      createdAt: this.now(),
      status: "RECEIVED",
    };
    this.runs.set(run.id, run);
    return run;
  }

  save(run: Run): void {
    this.runs.set(run.id, run);
  }

  get(id: string): Run | undefined {
    this.prune();
    return this.runs.get(id);
  }
}
