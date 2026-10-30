import { z } from "zod";
import { Operation } from "./operation.ts";
import { Source, type AuthRequirement } from "./source.ts";

/** Bumped on any breaking change to the IR shape. Stored IR carries it so it can be migrated. */
export const IR_VERSION = 1;

/**
 * What every ingestor produces and everything downstream consumes: one source
 * and the operations it offers. Contains no tenant data, so the same IR can
 * back demo toolsets and several tenants' toolsets (see DECISIONS D-004).
 */
export const IrDocument = z
  .object({
    irVersion: z.literal(IR_VERSION),
    source: Source,
    operations: z.array(Operation),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    doc.operations.forEach((op, i) => {
      if (ids.has(op.id)) ctx.addIssue({ code: "custom", path: ["operations", i, "id"], message: `duplicate operation id "${op.id}"` });
      ids.add(op.id);
    });

    const schemeIds = new Set<string>(doc.source.authSchemes.map((s) => s.id));
    const checkAuth = (req: AuthRequirement, path: (string | number)[]) => {
      for (const alt of req) {
        for (const use of alt) {
          if (!schemeIds.has(use.schemeId)) {
            ctx.addIssue({ code: "custom", path, message: `unknown auth scheme "${use.schemeId}"` });
          }
        }
      }
    };
    checkAuth(doc.source.defaultAuth, ["source", "defaultAuth"]);
    doc.operations.forEach((op, i) => {
      if (op.auth) checkAuth(op.auth, ["operations", i, "auth"]);
    });
  });
export type IrDocument = z.infer<typeof IrDocument>;
