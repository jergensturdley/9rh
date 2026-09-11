/**
 * New session form: workdir (browse + recents), model, backend mode with
 * direct-mode preset/url/key, team mode, advanced knobs, "Test connection"
 * showing the BackendSummary, and Create. The API key lives in component
 * state only; the remembered lastBackend never includes it.
 */

import { useEffect, useState } from "react";
import type { AppState, BackendChoice, BackendMode, BackendSummary, ModelInfo, ProviderPreset } from "@shared/ipc";
import { sessionsActions } from "@renderer/state/sessionsStore";
import { Modal } from "./Modal";
import { ModelPicker } from "./ModelPicker";
import { Badge, Button, ErrorNote, Spinner } from "./ui";
import "./NewSessionDialog.css";

const RECENT_CAP = 10;

export function NewSessionDialog(props: { onClose: () => void; initialWorkDir?: string }) {
  const [workDir, setWorkDir] = useState(props.initialWorkDir ?? "");
  const [recent, setRecent] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<BackendMode>("auto");
  const [routerUrl, setRouterUrl] = useState("");
  const [preset, setPreset] = useState("");
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [directUrl, setDirectUrl] = useState("");
  const [directKey, setDirectKey] = useState("");
  const [teamMode, setTeamMode] = useState(false);
  const [maxIterations, setMaxIterations] = useState("");
  const [toolConcurrency, setToolConcurrency] = useState("");
  const [maxContinuations, setMaxContinuations] = useState("");
  const [iterPerContinuation, setIterPerContinuation] = useState("");
  const [allowSkillInstall, setAllowSkillInstall] = useState(false);
  const [keepReports, setKeepReports] = useState(false);
  const [quietByDefault, setQuietByDefault] = useState(false);
  const [summary, setSummary] = useState<BackendSummary | null>(null);
  const [testing, setTesting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    let live = true;
    void window.ninerh.config.appState().then((res) => {
      if (!live || !res.ok) return;
      const s = res.value;
      setRecent(s.recentWorkDirs ?? []);
      setQuietByDefault(Boolean(s.quietByDefault));
      if (!props.initialWorkDir && s.recentWorkDirs?.[0]) setWorkDir(s.recentWorkDirs[0]);
      if (s.lastModel) setModel(s.lastModel);
      if (s.lastBackend) {
        setMode(s.lastBackend.mode);
        setRouterUrl(s.lastBackend.routerUrl ?? "");
        setPreset(s.lastBackend.preset ?? "");
        setDirectUrl(s.lastBackend.directUrl ?? "");
      }
    });
    void window.ninerh.backend.presets().then((res) => {
      if (live && res.ok) setPresets(res.value);
    });
    return () => {
      live = false;
    };
  }, [props.initialWorkDir]);

  const choice = (): BackendChoice => {
    const c: BackendChoice = { mode };
    if (mode === "router" && routerUrl.trim()) c.routerUrl = routerUrl.trim();
    if (mode === "direct") {
      if (preset) c.preset = preset;
      if (directUrl.trim()) c.directUrl = directUrl.trim();
      if (directKey) c.directKey = directKey;
    }
    return c;
  };

  const browse = async (): Promise<void> => {
    const res = await window.ninerh.shell.pickDirectory();
    if (res.ok && res.value) setWorkDir(res.value);
    else if (!res.ok) setError(res.error);
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setError(null);
    setSummary(null);
    const res = await window.ninerh.backend.detect(choice());
    setTesting(false);
    if (res.ok) setSummary(res.value);
    else setError(res.error);
  };

  const num = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };

  const create = async (): Promise<void> => {
    const dir = workDir.trim();
    if (!dir) {
      setError("Pick a working directory.");
      return;
    }
    setCreating(true);
    setError(null);
    const backend = choice();
    const res = await sessionsActions.create({
      workDir: dir,
      model: model.trim() || undefined,
      backend,
      maxIterations: num(maxIterations),
      toolConcurrency: num(toolConcurrency),
      continuationPolicy:
        num(maxContinuations) !== undefined
          ? { maxContinuations: num(maxContinuations)!, iterationsPerContinuation: num(iterPerContinuation) }
          : undefined,
      allowSkillInstall,
      keepReports,
      teamMode,
    });
    setCreating(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (quietByDefault) void sessionsActions.setQuiet(res.value.id, true);
    const { directKey: _omit, ...remembered } = backend;
    const patch: Partial<AppState> = {
      recentWorkDirs: [dir, ...recent.filter((r) => r !== dir)].slice(0, RECENT_CAP),
      lastBackend: remembered,
    };
    if (model.trim()) patch.lastModel = model.trim();
    void window.ninerh.config.setAppState(patch);
    props.onClose();
  };

  // Before a session exists only the router catalog can be listed.
  const loadModels = async (): Promise<{ ok: true; value: ModelInfo[] } | { ok: false; error: string }> => {
    const res = await window.ninerh.router.models();
    if (!res.ok) return res;
    return { ok: true, value: res.value.map((m) => ({ id: m.fullModel, owned_by: m.provider })) };
  };
  const canPick = summary?.name === "router" && summary.reachable;
  const selectedPreset = presets.find((p) => p.id === preset);

  return (
    <Modal title="New session" onClose={props.onClose} width={620}>
      <form
        className="nsd"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="nsd-field">
          <span className="nsd-label">Working directory</span>
          <span className="row gap-2">
            <input className="grow mono" value={workDir} onChange={(e) => setWorkDir(e.target.value)} placeholder="/path/to/repo" autoFocus />
            <Button size="sm" onClick={() => void browse()}>
              Browse
            </Button>
          </span>
        </label>
        {recent.length > 0 ? (
          <div className="nsd-recent" aria-label="recent directories">
            {recent.slice(0, 6).map((r) => (
              <button key={r} type="button" className={r === workDir ? "nsd-chip is-active" : "nsd-chip"} title={r} onClick={() => setWorkDir(r)}>
                {r.split(/[\\/]/).filter(Boolean).pop() ?? r}
              </button>
            ))}
          </div>
        ) : null}

        <label className="nsd-field">
          <span className="nsd-label">Model</span>
          <span className="row gap-2">
            <input className="grow mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="default from config" />
            <Button size="sm" disabled={!canPick} title={canPick ? "Pick from the router catalog" : "Test a router connection first"} onClick={() => setPicker(true)}>
              Pick
            </Button>
          </span>
        </label>

        <fieldset className="nsd-field nsd-modes">
          <legend className="nsd-label">Backend</legend>
          {(["auto", "router", "direct"] as const).map((m) => (
            <label key={m} className="nsd-radio">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} /> {m}
            </label>
          ))}
        </fieldset>

        {mode === "router" ? (
          <label className="nsd-field">
            <span className="nsd-label">Router URL</span>
            <input className="mono" value={routerUrl} onChange={(e) => setRouterUrl(e.target.value)} placeholder="http://127.0.0.1:20128/v1" />
          </label>
        ) : null}

        {mode === "direct" ? (
          <div className="nsd-direct">
            <label className="nsd-field">
              <span className="nsd-label">Preset</span>
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="">custom</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="nsd-field">
              <span className="nsd-label">Base URL</span>
              <input className="mono" value={directUrl} onChange={(e) => setDirectUrl(e.target.value)} placeholder={selectedPreset?.baseURL ?? "https://api.example.com/v1"} />
            </label>
            <label className="nsd-field">
              <span className="nsd-label">API key</span>
              <input type="password" className="mono" value={directKey} onChange={(e) => setDirectKey(e.target.value)} placeholder={selectedPreset?.envKey ? `from $${selectedPreset.envKey} if empty` : "kept in memory only"} autoComplete="off" />
            </label>
            {selectedPreset?.modelHint ? <p className="muted nsd-hint">{selectedPreset.modelHint}</p> : null}
          </div>
        ) : null}

        <label className="nsd-check">
          <input type="checkbox" checked={teamMode} onChange={(e) => setTeamMode(e.target.checked)} /> Team mode (orchestrator pipeline)
        </label>

        <details className="nsd-advanced">
          <summary>Advanced</summary>
          <div className="nsd-adv-grid">
            <label className="nsd-field">
              <span className="nsd-label">Max iterations</span>
              <input type="number" min={1} value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} placeholder="default" />
            </label>
            <label className="nsd-field">
              <span className="nsd-label">Parallel tools</span>
              <input type="number" min={1} value={toolConcurrency} onChange={(e) => setToolConcurrency(e.target.value)} placeholder="default" />
            </label>
            <label className="nsd-field">
              <span className="nsd-label">Max continuations</span>
              <input type="number" min={0} value={maxContinuations} onChange={(e) => setMaxContinuations(e.target.value)} placeholder="engine default" />
            </label>
            <label className="nsd-field">
              <span className="nsd-label">Iterations per continuation</span>
              <input type="number" min={1} value={iterPerContinuation} onChange={(e) => setIterPerContinuation(e.target.value)} placeholder="default" />
            </label>
            <label className="nsd-check">
              <input type="checkbox" checked={allowSkillInstall} onChange={(e) => setAllowSkillInstall(e.target.checked)} /> Allow skill install
            </label>
            <label className="nsd-check">
              <input type="checkbox" checked={keepReports} onChange={(e) => setKeepReports(e.target.checked)} /> Keep reports
            </label>
          </div>
        </details>

        {summary ? <SummaryView summary={summary} /> : null}
        {error ? <ErrorNote message={error} /> : null}

        <div className="nsd-actions">
          <Button onClick={() => void test()} disabled={testing || creating}>
            {testing ? <Spinner /> : null} Test connection
          </Button>
          <span className="grow" />
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={creating || !workDir.trim()}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
      {picker ? (
        <ModelPicker
          value={model}
          load={loadModels}
          onPick={(m) => {
            setModel(m);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </Modal>
  );
}

function SummaryView({ summary }: { summary: BackendSummary }) {
  return (
    <div className={summary.reachable ? "nsd-summary is-ok" : "nsd-summary is-bad"}>
      <div className="row gap-2 wrap">
        <Badge tone={summary.reachable ? "ok" : "err"}>{summary.reachable ? "reachable" : "unreachable"}</Badge>
        <Badge tone="accent">{summary.name}</Badge>
        {summary.ambiguous ? <Badge tone="warn">ambiguous</Badge> : null}
        <span className="ellipsis" title={summary.description}>
          {summary.description}
        </span>
      </div>
      <div className="mono muted ellipsis" title={summary.baseURL}>
        {summary.baseURL}
      </div>
      {summary.healthDetail ? <div className="muted">{summary.healthDetail}</div> : null}
      {summary.warnings.map((w, i) => (
        <div key={i} className="nsd-warning">
          {w}
        </div>
      ))}
    </div>
  );
}
