// One error type that crosses IPC with a stable code and a message written for the user
// (spec CHT-4). Internal details stay in `cause` and never reach the renderer.
// retryAfterMs: how long the other side asked us to wait before trying again (rate limits).
export class AppError extends Error {
  readonly retryAfterMs?: number;
  constructor(public readonly code: string, message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options);
    this.name = "AppError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}
