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

test('inconclusive source evidence defers results unless explicitly counted as wrong', () => {
  const plan = planAudit(161, { alpha: .05, floor: .90, designAccuracy: .98, power: .80 });
  const { sampleSize: n, criticalCorrect: k } = plan;
  assert.deepEqual([n, k], [39, 38]);
  const evaluate = (correct, incorrect, inconclusive, remaining = 0, options) =>
    evaluateAudit(plan, { correct, incorrect, inconclusive, remaining }, options);
  const countAsWrong = { countInconclusiveAsWrong: true };
  const complete = evaluate(k, n - k, 0);
  assert.equal(complete.status, 'pass');
  assert.equal(complete.countInconclusiveAsWrong, false);
  assert.deepEqual(complete.confidenceInterval, { level: .95, lower: 142 / 161, upper: 160 / 161 });
  const unresolved = evaluate(k, n - k - 1, 1);
  assert.equal(unresolved.status, 'needs-review');
  assert.equal(unresolved.countInconclusiveAsWrong, false);
  assert.equal(unresolved.pValueMin, null);
  assert.equal(unresolved.pValueMax, null);
  assert.equal(unresolved.confidenceInterval, null);
  const passWithAssumption = evaluate(k, n - k - 1, 1, 0, countAsWrong);
  assert.equal(passWithAssumption.status, 'pass');
  assert.equal(passWithAssumption.countInconclusiveAsWrong, true);
  assert.equal(passWithAssumption.inconclusive, 1);
  assert.equal(passWithAssumption.incorrect, 0);
  assert.equal(passWithAssumption.pValueMin, complete.pValueMin);
  assert.equal(passWithAssumption.pValueMax, complete.pValueMax);
  assert.deepEqual(passWithAssumption.confidenceInterval, complete.confidenceInterval);
  const verifiedFailure = evaluate(k - 1, n - k + 1, 0);
  const failureWithAssumption = evaluate(k - 1, n - k, 1, 0, countAsWrong);
  assert.equal(verifiedFailure.status, 'not-demonstrated');
  assert.equal(failureWithAssumption.status, verifiedFailure.status);
  assert.deepEqual(failureWithAssumption.confidenceInterval, verifiedFailure.confidenceInterval);
  const pending = evaluate(k - 1, n - k - 1, 1, 1, countAsWrong);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.countInconclusiveAsWrong, false);
  assert.equal(pending.pValueMin, null);
  assert.equal(pending.confidenceInterval, null);
  assert.throws(() => evaluate(1, 0, 0), /every row/);
});

test('the built-in five-row audit reviews every row and has no sampling uncertainty', () => {
  const plan = planAudit(5, { alpha: .05, floor: .90, designAccuracy: .98, power: .80 });
  assert.deepEqual([plan.sampleSize, plan.criticalCorrect], [5, 5]);
  const verified = evaluateAudit(plan, { correct: 5, incorrect: 0, inconclusive: 0, remaining: 0 });
  assert.deepEqual(verified.confidenceInterval, { level: .95, lower: 1, upper: 1 });
  const counts = { correct: 4, incorrect: 0, inconclusive: 1, remaining: 0 };
  const unresolved = evaluateAudit(plan, counts);
  assert.equal(unresolved.confidenceInterval, null);
  assert.equal(unresolved.status, 'needs-review');
  const counted = evaluateAudit(plan, counts, { countInconclusiveAsWrong: true });
  assert.deepEqual(counted.confidenceInterval, { level: .95, lower: .8, upper: .8 });
  assert.equal(counted.status, 'not-demonstrated');
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
  const unresolved = { correct: 0, incorrect: 0, inconclusive: 25_000 };
  assert.equal(estimateAccuracyInterval(25_000, unresolved), null);
  assert.deepEqual(estimateAccuracyInterval(25_000, unresolved, .95, { countInconclusiveAsWrong: true }), {
    level: .95, lower: 0, upper: 0,
  });
  assert.throws(() => estimateAccuracyInterval(5, { correct: 6, incorrect: 0, inconclusive: 0 }), /review counts/);
});
