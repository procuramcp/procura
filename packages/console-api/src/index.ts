// The console's JSON API (/app/api), written once. The server's route handlers
// in packages/server/src/console/ check every body they send against these
// types (`satisfies`), and packages/web/src/lib/api.ts uses them for every
// call, so a change on one side fails the other side's typecheck.
//
// Types only, with no imports: the browser build (DOM, no Node) and the server
// (Node, Zod) both compile this file. Ids are plain strings here; the server's
// branded ids are strings too. Optional fields allow `undefined` because the
// server's Zod types do (it never reaches the wire: JSON drops it).

// ---- Shared values ----

/** Someone's role in a tenant (D-038): the team may open the console, customers only call tools. */
export type Role = "owner" | "admin" | "editor" | "viewer" | "customer";
export type TeamRole = Exclude<Role, "customer">;
export type MemberStatus = "active" | "suspended";
/** A toolset access level (D-034). */
export type Level = "use" | "use_writes";
export type SideEffect = "read" | "write" | "destructive";
export type ClassificationBasis = "http_method" | "graphql_operation" | "name_heuristic" | "curated";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A sign-in option, listed when the session is missing. */
export type Provider = { id: string; name: string; href: string };

/** A problem with one tool of a toolset edit. */
export type Issue = { toolName: string; code?: string; message: string };

/** The body of every error response. */
export type ApiErrorBody = { error?: string; message?: string; issues?: Issue[]; providers?: Provider[] };

// ---- Session ----

/** `GET /me` */
export type Me = { user: { id: string; label: string }; tenants: Array<{ id: string; name: string; role: TeamRole }> };

// ---- People (D-038) ----

/** Someone in a tenant: on the team or a customer. */
export type Person = {
  userId: string;
  /** From their latest sign-in, usually an email; null until they sign in again after it was added. */
  label: string | null;
  role: Role;
  status: MemberStatus;
  note: string | null;
  /** When they joined the tenant (ISO 8601). */
  since: string;
  /** Profile ids they hold. */
  profiles: string[];
  you: boolean;
};

// ---- Tenant ----

/** `GET /tenants/:t` */
export type TenantView = {
  tenant: { id: string; name: string };
  sources: Array<{ id: string; name: string; operations: number; reads: number }>;
  toolsets: Array<{ id: string; name: string; sourceId: string; enabledTools: number; endpoint: string }>;
  people: { team: number; customers: number };
};

/** `POST /tenants/:t/toolsets` body. */
export type NewToolsetInput = { id: string; sourceId: string; name: string };
/** `POST /tenants/:t/toolsets` (201). */
export type CreatedToolset = { id: string; endpoint: string };

// ---- Toolsets ----

export type ToolBinding = {
  operationId: string;
  name: string;
  title?: string | undefined;
  description: string;
  enabled: boolean;
  pinnedInputs: Record<string, JsonValue>;
};

export type Toolset = { id: string; sourceId: string; name: string; description?: string | undefined; tools: ToolBinding[] };

export type OperationInput = { name: string; type: string; description: string; required: boolean };
export type OperationView = {
  id: string;
  title: string;
  description: string;
  method: string;
  path: string;
  tags: string[];
  deprecated: boolean;
  sideEffect: { class: SideEffect; basis: ClassificationBasis; reason: string };
  inputs: OperationInput[];
  /** The operation's whole input JSON Schema. */
  inputSchema: JsonObject;
};

/** `GET`/`PUT /tenants/:t/toolsets/:id`, and `PUT …/access`. */
export type ToolsetView = {
  toolset: Toolset;
  /** Profiles with a rule for this toolset (D-034). */
  profiles: Array<{ profileId: string; name: string; level: Level; operations: string[] | null; members: string[] }>;
  endpoint: string;
  source: { id: string; name: string; baseUrl: string };
  operations: OperationView[];
  /** Direct grants, with who they are. */
  access: Array<{ userId: string; label: string | null; role: Role; level: Level }>;
  /** The team, to grant access to; customers are granted by account id. */
  team: Array<{ userId: string; label: string | null; role: Role }>;
  issues: Issue[];
};

/** `PUT /tenants/:t/toolsets/:id` body. */
export type ToolsetEdit = { name: string; description?: string | undefined; tools: ToolBinding[] };
/** `PUT /tenants/:t/toolsets/:id/access` body. */
export type AccessEdit = { userId: string; level: Level | "none" };

/** `POST /tenants/:t/toolsets/:id/test` body. */
export type ToolTestInput = { tool: ToolBinding; args: Record<string, JsonValue>; confirm?: boolean | undefined };

export type ToolError = {
  kind: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number | undefined;
  /** Upstream HTTP status, for `upstream_error`. */
  status?: number | undefined;
  details?: string[] | undefined;
};
export type ToolResult = { ok: true; status: number; contentType?: string | undefined; data: JsonValue } | { ok: false; error: ToolError };

/** `POST /tenants/:t/toolsets/:id/test` */
export type TestResult = {
  tool: { name: string; sideEffect: SideEffect; pinnedInputs: Record<string, JsonValue> };
  args: Record<string, JsonValue>;
  result: ToolResult;
};

// ---- Access profiles (D-034) ----

/** One rule of a profile; `operations` null means every tool the level allows. */
export type ProfileRule = { toolsetId: string; level: Level; operations: string[] | null };
export type AccessProfile = { id: string; name: string; description?: string | undefined; rules: ProfileRule[]; members: string[] };

/** `GET /tenants/:t/access`, and every profile or team change. */
export type AccessView = {
  profiles: AccessProfile[];
  team: Person[];
  /** How many customers there are; `GET …/customers` pages through them. */
  customers: number;
  toolsets: Array<{ id: string; name: string; tools: Array<{ operationId: string; name: string; enabled: boolean; sideEffect: SideEffect }> }>;
};

/** `PUT /tenants/:t/profiles/:id` body. */
export type ProfileEdit = { name: string; description?: string | undefined; rules: ProfileRule[] };
/** `PUT /tenants/:t/members/:user/profiles` body. Adds them as a customer if they aren't in the tenant. */
export type MemberProfilesEdit = { profiles: string[] };

/** `GET /tenants/:t/customers?q=&after=`: newest first; pass `next` as `after` for the next page. */
export type CustomerPage = { customers: Person[]; total: number; next?: string | undefined };
/** `PUT /tenants/:t/members/:user/role` body. Adds them if they aren't in the tenant (they must have signed in once). */
export type RoleEdit = { role: Role };
/** `PUT /tenants/:t/members/:user` body: suspend or resume, or change the note (`null` clears it). Returns the `Person`. */
export type MemberEdit = { status?: MemberStatus | undefined; note?: string | null | undefined };
/** `DELETE /tenants/:t/members/:user` */
export type Removed = { ok: true };

// ---- Sources (D-035) ----

export type AuthSchemeType = "http_basic" | "http_bearer" | "api_key" | "oauth2" | "oidc";
export type AuthSchemeView = {
  id: string;
  type: AuthSchemeType;
  description?: string;
  fixedUsername?: string;
  in?: string;
  name?: string;
};
export type OperationCounts = { total: number; read: number; write: number; destructive: number };
export type IngestWarning = { code: string; message: string; pointer?: string | undefined };

/** Where the API description comes from: a URL to discover it at, or the text itself. */
export type DocumentInput = { url: string } | { document: string };

/** `POST /tenants/:t/sources/preview` body. */
export type SourcePreviewInput = DocumentInput & { id?: string; baseUrl?: string };
/** `POST /tenants/:t/sources/preview` */
export type SourcePreview = {
  documentUrl: string | null;
  via: string;
  takenIds: string[];
  preview: {
    suggestedId: string;
    name: string;
    description?: string;
    baseUrl: string;
    operations: OperationCounts;
    authSchemes: AuthSchemeView[];
    warnings: IngestWarning[];
    warningCount: number;
  };
};

/** `POST /tenants/:t/sources` body. */
export type SourceInput = DocumentInput & {
  id: string;
  baseUrl?: string;
  /** Per auth scheme id, a username the API fixes (e.g. Intervals.icu's `API_KEY`). */
  fixedUsernames?: Record<string, string>;
  /** A starter toolset to create with the source. */
  toolset?: { id: string; name: string };
};
export type SourceSummary = { id: string; name: string; operations: number; reads: number; authSchemes: string[]; warnings: number };
/** `POST /tenants/:t/sources` (201). */
export type CreatedSource = { source: SourceSummary; toolset?: CreatedToolset };

export type CredentialKind = "basic" | "bearer" | "api_key" | "oauth2";
export type CredentialInput =
  | { kind: "basic"; username?: string; password: string }
  | { kind: "bearer"; token: string }
  | { kind: "api_key"; value: string }
  | { kind: "oauth2"; accessToken: string; refreshToken?: string };
/** `PUT /tenants/:t/sources/:id/credentials/:scheme` body. */
export type CredentialBody = { credential: CredentialInput };

/** `GET /tenants/:t/sources/:id`, and every credential change. Never a credential's value. */
export type SourceView = {
  id: string;
  name: string;
  baseUrl: string;
  documentUrl: string | null;
  operations: OperationCounts;
  authSchemes: Array<AuthSchemeView & { accepts: CredentialKind[]; stored: Array<{ kind: CredentialKind }> }>;
  toolsets: Array<{ id: string; name: string }>;
};

/** `POST /logout` */
export type LoggedOut = { ok: true };
