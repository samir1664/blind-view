import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateFeedbackBody } from './feedback.js';

// Validation only — no test ever writes to real Firestore.

test('feedback validation: helpful boolean required', () => {
  assert.equal(validateFeedbackBody({ helpful: true }).ok, true);
  assert.equal(validateFeedbackBody({ helpful: false }).ok, true);
  assert.equal(validateFeedbackBody({}).ok, false);
  assert.equal(validateFeedbackBody({ helpful: 'yes' }).ok, false);
  assert.equal(validateFeedbackBody(null).ok, false);
});

test('feedback validation: placeCategory capped at 40 chars', () => {
  assert.equal(
    validateFeedbackBody({ helpful: true, placeCategory: 'office' }).ok,
    true,
  );
  assert.equal(
    validateFeedbackBody({ helpful: true, placeCategory: 'x'.repeat(41) }).ok,
    false,
  );
  assert.equal(
    validateFeedbackBody({ helpful: true, placeCategory: 42 }).ok,
    false,
  );
});
