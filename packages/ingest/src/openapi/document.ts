import { z } from "zod";

// Loose Zod models of the parts of OpenAPI 3.0/3.1 the mapper reads. Unknown
// fields pass through; anything that can be a `$ref` is typed `unknown` and
// resolved with `deref` before being parsed with the matching model.

const StringArrayRecord = z.record(z.string(), z.array(z.string()));
export const SecurityRequirements = z.array(StringArrayRecord);

export const OpenApiDocument = z.looseObject({
  openapi: z.string().regex(/^3\.[01]\.\d+/, "only OpenAPI 3.0.x and 3.1.x are supported"),
  info: z.looseObject({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
  }),
  servers: z
    .array(
      z.looseObject({
        url: z.string(),
        variables: z.record(z.string(), z.looseObject({ default: z.string() })).optional(),
      }),
    )
    .optional(),
  paths: z.record(z.string(), z.unknown()).optional(),
  components: z.looseObject({ securitySchemes: z.record(z.string(), z.unknown()).optional() }).optional(),
  security: SecurityRequirements.optional(),
});
export type OpenApiDocument = z.infer<typeof OpenApiDocument>;

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export const PathItem = z.looseObject({
  parameters: z.array(z.unknown()).optional(),
});

export const OaOperation = z.looseObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  deprecated: z.boolean().optional(),
  parameters: z.array(z.unknown()).optional(),
  requestBody: z.unknown().optional(),
  responses: z.record(z.string(), z.unknown()).optional(),
  security: SecurityRequirements.optional(),
});
export type OaOperation = z.infer<typeof OaOperation>;

const EncodingObject = z.looseObject({
  style: z.string().optional(),
  explode: z.boolean().optional(),
});
const MediaTypeObject = z.looseObject({
  schema: z.unknown().optional(),
  encoding: z.record(z.string(), EncodingObject).optional(),
});
const Content = z.record(z.string(), MediaTypeObject);

export const OaParameter = z.looseObject({
  name: z.string().min(1),
  in: z.enum(["path", "query", "header", "cookie"]),
  required: z.boolean().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
  schema: z.unknown().optional(),
  content: Content.optional(),
  style: z.enum(["simple", "form", "label", "matrix", "spaceDelimited", "pipeDelimited", "deepObject"]).optional(),
  explode: z.boolean().optional(),
});
export type OaParameter = z.infer<typeof OaParameter>;

export const OaRequestBody = z.looseObject({
  description: z.string().optional(),
  required: z.boolean().optional(),
  content: Content,
});
export type OaRequestBody = z.infer<typeof OaRequestBody>;

export const OaResponse = z.looseObject({
  description: z.string().optional(),
  content: Content.optional(),
});
export type OaResponse = z.infer<typeof OaResponse>;

const OAuthFlow = z.looseObject({
  authorizationUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  refreshUrl: z.string().optional(),
  scopes: z.record(z.string(), z.string()).default({}),
});

export const OaSecurityScheme = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("http"), scheme: z.string(), bearerFormat: z.string().optional(), description: z.string().optional() }),
  z.looseObject({ type: z.literal("apiKey"), in: z.enum(["header", "query", "cookie"]), name: z.string(), description: z.string().optional() }),
  z.looseObject({
    type: z.literal("oauth2"),
    description: z.string().optional(),
    flows: z.looseObject({
      implicit: OAuthFlow.optional(),
      password: OAuthFlow.optional(),
      clientCredentials: OAuthFlow.optional(),
      authorizationCode: OAuthFlow.optional(),
    }),
  }),
  z.looseObject({ type: z.literal("openIdConnect"), openIdConnectUrl: z.string(), description: z.string().optional() }),
  z.looseObject({ type: z.literal("mutualTLS"), description: z.string().optional() }),
]);
export type OaSecurityScheme = z.infer<typeof OaSecurityScheme>;
