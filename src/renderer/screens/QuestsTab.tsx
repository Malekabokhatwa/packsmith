// S08 Quests tab (INT-7, QST, D-12/D-26): any engine's book, including books packsmith didn't
// write (a pack's own book never looks empty). Chapter chips, a map of how quests lead into each other,
// the quest list, and a detail panel. Edit buttons put a request in the chat; they never change
// anything themselves. A new quest line starts by picking an engine (QST-1: nothing is added
// without that pick).
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ScrollText, X } from "lucide-react";
import type { Chapter, InstanceRecord, Quest, QuestBook, QuestEngineId, QuestEngineOption } from "@shared/schema";
import { layoutQuests } from "@shared/questLayout";
import { rewardText, taskText } from "@shared/questText";
import { call, errorMessage } from "../lib/api";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { EmptyState } from "../components/EmptyState";
import { plural } from "../lib/format";

const ENGINE_LABEL: Record<QuestEngineId, string> = { heracles: "Heracles", ftbquests: "FTB Quests", vanilla: "Vanilla advancements" };

export interface QuestsTabProps {
  pack: InstanceRecord;
  onPrefill: (text: string) => void;
  onChanged: () => void; // the journal changed
}

function ItemIcon({ id, icons, size = 6 }: { id?: string; icons: Record<string, string | null>; size?: 5 | 6 }) {
  const src = id ? icons[id] : null;
  const box = size === 6 ? "size-6" : "size-5";
  if (src) return <img src={src} alt="" className={`${box} shrink-0 [image-rendering:pixelated]`} />;
  const letters = (id?.split(":").pop() ?? "?").split("_").slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  return <span aria-hidden className={`${box} grid shrink-0 place-items-center rounded-xs bg-surface-2 text-[10px] font-semibold text-subtle`}>{letters}</span>;
}

export function QuestsTab({ pack, onPrefill, onChanged }: QuestsTabProps) {
  const [book, setBook] = useState<QuestBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [questId, setQuestId] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState<Chapter | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const b = await call("quests:get", { id: pack.id });
      setBook(b);
      setChapterId((cur) => (cur && b.chapters.some((c) => c.id === cur) ? cur : (b.chapters[0]?.id ?? null)));
    } catch (e) {
      setError(errorMessage(e));
      setBook({ installed: [], chapters: [], notes: [], names: {} });
    }
  }, [pack.id]);
  useEffect(() => { void load(); }, [load]);

  const chapter = book?.chapters.find((c) => c.id === chapterId) ?? null;
  const quest = chapter?.quests.find((q) => q.id === questId) ?? null;
  const names = book?.names ?? {};

  // Icons for the chapter on screen, fetched once per id.
  useEffect(() => {
    if (!chapter) return;
    const want = [...new Set(chapter.quests.flatMap((q) => [q.icon, ...q.tasks.map((t) => (t.kind === "item" ? t.item : undefined)), ...q.rewards.map((r) => (r.kind === "item" ? r.item : undefined))]))]
      .filter((x): x is string => !!x && !x.startsWith("#") && !(x in icons));
    if (!want.length) return;
    call("quests:icons", { id: pack.id, items: want }).then((got) => setIcons((cur) => ({ ...cur, ...got }))).catch(() => undefined);
  }, [chapter, pack.id, icons]);

  if (book === null) return <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Loading">{[0, 1, 2].map((i) => <li key={i} className="ps-skeleton h-13 rounded-md bg-surface-2" />)}</ul>;

  const own = pack.origin === "own";
  const ourChapter = chapter?.writtenBy === "packsmith" && own;
  const prefix = `In "${pack.name}", quest chapter "${chapter?.title ?? ""}"`;

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="flex-1">
          {book.chapters.length
            ? `Quest engine: ${[...new Set(book.chapters.map((c) => ENGINE_LABEL[c.engine]))].join(", ")} (in this pack)`
            : book.installed.filter((e) => e !== "vanilla").length
              ? `Quest engine: ${book.installed.filter((e) => e !== "vanilla").map((e) => ENGINE_LABEL[e]).join(", ")} (in this pack, no quests yet)`
              : "No quest engine yet"}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void load()}>Refresh</Button>
      </div>

      {book.chapters.length === 0 ? (
        <EmptyState icon={<ScrollText className="size-8" strokeWidth={1.5} />} text="No quests in this pack."
          action={own ? <Button variant="primary" onClick={() => setPicking(true)}>Create a quest line</Button> : undefined} />
      ) : (
        <>
          <div role="tablist" aria-label="Chapters" className="flex flex-wrap items-center gap-1.5">
            {book.chapters.map((c) => (
              <button key={c.id} type="button" role="tab" aria-selected={c.id === chapterId} onClick={() => { setChapterId(c.id); setQuestId(null); }}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm ${c.id === chapterId ? "border-input bg-surface-2 text-text" : "border-transparent text-muted hover:text-text"}`}>
                <span className="max-w-60 truncate">{c.title}</span><span className="text-xs text-subtle">{c.quests.length}</span>
              </button>
            ))}
            {own && <button type="button" onClick={() => setPicking(true)} className="px-1.5 text-sm text-muted underline-offset-2 hover:text-text hover:underline">Add a chapter…</button>}
          </div>

          {chapter && <QuestMap chapter={chapter} icons={icons} selected={questId} onSelect={setQuestId} />}

          {chapter && (
            <div className="grid grid-cols-[1fr_var(--inspector)] items-start gap-4 max-[1180px]:grid-cols-1">
              <ol aria-label="Quests" className="m-0 flex list-none flex-col gap-0.5 p-0">
                {chapter.quests.map((q, i) => (
                  <li key={q.id}
                    className={`group grid cursor-pointer grid-cols-[1.75rem_auto_1fr_auto] items-center gap-2.5 rounded-md border-l-3 px-2.5 py-2 hover:bg-surface-2 ${q.id === questId ? "border-accent bg-surface-2" : "border-transparent"}`}
                    onClick={() => setQuestId(q.id)}>
                    <span className="text-right text-xs text-subtle tabular-nums">{i + 1}</span>
                    <ItemIcon id={q.icon} icons={icons} />
                    <button type="button" className="min-w-0 text-left" onClick={(e) => { e.stopPropagation(); setQuestId(q.id); }} aria-pressed={q.id === questId}>
                      <span className="block truncate font-medium" title={q.title}>{q.title}</span>
                      {summary(q, names) !== q.title && <span className="block truncate text-sm text-muted">{summary(q, names)}</span>}
                    </button>
                    {ourChapter
                      ? <Button size="sm" variant="ghost" aria-label={`Edit ${q.title}`} onClick={(e) => { e.stopPropagation(); onPrefill(`${prefix}, quest "${q.title}": `); }}>Edit</Button>
                      : <span />}
                  </li>
                ))}
              </ol>
              <aside aria-label={quest ? "Quest" : "Chapter"} className="rounded-lg border border-border bg-surface p-4 text-sm">
                {quest ? (
                  <QuestDetail quest={quest} chapter={chapter} names={names} icons={icons} editable={ourChapter} onSelect={setQuestId}
                    onEdit={() => onPrefill(`${prefix}, quest "${quest.title}": `)}
                    onRemove={() => onPrefill(`${prefix}: remove the quest "${quest.title}".`)} />
                ) : (
                  <ChapterDetail chapter={chapter} index={book.chapters.indexOf(chapter)} total={book.chapters.length} editable={ourChapter} onSelect={setQuestId}
                    onEdit={() => onPrefill(`${prefix}: `)}
                    onAdd={() => onPrefill(`In "${pack.name}", add a quest to the "${chapter.title}" chapter: `)}
                    onRemove={() => setRemoving(chapter)} />
                )}
                <p className="m-0 mt-4 border-t border-border pt-3 text-xs text-subtle">This shows the quests as written. packsmith doesn't track anyone's progress.</p>
              </aside>
            </div>
          )}
          {book.notes.map((n) => <p key={n} className="m-0 text-xs text-subtle">{n}</p>)}
        </>
      )}

      <EnginePicker open={picking} pack={pack} onOpenChange={setPicking}
        onPicked={(label) => { onChanged(); void load(); onPrefill(book.chapters.length ? `In "${pack.name}", add a ${label} quest chapter about ` : `Write a quest line for "${pack.name}" with ${label}: `); }} />
      <RemoveChapter chapter={removing} pack={pack} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); setQuestId(null); onChanged(); void load(); }} />
    </div>
  );
}

function summary(q: Quest, names: Record<string, string>): string {
  if (!q.tasks.length) return "No tasks";
  const first = taskText(q.tasks[0]!, names);
  return q.tasks.length > 1 ? `${first}, and ${q.tasks.length - 1} more` : first;
}

// Columns = how far along a chain a quest is; a quest with two or more "after" links is a gate
// (diamond). Selecting a quest lights its path in and out.
function QuestMap({ chapter, icons, selected, onSelect }: { chapter: Chapter; icons: Record<string, string | null>; selected: string | null; onSelect: (id: string) => void }) {
  const ids = useMemo(() => new Set(chapter.quests.map((q) => q.id)), [chapter]);
  const { pos, cols, rows } = useMemo(() => layoutQuests(chapter.quests.map((q) => ({ id: q.id, dependsOn: q.dependsOn }))), [chapter]);
  const lit = useMemo(() => {
    if (!selected) return null;
    const out = new Set([selected]);
    const before = (id: string) => { for (const d of chapter.quests.find((q) => q.id === id)?.dependsOn ?? []) if (ids.has(d) && !out.has(d)) { out.add(d); before(d); } };
    const after = (id: string) => { for (const q of chapter.quests) if (q.dependsOn.includes(id) && !out.has(q.id)) { out.add(q.id); after(q.id); } };
    before(selected); after(selected);
    return out;
  }, [selected, chapter, ids]);
  const X = 64, Y = 44, PAD = 24;
  const w = (cols - 1) * X + PAD * 2, h = (rows - 1) * Y + PAD * 2;
  const at = (id: string) => { const p = pos.get(id)!; return { x: PAD + p.col * X, y: PAD + p.row * Y }; };
  const index = new Map(chapter.quests.map((q, i) => [q.id, i + 1]));
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface" aria-label={`Map of ${chapter.title}: ${plural(chapter.quests.length, "quest")}`} role="img">
      <svg width={Math.max(w, 120)} height={h} className="block">
        {chapter.quests.flatMap((q) => q.dependsOn.filter((d) => ids.has(d)).map((d) => {
          const a = at(d), b = at(q.id);
          const on = lit ? lit.has(d) && lit.has(q.id) : true;
          // Stop short of the target's edge: a gate's diamond reaches ~17 px out, a square 13.
          const isGate = q.dependsOn.filter((x) => ids.has(x)).length > 1;
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const k = (r: number) => r / len;
          const [x1, y1] = [a.x + (b.x - a.x) * k(14), a.y + (b.y - a.y) * k(14)];
          const [x2, y2] = [b.x - (b.x - a.x) * k(isGate ? 19 : 15), b.y - (b.y - a.y) * k(isGate ? 19 : 15)];
          return <line key={`${d}>${q.id}`} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={on && lit ? 2 : 1}
            className={on ? (lit ? "stroke-accent" : "stroke-input") : "stroke-border"} markerEnd="url(#ps-arrow)" />;
        }))}
        <defs><marker id="ps-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" className="fill-input" /></marker></defs>
        {chapter.quests.map((q) => {
          const { x, y } = at(q.id);
          const gate = q.dependsOn.filter((d) => ids.has(d)).length > 1;
          const dim = lit && !lit.has(q.id);
          const sel = q.id === selected;
          return (
            <g key={q.id} transform={`translate(${x},${y})`} opacity={dim ? 0.3 : 1} className="cursor-pointer" onClick={() => onSelect(q.id)}>
              <title>{q.title}</title>
              {gate
                ? <rect x={-12} y={-12} width={24} height={24} rx={3} transform="rotate(45)" className={`fill-surface-2 ${sel ? "stroke-accent" : "stroke-input"}`} strokeWidth={sel ? 2 : 1} />
                : <rect x={-13} y={-13} width={26} height={26} rx={5} className={`fill-surface-2 ${sel ? "stroke-accent" : "stroke-border"}`} strokeWidth={sel ? 2 : 1} />}
              <foreignObject x={-10} y={-10} width={20} height={20}><ItemIcon id={q.icon} icons={icons} size={5} /></foreignObject>
              <text y={24} textAnchor="middle" className="fill-subtle text-[10px]">{index.get(q.id)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Link({ q, onSelect }: { q: Quest; onSelect: (id: string) => void }) {
  return <button type="button" className="text-left text-accent underline-offset-2 hover:underline" onClick={() => onSelect(q.id)}>{q.title}</button>;
}

function QuestDetail({ quest, chapter, names, icons, editable, onSelect, onEdit, onRemove }: {
  quest: Quest; chapter: Chapter; names: Record<string, string>; icons: Record<string, string | null>; editable: boolean;
  onSelect: (id: string) => void; onEdit: () => void; onRemove: () => void;
}) {
  const before = chapter.quests.filter((q) => quest.dependsOn.includes(q.id));
  const outside = quest.dependsOn.length - before.length;
  const after = chapter.quests.filter((q) => q.dependsOn.includes(quest.id));
  const row = "grid grid-cols-[5.5rem_1fr] gap-2 py-1";
  return (
    <>
      <p className="m-0 text-xs text-subtle">Quest {chapter.quests.indexOf(quest) + 1} of {chapter.quests.length} · {chapter.title}</p>
      <h3 className="m-0 mt-1 mb-2 flex items-center gap-2 text-lg font-semibold"><ItemIcon id={quest.icon} icons={icons} /><span className="min-w-0 break-words">{quest.title}</span></h3>
      {quest.description.map((d, i) => <p key={i} className="m-0 mb-2 text-muted">{d}</p>)}
      <div className="mt-2">
        <div className={row}><span className="text-subtle">Task</span><ul className="m-0 list-none p-0">{quest.tasks.map((t, i) => <li key={i}>{taskText(t, names)}</li>)}</ul></div>
        <div className={row}><span className="text-subtle">Reward</span><ul className="m-0 list-none p-0">{quest.rewards.length ? quest.rewards.map((r, i) => <li key={i}>{rewardText(r, names)}</li>) : <li className="text-subtle">None</li>}</ul></div>
        <div className={row}><span className="text-subtle">After</span><span className="flex flex-wrap gap-x-2">{before.length || outside ? <>{before.map((q) => <Link key={q.id} q={q} onSelect={onSelect} />)}{outside > 0 && <span className="text-subtle">{plural(outside, "quest")} in other chapters</span>}</> : <span className="text-subtle">Nothing, it's a start</span>}</span></div>
        <div className={row}><span className="text-subtle">Unlocks</span><span className="flex flex-wrap gap-x-2">{after.length ? after.map((q) => <Link key={q.id} q={q} onSelect={onSelect} />) : <span className="text-subtle">Nothing in this chapter</span>}</span></div>
      </div>
      {editable
        ? <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="primary" onClick={onEdit}>Edit this quest</Button><Button size="sm" onClick={onRemove}>Remove</Button></div>
        : <p className="m-0 mt-3 text-xs text-subtle">This chapter came with the pack, so packsmith only reads it.</p>}
    </>
  );
}

function ChapterDetail({ chapter, index, total, editable, onSelect, onEdit, onAdd, onRemove }: {
  chapter: Chapter; index: number; total: number; editable: boolean; onSelect: (id: string) => void; onEdit: () => void; onAdd: () => void; onRemove: () => void;
}) {
  const { cols } = layoutQuests(chapter.quests.map((q) => ({ id: q.id, dependsOn: q.dependsOn })));
  const first = chapter.quests[0];
  const ids = new Set(chapter.quests.map((q) => q.id));
  const last = chapter.quests.filter((q) => !chapter.quests.some((o) => o.dependsOn.includes(q.id)) && q.dependsOn.some((d) => ids.has(d))).at(-1);
  return (
    <>
      <p className="m-0 text-xs text-subtle">Chapter {index + 1} of {total}</p>
      <h3 className="m-0 mt-1 text-lg font-semibold break-words">{chapter.title}</h3>
      <p className="m-0 mt-1 flex items-center gap-2 text-xs text-subtle">
        <span className="rounded-xs border border-border px-1.5 text-muted">{ENGINE_LABEL[chapter.engine]}</span>
        {chapter.writtenBy === "packsmith" ? <span className="rounded-xs border border-border px-1.5 text-muted">Written here</span> : <span>Came with the pack</span>}
      </p>
      <p className="m-0 mt-3">{plural(chapter.quests.length, "quest")}, {plural(cols, "step")} long.</p>
      {first && <p className="m-0 mt-1 text-muted">Starts with <Link q={first} onSelect={onSelect} />{last && last !== first ? <>, ends at <Link q={last} onSelect={onSelect} /></> : null}.</p>}
      <p className="m-0 mt-2 text-muted">Pick a quest to see what it asks for and gives.</p>
      {editable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onEdit}>Edit chapter</Button>
          <Button size="sm" onClick={onAdd}>Add a quest</Button>
          <Button size="sm" variant="danger" onClick={onRemove}>Remove chapter</Button>
        </div>
      )}
    </>
  );
}

function EnginePicker({ open, pack, onOpenChange, onPicked }: { open: boolean; pack: InstanceRecord; onOpenChange: (o: boolean) => void; onPicked: (label: string) => void }) {
  const [options, setOptions] = useState<QuestEngineOption[] | null>(null);
  const [choice, setChoice] = useState<QuestEngineId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setOptions(null); setError(null);
    call("quests:engines", { id: pack.id }).then((o) => {
      setOptions(o);
      // An engine already in the pack first, then one packsmith can add, then vanilla.
      setChoice((o.find((x) => x.id !== "vanilla" && x.installed && x.canWrite) ?? o.find((x) => x.canInstall) ?? o.find((x) => x.canWrite))?.id ?? null);
    }).catch((e) => setError(errorMessage(e)));
  }, [open, pack.id]);
  const picked = options?.find((o) => o.id === choice);
  async function go() {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      if (!picked.installed) await call("quests:installEngine", { id: pack.id, engine: picked.id });
      onOpenChange(false);
      onPicked(picked.label);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
          <div className="mb-2 flex items-center">
            <Dialog.Title className="m-0 flex-1 text-lg font-semibold">Pick a quest engine</Dialog.Title>
            <Dialog.Close aria-label="Close" className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></Dialog.Close>
          </div>
          <Dialog.Description className="m-0 mb-4 text-sm text-muted">The quests are written for the engine you pick. packsmith adds it to the pack only if you choose it here.</Dialog.Description>
          {!options && !error && <div className="ps-skeleton h-40 rounded-md bg-surface-2" aria-label="Loading" />}
          {options && (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="sr-only">Quest engine</legend>
              {options.map((o) => {
                const usable = o.canWrite || o.canInstall;
                return (
                  <label key={o.id} className={`flex items-start gap-2.5 rounded-sm border border-border px-3 py-2 ${usable ? "cursor-pointer has-checked:border-accent" : "opacity-60"}`}>
                    <input type="radio" name="engine" value={o.id} checked={choice === o.id} disabled={!usable} onChange={() => setChoice(o.id)} className="mt-1 accent-accent" />
                    <span className="flex flex-col"><span className="text-sm font-medium">{o.label}{o.installed && o.id !== "vanilla" ? " · in this pack" : ""}</span><span className="text-xs text-muted">{o.note}</span></span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {error && <div className="mt-3"><Banner tone="danger">{error}</Banner></div>}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild><Button type="button" variant="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
            <Button variant="primary" loading={busy} disabled={!picked} onClick={() => void go()}>{picked && !picked.installed ? `Add ${picked.label}` : "Use this engine"}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RemoveChapter({ chapter, pack, onClose, onRemoved }: { chapter: Chapter | null; pack: InstanceRecord; onClose: () => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!chapter) return;
    setBusy(true); setError(null);
    try {
      await call("quests:removeChapter", { id: pack.id, engine: chapter.engine, title: chapter.title });
      onRemoved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root open={chapter !== null} onOpenChange={(o) => { if (!o && !busy) { setError(null); onClose(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-120 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-pop outline-none">
          <Dialog.Title className="m-0 mb-2 text-lg font-semibold">Remove “{chapter?.title}”?</Dialog.Title>
          <Dialog.Description className="m-0 mb-4 text-sm text-muted">Its {plural(chapter?.quests.length ?? 0, "quest")} leave the book. You can bring it back from the Journal tab.</Dialog.Description>
          {error && <div className="mb-3"><Banner tone="danger">{error}</Banner></div>}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild><Button type="button" variant="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
            <Button variant="danger" loading={busy} onClick={() => void go()}>Remove chapter</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
