import type { Channel, In, IpcResult, Out } from "@shared/ipc";
import type { RunEnvelope } from "@shared/agent";

declare global {
  interface Window {
    packsmith: {
      invoke<C extends Channel>(channel: C, input?: In<C>): Promise<IpcResult<Out<C>>>;
      onRunEvent(cb: (env: RunEnvelope) => void): () => void;
    };
  }
}
export {};
