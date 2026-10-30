# Ingest eval report

Corpus entries: 13
Mapped: 12
Rejected: 1

| id | outcome | doc ops | IR ops | skipped | warnings | errors | mean confidence | input Ajv | output Ajv | IR bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| apisguru-listennotes-v2 | mapped | 24 | 24 | 0 | 0 | 0 | 0.900 | 24/24 | 24/24 | 196445 |
| apisguru-urlbox-v1 | mapped | 1 | 1 | 0 | 0 | 0 | 0.900 | 1/1 | 1/1 | 3871 |
| box-v2 | mapped | 297 | 278 | 19 | 10 | 19 | 0.895 | 278/278 | 228/228 | 3009493 |
| discord-v10 | mapped | 250 | 250 | 0 | 4 | 0 | 0.898 | 248/250 | 189/189 | 3246415 |
| intervals-icu | mapped | 148 | 148 | 0 | 149 | 0 | 0.800 | 148/148 | 131/131 | 886838 |
| oai-petstore-expanded-v3-0 | mapped | 4 | 4 | 0 | 0 | 0 | 0.900 | 4/4 | 3/3 | 6180 |
| oai-petstore-minimal-swagger-2-0 | rejected (unsupported_version) | 1 | 0 | 0 | 0 | 1 | - | 0/0 | 0/0 | 0 |
| oai-uspto-v3-0 | mapped | 3 | 3 | 0 | 0 | 0 | 0.900 | 3/3 | 3/3 | 6287 |
| oai-webhook-example-v3-1 | mapped | 0 | 0 | 0 | 0 | 0 | - | 0/0 | 0/0 | 499 |
| openai-openapi | mapped | 376 | 369 | 7 | 19 | 7 | 0.892 | 369/369 | 359/360 | 5108873 |
| swagger-petstore-v3 | mapped | 19 | 19 | 0 | 16 | 0 | 0.863 | 19/19 | 14/14 | 27736 |
| twilio-api-v2010-json | mapped | 197 | 197 | 0 | 1 | 0 | 0.899 | 197/197 | 164/164 | 1037120 |
| twilio-conversations-v2-yaml | mapped | 22 | 22 | 0 | 0 | 0 | 0.900 | 22/22 | 22/22 | 159894 |

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
- operations: 278/297 mapped (skipped 19)
- side effects: read 123, write 110, destructive 45 (name escalations 2)
- confidence: mean 0.895, min 0.700
- strict Ajv: input 278/278, output 228/228
- compact IR bytes: 3009493

Top diagnostics:
- error ir_validation_failed: 19
- warning response_media_type_unspecified: 6
- warning binary_request_body: 4

Error samples:
- ir_validation_failed (get_files_id_get_shared_link): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (get_folders_id_get_shared_link): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (get_shared_items_app_items): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (get_shared_items_folders): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (get_shared_items_web_links): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (get_web_links_id_get_shared_link): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (post_metadata_templates_schema_classifications): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (post_oauth2_token_refresh): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (put_files_id_add_shared_link): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (put_files_id_remove_shared_link): mapped operation failed IR validation: must start with / and contain no query or fragment

## discord-v10

- file: `discord/openapi.json`
- outcome: mapped
- operations: 250/250 mapped (skipped 0)
- side effects: read 107, write 101, destructive 42 (name escalations 2)
- confidence: mean 0.898, min 0.700
- strict Ajv: input 248/250, output 189/189
- compact IR bytes: 3246415

Top diagnostics:
- warning binary_request_body: 3
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
- operations: 369/376 mapped (skipped 7)
- side effects: read 163, write 153, destructive 53 (name escalations 0)
- confidence: mean 0.892, min 0.700
- strict Ajv: input 369/369, output 359/360
- compact IR bytes: 5108873

Top diagnostics:
- warning binary_request_body: 9
- warning response_media_type_unspecified: 9
- error ir_validation_failed: 7
- warning wildcard_media_type: 1

Error samples:
- ir_validation_failed (beta_cancel_response): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (beta_compactconversation): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (beta_create_response): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (beta_delete_response): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (beta_get_response): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (beta_getinputtokencounts): mapped operation failed IR validation: must start with / and contain no query or fragment
- ir_validation_failed (beta_list_input_items): mapped operation failed IR validation: must start with / and contain no query or fragment

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
