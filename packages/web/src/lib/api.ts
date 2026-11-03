// The console's JSON API (packages/server/src/console/). Same origin, cookie
// session; unsafe methods send JSON, which the server requires (CSRF). The
// request and response types are the shared contract in @cairnmcp/console-api,
// which the server's handlers are checked against.
import type {
  AccessEdit,
  AccessView,
  ApiErrorBody,
  CreatedSource,
  CreatedToolset,
  CredentialBody,
  CredentialInput,
  CustomerPage,
  JsonValue,
  LoggedOut,
  Me,
  MemberEdit,
  MemberProfilesEdit,
  NewToolsetInput,
  Person,
  ProfileEdit,
  Removed,
  Role,
  RoleEdit,
  SideEffectEdit,
  SideEffectsUpdated,
  SourceInput,
  SourcePreview,
  SourcePreviewInput,
  SourceView,
  TenantView,
  TestResult,
  ToolBinding,
  ToolsetEdit,
  ToolsetView,
  ToolTestInput,
} from "@cairnmcp/console-api";

export type * from "@cairnmcp/console-api";

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
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
  if (!response.ok) throw new ApiError(response.status, data as ApiErrorBody);
  return data as T;
}

const t = encodeURIComponent;

export const api = {
  me: () => call<Me>("GET", "/me"),
  logout: () => call<LoggedOut>("POST", "/logout", {}),
  tenant: (tenantId: string) => call<TenantView>("GET", `/tenants/${t(tenantId)}`),
  createToolset: (tenantId: string, input: NewToolsetInput) =>
    call<CreatedToolset>("POST", `/tenants/${t(tenantId)}/toolsets`, input),
  toolset: (tenantId: string, toolsetId: string) => call<ToolsetView>("GET", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}`),
  saveToolset: (tenantId: string, toolsetId: string, edit: ToolsetEdit) =>
    call<ToolsetView>("PUT", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}`, edit),
  setAccess: (tenantId: string, toolsetId: string, userId: string, level: AccessEdit["level"]) =>
    call<ToolsetView>("PUT", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}/access`, { userId, level } satisfies AccessEdit),
  access: (tenantId: string) => call<AccessView>("GET", `/tenants/${t(tenantId)}/access`),
  saveProfile: (tenantId: string, profileId: string, edit: ProfileEdit) =>
    call<AccessView>("PUT", `/tenants/${t(tenantId)}/profiles/${t(profileId)}`, edit),
  deleteProfile: (tenantId: string, profileId: string) => call<AccessView>("DELETE", `/tenants/${t(tenantId)}/profiles/${t(profileId)}`),
  setMemberProfiles: (tenantId: string, userId: string, profiles: string[]) =>
    call<AccessView>("PUT", `/tenants/${t(tenantId)}/members/${t(userId)}/profiles`, { profiles } satisfies MemberProfilesEdit),
  customers: (tenantId: string, query = "", after?: string) =>
    call<CustomerPage>("GET", `/tenants/${t(tenantId)}/customers?${new URLSearchParams({ q: query, ...(after ? { after } : {}) })}`),
  setRole: (tenantId: string, userId: string, role: Role) =>
    call<AccessView>("PUT", `/tenants/${t(tenantId)}/members/${t(userId)}/role`, { role } satisfies RoleEdit),
  updateMember: (tenantId: string, userId: string, edit: MemberEdit) => call<Person>("PUT", `/tenants/${t(tenantId)}/members/${t(userId)}`, edit),
  removeMember: (tenantId: string, userId: string) => call<Removed>("DELETE", `/tenants/${t(tenantId)}/members/${t(userId)}`),
  previewSource: (tenantId: string, input: SourcePreviewInput) => call<SourcePreview>("POST", `/tenants/${t(tenantId)}/sources/preview`, input),
  createSource: (tenantId: string, input: SourceInput) => call<CreatedSource>("POST", `/tenants/${t(tenantId)}/sources`, input),
  source: (tenantId: string, sourceId: string) => call<SourceView>("GET", `/tenants/${t(tenantId)}/sources/${t(sourceId)}`),
  setCredential: (tenantId: string, sourceId: string, schemeId: string, credential: CredentialInput) =>
    call<SourceView>("PUT", `/tenants/${t(tenantId)}/sources/${t(sourceId)}/credentials/${t(schemeId)}`, { credential } satisfies CredentialBody),
  removeCredential: (tenantId: string, sourceId: string, schemeId: string) =>
    call<SourceView>("DELETE", `/tenants/${t(tenantId)}/sources/${t(sourceId)}/credentials/${t(schemeId)}`),
  setSideEffects: (tenantId: string, sourceId: string, changes: SideEffectEdit["changes"]) =>
    call<SideEffectsUpdated>("PUT", `/tenants/${t(tenantId)}/sources/${t(sourceId)}/side-effects`, { changes } satisfies SideEffectEdit),
  testTool: (tenantId: string, toolsetId: string, tool: ToolBinding, args: Record<string, JsonValue>, confirm = false) =>
    call<TestResult>("POST", `/tenants/${t(tenantId)}/toolsets/${t(toolsetId)}/test`, { tool, args, confirm } satisfies ToolTestInput),
};
