# Prompt: Explain Apex Class

Reusable template — replace {CLASS_NAME}.

---

Explain the functionality of the Apex class {CLASS_NAME}.

Steps:
1. Search for "{CLASS_NAME}" to locate the class and everything referencing it.
2. Read the class file completely.
3. Read directly related files found in step 1: Visualforce page, LWC controller usage, trigger, or test class.
4. Do NOT create or modify any files. Do NOT create tests. This is an explanation task only.

Format the final answer with these sections:
- Purpose — what business problem the class solves
- Entry point — how it is invoked (constructor, page, LWC, trigger, batch)
- Data queried — objects and fields from SOQL
- Main methods/getters — each with one line of description
- Wrapper/view classes — inner classes and what they represent
- Error handling — how failures are caught and surfaced
- Simple summary — 2-3 plain sentences for a non-developer
- Evidence files — files actually read in this session
