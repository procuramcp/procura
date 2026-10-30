import { z } from "zod";

/**
 * Something an ingestor noticed. Errors mean an operation (or the whole
 * document) was skipped; warnings mean it was kept but something was assumed.
 * Shown in the curation UI next to the affected operation.
 */
export const Diagnostic = z.object({
  severity: z.enum(["error", "warning", "info"]),
  /** Stable machine-readable code, e.g. `wildcard_media_type`. */
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  message: z.string().min(1),
  /** JSON Pointer into the source document, when there is one. */
  pointer: z.string().optional(),
  /** IR operation id the diagnostic is about, if any. */
  operationId: z.string().optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;
