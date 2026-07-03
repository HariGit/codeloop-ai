/**
 * Salesforce final-answer templates, injected into the prompt by task mode.
 * Each template tells the model exactly which sections its final_answer
 * must contain.
 */

export const explainApexTemplate = `FINAL ANSWER FORMAT — structure your final_answer with exactly these sections:
- Purpose: the business problem this class solves
- Entry Point: how it is invoked (page, LWC, trigger, batch, REST)
- Constructor Behavior: what happens on instantiation
- Main Methods: each public method/getter with one line of description
- SOQL Queries: objects and fields queried, and where
- DML Operations: inserts/updates/deletes performed, or "none"
- Wrapper Classes: inner/view classes and what they represent
- Error Handling: how failures are caught and surfaced
- Related Metadata: connected pages, LWC, triggers, labels, test classes
- Risks / Improvements: issues noticed (hardcoding, bulkification, missing tests)
- Simple Summary: 2-3 plain sentences for a non-developer
- Evidence Files: files actually read in this session`;

export const flowMigrationTemplate = `FINAL ANSWER FORMAT — structure your final_answer with exactly these sections:
- Flow Recap: what the Flow does today, in short
- Trigger Object: the object and trigger type (before/after save, scheduled)
- Start Criteria: entry conditions and when the Flow fires
- Flow Elements: decisions, loops, assignments, subflows — every branch
- Email Actions: alerts/notifications sent, with recipients source
- Hardcoded Values: emails, ids, queue names, URLs found — and where each should move (Custom Label / Custom Metadata)
- Existing Apex Overlap: current trigger/handler/service logic that overlaps
- Recommended Apex Design: overall approach mapped to the framework
- Trigger Layer: what the trigger delegates
- Domain Layer: change detection and routing
- Service Layer: business logic methods
- Selector Layer: SOQL methods needed
- Test Strategy: scenarios that must be encoded before Flow deactivation
- Acceptance Criteria: how to verify behavior matches the Flow
- Caveats / Decisions to Confirm: open questions for the team`;

export const testClassTemplate = `FINAL ANSWER FORMAT — structure your final_answer with exactly these sections:
- Test Class Name: <ClassUnderTest>Test
- Scenarios Covered: positive, negative, null, bulk — list each test method
- Test Data Needed: records, factory usage, @TestSetup contents
- Assertions: what each scenario asserts (no assert-free tests)
- Bulk Scenario: how 200+ records are covered
- Negative Scenario: exception/error paths covered
- Commands to Run: exact sf CLI command(s) to execute the tests
- Risks: gaps or behaviors not covered`;

export const deploymentReviewTemplate = `FINAL ANSWER FORMAT — structure your final_answer with exactly these sections:
- Deployment Summary: what is being deployed and why
- Metadata Components: component types and counts in scope
- Dependencies: required components, order-of-deployment concerns
- Permission Sets / Profiles: access changes bundled in this deployment
- Custom Metadata / Labels: configuration records included or required
- Apex Tests: test level required and expected coverage impact
- Pre-Deployment Steps: manual steps before deploying
- Post-Deployment Steps: verification and manual steps after
- Risks: what could break, rollback approach`;

/** Template for a task mode; '' when the mode has no fixed format. */
export function getResponseTemplate(mode: string): string {
  switch (mode) {
    case 'EXPLAIN_APEX':
      return explainApexTemplate;
    case 'FLOW_MIGRATION':
      return flowMigrationTemplate;
    case 'CREATE_TEST':
      return testClassTemplate;
    case 'DEPLOYMENT_REVIEW':
      return deploymentReviewTemplate;
    default:
      return '';
  }
}
