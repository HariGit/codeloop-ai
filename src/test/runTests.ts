/**
 * Lightweight unit test runner (no external dependencies).
 * Run with: npm test   (compiles first, then executes this file)
 *
 * The 'vscode' module only exists inside VS Code, so it is stubbed
 * before any extension module is loaded.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const Module = require('module');

const vscodeStub = {
  window: {
    showWarningMessage: async () => 'Approve',
    showInformationMessage: () => undefined,
    showErrorMessage: () => undefined
  },
  workspace: {
    findFiles: async () => [],
    getConfiguration: () => ({ get: (_key: string, dflt: unknown) => dflt })
  },
  CancellationTokenSource: class {
    token = {};
  }
};

const originalLoad = Module._load;
Module._load = function (request: string, ...args: unknown[]) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.apply(this, [request, ...args]);
};

// Load modules under test AFTER the stub is installed.
const { detectSalesforceTaskMode } = require('../agent/taskModeDetector');
const { validateFinalAnswer, parseAction } = require('../agent/agentLoop');
const { assessCommandRisk, lwcTagToCamel } = require('../agent/tools');
const { redactSecrets } = require('../agent/memory');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, label = 'value'): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. taskModeDetector
// ---------------------------------------------------------------------------

console.log('\ntaskModeDetector');

test('explain class -> EXPLAIN_APEX', () => {
  assertEqual(detectSalesforceTaskMode('Explain Apex class AccountService functionality.').mode, 'EXPLAIN_APEX');
});

test('create test class -> CREATE_TEST', () => {
  assertEqual(detectSalesforceTaskMode('Create Apex test class for AccountService.').mode, 'CREATE_TEST');
});

test('flow migration -> FLOW_MIGRATION', () => {
  assertEqual(detectSalesforceTaskMode('Analyze Flow Account_After_Save and guide whether it should move to Apex.').mode, 'FLOW_MIGRATION');
});

test('deployment review -> DEPLOYMENT_REVIEW', () => {
  assertEqual(detectSalesforceTaskMode('Perform Salesforce deployment review for release 2.4.').mode, 'DEPLOYMENT_REVIEW');
});

test('EXPLAIN_APEX is read-only', () => {
  const r = detectSalesforceTaskMode('explain how this class works');
  assert(!r.allowedActions.includes('write_file'), 'write_file must not be allowed');
  assert(!r.allowedActions.includes('run_command'), 'run_command must not be allowed');
});

// ---------------------------------------------------------------------------
// 2. validateFinalAnswer
// ---------------------------------------------------------------------------

console.log('\nvalidateFinalAnswer');

test('"I created file" without write -> violation', () => {
  const v = validateFinalAnswer('I created the file AccountServiceTest.cls', false, false);
  assert(v.length > 0, 'expected a violation');
  assert(v.includes('created'), 'expected "created" violation');
});

test('"I ran tests" without run -> violation', () => {
  const v = validateFinalAnswer('I ran the tests and they passed', false, false);
  assert(v.length > 0, 'expected a violation');
  assert(v.includes('ran'), 'expected "ran" violation');
});

test('explain-only answer -> no violation', () => {
  const v = validateFinalAnswer('The controller loads a knowledge article and formats phone numbers for printing.', false, false);
  assertEqual(v.length, 0, 'violations');
});

test('claims pass when matching action succeeded', () => {
  assertEqual(validateFinalAnswer('I created the test class', true, false).length, 0, 'write-backed claim');
  assertEqual(validateFinalAnswer('I executed the tests', false, true).length, 0, 'run-backed claim');
});

test('descriptive system behavior is NOT a violation', () => {
  const answer =
    'When a Case record is created or updated, LA_CaseMaster_Trigger fires and the handler routes the event. Records are saved by the service after validation.';
  assertEqual(validateFinalAnswer(answer, false, false).length, 0, 'violations');
});

test('passive agent claims still caught', () => {
  const v = validateFinalAnswer('The test class was created and the tests were run.', false, false);
  assert(v.includes('created'), 'expected passive created claim');
  assert(v.includes('run'), 'expected passive run claim');
});

// ---------------------------------------------------------------------------
// 3. parseAction
// ---------------------------------------------------------------------------

console.log('\nparseAction');

test('valid JSON', () => {
  const a = parseAction('{"thought":"t","action":"read_file","path":"a.cls"}');
  assert(a !== undefined, 'expected parse to succeed');
  assertEqual(a!.action, 'read_file');
  assertEqual(a!.path, 'a.cls');
});

test('JSON inside code fence', () => {
  const a = parseAction('```json\n{"thought":"t","action":"search_code","query":"AccountService"}\n```');
  assert(a !== undefined, 'expected parse to succeed');
  assertEqual(a!.query, 'AccountService');
});

test('invalid JSON -> undefined', () => {
  assertEqual(parseAction('this is not json at all'), undefined);
});

test('missing required path for read_file -> undefined', () => {
  assertEqual(parseAction('{"thought":"t","action":"read_file"}'), undefined);
});

test('new input format is hoisted', () => {
  const a = parseAction('{"thought":"t","action":"read_file","input":{"path":"b.cls"}}');
  assert(a !== undefined, 'expected parse to succeed');
  assertEqual(a!.path, 'b.cls');
});

// ---------------------------------------------------------------------------
// 4. assessCommandRisk
// ---------------------------------------------------------------------------

console.log('\nassessCommandRisk');

test('git status -> LOW', () => {
  const r = assessCommandRisk('git status');
  assertEqual(r.level, 'LOW');
  assertEqual(r.blocked, false, 'blocked');
});

test('sf project deploy -> HIGH', () => {
  const r = assessCommandRisk('sf project deploy start -o prod');
  assertEqual(r.level, 'HIGH');
  assertEqual(r.blocked, false, 'blocked');
});

test('rm -rf -> BLOCKED', () => {
  const r = assessCommandRisk('rm -rf /tmp/everything');
  assertEqual(r.blocked, true, 'blocked');
});

test('npm install -> HIGH', () => {
  const r = assessCommandRisk('npm install lodash');
  assertEqual(r.level, 'HIGH');
  assertEqual(r.blocked, false, 'blocked');
});

test('git reset --hard -> BLOCKED', () => {
  assertEqual(assessCommandRisk('git reset --hard HEAD~1').blocked, true, 'blocked');
});

// ---------------------------------------------------------------------------
// 4b. lwcTagToCamel
// ---------------------------------------------------------------------------

console.log('\nlwcTagToCamel');

test('c-la-case-creation-flow -> laCaseCreationFlow', () => {
  assertEqual(lwcTagToCamel('c-la-case-creation-flow'), 'laCaseCreationFlow');
});

test('c-la-home -> laHome', () => {
  assertEqual(lwcTagToCamel('c-la-home'), 'laHome');
});

test('non-tag input -> undefined', () => {
  assertEqual(lwcTagToCamel('AccountService'), undefined);
  assertEqual(lwcTagToCamel('c-'), undefined);
});

// ---------------------------------------------------------------------------
// 5. redactSecrets
// ---------------------------------------------------------------------------

console.log('\nredactSecrets');

test('token redacted', () => {
  const r = redactSecrets('use github_pat_11ABCDEFGH1234567890abcdefXYZ for auth');
  assert(!r.includes('github_pat_11ABCDEFGH'), 'PAT must be redacted');
  assert(r.includes('[REDACTED]'), 'expected [REDACTED] marker');
});

test('password assignment redacted', () => {
  const r = redactSecrets('password=SuperSecret99 and more');
  assert(!r.includes('SuperSecret99'), 'password must be redacted');
});

test('api key assignment redacted', () => {
  const r = redactSecrets('api_key: abcd1234efgh5678');
  assert(!r.includes('abcd1234efgh5678'), 'api key must be redacted');
});

test('normal text untouched', () => {
  const text = 'The AccountService class queries contacts via the selector.';
  assertEqual(redactSecrets(text), text);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
