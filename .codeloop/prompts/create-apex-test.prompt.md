# Prompt: Create Apex Test Class

Reusable template — replace {CLASS_NAME}.

---

Create a test class for {CLASS_NAME}.

Steps:
1. Read {CLASS_NAME} completely — every public method and exception path.
2. Search for existing test data factories or @TestSetup patterns in this project and reuse them.
3. Read one or two existing test classes to match naming and structure conventions.
4. Write the test class ({CLASS_NAME}Test) via write_file.

Requirements:
- @isTest, SeeAllData=false
- @TestSetup for shared data; use the project's data factory if one exists
- Cover: positive path, negative/exception path, null inputs, and a bulk scenario (200+ records)
- Test.startTest/stopTest around the action under test
- Meaningful System.assertEquals/assert with messages — no assert-free methods
- Mock callouts with HttpCalloutMock if {CLASS_NAME} makes callouts

Format the final answer as:
- Test scenarios covered (list)
- Test data strategy
- The command to run the tests
- Evidence files
