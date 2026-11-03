// Request bodies the console API accepts, and how to read them.
import type * as Contract from "@cairnmcp/console-api";
import { JsonValue, MemberRole, MemberStatus, OperationId, SideEffect, SourceId, ToolBinding, ToolsetAccessLevel, ToolsetId, UserId } from "@cairnmcp/core";
import { readJson } from "@cairnmcp/http";
import { CredentialInput } from "@cairnmcp/vault";
import { z } from "zod";
import { MAX_DOCUMENT_FETCH_BYTES } from "../fetch-document.ts";

/** Ordinary JSON bodies. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Bodies that may carry a pasted API description. */
export const MAX_DOCUMENT_BODY_BYTES = MAX_DOCUMENT_FETCH_BYTES + 64 * 1024;

/** The body checked against `schema`; throws `BodyError` (a 400) when too large or not JSON. */
export async function readBody<T extends z.ZodType>(request: Request, schema: T, maxBytes = MAX_BODY_BYTES): Promise<z.ZodSafeParseResult<z.output<T>>> {
  return schema.safeParse(await readJson(request, maxBytes));
}

/** Zod issues as one line for an error message. */
export function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export const NewToolset = z.object({ id: ToolsetId, sourceId: SourceId, name: z.string().min(1).max(200) });
export const ToolsetEdit = z.object({ name: z.string().min(1).max(200), description: z.string().max(4000).optional(), tools: z.array(z.unknown()).max(2000) });
export const AccessEdit = z.object({ userId: UserId, level: z.union([ToolsetAccessLevel, z.literal("none")]) });
export const ProfileEdit = z.object({ name: z.string(), description: z.string().optional(), rules: z.array(z.unknown()).max(200), limits: z.unknown().optional() });
export const MemberProfiles = z.object({ profiles: z.array(z.string().max(64)).max(100) });
export const RoleEdit = z.object({ role: MemberRole });
export const MemberEdit = z.object({ status: MemberStatus.optional(), note: z.string().trim().max(2000).nullable().optional() });
export const CredentialBody = z.object({ credential: CredentialInput });
export const SideEffectEdit = z.object({
  changes: z
    .array(z.object({ operationId: OperationId, class: z.union([SideEffect, z.literal("automatic")]), reason: z.string().trim().max(300).optional() }))
    .min(1)
    .max(2000),
});
export const ToolTest = z.object({ tool: ToolBinding, args: z.record(z.string(), JsonValue).default({}), confirm: z.boolean().optional() });

const SourceFields = z.object({
  id: SourceId,
  url: z.string().max(2000).optional(),
  document: z.string().max(MAX_DOCUMENT_FETCH_BYTES).optional(),
  baseUrl: z.string().max(2000).optional(),
  fixedUsernames: z.record(z.string(), z.string().max(200)).default({}),
  toolset: z.object({ id: ToolsetId, name: z.string().trim().min(1).max(200) }).optional(),
});
const oneDocument = (b: { url?: string | undefined; document?: string | undefined }) => Boolean(b.url) !== Boolean(b.document);
const ONE_DOCUMENT = { message: "give either a URL or the document, not both" };
export const SourceInput = SourceFields.refine(oneDocument, ONE_DOCUMENT);
export const SourcePreviewInput = SourceFields.partial({ id: true }).refine(oneDocument, ONE_DOCUMENT);

/** Fails to compile unless the schema accepts the contract's body shape (the schema also checks limits). */
type Accepts<Schema extends z.ZodType, _Body extends z.input<Schema>> = true;
// Every body the web console sends (@cairnmcp/console-api) against the schema that reads it.
export type BodiesMatchContract = [
  Accepts<typeof NewToolset, Contract.NewToolsetInput>,
  Accepts<typeof ToolsetEdit, Contract.ToolsetEdit>,
  Accepts<typeof AccessEdit, Contract.AccessEdit>,
  Accepts<typeof ProfileEdit, Contract.ProfileEdit>,
  Accepts<typeof MemberProfiles, Contract.MemberProfilesEdit>,
  Accepts<typeof RoleEdit, Contract.RoleEdit>,
  Accepts<typeof MemberEdit, Contract.MemberEdit>,
  Accepts<typeof CredentialBody, Contract.CredentialBody>,
  Accepts<typeof SideEffectEdit, Contract.SideEffectEdit>,
  Accepts<typeof ToolTest, Contract.ToolTestInput>,
  Accepts<typeof SourceInput, Contract.SourceInput>,
  Accepts<typeof SourcePreviewInput, Contract.SourcePreviewInput>,
];
