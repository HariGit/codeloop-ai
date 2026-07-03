# Skill: Salesforce Security

Best practices for secure Apex, LWC, and configuration.

## Sharing

- Every class declares sharing explicitly: `with sharing` by default, `inherited sharing` for utilities, `without sharing` only with a documented reason.
- Service classes called from user contexts must respect the user's record access unless the business case demands otherwise.

## CRUD / FLS

- Reads: `WITH SECURITY_ENFORCED` in SOQL, or `Security.stripInaccessible(AccessType.READABLE, records)`.
- Writes: `Security.stripInaccessible(AccessType.CREATABLE/UPDATABLE, ...)` before DML, or explicit `isCreateable()/isUpdateable()` checks.
- LWC does not bypass FLS automatically — enforce in the Apex controller.

## SOQL injection

- Static SOQL wherever possible.
- Dynamic SOQL: bind variables first choice; `String.escapeSingleQuotes()` for unavoidable string concatenation; whitelist field/object names — never concatenate them raw from user input.

## Secrets

- No credentials, tokens, or API keys in Apex, custom labels, or debug logs.
- Named Credentials for auth; Protected Custom Settings/Metadata for other sensitive config.
- Never log request headers or bodies containing tokens; sanitize before logging.

## Permissions

- Least privilege: permission sets over profile edits; one permission set per function.
- Do not grant Modify All Data / View All Data to solve an access bug — find the actual gap.
- Review permission sets bundled in deployments — code reviews miss them easily.

## Anti-patterns

- `without sharing` as a quick fix for visibility issues.
- Dynamic SOQL built by concatenating user input.
- `@AuraEnabled` methods that skip CRUD/FLS because "the UI restricts it".
- Secrets in debug logs, comments, or test data.
