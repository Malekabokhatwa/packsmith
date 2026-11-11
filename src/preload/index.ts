import { contextBridge, ipcRenderer } from "electron";
import { CHANNEL_NAMES, RUN_EVENT_CHANNEL } from "@shared/channelNames";

// The renderer's only door to the main process: invoke a known channel. No raw ipcRenderer,
// no Node APIs (spec 4.1). The main side validates every input again.
const known = new Set<string>(CHANNEL_NAMES);

contextBridge.exposeInMainWorld("packsmith", {
  invoke: (channel: string, input?: unknown) => {
    if (!known.has(channel)) return Promise.resolve({ ok: false, error: { code: "unknown-channel", message: "Unknown request." } });
    return ipcRenderer.invoke(channel, input);
  },
  onRunEvent: (cb: (env: unknown) => void) => {
    const listener = (_e: unknown, env: unknown) => cb(env);
    ipcRenderer.on(RUN_EVENT_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(RUN_EVENT_CHANNEL, listener); };
  },
});
