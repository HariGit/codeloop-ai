# Prompt: Review Apex Code

Reusable template — replace {CLASS_NAME}.

---

Review the Apex class {CLASS_NAME} for quality and architecture issues. Do not modify any files — report only.

Check against project standards:
1. SOQL or DML inside loops
2. SOQL outside selector classes
3. Business logic in triggers instead of services
4. Missing bulkification (assume 200+ records per transaction)
5. Hardcoded emails, URLs, ids, queue names, profile/permission set names, record type ids
6. Missing or unclear sharing declaration (with/without/inherited sharing)
7. Missing CRUD/FLS enforcement
8. Exception handling that swallows errors or exposes raw messages
9. Missing/weak test class (check the related test class)

Format the final answer as:
- Findings by severity (Critical / High / Medium / Low), each with file:line, issue, and suggested fix
- What the class does well
- Prioritized fix list (top 3 first)
- Evidence files
