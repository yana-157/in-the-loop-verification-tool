import test from 'node:test';
import assert from 'node:assert/strict';
import { drawAuditSample, estimateAccuracyInterval, evaluateAudit, planAudit } from '../lib/audit.js';

function combinations(n, k) {
  if (k < 0 || k > n) return 0n;
  let count = 1n;
  for (let i = 1; i <= k; i++) count = count * BigInt(n - i + 1) / BigInt(i);
  return count;
}

function referenceTail(n, k, draws, threshold) {
  let numerator = 0n;
  for (let successes = threshold; successes <= draws; successes++) {
    numerator += combinations(k, successes) * combinations(n - k, draws - successes);
  }
  return Number(numerator) / Number(combinations(n, draws));
}

test('planner picks the same smallest fixed sample and cutoff as exhaustive integer counting', () => {
  for (const settings of [
    { alpha: .05, floor: .90, designAccuracy: .98, power: .80 },
    { alpha: .10, floor: .65, designAccuracy: .85, power: .90 },
    { alpha: .01, floor: .30, designAccuracy: .60, power: .80 },
    { alpha: .20, floor: .25, designAccuracy: .75, power: .60 },
    { alpha: .05, floor: .99, designAccuracy: 1, power: 1 },
  ]) {
    for (let n = 1; n <= 32; n++) {
      const plan = planAudit(n, settings);
      let expected;
      for (let draw = 1; draw <= n && !expected; draw++) {
        for (let cutoff = 1; cutoff <= draw; cutoff++) {
          const risk = referenceTail(n, plan.nullCorrect, draw, cutoff);
          const sensitivity = referenceTail(n, plan.designCorrect, draw, cutoff);
          if (risk <= settings.alpha && sensitivity >= settings.power) {
            expected = [draw, cutoff, risk, sensitivity];
            break;
          }
        }
      }
      assert.deepEqual([plan.sampleSize, plan.criticalCorrect], expected.slice(0, 2));
      assert.ok(Math.abs(plan.typeIError - expected[2]) < 1e-12);
      assert.ok(Math.abs(plan.achievedPower - expected[3]) < 1e-12);
    }
  }
});

test('inconclusive source evidence stays in the frozen sample and bounds the p-value', () => {
  const plan = planAudit(161, { alpha: .05, floor: .90, designAccuracy: .98, power: .80 });
  const { sampleSize: n, criticalCorrect: k } = plan;
  assert.deepEqual([n, k], [39, 38]);
  const evaluate = (correct, incorrect, inconclusive, remaining = 0) =>
    evaluateAudit(plan, { correct, incorrect, inconclusive, remaining });
  const complete = evaluate(k, n - k, 0);
  assert.equal(complete.status, 'pass');
  assert.deepEqual(complete.confidenceInterval, { level: .95, lower: 142 / 161, upper: 160 / 161 });
  assert.equal(evaluate(k - 1, n - k + 1, 0).status, 'not-demonstrated');
  const passWithUnknown = evaluate(k, n - k - 1, 1);
  assert.equal(passWithUnknown.status, 'pass');
  assert.deepEqual(passWithUnknown.confidenceInterval, { level: .95, lower: 142 / 161, upper: 1 });
  const unresolved = evaluate(k - 1, n - k, 1);
  assert.equal(unresolved.status, 'inconclusive');
  assert.ok(unresolved.pValueMin <= plan.alpha && unresolved.pValueMax > plan.alpha);
  assert.deepEqual(unresolved.confidenceInterval, { level: .95, lower: 136 / 161, upper: 160 / 161 });
  assert.equal(evaluate(k - 2, n - k + 1, 1).status, 'not-demonstrated');
  const pending = evaluate(k, n - k - 1, 0, 1);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.pValueMin, null);
  assert.equal(pending.confidenceInterval, null);
  assert.throws(() => evaluate(1, 0, 0), /every row/);
});

test('the built-in five-row audit reviews every row and has no sampling uncertainty', () => {
  const plan = planAudit(5, { alpha: .05, floor: .90, designAccuracy: .98, power: .80 });
  assert.deepEqual([plan.sampleSize, plan.criticalCorrect], [5, 5]);
  const verified = evaluateAudit(plan, { correct: 5, incorrect: 0, inconclusive: 0, remaining: 0 });
  assert.deepEqual(verified.confidenceInterval, { level: .95, lower: 1, upper: 1 });
  const unresolved = evaluateAudit(plan, { correct: 4, incorrect: 0, inconclusive: 1, remaining: 0 });
  assert.deepEqual(unresolved.confidenceInterval, { level: .95, lower: .8, upper: 1 });
  assert.equal(unresolved.status, 'inconclusive');
});

test('confidence intervals invert both exact tails, including at discrete confidence cutoffs', () => {
  for (let population = 1; population <= 12; population++) {
    for (let sampleSize = 1; sampleSize <= population; sampleSize++) {
      for (let correct = 0; correct <= sampleSize; correct++) {
        const incorrect = sampleSize - correct;
        const possibleTotals = [];
        for (let total = 0; total <= population; total++) {
          if (referenceTail(population, total, sampleSize, correct) >= .025
              && referenceTail(population, population - total, sampleSize, incorrect) >= .025) {
            possibleTotals.push(total);
          }
        }
        assert.deepEqual(estimateAccuracyInterval(population, { correct, incorrect, inconclusive: 0 }), {
          level: .95, lower: possibleTotals[0] / population, upper: possibleTotals.at(-1) / population,
        });
      }
    }
  }
  assert.deepEqual(estimateAccuracyInterval(40, { correct: 1, incorrect: 0, inconclusive: 0 }), {
    level: .95, lower: .025, upper: 1,
  });
});

test('random sample contains distinct original IDs without changing their input order', () => {
  const ids = Array.from({ length: 100 }, (_, index) => `record-${index}`);
  const first = ids.slice();
  const sample = drawAuditSample(ids, 49);
  assert.equal(sample.length, 49);
  assert.equal(new Set(sample).size, 49);
  assert.ok(sample.every(id => ids.includes(id)));
  assert.deepEqual(ids, first);
  assert.throws(() => drawAuditSample(['same', 'same'], 1), /distinct/);
  assert.throws(() => drawAuditSample(ids, 101), /sample size/);
});

test('invalid test settings are rejected and close rates can require nearly a census', () => {
  assert.throws(() => planAudit(0, { alpha: .05, floor: .90, designAccuracy: .98, power: .80 }), /rows/);
  assert.throws(() => planAudit(10, { alpha: .05, floor: .95, designAccuracy: .90, power: .80 }), /above/);
  assert.throws(() => planAudit(10, { alpha: 0, floor: .90, designAccuracy: .98, power: .80 }), /alpha/);
  const plan = planAudit(25_000, { alpha: .01, floor: .90, designAccuracy: .90004, power: .90 });
  assert.ok(plan.sampleSize > 24_900 && plan.sampleSize <= 25_000);
  assert.deepEqual(estimateAccuracyInterval(25_000, { correct: 0, incorrect: 0, inconclusive: 25_000 }), {
    level: .95, lower: 0, upper: 1,
  });
  assert.throws(() => estimateAccuracyInterval(5, { correct: 6, incorrect: 0, inconclusive: 0 }), /review counts/);
});
