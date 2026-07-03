# Prompt: Migrate Flow to Apex

Reusable template — replace {FLOW_NAME} and {OBJECT_NAME}.

---

Analyze the Flow {FLOW_NAME} on {OBJECT_NAME} and produce a migration plan to Apex. Analysis first — do not write Apex until the full analysis is presented.

Steps:
1. Read the Flow XML in force-app/main/default/flows/.
2. Read the existing trigger, handler, service, and selector classes for {OBJECT_NAME}.
3. Identify in the Flow: trigger type and entry criteria, every decision branch, loops, DML operations, email actions, subflow calls, and hardcoded values (emails, ids, queue names, URLs).
4. Check for existing Apex that already implements similar logic (duplication risk).

Format the final answer as:
- Flow inventory (entry criteria, branches, actions, DML, emails)
- Hardcoded values found → where each should move (Custom Label / Custom Metadata)
- Dependencies and double-execution risks (Flow + Apex both active)
- Proposed Apex design mapped to Trigger → Domain → Service → Selector
- Ordered migration steps including test plan and Flow deactivation point
- Evidence files
