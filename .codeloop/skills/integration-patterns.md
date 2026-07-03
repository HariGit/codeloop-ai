# Skill: Integration Patterns

Best practices for Salesforce integrations (inbound REST and outbound callouts).

## DTO discipline

- Separate classes for request and response payloads — never one shared DTO.
- Name clearly: `CreateOrderRequest`, `CreateOrderResponse`.
- DTOs are dumb: fields + optional parse/serialize helpers; no business logic.
- Version DTOs alongside the endpoint (v1, v2 packages) instead of mutating existing contracts.

## Inbound (@RestResource)

- REST class is a thin adapter: deserialize → validate → call service → serialize.
- Consistent error body: `{ "errorCode": "...", "message": "...", "details": [...] }`.
- Correct status codes: 200/201 success, 400 validation, 404 not found, 500 unexpected.
- Catch everything at the boundary — never let a raw exception produce a 500 HTML page.
- Accept lists where the operation allows it (bulk-safe contracts).

## Outbound (callouts)

- Named Credentials for endpoints and auth — no URLs or secrets in Apex.
- Timeouts and retry counts in Custom Metadata, not constants.
- Wrap callouts in a service with a single public method per operation.
- Idempotency: pass external ids so retries don't duplicate records.
- Async (Queueable with callout=true) when calling after DML — callouts cannot follow uncommitted DML in one transaction.

## Resilience

- Log request/response (sanitized — never tokens or PII) to a custom log object.
- Design for partial failure: per-record status in bulk responses.
- Circuit-breaker flag in Custom Metadata to disable an integration without deployment.

## Anti-patterns

- Hardcoded endpoints, credentials, or tokens.
- One giant "callout util" doing every integration.
- Swallowing callout exceptions without logging.
- Trusting external data without validation before DML.
