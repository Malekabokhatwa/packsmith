// Redaction before anything is sent to a provider (spec 8.3): home-directory paths, the user's
// name in paths, known API-key shapes, bearer tokens and password-like assignments.
import { homedir, userInfo } from "node:os";

const PATTERNS: Array<[RegExp, string]> = [
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[key]"],
  [/\bAQ\.[0-9A-Za-z_-]{30,}/g, "[key]"], // Google's newer API key format
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, "[key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "[token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[key]"],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 [token]"],
  [/--accessToken\s+\S+/g, "--accessToken [token]"],
  [/\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[redacted]"],
];

export function makeRedactor(extraSecrets: () => string[] = () => [], home = homedir(), user = userInfo().username) {
  return (text: string): string => {
    let out = text;
    for (const s of extraSecrets()) if (s && s.length >= 8) out = out.split(s).join("[key]");
    if (home && home !== "/") out = out.split(home).join("~");
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    if (user && user.length >= 3) out = out.replace(new RegExp(`/home/${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "~");
    return out;
  };
}
