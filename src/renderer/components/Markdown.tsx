import type { ReactNode } from "react";
import { ModCard } from "./ModCard";

// Minimal, safe Markdown for agent answers: paragraphs, bullet/numbered lists, headings,
// **bold**, *italic*, `code`, and {{mod:<project id>}} as an inline mod card. Builds React
// elements only; never injects HTML.
const MOD_TOKEN = /\{\{mod:([A-Za-z0-9]{8})\}\}/;

// While an answer streams, a card token can arrive in pieces: hide an unfinished one at the end
// instead of showing "{{mod:AB" and then swapping it for a card (CHT-1).
export function withoutPartialToken(text: string): string {
  return text.replace(/\{(\{(m(o(d(:[A-Za-z0-9]{0,8}(\})?)?)?)?)?)?$/, "");
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(`(${MOD_TOKEN.source}|\\*\\*[^*]+\\*\\*|\`[^\`]+\`|\\*[^*\\s][^*]*\\*)`, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const mod = MOD_TOKEN.exec(tok);
    if (mod) out.push(<ModCard key={`${key}-${i++}`} id={mod[1]!} />);
    else if (tok.startsWith("**")) out.push(<strong key={`${key}-${i++}`} className="font-semibold">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={`${key}-${i++}`} className="rounded-xs bg-surface-2 px-1 font-mono text-mono-sm">{tok.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-${i++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks: ReactNode[] = [];
  const lines = (streaming ? withoutPartialToken(text) : text).replace(/\r/g, "").split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      // A line ending in two spaces or a backslash is a hard line break; other lines join with a space.
      const k = `p${blocks.length}`;
      const parts: ReactNode[] = [];
      para.forEach((line, i) => {
        const hard = / {2,}$|\\$/.test(line);
        parts.push(...inline(line.replace(/ {2,}$|\\$/, "").trim(), `${k}-${i}`));
        if (i < para.length - 1) parts.push(hard ? <br key={`${k}-br${i}`} /> : " ");
      });
      blocks.push(<p key={k} className="m-0 mb-2.5">{parts}</p>);
    }
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i} className="mb-1">{inline(it, `l${blocks.length}-${i}`)}</li>);
    blocks.push(list.ordered
      ? <ol key={`l${blocks.length}`} className="m-0 mb-2.5 list-decimal pl-5">{items}</ol>
      : <ul key={`l${blocks.length}`} className="m-0 mb-2.5 list-disc pl-5">{items}</ul>);
    list = null;
  };
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? numbered)![1]!);
    } else if (heading) {
      flushPara(); flushList();
      blocks.push(<h3 key={`h${blocks.length}`} className="m-0 mt-1 mb-2 text-base font-semibold">{inline(heading[1]!, `h${blocks.length}`)}</h3>);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line.replace(/^\s+/, "")); // keep trailing spaces: they mark hard breaks
    }
  }
  flushPara(); flushList();
  return <div className="text-base">{blocks}</div>;
}
