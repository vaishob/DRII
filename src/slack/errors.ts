export class IntakeError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
  ) {
    super(code);
    this.name = "IntakeError";
  }
}

export function publicError(error: unknown): string {
  return error instanceof IntakeError
    ? error.userMessage
    : "DRII could not finish this request. Please send a new @DRII analyze message to retry, or paste a transcript. No decision was approved.";
}
