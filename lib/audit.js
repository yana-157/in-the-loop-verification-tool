/** Accuracy tests and confidence intervals for a frozen spreadsheet sampled without replacement. */

function hypergeometricUpperTail(population) {
  const logFactorial = new Float64Array(population + 1);
  for (let i = 2; i <= population; i++) logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  const choose = (n, k) => logFactorial[n] - logFactorial[k] - logFactorial[n - k];

  // Sum away from the mode toward the smaller tail. The ratio recurrence avoids
  // underflow from initializing at an extreme support point and walking inward.
  return (totalsCorrect, sampleSize, correctAtLeast) => {
    const totalsIncorrect = population - totalsCorrect;
    const first = Math.max(0, sampleSize - totalsIncorrect);
    const last = Math.min(sampleSize, totalsCorrect);
    if (correctAtLeast <= first) return 1;
    if (correctAtLeast > last) return 0;
    const mode = Math.floor((sampleSize + 1) * (totalsCorrect + 1) / (population + 2));
    const complement = correctAtLeast <= mode;
    let correct = complement ? correctAtLeast - 1 : correctAtLeast;
    let term = Math.exp(choose(totalsCorrect, correct) + choose(totalsIncorrect, sampleSize - correct)
      - choose(population, sampleSize));
    let sum = term;
    if (complement) {
      for (; correct > first && term > sum * Number.EPSILON; correct--) {
        term *= correct * (totalsIncorrect - sampleSize + correct)
          / ((totalsCorrect - correct + 1) * (sampleSize - correct + 1));
        sum += term;
      }
    } else {
      for (; correct < last && term > sum * Number.EPSILON; correct++) {
        term *= (totalsCorrect - correct) * (sampleSize - correct)
          / ((correct + 1) * (totalsIncorrect - sampleSize + correct + 1));
        sum += term;
      }
    }
    return Math.min(1, Math.max(0, complement ? 1 - sum : sum));
  };
}

function atMost(probability, limit) {
  // The factorial log differences accumulate rounding error on large sheets.
  return probability <= limit * (1 + 3e-10);
}

function stableCount(rate, population) {
  const product = rate * population;
  const whole = Math.round(product);
  return Math.abs(product - whole) <= 4 * Number.EPSILON * product ? whole : product;
}

function checkPopulation(population) {
  if (!Number.isSafeInteger(population) || population < 1 || population > 25_000) {
    throw new Error('Use a spreadsheet of 1 to 25,000 rows for the accuracy test.');
  }
}

/** Choose the smallest fixed sample that meets both the risk and power constraints. */
export function planAudit(population, { alpha, floor, designAccuracy, power }) {
  checkPopulation(population);
  if (![alpha, floor, designAccuracy, power].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      || alpha <= 0 || alpha >= power || floor >= designAccuracy) {
    throw new Error('Choose an alpha above 0, power higher than alpha, and design accuracy above the accuracy floor.');
  }
  // Stabilize conversions at exact integer boundaries after decimal input.
  const nullCorrect = Math.floor(stableCount(floor, population));
  const designCorrect = Math.ceil(stableCount(designAccuracy, population));
  if (designCorrect <= nullCorrect) throw new Error('Raise the design accuracy for this population size.');
  const upperTail = hypergeometricUpperTail(population);
  let criticalCorrect = 1;
  for (let sampleSize = 1; sampleSize <= population; sampleSize++) {
    let typeIError = upperTail(nullCorrect, sampleSize, criticalCorrect);
    // Adding one draw can move the smallest valid rejection threshold by at most one.
    if (!atMost(typeIError, alpha)) typeIError = upperTail(nullCorrect, sampleSize, ++criticalCorrect);
    const achievedPower = upperTail(designCorrect, sampleSize, criticalCorrect);
    const meetsPower = power === 1 ? criticalCorrect <= sampleSize - (population - designCorrect)
      : atMost(power, achievedPower);
    if (criticalCorrect <= sampleSize && meetsPower) {
      return { population, alpha, floor, designAccuracy, power, nullCorrect, designCorrect,
        effectiveNullAccuracy: nullCorrect / population, effectiveDesignAccuracy: designCorrect / population,
        sampleSize, criticalCorrect, typeIError, achievedPower };
    }
  }
  throw new Error('Could not find a sample that meets the accuracy test settings.');
}

/** Make a uniform sample without replacement using rejection-sampled browser randomness. */
export function drawAuditSample(ids, size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > ids.length || new Set(ids).size !== ids.length) {
    throw new Error('The audit needs distinct row IDs and a valid sample size.');
  }
  const rows = [...ids];
  const word = new Uint32Array(1);
  const range = 2 ** 32;
  for (let i = 0; i < size; i++) {
    const width = rows.length - i;
    const limit = range - range % width;
    do globalThis.crypto.getRandomValues(word); while (word[0] >= limit);
    const other = i + word[0] % width;
    [rows[i], rows[other]] = [rows[other], rows[i]];
  }
  return rows.slice(0, size);
}

function lowerConfidenceTotal(population, sampleSize, observed, tailCutoff, upperTail) {
  let first = observed;
  let last = population - sampleSize + observed;
  // The upper tail increases with the total. Include equality at the cutoff
  // so rounding at a discrete boundary can only widen the interval.
  while (first < last) {
    const candidate = Math.floor((first + last) / 2);
    if (atMost(tailCutoff, upperTail(candidate, sampleSize, observed))) last = candidate;
    else first = candidate + 1;
  }
  return first;
}

/** Estimate whole-sheet accuracy after every sampled row has a binary outcome. */
export function estimateAccuracyInterval(population, { correct, incorrect, inconclusive }, level = .95,
  { countInconclusiveAsWrong = false } = {}) {
  checkPopulation(population);
  const counts = [correct, incorrect, inconclusive];
  const sampleSize = correct + incorrect + inconclusive;
  if (!counts.every(count => Number.isSafeInteger(count) && count >= 0)
      || sampleSize < 1 || sampleSize > population) {
    throw new Error('Use a valid set of completed review counts for the confidence interval.');
  }
  if (!Number.isFinite(level) || level <= 0 || level >= 1) {
    throw new Error('Set a confidence level between 0 and 1.');
  }
  if (inconclusive > 0 && countInconclusiveAsWrong !== true) return null;
  const upperTail = hypergeometricUpperTail(population);
  const tailCutoff = (1 - level) / 2;
  const lower = lowerConfidenceTotal(population, sampleSize, correct, tailCutoff, upperTail);
  const upper = population - lowerConfidenceTotal(population, sampleSize, incorrect + inconclusive, tailCutoff, upperTail);
  return { level, lower: lower / population, upper: upper / population };
}

/** Defer results until each sampled row is resolved or explicitly counted as wrong. */
export function evaluateAudit(plan, { correct, incorrect, inconclusive, remaining },
  { countInconclusiveAsWrong = false } = {}) {
  const counts = { correct, incorrect, inconclusive, remaining };
  const values = Object.values(counts);
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)
      || values.reduce((sum, value) => sum + value, 0) !== plan.sampleSize) {
    throw new Error('Review counts must account for every row in the fixed sample.');
  }
  const appliesAssumption = inconclusive > 0 && countInconclusiveAsWrong === true;
  if (remaining || (inconclusive > 0 && !appliesAssumption)) {
    return { status: remaining ? 'pending' : 'needs-review', ...counts,
      countInconclusiveAsWrong: false, pValueMin: null, pValueMax: null, confidenceInterval: null };
  }
  const upperTail = hypergeometricUpperTail(plan.population);
  const pValue = upperTail(plan.nullCorrect, plan.sampleSize, correct);
  const status = atMost(pValue, plan.alpha) ? 'pass' : 'not-demonstrated';
  const confidenceInterval = estimateAccuracyInterval(plan.population, counts, .95,
    { countInconclusiveAsWrong: appliesAssumption });
  return { status, ...counts, countInconclusiveAsWrong: appliesAssumption,
    pValueMin: pValue, pValueMax: pValue, confidenceInterval };
}
