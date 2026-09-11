/**
 * 9router native `/api/*` record shapes, as observed against 9router 0.5.75.
 * Every field the console renders is listed; unknown extra fields are kept
 * via the index signature so nothing is dropped when records round-trip.
 */

export interface RouterHealth {
  reachable: boolean;
  url: string;
  detail?: string;
}

export interface RouterVersion {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

export interface RouterAuthStatus {
  requireLogin: boolean;
  authMode: string;
  ssoType?: string;
  oidcConfigured?: boolean;
  samlConfigured?: boolean;
  [key: string]: unknown;
}

export interface RouterTunnelStatus {
  tunnel: {
    enabled: boolean;
    running: boolean;
    tunnelUrl?: string;
    publicUrl?: string;
    [key: string]: unknown;
  };
  tailscale?: {
    enabled: boolean;
    running: boolean;
    tunnelUrl?: string;
    loggedIn?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RouterProvider {
  id: string;
  provider: string;
  name?: string;
  email?: string;
  authType?: string;
  priority?: number;
  isActive: boolean;
  testStatus?: string;
  lastUsedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  errorCode?: number;
  consecutiveUseCount?: number;
  backoffLevel?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface RouterCombo {
  id: string;
  name: string;
  kind: string | null;
  /** Ordered fallback chain of `provider/model` ids. */
  models: string[];
  [key: string]: unknown;
}

export interface RouterComboInput {
  name: string;
  models: string[];
  kind?: string | null;
}

export interface RouterApiKey {
  id: string;
  /** Full key value as 9router returns it; the UI masks it by default. */
  key: string;
  name: string;
  isActive: boolean;
  createdAt?: string;
  machineId?: string;
  [key: string]: unknown;
}

export interface RouterModelCaps {
  vision?: boolean;
  search?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  [key: string]: unknown;
}

export interface RouterModel {
  provider: string;
  model: string;
  name?: string;
  /** `provider/model`, the id to send in chat requests. */
  fullModel: string;
  routedModel?: string;
  alias?: string;
  caps?: RouterModelCaps;
  [key: string]: unknown;
}

export interface RouterModelAvailability {
  provider: string;
  /** "__all" means the whole connection. */
  model: string;
  status: string;
  connectionId?: string;
  connectionName?: string;
  lastError?: string;
  [key: string]: unknown;
}

export interface RouterUsageByProvider {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
}

export interface RouterUsageStats {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  byProvider: Record<string, RouterUsageByProvider>;
  [key: string]: unknown;
}

export interface RouterUsageChartPoint {
  label: string;
  tokens: number;
  cost: number;
}

/** Read-only subset of `GET /api/settings` the console displays. */
export interface RouterSettingsSummary {
  requireLogin?: boolean;
  requireApiKey?: boolean;
  authMode?: string;
  hasPassword?: boolean;
  tunnelEnabled?: boolean;
  tunnelUrl?: string;
  tunnelProvider?: string;
  tailscaleEnabled?: boolean;
  comboStrategy?: string;
  fallbackStrategy?: string;
  stickyRoundRobinLimit?: number;
  enableRequestLogs?: boolean;
  enableObservability?: boolean;
  mitmEnabled?: boolean;
  outboundProxyEnabled?: boolean;
  outboundProxyUrl?: string;
  headroomEnabled?: boolean;
  cavemanEnabled?: boolean;
  ponytailEnabled?: boolean;
  [key: string]: unknown;
}

/**
 * A request-log line as 9router returns it from `/api/usage/request-logs`:
 * "dd-mm-yyyy HH:MM:SS | model | PROVIDER | keyName | promptTokens | completionTokens | status".
 */
export interface RouterRequestLogLine {
  raw: string;
  timestamp: string;
  model: string;
  provider: string;
  keyName: string;
  promptTokens: number;
  completionTokens: number;
  status: string;
}

export function parseRequestLogLine(raw: string): RouterRequestLogLine {
  const parts = raw.split("|").map((p) => p.trim());
  const num = (s: string | undefined): number => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    raw,
    timestamp: parts[0] ?? "",
    model: parts[1] ?? "",
    provider: parts[2] ?? "",
    keyName: parts[3] ?? "",
    promptTokens: num(parts[4]),
    completionTokens: num(parts[5]),
    status: parts[6] ?? "",
  };
}
