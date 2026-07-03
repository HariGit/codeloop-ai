# Prompt: Architecture Overview

Reusable template — replace {SCOPE} (object, class, feature, flow, or module name).

---

Provide architecture overview for {SCOPE}.

Steps:
1. Review the pre-scanned ARCHITECTURE INVENTORY in your context — it lists matched components by layer.
2. Read the entry points (trigger, Visualforce page, LWC, REST resource, flow).
3. Read the central service/controller class and the selector(s) it uses.
4. Track while reading: sharing declarations, SOQL objects, DML, Custom Labels, custom metadata, callouts.
5. Do NOT modify anything. This is analysis and documentation only.

Deliver the final answer with all 18 sections (Executive Summary → Evidence Files), including:
- A ```mermaid flowchart TD block showing component dependencies (entry point at top, database/objects at bottom).
- A ```mermaid sequenceDiagram block showing the main scenario (participants = actual class/component names).

Keep each section tight — this document should be readable in five minutes.
