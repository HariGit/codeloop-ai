# Skill: LWC Patterns

Best practices for Lightning Web Components in this project.

## Data access

- `@wire` for reactive reads that should refresh automatically; imperative `apexMethod({params})` for user-initiated actions.
- Apex controller methods: `@AuraEnabled(cacheable=true)` for reads, non-cacheable for writes.
- Controllers stay thin — delegate to service classes; no SOQL directly in controllers (use selectors).

## Error handling (project rule: handle Apex errors clearly)

- Every imperative call gets `.catch()`; every wire gets an `error` branch.
- Parse errors with a shared `reduceErrors` utility (handle body.message, body.pageErrors, fieldErrors arrays).
- Show user-friendly messages via ShowToastEvent or inline text — never raw stack traces or "Script-thrown exception".
- Log technical details to console for debugging; show business language to users.

## Component design

- Small, single-purpose components; compose with slots and child components.
- Parent → child via `@api` properties; child → parent via CustomEvent.
- Cross-DOM communication via Lightning Message Service.
- Use `lightning-record-edit-form` / getRecord where possible before writing custom Apex.

## Configuration

- Labels via `@salesforce/label` imports — no hardcoded UI text where labels exist.
- Object/field references via `@salesforce/schema` imports — survives renames.
- No hardcoded record type ids, URLs, or org-specific values.

## Anti-patterns

- Business logic in the component JavaScript (belongs in Apex services).
- Chaining multiple imperative Apex calls where one composite method would do.
- Ignoring the `error` property of a wire.
- Mutating `@api` properties directly.
