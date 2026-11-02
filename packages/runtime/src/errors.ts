/**
 * Everything the runtime can report back. Messages are written for the agent:
 * what went wrong and what to do. They never contain credentials, request
 * headers, or full URLs (an API key can live in a query string).
 */
export type RuntimeErrorKind =
  | "invalid_input"
  | "missing_credentials"
  | "rate_limited"
  /** The caller's plan is used up for now (D-039); not the upstream's limit. */
  | "limit_reached"
  | "timeout"
  | "network_error"
  | "egress_blocked"
  | "response_too_large"
  | "upstream_error"
  | "invalid_upstream_response"
  | "unsupported"
  | "audit_failed";

export type RuntimeError = {
  kind: RuntimeErrorKind;
  message: string;
  /** True if the same call might succeed later without changes. */
  retryable: boolean;
  retryAfterSeconds?: number;
  /** Upstream HTTP status, for `upstream_error`. */
  status?: number;
  /** For `limit_reached`: when the allowance starts over, and where to get more. */
  resetsAt?: string;
  upgradeUrl?: string;
  details?: string[];
};

export class RuntimeFailure extends Error {
  readonly error: RuntimeError;
  constructor(error: RuntimeError) {
    super(error.message);
    this.error = error;
  }
}

export function fail(kind: RuntimeErrorKind, message: string, extra: Partial<Omit<RuntimeError, "kind" | "message">> = {}): never {
  const retryable = extra.retryable ?? (kind === "rate_limited" || kind === "timeout" || kind === "network_error");
  throw new RuntimeFailure({ kind, message, retryable, ...extra });
}
