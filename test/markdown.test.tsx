// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown, withoutPartialToken } from "../src/renderer/components/Markdown";
import { resetModCards } from "../src/renderer/components/ModCard";

describe("Markdown renderer", () => {
  it("keeps hard line breaks (two trailing spaces) and joins soft ones", () => {
    const { container } = render(<Markdown text={"**Minecraft:** 1.21.1  \n**Loader:** Fabric\nsame line"} />);
    const p = container.querySelector("p")!;
    expect(p.querySelectorAll("br")).toHaveLength(1);
    expect(p.textContent).toBe("Minecraft: 1.21.1Loader: Fabric same line");
  });
  it("renders headings, bullets, numbered lists, bold, italic and code without HTML injection", () => {
    const { container } = render(<Markdown text={"### Title\n\n* **A**: one\n- *b* `c`\n\n1. first\n2. second\n\n<img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("h3")!.textContent).toBe("Title");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("strong")!.textContent).toBe("A");
    expect(container.querySelector("em")!.textContent).toBe("b");
    expect(container.querySelector("code")!.textContent).toBe("c");
    expect(container.querySelector("img")).toBeNull(); // shown as text, never as HTML
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("turns {{mod:id}} into one inline card per mod, fetched in one batch; an unknown id still renders", async () => {
    resetModCards();
    const invoke = vi.fn(async (_ch: string, input: { ids: string[] }) => ({ ok: true, value: input.ids.filter((id) => id !== "ZZZZZZZZ").map((id) => ({ id, title: `Mod ${id}`, summary: "Does a thing" })) }));
    (window as unknown as { packsmith: unknown }).packsmith = { invoke };
    render(<Markdown text={"Built:\n- {{mod:AANWFOg1}} - the map\n- {{mod:bbbbbbbb}} - waystones\n- {{mod:ZZZZZZZZ}}"} />);
    expect((await screen.findByRole("link", { name: "Mod AANWFOg1 on Modrinth" })).getAttribute("href")).toBe("https://modrinth.com/project/AANWFOg1");
    expect(await screen.findByRole("link", { name: "Mod bbbbbbbb on Modrinth" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "A Modrinth project" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1); // one batch for all three
    expect(screen.getByText(/- the map/)).toBeTruthy();
  });

  it("hides a card token that is still streaming in, never anything else", () => {
    for (const partial of ["{", "{{", "{{m", "{{mod", "{{mod:", "{{mod:AAN", "{{mod:AANWFOg1", "{{mod:AANWFOg1}"]) expect(withoutPartialToken(`Built: ${partial}`)).toBe("Built: ");
    expect(withoutPartialToken("Built: {{mod:AANWFOg1}}")).toBe("Built: {{mod:AANWFOg1}}");
    expect(withoutPartialToken("a { b")).toBe("a { b");
  });
});
