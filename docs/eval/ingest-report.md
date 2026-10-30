# Ingest eval report

Corpus entries: 12
Mapped: 11
Rejected: 1

| id | outcome | doc ops | IR ops | skipped | warnings | errors | mean confidence | input Ajv | output Ajv | IR bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| apisguru-listennotes-v2 | mapped | 24 | 24 | 0 | 0 | 0 | 0.900 | 24/24 | 24/24 | 196445 |
| apisguru-urlbox-v1 | mapped | 1 | 1 | 0 | 0 | 0 | 0.900 | 0/1 | 1/1 | 3871 |
| intervals-icu | mapped | 148 | 148 | 0 | 149 | 0 | 0.800 | 148/148 | 131/131 | 886838 |
| kubernetes-openapi-v2 | rejected (unsupported_version) | 1172 | 0 | 1172 | 0 | 1 | - | 0/0 | 0/0 | 0 |
| openai-openapi | mapped | 376 | 369 | 7 | 19 | 7 | 0.892 | 345/369 | 329/360 | 5108873 |
| twilio-accounts-v1-json | mapped | 20 | 20 | 0 | 0 | 0 | 0.900 | 20/20 | 16/16 | 42452 |
| twilio-api-v2010-json | mapped | 197 | 197 | 0 | 1 | 0 | 0.899 | 197/197 | 99/164 | 1037120 |
| twilio-conversations-v2-yaml | mapped | 22 | 22 | 0 | 0 | 0 | 0.900 | 22/22 | 22/22 | 159894 |
| twilio-sync-v1-yaml | mapped | 48 | 48 | 0 | 0 | 0 | 0.900 | 48/48 | 18/38 | 172157 |
| twilio-taskrouter-v1-yaml | mapped | 61 | 61 | 0 | 0 | 0 | 0.900 | 61/61 | 20/54 | 295477 |
| twilio-verify-v2-json | mapped | 57 | 57 | 0 | 0 | 0 | 0.900 | 57/57 | 32/49 | 239597 |
| twilio-video-v1-json | mapped | 39 | 39 | 0 | 0 | 0 | 0.900 | 39/39 | 17/35 | 189616 |

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
- strict Ajv: input 0/1, output 1/1
- compact IR bytes: 3871

Top diagnostics:
- none

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

## kubernetes-openapi-v2

- file: `kubernetes/swagger.json`
- outcome: rejected (unsupported_version)
- operations: 0/1172 mapped (skipped 1172)
- side effects: read 0, write 0, destructive 0 (name escalations 0)
- confidence: n/a
- strict Ajv: input 0/0, output 0/0
- compact IR bytes: 0

Top diagnostics:
- error unsupported_version: 1

Error samples:
- unsupported_version: Swagger 2.0 is not supported; convert to OpenAPI 3 first

## openai-openapi

- file: `openai/openapi.yaml`
- outcome: mapped
- operations: 369/376 mapped (skipped 7)
- side effects: read 163, write 153, destructive 53 (name escalations 0)
- confidence: mean 0.892, min 0.700
- strict Ajv: input 345/369, output 329/360
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

## twilio-accounts-v1-json

- file: `twilio/twilio_accounts_v1.json`
- outcome: mapped
- operations: 20/20 mapped (skipped 0)
- side effects: read 6, write 10, destructive 4 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 20/20, output 16/16
- compact IR bytes: 42452

Top diagnostics:
- none

Error samples:
- none

## twilio-api-v2010-json

- file: `twilio/twilio_api_v2010.json`
- outcome: mapped
- operations: 197/197 mapped (skipped 0)
- side effects: read 101, write 64, destructive 32 (name escalations 2)
- confidence: mean 0.899, min 0.800
- strict Ajv: input 197/197, output 99/164
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

## twilio-sync-v1-yaml

- file: `twilio/twilio_sync_v1.yaml`
- outcome: mapped
- operations: 48/48 mapped (skipped 0)
- side effects: read 20, write 18, destructive 10 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 48/48, output 18/38
- compact IR bytes: 172157

Top diagnostics:
- none

Error samples:
- none

## twilio-taskrouter-v1-yaml

- file: `twilio/twilio_taskrouter_v1.yaml`
- outcome: mapped
- operations: 61/61 mapped (skipped 0)
- side effects: read 36, write 18, destructive 7 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 61/61, output 20/54
- compact IR bytes: 295477

Top diagnostics:
- none

Error samples:
- none

## twilio-verify-v2-json

- file: `twilio/twilio_verify_v2.json`
- outcome: mapped
- operations: 57/57 mapped (skipped 0)
- side effects: read 24, write 25, destructive 8 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 57/57, output 32/49
- compact IR bytes: 239597

Top diagnostics:
- none

Error samples:
- none

## twilio-video-v1-json

- file: `twilio/twilio_video_v1.json`
- outcome: mapped
- operations: 39/39 mapped (skipped 0)
- side effects: read 22, write 13, destructive 4 (name escalations 0)
- confidence: mean 0.900, min 0.900
- strict Ajv: input 39/39, output 17/35
- compact IR bytes: 189616

Top diagnostics:
- none

Error samples:
- none
