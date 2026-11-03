# Ingest eval report

Corpus entries: 15
Mapped: 14
Rejected: 1

| id | outcome | doc ops | IR ops | skipped | warnings | errors | mean confidence | input Ajv | output Ajv | IR bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| apisguru-digitalocean-v2 | mapped | 290 | 290 | 0 | 16 | 0 | 0.895 | 290/290 | 215/215 | 1885342 |
| apisguru-listennotes-v2 | mapped | 24 | 24 | 0 | 0 | 0 | 0.900 | 24/24 | 24/24 | 196445 |
| apisguru-urlbox-v1 | mapped | 1 | 1 | 0 | 0 | 0 | 0.900 | 1/1 | 1/1 | 3871 |
| box-v2 | mapped | 297 | 297 | 0 | 10 | 0 | 0.895 | 297/297 | 247/247 | 3442394 |
| discord-v10 | mapped | 250 | 250 | 0 | 6 | 0 | 0.898 | 250/250 | 189/189 | 3246395 |
| intervals-icu | mapped | 148 | 148 | 0 | 149 | 0 | 0.800 | 148/148 | 131/131 | 886838 |
| oai-petstore-expanded-v3-0 | mapped | 4 | 4 | 0 | 0 | 0 | 0.900 | 4/4 | 3/3 | 6180 |
| oai-petstore-minimal-swagger-2-0 | rejected (unsupported_version) | 1 | 0 | 0 | 0 | 1 | - | 0/0 | 0/0 | 0 |
| oai-uspto-v3-0 | mapped | 3 | 3 | 0 | 0 | 0 | 0.900 | 3/3 | 3/3 | 6287 |
| oai-webhook-example-v3-1 | mapped | 0 | 0 | 0 | 0 | 0 | - | 0/0 | 0/0 | 499 |
| openai-openapi | mapped | 376 | 376 | 0 | 27 | 0 | 0.893 | 376/376 | 367/367 | 5058589 |
| stripe-v1 | mapped | 612 | 612 | 0 | 1 | 0 | 0.900 | 612/612 | 612/612 | 17501515 |
| swagger-petstore-v3 | mapped | 19 | 19 | 0 | 16 | 0 | 0.863 | 19/19 | 14/14 | 27736 |
| twilio-api-v2010-json | mapped | 197 | 197 | 0 | 1 | 0 | 0.899 | 197/197 | 164/164 | 1037120 |
| twilio-conversations-v2-yaml | mapped | 22 | 22 | 0 | 0 | 0 | 0.900 | 22/22 | 22/22 | 159894 |

## apisguru-digitalocean-v2

- file: `apisguru/digitalocean_v2.yaml`
- outcome: mapped
- operations: 290/290 mapped (skipped 0)
- side effects: read 141, write 95, destructive 54 (name escalations 6)
- confidence: mean 0.895, min 0.800
- strict Ajv: input 290/290, output 215/215
- compact IR bytes: 1885342

Top diagnostics:
- warning response_media_type_unspecified: 9
- warning output_schema_too_large: 4
- warning pattern_rewritten: 3
- info reserved_header_ignored: 2
- info description_truncated: 1

Error samples:
- none

## apisguru-listennotes-v2

- file: `apisguru/listennotes_v2.yaml`
- outcome: mapped
- operations: 24/24 mapped (skipped 0)
- side effects: read 20, write 3, destructive 1 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 24/24, output 24/24
- compact IR bytes: 196445

Top diagnostics:
- none

Error samples:
- none

## apisguru-urlbox-v1

- file: `apisguru/urlbox_v1.yaml`
- outcome: mapped
- operations: 1/1 mapped (skipped 0)
- side effects: read 0, write 1, destructive 0 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 1/1, output 1/1
- compact IR bytes: 3871

Top diagnostics:
- none

Error samples:
- none

## box-v2

- file: `box/openapi.json`
- outcome: mapped
- operations: 297/297 mapped (skipped 0)
- side effects: read 129, write 120, destructive 48 (name escalations 5)
- confidence: mean 0.895, min 0.700
- strict Ajv: input 297/297, output 247/247
- compact IR bytes: 3442394

Top diagnostics:
- info path_key_fragment: 19
- info output_schema_trimmed: 14
- warning response_media_type_unspecified: 6
- warning binary_request_body: 4

Error samples:
- none

## discord-v10

- file: `discord/openapi.json`
- outcome: mapped
- operations: 250/250 mapped (skipped 0)
- side effects: read 107, write 101, destructive 42 (name escalations 2)
- confidence: mean 0.898, min 0.700
- strict Ajv: input 250/250, output 189/189
- compact IR bytes: 3246395

Top diagnostics:
- warning binary_request_body: 3
- warning empty_enum: 2
- warning unsupported_oauth_flow: 1

Error samples:
- none

## intervals-icu

- file: `../../ingest/fixtures/intervals-icu/openapi.json`
- outcome: mapped
- operations: 148/148 mapped (skipped 0)
- side effects: read 79, write 55, destructive 14 (name escalations 2)
- confidence: mean 0.800, min 0.800
- strict Ajv: input 148/148, output 131/131
- compact IR bytes: 886838

Top diagnostics:
- warning wildcard_media_type: 131
- warning response_media_type_unspecified: 17
- warning auth_conjunction_unsatisfiable: 1

Error samples:
- none

## oai-petstore-expanded-v3-0

- file: `oai-examples/petstore-expanded.yaml`
- outcome: mapped
- operations: 4/4 mapped (skipped 0)
- side effects: read 2, write 1, destructive 1 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 4/4, output 3/3
- compact IR bytes: 6180

Top diagnostics:
- none

Error samples:
- none

## oai-petstore-minimal-swagger-2-0

- file: `oai-examples/petstore-minimal.swagger.json`
- outcome: rejected (unsupported_version)
- operations: 0/1 mapped (skipped 0)
- side effects: read 0, write 0, destructive 0 (name escalations 0)
- confidence: n/a
- strict Ajv: input 0/0, output 0/0
- compact IR bytes: 0

Top diagnostics:
- error unsupported_version: 1

Error samples:
- unsupported_version: Swagger 2.0 is not supported; convert to OpenAPI 3 first

## oai-uspto-v3-0

- file: `oai-examples/uspto.yaml`
- outcome: mapped
- operations: 3/3 mapped (skipped 0)
- side effects: read 2, write 1, destructive 0 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 3/3, output 3/3
- compact IR bytes: 6287

Top diagnostics:
- none

Error samples:
- none

## oai-webhook-example-v3-1

- file: `oai-examples/webhook-example.yaml`
- outcome: mapped
- operations: 0/0 mapped (skipped 0)
- side effects: read 0, write 0, destructive 0 (name escalations 0)
- confidence: n/a
- strict Ajv: input 0/0, output 0/0
- compact IR bytes: 499

Top diagnostics:
- none

Error samples:
- none

## openai-openapi

- file: `openai/openapi.yaml`
- outcome: mapped
- operations: 376/376 mapped (skipped 0)
- side effects: read 165, write 157, destructive 54 (name escalations 0)
- confidence: mean 0.893, min 0.700
- strict Ajv: input 376/376, output 367/367
- compact IR bytes: 5058589

Top diagnostics:
- info output_schema_trimmed: 15
- warning binary_request_body: 9
- warning response_media_type_unspecified: 9
- warning path_key_query: 7
- warning unknown_schema_keyword: 1

Error samples:
- none

## stripe-v1

- file: `stripe/spec3.json`
- outcome: mapped
- operations: 612/612 mapped (skipped 0)
- side effects: read 273, write 305, destructive 34 (name escalations 2)
- confidence: mean 0.900, min 0.700
- strict Ajv: input 612/612, output 612/612
- compact IR bytes: 17501515

Top diagnostics:
- info output_schema_trimmed: 364
- warning binary_request_body: 1

Error samples:
- none

## swagger-petstore-v3

- file: `swagger-petstore/openapi.yaml`
- outcome: mapped
- operations: 19/19 mapped (skipped 0)
- side effects: read 8, write 8, destructive 3 (name escalations 0)
- confidence: mean 0.863, min 0.700
- strict Ajv: input 19/19, output 14/14
- compact IR bytes: 27736

Top diagnostics:
- warning security_requirement_dropped: 8
- warning response_media_type_unspecified: 5
- warning binary_request_body: 1
- warning invalid_security_scheme: 1
- warning unsupported_oauth_flow: 1

Error samples:
- none

## twilio-api-v2010-json

- file: `twilio/twilio_api_v2010.json`
- outcome: mapped
- operations: 197/197 mapped (skipped 0)
- side effects: read 101, write 64, destructive 32 (name escalations 2)
- confidence: mean 0.899, min 0.800
- strict Ajv: input 197/197, output 164/164
- compact IR bytes: 1037120

Top diagnostics:
- warning no_success_response: 1

Error samples:
- none

## twilio-conversations-v2-yaml

- file: `twilio/twilio_conversations_v2.yaml`
- outcome: mapped
- operations: 22/22 mapped (skipped 0)
- side effects: read 10, write 10, destructive 2 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 22/22, output 22/22
- compact IR bytes: 159894

Top diagnostics:
- none

Error samples:
- none
