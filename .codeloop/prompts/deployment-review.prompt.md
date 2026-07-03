# Prompt: Deployment Review

Reusable template — replace {TARGET_ORG} (e.g. sandbox/production) and {SCOPE} (components or branch).

---

Review the pending deployment of {SCOPE} to {TARGET_ORG}. Report only — do not deploy without my explicit confirmation.

Steps:
1. Read sfdx-project.json and any manifest (package.xml) in scope.
2. Identify all components being deployed and their dependencies.
3. Check for: destructive changes, profile/permission set changes, new required fields on existing objects, automation conflicts (Flow + trigger on the same object/event).
4. Determine the required test level ({TARGET_ORG} = production → RunLocalTests).

Format the final answer as:
- Deployment scope (component types and counts)
- Risk assessment (Critical / High / Medium / Low, each with reason)
- Pre-deployment checklist
- Exact validate command, then the exact deploy command
- Rollback approach
- Evidence files
