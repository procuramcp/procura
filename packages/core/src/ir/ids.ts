import { z } from "zod";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Tool-safe identifier: lowercase snake_case, at most 64 characters.
 * This is the intersection of the MCP tool-name rule (`^[A-Za-z0-9._-]{1,128}$`,
 * SEP-986) and the Claude API tool-name rule (`^[a-zA-Z0-9_-]{1,64}$`), narrowed
 * to one style so names look the same everywhere.
 */
export const TOOL_SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const SourceId = z.string().max(64).regex(SLUG, "must be a lowercase slug").brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;

export const ToolsetId = z.string().max(64).regex(SLUG, "must be a lowercase slug").brand<"ToolsetId">();
export type ToolsetId = z.infer<typeof ToolsetId>;

/** Stable id of an operation within one source. */
export const OperationId = z.string().regex(TOOL_SAFE_NAME, "must be snake_case, max 64 chars").brand<"OperationId">();
export type OperationId = z.infer<typeof OperationId>;

/** Name an agent sees. Chosen per toolset; defaults to the operation id. */
export const ToolName = z.string().regex(TOOL_SAFE_NAME, "must be snake_case, max 64 chars").brand<"ToolName">();
export type ToolName = z.infer<typeof ToolName>;

/** Id of an auth scheme within a source, e.g. the OpenAPI securitySchemes key. */
export const AuthSchemeId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).brand<"AuthSchemeId">();
export type AuthSchemeId = z.infer<typeof AuthSchemeId>;

/**
 * Tenant identifier. Opaque to cairnmcp: a UUID in the hosted deployment, any
 * slug-like value in tests and self-hosted setups. Not part of the IR itself
 * (D-004); used by the vault, runtime, and storage layers.
 */
export const TenantId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "must be 1-64 letters, digits, - or _").brand<"TenantId">();
export type TenantId = z.infer<typeof TenantId>;
