# Skill: System Design (Salesforce)

How to describe a Salesforce system design well.

## Structure of a good design description

- Start from the business capability, not the code: what does this feature do for users?
- Name the architectural style in use: layered trigger framework (Trigger → Domain → Service → Selector), MVC for VF/LWC, event-driven (platform events), batch/async.
- Separate concerns explicitly: presentation (LWC/VF), orchestration (controllers/handlers), business logic (services), data access (selectors), configuration (labels/custom metadata).
- State where the boundaries are honored and where they leak (logic in triggers, SOQL in controllers).

## Entry point taxonomy

- Record lifecycle: triggers, record-triggered flows.
- User initiated: LWC actions, Visualforce buttons, quick actions.
- External: @RestResource endpoints, platform events, inbound email handlers.
- Time-based: scheduled flows, Schedulable Apex, batch jobs.

## Dependency mapping

- Direction matters: UI → controller → service → selector → objects. Reverse arrows are smells.
- Fan-in (many callers) marks shared services — change with care.
- Fan-out (one class calling many) marks orchestrators — candidates for splitting.

## Data flow narration

- Follow one record through the scenario: where it is read, transformed, validated, written.
- Name the transaction boundaries and where partial failure is possible.

## Diagrams

- Flowchart: components as nodes, call/data direction as arrows, group by layer.
- Sequence: only the main scenario, 5-10 steps, real class names as participants.
