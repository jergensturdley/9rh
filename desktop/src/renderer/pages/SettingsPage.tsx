/**
 * Settings: 9rh user config defaults (~/.9rh/config.json), desktop app state
 * (~/.9rh/desktop.json), a backend detection check, and an About card. Each
 * section saves on its own and shows a saved / error note inline.
 */

import { useEffect, useState } from "react";
import type { ProviderPreset, UserConfig } from "9rh";
import type { AppState, BackendChoice, BackendMode, BackendSummary, IpcResult } from "@shared/ipc";
import { Badge, Button, ErrorNote, Spinner } from "@renderer/components/ui";
import { useAsync } from "@renderer/state/useAsync";
import "./SettingsPage.css";

type Note = { kind: "saved" } | { kind: "error"; text: string } | null;

/** Runs a save, tracks busy state, and turns the IpcResult into a note. */
function useSaver(): [Note, boolean, <T>(op: () => Promise<IpcResult<T>>, then?: (v: T) => void) => Promise<void>] {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const save = async <T,>(op: () => Promise<IpcResult<T>>, then?: (v: T) => void): Promise<void> => {
    setBusy(true);
    const res = await op();
    setBusy(false);
    if (res.ok) {
      then?.(res.value);
      setNote({ kind: "saved" });
    } else {
      setNote({ kind: "error", text: res.error });
    }
  };
  return [note, busy, save];
}

function SaveNote({ note }: { note: Note }) {
  if (!note) return null;
  return note.kind === "saved" ? <span className="settings-saved">Saved</span> : <ErrorNote message={note.text} />;
}

export function SettingsPage() {
  return (
    <div className="settings">
      <DefaultsSection />
      <AppSection />
      <BackendCheckSection />
      <AboutSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Defaults: ~/.9rh/config.json
// ---------------------------------------------------------------------------

function DefaultsSection() {
  const cfg = useAsync(() => window.ninerh.config.get(), []);
  const [form, setForm] = useState<UserConfig>({});
  const [note, busy, save] = useSaver();
  useEffect(() => {
    if (cfg.data) setForm(cfg.data);
  }, [cfg.data]);

  const backend = form.backend === "router" || form.backend === "direct" ? form.backend : "auto";
  const submit = (): void => {
    // Explicit undefined clears a key: structured clone keeps it over IPC and
    // JSON.stringify drops it when config.json is written.
    const patch: UserConfig = {
      defaultModel: form.defaultModel?.trim() || undefined,
      defaultProvider: form.defaultProvider?.trim() || undefined,
      backend: backend === "auto" ? undefined : backend,
      keepReports: form.keepReports ? true : undefined,
      reportPath: form.reportPath?.trim() || undefined,
    };
    void save(() => window.ninerh.config.set(patch), setForm);
  };

  return (
    <section className="settings-section">
      <h2>Defaults</h2>
      <p className="settings-hint">Persisted to ~/.9rh/config.json and shared with the CLI.</p>
      {cfg.error ? <ErrorNote message={cfg.error} onRetry={() => void cfg.refresh()} /> : null}
      {cfg.data === null && !cfg.error ? <Spinner /> : null}
      <div className="settings-grid">
        <label>
          Default model
          <input value={form.defaultModel ?? ""} placeholder="kr/claude-sonnet-4.5" onChange={(e) => setForm({ ...form, defaultModel: e.target.value })} />
        </label>
        <label>
          Default provider
          <input value={form.defaultProvider ?? ""} placeholder="kr" onChange={(e) => setForm({ ...form, defaultProvider: e.target.value })} />
        </label>
        <label>
          Backend
          <select value={backend} onChange={(e) => setForm({ ...form, backend: e.target.value === "auto" ? undefined : e.target.value })}>
            <option value="auto">auto (detect)</option>
            <option value="router">router (9router)</option>
            <option value="direct">direct (OpenAI-compatible)</option>
          </select>
        </label>
        <label>
          Report path
          <input value={form.reportPath ?? ""} placeholder="~/.9rh/last-run.html" onChange={(e) => setForm({ ...form, reportPath: e.target.value })} />
        </label>
        <label className="settings-check">
          <input type="checkbox" checked={form.keepReports ?? false} onChange={(e) => setForm({ ...form, keepReports: e.target.checked })} />
          Keep every turn's report with a unique filename
        </label>
      </div>
      <div className="settings-actions">
        <Button variant="primary" disabled={busy || cfg.data === null} onClick={submit}>
          {busy ? "Saving..." : "Save defaults"}
        </Button>
        <SaveNote note={note} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// App: ~/.9rh/desktop.json
// ---------------------------------------------------------------------------

function AppSection() {
  const app = useAsync(() => window.ninerh.config.appState(), []);
  const [form, setForm] = useState<Partial<AppState>>({});
  const [note, busy, save] = useSaver();
  useEffect(() => {
    if (app.data) setForm(app.data);
  }, [app.data]);

  const apply = (patch: Partial<AppState>): void => {
    void save(() => window.ninerh.config.setAppState(patch), setForm);
  };
  const recents = form.recentWorkDirs ?? [];

  return (
    <section className="settings-section">
      <h2>App</h2>
      <p className="settings-hint">Desktop preferences in ~/.9rh/desktop.json.</p>
      {app.error ? <ErrorNote message={app.error} onRetry={() => void app.refresh()} /> : null}
      {app.data === null && !app.error ? <Spinner /> : null}
      <div className="settings-grid">
        <label className="settings-check">
          <input type="checkbox" checked={form.quietByDefault ?? false} onChange={(e) => setForm({ ...form, quietByDefault: e.target.checked })} />
          New sessions start quiet (thinking collapsed)
        </label>
        <label>
          Router poll interval (ms)
          <input
            type="number"
            min={1000}
            step={1000}
            value={form.routerPollMs ?? 15000}
            onChange={(e) => setForm({ ...form, routerPollMs: Math.max(1000, Number(e.target.value) || 15000) })}
          />
        </label>
      </div>
      <div className="settings-actions">
        <Button variant="primary" disabled={busy || app.data === null} onClick={() => apply({ quietByDefault: form.quietByDefault ?? false, routerPollMs: form.routerPollMs ?? 15000 })}>
          {busy ? "Saving..." : "Save app settings"}
        </Button>
        <SaveNote note={note} />
      </div>
      <h3>Recent workdirs</h3>
      {recents.length === 0 ? (
        <p className="settings-hint">None yet. Creating a session remembers its folder here.</p>
      ) : (
        <>
          <ul className="settings-recents">
            {recents.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => apply({ recentWorkDirs: [] })}>
            Remove all
          </Button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Backend check
// ---------------------------------------------------------------------------

export function BackendChoiceForm({
  value,
  onChange,
  presets,
}: {
  value: BackendChoice;
  onChange: (next: BackendChoice) => void;
  presets: ProviderPreset[];
}) {
  const set = (patch: Partial<BackendChoice>): void => onChange({ ...value, ...patch });
  return (
    <div className="settings-grid">
      <label>
        Mode
        <select value={value.mode} onChange={(e) => set({ mode: e.target.value as BackendMode })}>
          <option value="auto">auto (env, config, 9router, presets)</option>
          <option value="router">router (9router)</option>
          <option value="direct">direct (OpenAI-compatible)</option>
        </select>
      </label>
      {value.mode === "router" ? (
        <>
          <label>
            Router URL
            <input value={value.routerUrl ?? ""} placeholder="http://127.0.0.1:20128/v1" onChange={(e) => set({ routerUrl: e.target.value || undefined })} />
          </label>
          <label>
            Router key (optional)
            <input type="password" value={value.routerKey ?? ""} autoComplete="off" onChange={(e) => set({ routerKey: e.target.value || undefined })} />
          </label>
        </>
      ) : null}
      {value.mode === "direct" ? (
        <>
          <label>
            Preset
            <select value={value.preset ?? ""} onChange={(e) => set({ preset: e.target.value || undefined })}>
              <option value="">(custom URL)</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Base URL (wins over the preset)
            <input value={value.directUrl ?? ""} placeholder={presets.find((p) => p.id === value.preset)?.baseURL ?? "https://api.openai.com/v1"} onChange={(e) => set({ directUrl: e.target.value || undefined })} />
          </label>
          <label>
            API key (kept in memory only)
            <input type="password" value={value.directKey ?? ""} autoComplete="off" onChange={(e) => set({ directKey: e.target.value || undefined })} />
          </label>
        </>
      ) : null}
    </div>
  );
}

function BackendCheckSection() {
  const presets = useAsync(() => window.ninerh.backend.presets(), []);
  const [choice, setChoice] = useState<BackendChoice>({ mode: "auto" });
  const [summary, setSummary] = useState<BackendSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const detect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSummary(null);
    const res = await window.ninerh.backend.detect(choice);
    setBusy(false);
    if (res.ok) setSummary(res.value);
    else setError(res.error);
  };

  return (
    <section className="settings-section">
      <h2>Backend check</h2>
      <p className="settings-hint">Runs the same detection a new session uses and shows what it would connect to. Nothing is saved.</p>
      <BackendChoiceForm value={choice} onChange={setChoice} presets={presets.data ?? []} />
      <div className="settings-actions">
        <Button variant="primary" disabled={busy} onClick={() => void detect()}>
          {busy ? "Detecting..." : "Detect"}
        </Button>
      </div>
      {error ? <ErrorNote message={error} onRetry={() => void detect()} /> : null}
      {summary ? <BackendCard summary={summary} /> : null}
    </section>
  );
}

function BackendCard({ summary }: { summary: BackendSummary }) {
  return (
    <div className="settings-card">
      <div className="settings-card-head">
        <Badge tone="accent">{summary.name}</Badge>
        <Badge tone={summary.reachable ? "ok" : "err"}>{summary.reachable ? "reachable" : "unreachable"}</Badge>
        {summary.hasNativeRouter ? <Badge tone="muted">native api</Badge> : null}
        {summary.ambiguous ? <Badge tone="warn">ambiguous</Badge> : null}
      </div>
      <p>{summary.description}</p>
      <code>{summary.baseURL}</code>
      {summary.healthDetail ? <p className="settings-hint">{summary.healthDetail}</p> : null}
      {summary.warnings.length > 0 ? (
        <ul className="settings-warnings">
          {summary.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutSection() {
  const info = useAsync(() => window.ninerh.shell.platform(), []);
  return (
    <section className="settings-section">
      <h2>About</h2>
      {info.error ? <ErrorNote message={info.error} onRetry={() => void info.refresh()} /> : null}
      {info.data ? (
        <dl className="settings-about">
          <dt>App version</dt>
          <dd>{info.data.version}</dd>
          <dt>Platform</dt>
          <dd>{info.data.platform}</dd>
          <dt>9rh home</dt>
          <dd>
            <code>{info.data.home}</code>
          </dd>
        </dl>
      ) : !info.error ? (
        <Spinner />
      ) : null}
    </section>
  );
}
