// The console's JSON API (packages/server/src/console.ts). Same origin, cookie
// session; unsafe methods send JSON, which the server requires (CSRF).

export type Role = "owner" | "admin" | "member";
export type Level = "use" | "use_writes";
export type SideEffect = "read" | "write" | "destructive";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Provider = { id: string; name: string; href: string };
export type Me = { user: { id: string; label: string }; tenants: Array<{ id: string; name: string; role: Role }> };

export type TenantView = {
  tenant: { id: string; name: string };
  sources: Array<{ id: string; name: string; operations: number; reads: number }>;
  toolsets: Array<{ id: string; name: string; sourceId: string; enabledTools: number; endpoint: string }>;
  members: Array<{ userId: string; role: Role; you: boolean }>;
};

export type ToolBinding = {
  operationId: string;
  name: string;
  title?: string;
  description: string;
  enabled: boolean;
  pinnedInputs: Record<string, JsonValue>;
};

export type Toolset = { id: string; sourceId: string; name: string; description?: string; tools: ToolBinding[] };

export type OperationInput = { name: string; type: string; description: string; required: boolean };
export type OperationView = {
  id: string;
  title: string;
  description: string;
  method: string;
  path: string;
  tags: string[];
  deprecated: boolean;
  sideEffect: { class: SideEffect; basis: string; reason: string };
  inputs: OperationInput[];
};

export type Issue = { toolName: string; message: string };

export type ProfileRule = { toolsetId: string; level: Level; operations: string[] | null };
export type AccessProfile = { id: string; name: string; description?: string; rules: ProfileRule[]; members: string[] };

export type AccessView = {
  profiles: AccessProfile[];
  members: Array<{ userId: string; role: Role; you: boolean; profiles: string[] }>;
  toolsets: Array<{ id: string; name: string; tools: Array<{ operationId: string; name: string; enabled: boolean; sideEffect: SideEffect }> }>;
};

export type ToolsetView = {
  toolset: Toolset;
  /** Profiles with a rule for this toolset (D-034). */
  profiles: Array<{ profileId: string; name: string; level: Level; operations: string[] | null; members: string[] }>;
  endpoint: string;
  source: { id: string; name: string; baseUrl: string };
  operations: OperationView[];
  access: Array<{ userId: string; level: Level }>;
  members: Array<{ userId: string; role: Role }>;
  issues: Issue[];
};

export type TestResult = {
  tool: { name: string; sideEffect: SideEffect; pinnedInputs: Record<string, JsonValue> };
  args: Record<string, JsonValue>;
  result: { ok: true; status: number; contentType?: string; data: JsonValue } | { ok: false; error: { kind: string; message: string; retryable: boolean } };
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; message?: string; issues?: Issue[]; providers?: Provider[] };
  constructor(status: number, body: ApiError["body"]) {
    super(body.message ?? body.issues?.map((i) => `${i.toolName}: ${i.message}`).join("\n") ?? body.error ?? `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/app/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) throw new ApiError(response.status, data as ApiError["body"]);
  return data as T;
}

const t = encodeURIComponent;

export const api = {
  me: () => call<Me>("GET", "/me"),
  logout: () => call<{ ok: true }>("POST", "/logout", {}),
  tenant: (tenantId: string) => call<TenantView>("GET", `/tenants/${t(tenantId)}`),
  createToolset: (tenantId: string, input: { id: string; sourceId: string; name: string }) =>
    call<{ id: string; endpoint: string }>("POST", `/tenants/${t(tenantId)}/toolsets`, input),
  toolset: (tenantId: string, toolsetId: string) => call<ToolsetView>("GET", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}`),
  saveToolset: (tenantId: string, toolsetId: string, edit: { name: string; description?: string; tools: ToolBinding[] }) =>
    call<ToolsetView>("PUT", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}`, edit),
  setAccess: (tenantId: string, toolsetId: string, userId: string, level: Level | "none") =>
    call<ToolsetView>("PUT", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}/access`, { userId, level }),
  access: (tenantId: string) => call<AccessView>("GET", `/tenants/${t(tenantId)}/access`),
  saveProfile: (tenantId: string, profileId: string, edit: { name: string; description?: string; rules: ProfileRule[] }) =>
    call<AccessView>("PUT", `/tenants/${t(tenantId)}/profiles/${t(profileId)}`, edit),
  deleteProfile: (tenantId: string, profileId: string) => call<AccessView>("DELETE", `/tenants/${t(tenantId)}/profiles/${t(profileId)}`),
  setMemberProfiles: (tenantId: string, userId: string, profiles: string[]) =>
    call<AccessView>("PUT", `/tenants/${t(tenantId)}/members/${t(userId)}/profiles`, { profiles }),
  testTool: (tenantId: string, toolsetId: string, tool: ToolBinding, args: Record<string, JsonValue>, confirm = false) =>
    call<TestResult>("POST", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}/test`, { tool, args, confirm }),
};
