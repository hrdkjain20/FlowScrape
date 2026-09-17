import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PanelToWorkerMessage, WorkerToPanelMessage } from "../shared/protocol";
import type { AiCleanupResult, AiStatus, CollectionCandidate, FieldDefinition, FieldType, ScrapedRecord, SessionState, Settings } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";
import { makeId, safeFilename } from "../shared/utils";
import { downloadText, toCsv, toJson, toJsonLines } from "../export/exporters";

const fieldTypes: FieldType[] = ["text", "number", "price", "date", "url", "image", "email", "phone", "attribute", "html"];
const extensionVersion = chrome.runtime.getManifest().version;
const groqOrigin = "https://api.groq.com/*";

const statusLabels: Record<string, string> = {
  idle: "Idle", detecting: "Analyzing", ready: "Ready", selecting: "Select on page",
  capturing: "Live capture", paused: "Paused", stopped: "Stopped", error: "Needs attention"
};

const selectorIsValid = (selector: string): boolean => {
  if (!selector.trim()) return false;
  try { document.createDocumentFragment().querySelector(selector); return true; } catch { return false; }
};

function FieldEditor({ fields, onChange, onPick }: { fields: FieldDefinition[]; onChange: (fields: FieldDefinition[]) => void; onPick: (fieldId: string) => void }) {
  const update = (index: number, patch: Partial<FieldDefinition>) => onChange(fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return <div className="field-list" aria-label="Columns">
    {fields.map((field, index) => <details className="field" key={field.id} open={index < 4}>
      <summary><span className="drag">⋮⋮</span><span>{field.name}</span><span className="type-tag">{field.type}</span></summary>
      <div className="field-grid">
        <label>Name<input value={field.name} onChange={(event) => update(index, { name: event.target.value.slice(0, 80) })} /></label>
        <label>Type<select value={field.type} onChange={(event) => update(index, { type: event.target.value as FieldType })}>{fieldTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label className="wide">Selector<input className={selectorIsValid(field.selector) ? "" : "invalid"} value={field.selector} onChange={(event) => update(index, { selector: event.target.value, selectors: undefined, pattern: undefined, patternFlags: undefined })} aria-invalid={!selectorIsValid(field.selector)} /></label>
        {field.type === "attribute" && <label className="wide">Attribute<input value={field.attribute ?? ""} onChange={(event) => update(index, { attribute: event.target.value })} /></label>}
        <div className="field-actions wide">
          <button className="icon" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${field.name} left`}>←</button>
          <button className="icon" onClick={() => move(index, 1)} disabled={index === fields.length - 1} aria-label={`Move ${field.name} right`}>→</button>
          <button className="quiet" onClick={() => update(index, { hidden: !field.hidden })}>{field.hidden ? "Show" : "Hide"}</button>
          <button className="quiet" onClick={() => onPick(field.id)}>Pick on page</button>
          <button className="danger-text" onClick={() => onChange(fields.filter((_, fieldIndex) => fieldIndex !== index))}>Delete</button>
        </div>
        {field.explanation && <small className="wide muted">{Math.round((field.confidence ?? 0) * 100)}% · {field.explanation}</small>}
      </div>
    </details>)}
    <button className="dashed" onClick={() => onChange([...fields, { id: makeId("field"), name: `Field ${fields.length + 1}`, selector: ":scope", type: "text", multiple: false, required: false }])}>+ Add custom field</button>
  </div>;
}

function CandidateCard({ candidate, selected, onSelect }: { candidate: CollectionCandidate; selected: boolean; onSelect: () => void }) {
  return <button className={`candidate ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
    <span className="candidate-top"><strong>{candidate.name}</strong><span className="score">{candidate.score}%</span></span>
    <span>{candidate.itemCount} items · {candidate.fields.length} inferred columns</span>
    <small>{candidate.explanation}</small>
  </button>;
}

function RecordTable({ records, fields, search, selected, onToggle }: { records: ScrapedRecord[]; fields: FieldDefinition[]; search: string; selected: Set<string>; onToggle: (recordId: string) => void }) {
  const parent = useRef<HTMLDivElement>(null);
  const visibleFields = fields.filter((field) => !field.hidden);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? records.filter((record) => Object.values(record.values).some((value) => String(value ?? "").toLocaleLowerCase().includes(query))) : records;
  }, [records, search]);
  const virtualizer = useVirtualizer({ count: filtered.length, getScrollElement: () => parent.current, estimateSize: () => 38, overscan: 8 });
  return <div className="table-shell" ref={parent} tabIndex={0} aria-label="Captured records">
    <div className="table-row header" style={{ gridTemplateColumns: `48px repeat(${Math.max(visibleFields.length, 1)}, minmax(130px, 1fr))`, width: Math.max(360, 48 + visibleFields.length * 145) }}>
      <span>Select</span>{visibleFields.map((field) => <span key={field.id}>{field.name}</span>)}
    </div>
    <div className="virtual-space" style={{ height: virtualizer.getTotalSize(), width: Math.max(360, 48 + visibleFields.length * 145) }}>
      {virtualizer.getVirtualItems().map((row) => {
        const record = filtered[row.index];
        return <div className="table-row" key={record.id} style={{ transform: `translateY(${row.start}px)`, gridTemplateColumns: `48px repeat(${Math.max(visibleFields.length, 1)}, minmax(130px, 1fr))` }}>
          <span className="row-number"><input type="checkbox" aria-label={`Select row ${row.index + 1}`} checked={selected.has(record.id)} onChange={() => onToggle(record.id)} /> {row.index + 1}</span>
          {visibleFields.map((field) => <span title={String(record.values[field.id] ?? "")} key={field.id}>{Array.isArray(record.values[field.id]) ? (record.values[field.id] as string[]).join(" | ") : String(record.values[field.id] ?? "")}</span>)}
        </div>;
      })}
    </div>
  </div>;
}

export function App() {
  const [state, setState] = useState<SessionState | null>(null);
  const [records, setRecords] = useState<ScrapedRecord[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [selectedId, setSelectedId] = useState("");
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const [tab, setTab] = useState<"capture" | "settings">("capture");
  const [aiStatus, setAiStatus] = useState<AiStatus>({ configured: false, persistent: false, testing: false, cleaning: false, model: DEFAULT_SETTINGS.aiModel });
  const [aiResult, setAiResult] = useState<AiCleanupResult | null>(null);
  const [datasetView, setDatasetView] = useState<"original" | "cleaned">("original");
  const [aiInstruction, setAiInstruction] = useState("");
  const [persistAiKey, setPersistAiKey] = useState(false);
  const aiKeyRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    let disposed = false;
    const port = chrome.runtime.connect({ name: "flowscrape-panel" });
    portRef.current = port;
    port.onDisconnect.addListener(() => {
      if (!disposed) setTimeout(() => location.reload(), 250);
    });
    port.onMessage.addListener((message: WorkerToPanelMessage) => {
      if (message.type === "STATE") {
        setState(message.state);
        if (message.state) {
          const candidateId = message.state.selectedCandidateId || message.state.candidates[0]?.id || "";
          setSelectedId((current) => message.state?.selectedCandidateId || (message.state?.candidates.some((candidate) => candidate.id === current) ? current : candidateId));
          setFields((current) => message.state?.fields.length ? message.state.fields : message.state?.selectedCandidateId ? current : message.state?.candidates.find((candidate) => candidate.id === candidateId)?.fields ?? current);
          port.postMessage({ type: "GET_RECORDS" } satisfies PanelToWorkerMessage);
        }
      }
      if (message.type === "RECORDS") { setRecords(message.records); setAiResult(null); setDatasetView("original"); }
      if (message.type === "SETTINGS") setSettings(message.settings);
      if (message.type === "AI_STATUS") { setAiStatus(message.status); setPersistAiKey(message.status.persistent); }
      if (message.type === "AI_CLEAN_RESULT") { setAiResult(message.result); setDatasetView("cleaned"); setSelectedRows(new Set()); }
      if (message.type === "NOTICE") { setNotice(message.message); setTimeout(() => setNotice(""), 5000); }
    });
    port.postMessage({ type: "PANEL_CONNECT" } satisfies PanelToWorkerMessage);
    return () => { disposed = true; port.disconnect(); };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
  }, [settings.theme]);

  const send = (message: PanelToWorkerMessage) => portRef.current?.postMessage(message);
  const selectCandidate = (candidate: CollectionCandidate) => { setSelectedId(candidate.id); setFields(candidate.fields); };
  const updateFields = (next: FieldDefinition[]) => { setFields(next); if (state?.selectedCandidateId) send({ type: "UPDATE_FIELDS", fields: next }); };
  const selectedCandidate = state?.candidates.find((candidate) => candidate.id === selectedId);
  const canStart = Boolean(selectedCandidate && fields.length && fields.every((field) => selectorIsValid(field.selector)));
  const activeRecords = datasetView === "cleaned" && aiResult ? aiResult.records : records;
  const activeFields = datasetView === "cleaned" && aiResult ? aiResult.fields : fields;

  const requestGroqPermission = async (): Promise<boolean> => {
    const granted = await chrome.permissions.request({ origins: [groqOrigin] });
    if (!granted) { setNotice("Groq access was not granted. No data was sent."); setTimeout(() => setNotice(""), 5000); }
    return granted;
  };

  const saveAiKey = async () => {
    const key = aiKeyRef.current?.value.trim() ?? "";
    if (!key) { setNotice("Paste a Groq API key first."); return; }
    if (!await requestGroqPermission()) return;
    send({ type: "AI_SAVE_KEY", key, persistent: persistAiKey });
    if (aiKeyRef.current) aiKeyRef.current.value = "";
  };

  const runAiCleanup = async () => {
    if (!await requestGroqPermission()) return;
    send({ type: "AI_CLEAN", instruction: aiInstruction, fields });
  };

  const exportData = (format: "csv" | "json" | "jsonl") => {
    if (!state || !activeRecords.length) return;
    const output = format === "csv" ? toCsv(activeRecords, activeFields, settings.includeMetadata) : format === "json" ? toJson(activeRecords, activeFields, settings.includeMetadata) : toJsonLines(activeRecords, activeFields, settings.includeMetadata);
    const mime = format === "csv" ? "text/csv" : format === "json" ? "application/json" : "application/x-ndjson";
    downloadText(output, safeFilename(`${state.page.hostname}_${datasetView}`, format), mime);
  };
  const copyRows = async () => {
    const chosen = activeRecords.filter((record) => selectedRows.has(record.id));
    await navigator.clipboard.writeText(toJson(chosen, activeFields, settings.includeMetadata));
    setNotice(`Copied ${chosen.length} selected records as JSON.`);
  };

  return <main>
    <header className="app-header">
      <div className="brand"><div className="logo">F</div><div><h1>FlowScrape</h1><span>Local structured capture · v{extensionVersion}</span></div></div>
      <nav><button className={tab === "capture" ? "active" : ""} onClick={() => setTab("capture")}>Capture</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button></nav>
    </header>
    {notice && <div className="toast" role="status">{notice}</div>}
    {tab === "settings" ? <section className="panel settings">
      <h2>Settings & privacy</h2>
      <label>Theme<select value={settings.theme} onChange={(event) => { const next = { ...settings, theme: event.target.value as Settings["theme"] }; setSettings(next); send({ type: "SETTINGS_UPDATE", settings: next }); }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label>Maximum records<input type="number" min={100} max={100000} value={settings.maxRecords} onChange={(event) => { const next = { ...settings, maxRecords: Math.max(100, Math.min(100000, Number(event.target.value))) }; setSettings(next); send({ type: "SETTINGS_UPDATE", settings: next }); }} /></label>
      <label className="check"><input type="checkbox" checked={settings.includeMetadata} onChange={(event) => { const next = { ...settings, includeMetadata: event.target.checked }; setSettings(next); send({ type: "SETTINGS_UPDATE", settings: next }); }} /> Include capture metadata in exports</label>
      <label>Domain blocklist<textarea placeholder="example.com, one per line" value={settings.blockedDomains.join("\n")} onChange={(event) => { const next = { ...settings, blockedDomains: event.target.value.split(/\n|,/).map((value) => value.trim().toLowerCase()).filter(Boolean) }; setSettings(next); send({ type: "SETTINGS_UPDATE", settings: next }); }} /></label>
      <div className="ai-settings">
        <h3>AI cleanup · Groq</h3>
        <p>Paste your key here. It is sent only to Groq as an Authorization header and is never included in scraped records, exports, prompts, or page scripts.</p>
        <label>Groq API key<input ref={aiKeyRef} type="password" autoComplete="off" spellCheck={false} placeholder={aiStatus.configured ? "Key configured — paste to replace" : "gsk_…"} /></label>
        <label className="check"><input type="checkbox" checked={persistAiKey} onChange={(event) => setPersistAiKey(event.target.checked)} /> Keep key after browser restart using extension-local storage</label>
        <label>Model<select value={settings.aiModel} onChange={(event) => { const next = { ...settings, aiModel: event.target.value as Settings["aiModel"] }; setSettings(next); send({ type: "SETTINGS_UPDATE", settings: next }); }}><option value="openai/gpt-oss-20b">GPT-OSS 20B · faster</option><option value="openai/gpt-oss-120b">GPT-OSS 120B · higher quality</option></select></label>
        <label className="check"><input type="checkbox" checked={settings.aiCachePlans} onChange={(event) => { const next = { ...settings, aiCachePlans: event.target.checked }; setSettings(next); send({ type: "SETTINGS_UPDATE", settings: next }); }} /> Cache validated cleanup plans locally for 30 days</label>
        <div className="ai-actions"><button className="primary" onClick={() => void saveAiKey()} disabled={aiStatus.testing}>Save & test</button><button className="quiet" onClick={() => void requestGroqPermission().then((allowed) => allowed && send({ type: "AI_TEST" }))} disabled={!aiStatus.configured || aiStatus.testing}>Test</button><button className="danger-text" onClick={() => send({ type: "AI_DELETE_KEY" })} disabled={!aiStatus.configured}>Delete key</button></div>
        <span className={`ai-connection ${aiStatus.configured ? "connected" : ""}`}>{aiStatus.testing ? "Testing connection…" : aiStatus.configured ? `Configured ${aiStatus.persistent ? "persistently" : "for this browser session"}` : "Not configured"}</span>
        {aiStatus.lastError && <div className="alert error">{aiStatus.lastError}</div>}
      </div>
      <button className="quiet" onClick={() => chrome.runtime.openOptionsPage()}>Open privacy & threat model</button>
    </section> : <>
      <section className="page-bar">
        <div className="site-icon">{state?.page.hostname?.[0]?.toUpperCase() || "?"}</div>
        <div className="page-copy"><strong>{state?.page.title || "Choose a webpage"}</strong><span>{state?.page.hostname || "Open FlowScrape while viewing an HTTP(S) page"}</span></div>
        <span className={`status ${state?.status ?? "idle"}`}><i />{statusLabels[state?.status ?? "idle"]}</span>
      </section>
      {(state?.warning || state?.error || state?.page.limitations.length || state?.page.inaccessibleFrames) ? <section className="alerts" aria-live="polite">
        {state.warning && <div className="alert warning">{state.warning}</div>}
        {state.error && <div className="alert error">{state.error}</div>}
        {state.page.inaccessibleFrames > 0 && <div className="alert warning">{state.page.inaccessibleFrames} cross-origin frame(s) could not be inspected. Open that frame directly if you are authorized to collect it.</div>}
        {state.page.limitations.map((limit) => <div className="alert warning" key={limit}>{limit}</div>)}
      </section> : null}
      <section className="toolbar">
        <button className="quiet" onClick={() => send({ type: "DETECT" })} disabled={state?.status === "detecting"}>↻ Smart detect</button>
        <button className="quiet" onClick={() => send({ type: "START_POINT_SELECT" })}>⌖ Point & select</button>
      </section>
      {!state || state.status === "detecting" ? <section className="empty"><div className="spinner" /><h2>Finding structured collections</h2><p>FlowScrape is comparing visible repeated structures. Nothing is collected yet.</p></section> : !state.candidates.length ? <section className="empty"><div className="empty-icon">◇</div><h2>No clear collection found</h2><p>Try Point & select on a repeated item, or add custom fields after selecting a nearby collection.</p></section> : <>
        <section className="panel candidates"><div className="section-title"><div><h2>Detected collections</h2><p>Select what you want to capture.</p></div><span>{state.candidates.length}</span></div>
          <div className="candidate-list">{state.candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} selected={selectedId === candidate.id} onSelect={() => selectCandidate(candidate)} />)}</div>
        </section>
        <section className="panel"><div className="section-title"><div><h2>Columns</h2><p>Rename, reorder, hide, delete, or redefine fields.</p></div><span>{fields.filter((field) => !field.hidden).length}</span></div>
          <FieldEditor fields={fields} onChange={updateFields} onPick={(fieldId) => send({ type: "START_FIELD_SELECT", fieldId, candidateId: selectedId, fields })} />
          {!state.selectedCandidateId && <button className="primary full" disabled={!canStart} onClick={() => send({ type: "START_CAPTURE", candidateId: selectedId, fields })}>Start live capture</button>}
        </section>
      </>}
      {state && (state.selectedCandidateId || records.length > 0) && <section className="panel live">
        <div className="section-title"><div><h2>Live data</h2><p>Updates as the page renders new items.</p></div><strong className="count">{state.stats.total.toLocaleString()}</strong></div>
        <div className="stats"><span><b>{state.stats.duplicates}</b> duplicates</span><span><b>{state.stats.incomplete}</b> incomplete</span><span><b>{state.stats.batches}</b> batches</span></div>
        {state.stats.total > settings.maxRecords * 0.8 && <div className="alert warning">Approaching the {settings.maxRecords.toLocaleString()} record limit. Export or stop soon to limit memory use.</div>}
        <div className="ai-cleaner">
          <div className="section-title"><div><h2>AI cleanup</h2><p>Groq receives field profiles and up to three shortened sample values per field. Full records and your API key are never placed in the prompt.</p></div><span>Optional</span></div>
          <label>What should the clean dataset contain? <span className="muted">Optional</span><textarea maxLength={1000} value={aiInstruction} onChange={(event) => setAiInstruction(event.target.value)} placeholder="Example: Keep supplier identity, product details and public contact information. Remove navigation and promotional boilerplate." /></label>
          <div className="ai-actions">{aiStatus.cleaning ? <><button className="quiet" onClick={() => send({ type: "AI_CANCEL" })}>Cancel</button><span className="muted">AI is planning and validating the schema…</span></> : <button className="primary" onClick={() => void runAiCleanup()} disabled={!records.length || !aiStatus.configured}>Clean with AI</button>}</div>
          {!aiStatus.configured && <p className="muted">Add a Groq API key in Settings to enable AI cleanup.</p>}
          {aiResult && <div className="ai-result"><strong>{aiResult.plan.recordType}</strong><p>{aiResult.plan.summary}</p><div className="stats"><span><b>{aiResult.originalCount}</b> original</span><span><b>{aiResult.cleanedCount}</b> clean</span><span><b>{aiResult.fields.length}</b> fields</span>{aiResult.cacheHit && <span>cached plan</span>}</div><div className="view-switch"><button className={datasetView === "original" ? "primary" : "quiet"} onClick={() => { setDatasetView("original"); setSelectedRows(new Set()); }}>Original</button><button className={datasetView === "cleaned" ? "primary" : "quiet"} onClick={() => { setDatasetView("cleaned"); setSelectedRows(new Set()); }}>AI cleaned</button></div><p className="muted">Original records remain unchanged. Exports use the selected view.</p></div>}
        </div>
        <div className="live-tools"><input type="search" placeholder={`Search ${datasetView} records`} value={search} onChange={(event) => setSearch(event.target.value)} /><button className="quiet" onClick={() => copyRows()} disabled={!selectedRows.size}>Copy selected ({selectedRows.size})</button></div>
        <RecordTable records={activeRecords} fields={activeFields} search={search} selected={selectedRows} onToggle={(recordId) => setSelectedRows((current) => { const next = new Set(current); if (next.has(recordId)) next.delete(recordId); else next.add(recordId); return next; })} />
        <div className="capture-actions">
          {state.status === "capturing" ? <button className="quiet" onClick={() => send({ type: "PAUSE" })}>Pause</button> : state.status === "paused" ? <button className="primary" onClick={() => send({ type: "RESUME" })}>Resume</button> : null}
          <button className="quiet" onClick={() => send({ type: "UNDO" })} disabled={!state.stats.batches}>Undo batch</button>
          <button className="quiet" onClick={() => send({ type: "STOP" })} disabled={state.status === "stopped"}>Stop</button>
          <button className="danger-text" onClick={() => { if (confirm("Clear this session and all captured records?")) { send({ type: "CLEAR" }); setRecords([]); setFields([]); setSelectedRows(new Set()); } }}>Clear</button>
        </div>
        <div className="export-row"><button onClick={() => exportData("csv")} disabled={!activeRecords.length}>CSV · {datasetView}</button><button onClick={() => exportData("json")} disabled={!activeRecords.length}>JSON · {datasetView}</button><button onClick={() => exportData("jsonl")} disabled={!activeRecords.length}>JSONL · {datasetView}</button></div>
      </section>}
    </>}
  </main>;
}
