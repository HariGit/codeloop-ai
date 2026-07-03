# Skill: Apex Trigger Framework

Best practices for the Trigger → Domain → Service → Selector pattern.

## Layers

- **Trigger** — one per object. No logic. Delegates immediately to a handler.
- **Domain/Handler** — routes trigger events (before insert, after update, ...) to service methods. Holds record-scoped logic.
- **Service** — business logic, transaction boundaries. Callable from triggers, LWC controllers, batch, and REST.
- **Selector** — all SOQL for one object. Returns typed lists; fields declared in one place.

## Trigger rules

- One trigger per object, named `<Object>Trigger`.
- Trigger body: a single handler call, nothing else.
- Use a static "bypass" flag (or Custom Setting) so data loads can skip automation.
- Guard against recursion with a static processed-ids set in the handler.

## Handler rules

- One method per event: `onBeforeInsert(List<SObject>)`, `onAfterUpdate(Map<Id,SObject> old, Map<Id,SObject> new)`.
- Compare old/new maps to act only on records that actually changed.
- Collect ids/records first, then call the service ONCE with the full collection (bulkified).

## Service rules

- Stateless public methods that accept collections, never single records.
- One DML statement per object per operation — collect then commit.
- Throw typed exceptions; let callers decide how to surface them.

## Selector rules

- `with sharing` by default; document any exception.
- Methods like `selectByIds(Set<Id>)`, `selectOpenByAccountId(Set<Id>)`.
- Never accept raw query fragments from callers (injection risk).

## Anti-patterns

- SOQL/DML in loops.
- Logic in the trigger body.
- Multiple triggers on one object.
- Handler calling another object's trigger logic directly (use services).
