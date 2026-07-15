import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateShadow, shadowStatus } from './shadow.js';

test('first sample seeds the agreement', () => {
  const s = updateShadow(null, { agreement: 0.9, samples: 8 });
  assert.deepEqual(s, { agreement: 0.9, runs: 1, samples: 8 });
});

test('EWMA smooths a noisy later sample (alpha 0.4)', () => {
  const s1 = updateShadow(null, { agreement: 0.9, samples: 8 });
  const s2 = updateShadow(s1, { agreement: 0.5, samples: 8 });
  assert.ok(Math.abs(s2.agreement - (0.4 * 0.5 + 0.6 * 0.9)) < 1e-9); // 0.74
  assert.equal(s2.runs, 2);
  assert.equal(s2.samples, 16);
});

test('status: validating below minRuns, then passing / drifting by the bar', () => {
  assert.equal(shadowStatus({ agreement: 0.99, runs: 2, samples: 16 }), 'validating'); // runs < 3
  assert.equal(shadowStatus({ agreement: 0.97, runs: 3, samples: 24 }), 'passing');
  assert.equal(shadowStatus({ agreement: 0.80, runs: 3, samples: 24 }), 'drifting');
});

test('a recovering agreement climbs back to passing', () => {
  assert.equal(shadowStatus({ agreement: 0.96, runs: 5, samples: 40 }), 'passing');
});
