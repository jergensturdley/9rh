/**
 * Session registry: creates, lists, and removes `SessionHost`s.
 *
 * The registry owns nothing about a running turn; that is the host's job.
 * It validates the working directory, resolves the backend, picks a default
 * model, mints an id, and keeps the backend resolution warnings so they
 * appear on every snapshot the renderer sees.
 */

import { stat } from "fs/promises";
import { readUserConfig as readUserConfigDefault, resolveConfiguredModel } from "9rh";
import type { Backend, UserConfig } from "9rh";
import type { SessionCreateInput, SessionEventEnvelope, SessionSnapshot } from "@shared/ipc";
import { resolveBackend as resolveBackendDefault } from "./backendService";
import type { SessionHost, SessionHostDeps } from "./sessionHost";

export interface SessionRegistryDeps {
  emit: (e: SessionEventEnvelope) => void;
  onChanged: (s: SessionSnapshot) => void;
  onRemoved: (id: string) => void;
  resolveBackend?: typeof resolveBackendDefault;
  createHost?: (
    id: string,
    input: SessionCreateInput,
    model: string,
    hostDeps: SessionHostDeps,
  ) => SessionHost;
  readUserConfig?: () => Promise<UserConfig>;
  now?: () => number;
}

interface Entry {
  host: SessionHost;
  /** Backend resolution warnings; merged into every snapshot for this session. */
  warnings: string[];
}

const DIRECT_DEFAULT_MODEL = "gpt-4o";

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private counter = 0;

  constructor(private readonly deps: SessionRegistryDeps) {}

  async create(input: SessionCreateInput): Promise<SessionSnapshot> {
    await assertDirectory(input.workDir);
    const resolve = this.deps.resolveBackend ?? resolveBackendDefault;
    const { backend, warnings } = await resolve(input.backend);
    const model = input.model ?? (await this.defaultModel(backend));
    const now = this.deps.now ?? Date.now;
    const id = `s-${now().toString(36)}-${++this.counter}`;
    const hostDeps: SessionHostDeps = {
      backend,
      emit: this.deps.emit,
      onChanged: (snap: SessionSnapshot) => this.deps.onChanged(withWarnings(snap, warnings)),
      now: this.deps.now,
    };
    const host = this.deps.createHost
      ? this.deps.createHost(id, input, model, hostDeps)
      : await createRealHost(id, input, model, hostDeps);
    this.entries.set(id, { host, warnings });
    return this.get(id);
  }

  /** Creation order. */
  list(): SessionSnapshot[] {
    return [...this.entries.values()].map((e) => withWarnings(e.host.snapshot(), e.warnings));
  }

  get(id: string): SessionSnapshot {
    const e = this.entry(id);
    return withWarnings(e.host.snapshot(), e.warnings);
  }

  host(id: string): SessionHost {
    return this.entry(id).host;
  }

  remove(id: string): void {
    const e = this.entry(id);
    e.host.dispose();
    this.entries.delete(id);
    this.deps.onRemoved(id);
  }

  /** Shutdown path: dispose everything without per-session onRemoved pushes. */
  disposeAll(): void {
    for (const e of this.entries.values()) e.host.dispose();
    this.entries.clear();
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown session ${id}`);
    return e;
  }

  /**
   * Same precedence as the CLI (NINE_ROUTER_MODEL, then config.defaultModel
   * with provider prefixing), except a direct backend with nothing
   * configured asks the endpoint instead of assuming a 9router model id.
   */
  private async defaultModel(backend: Backend): Promise<string> {
    const config = await (this.deps.readUserConfig ?? readUserConfigDefault)();
    const configured = process.env.NINE_ROUTER_MODEL?.trim() || config.defaultModel;
    if (configured || backend.name !== "direct") return resolveConfiguredModel(undefined, config);
    const [first] = await backend.listModels();
    return first?.id ?? DIRECT_DEFAULT_MODEL;
  }
}

/**
 * Loaded on first use rather than at module top so the registry (and its
 * tests, which always inject `createHost`) never pulls in the engine-backed
 * host just to be imported.
 */
async function createRealHost(
  id: string,
  input: SessionCreateInput,
  model: string,
  hostDeps: SessionHostDeps,
): Promise<SessionHost> {
  const { SessionHost } = await import("./sessionHost");
  return new SessionHost(id, input, model, hostDeps);
}

function withWarnings(snap: SessionSnapshot, warnings: string[]): SessionSnapshot {
  return warnings.length ? { ...snap, warnings: [...warnings, ...snap.warnings] } : snap;
}

async function assertDirectory(path: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`workDir is not a directory: ${path}`);
}
