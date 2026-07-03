# Skill: Flow to Apex Migration

Best practices for migrating Flows to Apex.

## When to migrate

- Flow hits performance/limit issues on bulk operations.
- Logic exceeds what Flow can express cleanly (complex branching, reuse needs).
- The object already has Apex automation — consolidating avoids Flow/trigger ordering problems.

## Analysis before any code

1. Export and read the full Flow XML — every element, not just the happy path.
2. Inventory: trigger type (before/after save, scheduled), entry criteria, decision branches, loops, assignments, DML, email actions, subflow calls.
3. List hardcoded values: emails, queue names, record type ids, URLs, user ids.
4. Map dependencies: other Flows on the object, existing triggers, workflow rules, process builders.
5. Identify the execution order today — migrating can change when logic runs relative to other automation.

## Mapping Flow → Apex layers

- Record-triggered Flow entry criteria → handler change detection (old/new map comparison).
- Decision elements → service method branching.
- Get Records → selector methods.
- Create/Update Records → collected DML in the service.
- Email actions → a dedicated email service using Custom Labels for addresses and templates.
- Scheduled Flow → Schedulable/Batchable Apex.

## Migration safety

- Write the Apex test class BEFORE deactivating the Flow; encode current Flow behavior as assertions.
- Deploy Apex inactive-safe (behind the trigger bypass flag), verify, then deactivate the Flow in the same window — never both fully active.
- Keep the Flow (deactivated) until the Apex has survived a full business cycle.

## Anti-patterns

- Migrating branch-by-branch while the Flow stays active (double execution).
- Recreating Flow hardcoded values as Apex hardcoded values — move them to Custom Labels/Metadata.
- Skipping "unused" Flow branches without proving they're unreachable.
