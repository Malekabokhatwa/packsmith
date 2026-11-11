import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const shared = { "@shared": resolve(__dirname, "src/shared") };

// The CSP in index.html is strict. Only the dev server relaxes it, for Vite's hot reload
// (inline preamble + websocket). Production builds keep it exactly as written.
const devCsp = {
  name: "packsmith-dev-csp",
  apply: "serve" as const,
  transformIndexHtml: (html: string) =>
    html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws://localhost:*"),
};

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: { resolve: { alias: shared } },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { ...shared, "@renderer": resolve(__dirname, "src/renderer") } },
    plugins: [react(), tailwindcss(), devCsp],
  },
});
