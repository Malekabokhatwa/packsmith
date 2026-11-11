// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(cleanup);
import { EvidenceLadder, headline } from "../src/renderer/components/EvidenceLadder";
import type { TestReport } from "../src/shared/schema";

const base = { instanceId: "p1", at: "2026-11-03T00:00:00.000Z" };
const client = { branch: "client" as const, status: "not-tested" as const, reached: 1, proof: [], tail: [], note: "not set up" };
const failed: TestReport = {
  ...base, resolved: { ok: true, note: "3 mods" },
  branches: [{ branch: "server", status: "failed", reached: 1, failedAt: 2, proof: [], tail: ["boom"], note: "The server stopped before it started.",
    diagnosis: { kind: "mixin_failure", confidence: "high", culprits: [], evidence: [{ line: 3, text: "Mixin apply for mod x failed" }], suggested: ["Update x."], signature: "s" } }, client],
};

describe("EvidenceLadder", () => {
  it("a failure shows the rung that failed and nothing above it as proven", () => {
    const { getByLabelText, getByText } = render(<EvidenceLadder report={failed} />);
    expect(headline(failed)).toEqual({ text: "Stopped at: server boots", tone: "danger" });
    getByLabelText("Server: Resolved, proven");
    getByLabelText("Server: Boots, failed");
    getByLabelText("Server: Loads a world, not reached");
    getByText("The server stopped before it started. Update x.");
  });
  it("a client branch that wasn't tested says so and never shows Boots", () => {
    const { queryByLabelText, getByText } = render(<EvidenceLadder report={failed} />);
    expect(queryByLabelText(/Client: Boots/)).toBeNull();
    getByText(/Not tested: not set up/);
  });
  it("only a proven branch above Resolved counts as proven up to something", () => {
    const onlyResolved: TestReport = { ...base, resolved: { ok: true, note: "" }, branches: [{ ...client, branch: "server", status: "not-tested" }, client] };
    expect(headline(onlyResolved).text).toBe("Not proven yet");
  });
});
