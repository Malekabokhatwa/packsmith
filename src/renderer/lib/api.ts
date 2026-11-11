import type { Channel, In, Out } from "@shared/ipc";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

// Call the main process; failures come back as ApiError with the message written for the user.
export async function call<C extends Channel>(channel: C, input?: In<C>): Promise<Out<C>> {
  const res = await window.packsmith.invoke(channel, input);
  if (!res.ok) throw new ApiError(res.error.code, res.error.message);
  return res.value;
}

export function iconSrc(url: string | undefined): string | undefined {
  return url ? `psicon://icon/?u=${encodeURIComponent(url)}` : undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
