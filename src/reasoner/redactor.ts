const SECRET_PATTERNS = [
  [/\b(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE|KEY|CREDENTIAL|BEARER|ACCESS_SECRET)[_A-Z]*\s*[=:]\s*["']?([a-zA-Z0-9_+/=-]{8,})["']?/gi, "[REDACTED_ENV_VAR]"],
  [/Bearer\s+([a-zA-Z0-9_+/=-]{20,})/g, "Bearer [REDACTED_TOKEN]"],
  [/\/\/[^:]+:[^@]+@[^\s]+/g, "//[REDACTED_CREDENTIALS]@"],
  [/\b(?:AKIA|ABIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\b(?:gho_|ghp_|ghs_|ghr_)[a-zA-Z0-9_]{36,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bnpm_[a-zA-Z0-9]{36,}\b/g, "[REDACTED_NPM_TOKEN]"],
] as [RegExp, string][];

const SENSITIVE_KEYS = new Set([
  "api_key", "apikey", "apiKey", "secret", "password", "token", "bearer",
  "access_token", "accessToken", "refresh_token", "refreshToken",
  "authorization", "authorization_header", "credentials", "credential",
  "private_key", "privateKey", "session_token", "sessionToken",
]);

function recursivelyRedact(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    let result = value;
    for (let i = 0; i < SECRET_PATTERNS.length; i++) {
      const [pattern, replacement] = SECRET_PATTERNS[i];
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  if (Array.isArray(value)) {
    return value.map(recursivelyRedact);
  }

  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        redacted[k] = "[REDACTED]";
      } else {
        redacted[k] = recursivelyRedact(v);
      }
    }
    return redacted;
  }

  return value;
}

export function redact<T>(value: T): T {
  return recursivelyRedact(value) as T;
}

export function redactEvent<T extends { type: string; payload?: unknown }>(event: T): T {
  const result = { ...event } as Record<string, unknown>;
  if (result.payload !== undefined) {
    result.payload = recursivelyRedact(result.payload);
  }
  return result as T;
}