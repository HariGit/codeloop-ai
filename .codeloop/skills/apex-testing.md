# Skill: Apex Testing

Best practices for Apex test classes.

## Structure

- `@isTest` class named `<ClassUnderTest>Test`.
- `@TestSetup` method creates shared data once per class.
- Use a central TestDataFactory class; never duplicate record-creation code across tests.
- SeeAllData=false always — tests must create their own data.

## Coverage that matters

- Positive path, negative/exception path, null/empty inputs, and bulk (200+ records) — all four for every public method.
- Assert outcomes, not just "no exception": `System.assertEquals(expected, actual, 'message')`.
- Assert-free tests are defects, even at 100% coverage.

## Mechanics

- `Test.startTest()/stopTest()` around the action under test — resets governor limits and flushes async.
- Test async (future, queueable, batch) by asserting post-`stopTest()` state.
- `System.runAs(user)` for permission and sharing tests.
- Mock all callouts with `HttpCalloutMock` / `Test.setMock` — tests must never make real callouts.

## Data

- Create minimal valid records; set only fields the logic reads.
- For record types: query by DeveloperName, never hardcode ids.
- Use `Test.getStandardPricebookId()` for pricebook scenarios.

## Anti-patterns

- SeeAllData=true.
- Testing only one record when the code runs in bulk contexts.
- Catching exceptions in tests without asserting the exception type/message.
- Asserting only `isSuccess` without checking the resulting data.
