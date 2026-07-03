# Skill: HLD vs LLD

How to write High Level Design and Low Level Design sections that are actually different from each other.

## High Level Design (HLD)

Audience: architects, leads, new team members.

- Components as boxes: name, responsibility in one line, layer it belongs to.
- Interactions between components: who calls whom and why — no method names yet.
- External touchpoints: objects, integrations, configuration sources.
- Non-functional notes: volume expectations, async vs sync, bulkification posture.
- A reader should understand the shape of the system without opening a single file.

## Low Level Design (LLD)

Audience: the developer changing this code next week.

- Key classes with their important public methods and signatures.
- Where each business rule lives (class + method).
- Data structures passed between layers (lists, maps keyed by Id, DTOs).
- Error handling paths: what throws, what catches, what the user sees.
- Extension points: where new behavior should be added (and where it should NOT).

## Rules of separation

- HLD never names methods; LLD always does.
- HLD says "AccountService enriches accounts"; LLD says "AccountService.enrich(List<Account>) queries ContactSelector.selectByAccountIds and sets Description".
- If HLD and LLD read the same, the LLD is missing.

## Mermaid quick reference

- Flowchart: \`flowchart TD\`, nodes \`A[AccountTrigger]\`, arrows \`A --> B\`, subgraphs per layer.
- Sequence: \`sequenceDiagram\`, \`participant S as AccountService\`, arrows \`A->>B: call()\`, returns \`B-->>A: result\`.
- Keep diagrams under ~15 nodes/steps; split rather than cram.
