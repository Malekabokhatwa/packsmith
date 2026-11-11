// S05-S07 Packs (the Installed tab): packsmith's own packs, what is in them (matched against
// Modrinth or not), adding from Modrinth with dependencies resolved, on/off, update and remove
// with an undo toast (INT-2), and the Journal tab where every change can be undone (4.3).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Boxes, FlaskConical, FolderOpen, Package, Plus, Search, X } from "lucide-react";
import type { ContentItem, ContentKind, InstanceRecord, JournalEntry, TestReport } from "@shared/schema";
import type { InstallResult, ProjectType, SearchHit } from "@shared/ipc";
import { call, errorMessage } from "../lib/api";
import { compactNumber, describePack, loaderName } from "../lib/format";
import { Header } from "../components/Header";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { EmptyState } from "../components/EmptyState";
import { ContentRow, contentTitle } from "../components/ContentRow";
import { Toast } from "../components/Toast";
import { JournalTab } from "./JournalTab";
import { QuestsTab } from "./QuestsTab";
import { ProjectIcon } from "../components/ProjectIcon";
import { NewPackDialog } from "./NewPackDialog";
import { EvidenceLadder } from "../components/EvidenceLadder";
import { ExportMenu, exportSummary } from "../components/ExportMenu";
import { GraphView, type Graph } from "../components/GraphView";
import { groupItems, groupOf, searchText } from "../lib/categories";
import { FoundDetail, StopManaging, type Found } from "./Adoption";

type Kind = Exclude<ContentKind, "datapack">;
const SCOPE_LABEL = { mods: "mods", configs: "configs", settings: "game settings", shaders: "shaders", resourcepacks: "resource packs", quests: "quests", loader: "the mod loader" } as const;
const TABS: Array<{ kind: Kind; label: string; type: ProjectType; noun: string }> = [
  { kind: "mod", label: "Mods", type: "mod", noun: "mods" },
  { kind: "shader", label: "Shaders", type: "shader", noun: "shaders" },
  { kind: "resourcepack", label: "Resource packs", type: "resourcepack", noun: "resource packs" },
];

export function PacksScreen({ onGoSettings, onPrefill }: { onGoSettings: () => void; onPrefill: (text: string) => void }) {
  const [packs, setPacks] = useState<InstanceRecord[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // The user's other Prism instances, read-only until they choose Manage (ADP-1). Without Prism
  // configured there are none, and that's not an error.
  const [found, setFound] = useState<Found[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await call("packs:list");
      setPacks(list);
      setSelected((cur) => (cur && (cur.startsWith("found:") || list.some((p) => p.id === cur)) ? cur : list[0]?.id ?? null));
    } catch (err) {
      setError(errorMessage(err));
      setPacks([]);
    }
    setFound(await call("adoption:discover").catch(() => []));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const match = (name: string) => name.toLowerCase().includes(filter.trim().toLowerCase());
  const shown = useMemo(() => (packs ?? []).filter((p) => match(p.name)), [packs, filter]);
  const current = packs?.find((p) => p.id === selected) ?? null;
  const currentFound = selected?.startsWith("found:") ? found.find((f) => `found:${f.ref}` === selected) ?? null : null;
  const item = (key: string, title: string, sub: string) => (
    <li key={key}>
      <button type="button" onClick={() => setSelected(key)} aria-current={key === selected ? "true" : undefined}
        className={`relative flex w-full flex-col items-start rounded-sm px-2.5 py-1.5 text-left hover:bg-surface-2 ${key === selected ? "bg-surface-2" : ""}`}>
        {key === selected && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.75 rounded-full bg-accent" aria-hidden />}
        <span className="w-full truncate text-sm font-medium" title={title}>{title}</span>
        <span className="text-xs text-subtle">{sub}</span>
      </button>
    </li>
  );
  const own = shown.filter((p) => p.origin === "own"), managed = shown.filter((p) => p.origin === "adopted");
  const foundShown = found.filter((f) => match(f.name));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Header title="Packs" />
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Packs list" className="flex w-(--list-pane) shrink-0 flex-col gap-3 border-r border-border p-3">
          <label className="flex h-8.5 items-center gap-2 rounded-sm border border-input bg-surface px-2.5 text-sm focus-within:outline-2 focus-within:outline-focus">
            <Search className="size-4 text-subtle" aria-hidden />
            <span className="sr-only">Find a pack</span>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a pack" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle" />
          </label>
          <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setDialogOpen(true)}>New pack</Button>
          <div className="min-h-0 flex-1 overflow-auto">
            <h2 className="mt-1 mb-1.5 px-1 text-xs font-medium text-subtle">Made with packsmith</h2>
            {packs === null && <div className="ps-skeleton mx-1 h-9 rounded-sm bg-surface-2" />}
            {packs !== null && own.length === 0 && <p className="m-0 px-1 text-sm text-subtle">{packs.some((p) => p.origin === "own") ? "No pack matches." : "None yet."}</p>}
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {own.map((p) => item(p.id, p.name, `${loaderName(p.loader)} · ${p.mcVersion}${p.launcher === "prism" ? " · Prism" : ""}`))}
            </ul>
            {managed.length > 0 && <>
              <h2 className="mt-4 mb-1.5 px-1 text-xs font-medium text-subtle">Managed</h2>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {managed.map((p) => item(p.id, p.name, `${loaderName(p.loader)} · ${p.mcVersion} · Prism`))}
              </ul>
            </>}
            {foundShown.length > 0 && <>
              <h2 className="mt-4 mb-1.5 px-1 text-xs font-medium text-subtle">Found in Prism (read-only)</h2>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {foundShown.map((f) => item(`found:${f.ref}`, f.name, `${f.loader ? loaderName(f.loader) : "?"} · ${f.mcVersion ?? "?"}`))}
              </ul>
            </>}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {error && <div className="p-4"><Banner tone="danger">{error}</Banner></div>}
          {currentFound && <FoundDetail key={currentFound.ref} found={currentFound} onManaged={(r) => { setSelected(r.id); void load(); }} />}
          {packs !== null && !current && !currentFound && (
            <EmptyState icon={<Boxes className="size-8" strokeWidth={1.5} />} text="No packs yet. Make one, then add mods from Modrinth."
              action={<Button variant="primary" onClick={() => setDialogOpen(true)}>New pack</Button>} />
          )}
          {current && <PackDetail key={current.id} pack={current} onPrefill={onPrefill} onStopped={() => { setSelected(null); void load(); }} />}
        </section>
      </div>
      <NewPackDialog open={dialogOpen} onOpenChange={setDialogOpen} onGoSettings={onGoSettings}
        onCreated={(r) => { setPacks((ps) => [...(ps ?? []), r]); setSelected(r.id); }} />
    </div>
  );
}

// What an install added, in one sentence: the project, then the libraries it pulled in.
export function installNotice(res: InstallResult): { tone: "info" | "warning"; text: string } {
  const libs = res.added.filter((a) => a.title !== res.title).map((a) => a.title);
  const text = res.alreadyInstalled && !res.added.length
    ? `${res.title} is already in this pack.`
    : `Added ${res.title}${libs.length ? `, plus ${libs.join(", ")} ${libs.length === 1 ? "it needs" : "that it needs"}` : ""}.`;
  return res.unknowns.length ? { tone: "warning", text: `${text} ${res.unknowns.join(" ")}` } : { tone: "info", text };
}

// S06: from this many mods on, the list gets a search, category chips and group headings.
const MANY = 8;

function ModFilters({ items, query, onQuery, group, onGroup }: { items: ContentItem[]; query: string; onQuery: (q: string) => void; group: string | null; onGroup: (g: string | null) => void }) {
  const groups = groupItems(items);
  const chip = (active: boolean) => `rounded-full border px-2.5 py-0.5 text-xs font-medium ${active ? "border-accent bg-surface-2 text-text" : "border-border text-muted hover:text-text"}`;
  return (
    <div className="mb-3 flex flex-col gap-2">
      <label className="flex h-8.5 items-center gap-2 rounded-sm border border-input bg-bg px-2.5 focus-within:border-focus">
        <Search className="size-4 text-subtle" aria-hidden />
        <span className="sr-only">Find a mod</span>
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Find a mod" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
      </label>
      <div role="group" aria-label="Categories" className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={group === null} className={chip(group === null)} onClick={() => onGroup(null)}>All <span className="text-subtle">{items.length}</span></button>
        {groups.map((g) => (
          <button key={g.name} type="button" aria-pressed={group === g.name} className={chip(group === g.name)} onClick={() => onGroup(group === g.name ? null : g.name)}>
            {g.name} <span className="text-subtle">{g.items.length}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function GroupedMods({ items, render }: { items: ContentItem[]; render: (c: ContentItem) => ReactNode }) {
  if (!items.length) return <p className="m-0 text-sm text-subtle">No mods match.</p>;
  return (
    <div className="flex flex-col gap-4">
      {groupItems(items).map((g) => (
        <section key={g.name} aria-label={g.name}>
          <h3 className="m-0 mb-1 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">{g.name} <span className="font-normal text-subtle">{g.items.length}</span></h3>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{g.items.map(render)}</ul>
        </section>
      ))}
    </div>
  );
}

function PackDetail({ pack, onPrefill, onStopped }: { pack: InstanceRecord; onPrefill: (text: string) => void; onStopped: () => void }) {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [journal, setJournal] = useState<JournalEntry[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [tab, setTab] = useState<Kind | "quests" | "journal">("mod");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // relpath being changed
  const [notice, setNotice] = useState<{ tone: "info" | "warning" | "danger"; text: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; entryId?: string } | null>(null);
  const [report, setReport] = useState<TestReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [modView, setModView] = useState<"list" | "graph">("list");
  const [modQuery, setModQuery] = useState("");
  const [modGroup, setModGroup] = useState<string | null>(null);
  useEffect(() => { setModQuery(""); setModGroup(null); }, [pack.id]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  // The graph loads when it's shown, and again whenever the pack's content changes.
  useEffect(() => {
    if (modView !== "graph" || items === null) return;
    setGraph(null); setGraphError(null);
    void call("packs:graph", { id: pack.id }).then(setGraph).catch((e) => setGraphError(errorMessage(e)));
  }, [modView, items, pack.id]);
  const [phase, setPhase] = useState<string | null>(null);
  useEffect(() => {
    if (!testing) { setPhase(null); return; }
    const t = setInterval(() => { void call("tests:progress", { id: pack.id }).then(setPhase).catch(() => undefined); }, 1000);
    return () => clearInterval(t);
  }, [testing, pack.id]);
  useEffect(() => { void call("tests:last", { id: pack.id }).then(setReport).catch(() => setReport(null)); }, [pack.id]);
  async function testNow() {
    setTesting(true);
    setNotice(null);
    try { setReport(await call("tests:run", { id: pack.id })); } catch (e) { setNotice({ tone: "danger", text: errorMessage(e) }); } finally { setTesting(false); }
  }
  // A test only speaks for the pack as it was: any committed change since makes it out of date.
  const stale = report !== null && (journal ?? []).some((e) => e.state === "committed" && e.at > report.at);

  const rescan = useCallback(async () => {
    setScanError(null);
    try {
      setItems(await call("packs:scan", { id: pack.id }));
    } catch (err) {
      setScanError(errorMessage(err));
      setItems([]);
    }
  }, [pack.id]);
  const reloadJournal = useCallback(async () => {
    setJournal(await call("journal:list", { id: pack.id }).catch(() => []));
  }, [pack.id]);
  const refresh = useCallback(() => Promise.all([rescan(), reloadJournal()]), [rescan, reloadJournal]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Run one change, refresh both lists, and offer undo in a toast.
  async function change(relpath: string, run: () => Promise<{ entryId?: string | null; text: string } | null>) {
    setBusy(relpath);
    setNotice(null);
    try {
      const res = await run();
      await refresh();
      if (res) setToast({ text: res.text, entryId: res.entryId ?? undefined });
    } catch (e) {
      setNotice({ tone: "danger", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function undo(entryId: string) {
    await call("journal:undo", { id: pack.id, entryId });
    await refresh();
  }

  const actionsFor = (i: ContentItem) => {
    const title = contentTitle(i);
    return {
      busy: busy !== null,
      onToggle: (enabled: boolean) => void change(i.relpath, async () => {
        const r = await call("packs:setEnabled", { id: pack.id, relpath: i.relpath, enabled, label: title });
        return r.entryId ? { entryId: r.entryId, text: `${enabled ? "Turned on" : "Turned off"} ${title}.` } : null;
      }),
      onUpdate: () => void change(i.relpath, async () => {
        const r = await call("packs:update", { id: pack.id, relpath: i.relpath });
        return { entryId: r.entryId, text: `Updated ${title} to ${r.versionNumber}.` };
      }),
      onRemove: () => void change(i.relpath, async () => {
        const r = await call("packs:remove", { id: pack.id, relpath: i.relpath, label: title });
        return { entryId: r.entryId, text: `Removed ${title}.` };
      }),
    };
  };

  const count = (k: Kind) => items?.filter((i) => i.kind === k).length ?? 0;
  const tabInfo = TABS.find((t) => t.kind === tab);
  const modsBlocked = tab === "mod" && pack.loader === "vanilla";

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-auto px-6 py-5">
        <div className="mb-4 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-xl font-semibold" title={pack.name}>{pack.name}</h2>
            <p className="m-0 mt-1 text-sm text-muted">{describePack(pack, items)}</p>
          </div>
          <Button icon={<FlaskConical className="size-4" aria-hidden />} loading={testing} disabled={testing} onClick={() => void testNow()}>Test now</Button>
          <Button icon={<FolderOpen className="size-4" aria-hidden />} onClick={() => void call("packs:openFolder", { id: pack.id }).catch((e) => setNotice({ tone: "danger", text: errorMessage(e) }))}>Show files</Button>
          {pack.origin === "adopted" && <StopManaging pack={pack} onStopped={onStopped} />}
          <ExportMenu packId={pack.id} onDone={(r) => setNotice(exportSummary(r))} onError={(text) => setNotice({ tone: "danger", text })} />
          {!adding && tabInfo && !modsBlocked && <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setAdding(true)}>Add {tabInfo.noun}</Button>}
        </div>
        {pack.origin === "adopted" && <p className="m-0 -mt-2 mb-4 text-xs text-subtle">Managed: packsmith may change {(pack.scope ?? []).map((x) => SCOPE_LABEL[x]).join(", ")}. Worlds never.</p>}
        {notice && <div className="mb-3"><Banner tone={notice.tone} action={<button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-muted hover:text-text"><X className="size-4" /></button>}>{notice.text}</Banner></div>}
        {scanError && <div className="mb-3"><Banner tone="danger">{scanError}</Banner></div>}
        {testing && (
          <div className="mb-3">
            <Banner>
              {phase ? `Testing: ${phase}.` : "Testing this pack."} The first test downloads Minecraft and can take a few minutes; the game test runs on a hidden screen.
            </Banner>
          </div>
        )}
        {!testing && report && (
          <div className="mb-4 max-w-140">
            <EvidenceLadder report={report} title={`Last test · ${new Date(report.at).toLocaleString()}`} />
            {stale && <p className="m-0 mt-1.5 text-xs text-warning">The pack changed after this test. Test again to prove the current state.</p>}
          </div>
        )}
        {!testing && !report && <p className="m-0 mb-4 text-sm text-subtle">Not tested yet. Test now boots a Minecraft server with this pack, and the game itself once you log in for game tests, to prove it loads.</p>}

        <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Kind | "quests" | "journal")}>
          <Tabs.List aria-label="Pack contents" className="mb-3 flex gap-5 border-b border-border">
            {TABS.map((t) => (
              <Tabs.Trigger key={t.kind} value={t.kind}
                className="-mb-px flex items-center gap-1.5 border-b-2 border-transparent py-2 text-sm font-medium text-muted hover:text-text data-[state=active]:border-accent data-[state=active]:text-text">
                {t.label}
                {count(t.kind) > 0 && <span className="rounded-full bg-surface-2 px-1.5 text-xs text-subtle">{count(t.kind)}</span>}
              </Tabs.Trigger>
            ))}
            <Tabs.Trigger value="quests"
              className="-mb-px flex items-center gap-1.5 border-b-2 border-transparent py-2 text-sm font-medium text-muted hover:text-text data-[state=active]:border-accent data-[state=active]:text-text">
              Quests
            </Tabs.Trigger>
            <Tabs.Trigger value="journal"
              className="-mb-px flex items-center gap-1.5 border-b-2 border-transparent py-2 text-sm font-medium text-muted hover:text-text data-[state=active]:border-accent data-[state=active]:text-text">
              Journal
            </Tabs.Trigger>
          </Tabs.List>
          {TABS.map((t) => (
            <Tabs.Content key={t.kind} value={t.kind} className="outline-none">
              {items === null ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Loading">
                  {[0, 1, 2].map((i) => <li key={i} className="ps-skeleton h-13 rounded-md bg-surface-2" />)}
                </ul>
              ) : t.kind === "mod" && pack.loader === "vanilla" ? (
                <EmptyState icon={<Package className="size-8" strokeWidth={1.5} />} text="This pack has no mod loader, so it can't run mods. Make a Fabric, Forge or NeoForge pack for mods." />
              ) : items.filter((i) => i.kind === t.kind).length === 0 ? (
                <EmptyState icon={<Package className="size-8" strokeWidth={1.5} />} text={`No ${t.noun} in this pack yet.`}
                  action={!adding ? <Button variant="primary" onClick={() => setAdding(true)}>Add {t.noun}</Button> : undefined} />
              ) : (
                <>
                  {t.kind === "mod" && (
                    <div role="radiogroup" aria-label="Show mods as" className="mb-2 flex justify-end gap-1">
                      {(["list", "graph"] as const).map((v) => (
                        <button key={v} type="button" role="radio" aria-checked={modView === v} onClick={() => setModView(v)}
                          className={`rounded-sm px-2.5 py-1 text-xs font-semibold ${modView === v ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}>
                          {v === "list" ? "List" : "Graph"}
                        </button>
                      ))}
                    </div>
                  )}
                  {t.kind === "mod" && modView === "list" && (items.filter((i) => i.kind === "mod").length >= MANY) && (
                    <ModFilters items={items.filter((i) => i.kind === "mod")} query={modQuery} onQuery={setModQuery} group={modGroup} onGroup={setModGroup} />
                  )}
                  {t.kind === "mod" && modView === "graph" ? (
                    graph ? <GraphView graph={graph} />
                      : graphError ? <Banner tone="danger">{graphError}</Banner>
                      : <div className="ps-skeleton h-120 rounded-lg bg-surface-2" aria-label="Loading the graph" />
                  ) : (
                    t.kind === "mod" && items.filter((i) => i.kind === "mod").length >= MANY ? (
                      <GroupedMods items={items.filter((i) => i.kind === "mod" && (modGroup === null || groupOf(i) === modGroup) && (!modQuery.trim() || searchText(i).includes(modQuery.trim().toLowerCase())))}
                        render={(i) => <ContentRow key={i.relpath} item={i} actions={pack.origin === "own" ? actionsFor(i) : undefined} />} />
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {items.filter((i) => i.kind === t.kind).map((i) => <ContentRow key={i.relpath} item={i} actions={pack.origin === "own" ? actionsFor(i) : undefined} />)}
                      </ul>
                    )
                  )}
                </>
              )}
            </Tabs.Content>
          ))}
          <Tabs.Content value="quests" className="outline-none">
            {tab === "quests" && <QuestsTab pack={pack} onPrefill={onPrefill} onChanged={() => void refresh()} />}
          </Tabs.Content>
          <Tabs.Content value="journal" className="outline-none">
            <JournalTab entries={journal} onUndo={(e) => undo(e.id)} />
          </Tabs.Content>
        </Tabs.Root>
      </div>
      {adding && tabInfo && !modsBlocked && (
        <AddPanel pack={pack} type={tabInfo.type} noun={tabInfo.noun} onClose={() => setAdding(false)}
          onInstalled={async (res) => {
            // Refresh the list first, so the notice never contradicts what's on screen.
            await refresh();
            setNotice(installNotice(res));
          }} />
      )}
      {toast && (
        <Toast onClose={() => setToast(null)}
          action={toast.entryId ? <Button size="sm" variant="secondary" onClick={() => {
            const id = toast.entryId!;
            setToast(null);
            void undo(id).then(() => setToast({ text: "Undone." }), (e) => setNotice({ tone: "danger", text: errorMessage(e) }));
          }}>Undo</Button> : undefined}>
          {toast.text}
        </Toast>
      )}
    </div>
  );
}

function AddPanel({ pack, type, noun, onClose, onInstalled }: {
  pack: InstanceRecord; type: ProjectType; noun: string; onClose: () => void; onInstalled: (res: InstallResult) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setHits(null);
    setError(null);
    const t = setTimeout(() => {
      call("modrinth:search", { query, mcVersion: pack.mcVersion, loader: pack.loader, projectType: type })
        .then((h) => { if (live) setHits(h); })
        .catch((e) => { if (live) { setError(errorMessage(e)); setHits([]); } });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [query, pack.mcVersion, pack.loader, type]);

  async function install(hit: SearchHit) {
    setBusy(hit.projectId);
    setError(null);
    try {
      const res = await call("packs:install", { id: pack.id, projectId: hit.projectId });
      setAdded((s) => new Set(s).add(hit.projectId));
      await onInstalled(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    // Third column on wide windows; slides over the list on narrow ones (tiled windows).
    <aside aria-label={`Add ${noun}`} className="z-10 flex w-(--inspector) shrink-0 flex-col border-l border-border bg-surface max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:shadow-pop">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="m-0 flex-1 text-sm font-semibold">Add {noun} from Modrinth</h3>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-sm p-1 text-muted hover:bg-surface-2 hover:text-text"><X className="size-4" /></button>
      </div>
      <div className="p-3">
        <label className="flex h-8.5 items-center gap-2 rounded-sm border border-input bg-bg px-2.5 text-sm focus-within:outline-2 focus-within:outline-focus">
          <Search className="size-4 text-subtle" aria-hidden />
          <span className="sr-only">Search Modrinth</span>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${noun} for ${pack.mcVersion}`} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle" />
        </label>
        <p className="m-0 mt-1.5 text-xs text-subtle">Showing {noun} for {type === "mod" ? `${loaderName(pack.loader)} on ` : ""}Minecraft {pack.mcVersion} only.</p>
      </div>
      {error && <div className="px-3 pb-2"><Banner tone="danger">{error}</Banner></div>}
      <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0 px-1.5 pb-3" aria-busy={hits === null}>
        {hits === null && [0, 1, 2, 3].map((i) => <li key={i} className="ps-skeleton mx-1.5 my-1 h-14 rounded-md bg-surface-2" />)}
        {hits?.length === 0 && !error && <li className="px-3 py-6 text-center text-sm text-muted">Nothing on Modrinth matches that for Minecraft {pack.mcVersion}.</li>}
        {hits?.map((h) => (
          <li key={h.projectId} className="grid grid-cols-[auto_1fr_auto] items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-surface-2">
            <ProjectIcon url={h.iconUrl} title={h.title} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" title={h.title}>{h.title}</div>
              <div className="truncate text-xs text-muted" title={h.summary}>{h.summary}</div>
              <div className="text-xs text-subtle">{compactNumber(h.downloads)} downloads</div>
            </div>
            {added.has(h.projectId)
              ? <span className="px-2 text-xs font-medium text-muted">Added</span>
              : <Button size="sm" variant="primary" loading={busy === h.projectId} disabled={busy !== null && busy !== h.projectId}
                  aria-label={`Add ${h.title}`} onClick={() => void install(h)}>Add</Button>}
          </li>
        ))}
      </ul>
      <p className="m-0 border-t border-border px-4 py-2.5 text-xs text-subtle">Libraries a project needs come along automatically. Each file is checked against Modrinth's published checksum before it lands in the pack.</p>
    </aside>
  );
}
