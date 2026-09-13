/**
 * Seeded PRNG (mulberry32) and bootstrap utilities.
 *
 * mulberry32 is a well-tested, fast 32-bit PRNG with good statistical
 * properties. It is deterministic given the same seed, which satisfies
 * the reproducibility invariant of §6.3.
 *
 * The seed string is hashed to a uint32 via FNV-1a 32-bit to ensure
 * any string seed produces a good distribution of starting states.
 *
 * Reference: https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * Returns a seedable pseudo-random number generator (mulberry32).
 * The returned function produces values in [0, 1).
 */
export function createSeededRng(seed: string): () => number {
  // Hash the seed string to a uint32
  const hash = createHash("sha256").update(seed).digest();
  let state =
    ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>>
    0;

  return function mulberry32(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Bootstrap sampling
// ---------------------------------------------------------------------------

/**
 * Draw one bootstrap resample of indices from [0, n).
 */
export function bootstrapResampleIndices(
  n: number,
  rng: () => number,
): number[] {
  const indices = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    indices[i] = Math.floor(rng() * n);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Normal quantile (probit) — needed for BCa
// ---------------------------------------------------------------------------

/**
 * Rational approximation of the standard normal CDF inverse (probit).
 * Accurate to 4.5e-4 for p in (0, 1).
 * Algorithm: Peter Acklam's method.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError(`normalQuantile: p must be in (0,1), got ${p}`);

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
           ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
           (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
            ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
}

/**
 * Standard normal CDF.
 * Approximation using the Horner method (error < 7.5e-8).
 */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815530 + t * (-0.3565637910 + t * (1.7814779370 + t * (-1.8212559780 + t * 1.3302744290))));
  return x > 0 ? 1 - p : p;
}

// ---------------------------------------------------------------------------
// BCa interval computation
// ---------------------------------------------------------------------------

export interface BcaIntervalResult {
  readonly low: number;
  readonly high: number;
  readonly z0: number;
  readonly accelerationA: number;
  readonly pValueTwoSided: number;
}

/**
 * Compute BCa confidence interval for a statistic theta.
 *
 * @param observed - Observed statistic value on the original sample
 * @param bootstrapThetas - Array of bootstrap statistic values (length = resamples)
 * @param jackknifeMeans - Array of jackknife leave-one-out statistic values (length = n)
 * @param alpha - Significance level (e.g. 0.05 for 95% CI)
 */
export function computeBcaInterval(
  observed: number,
  bootstrapThetas: readonly number[],
  jackknifeMeans: readonly number[],
  alpha: number,
  nullThetas: readonly number[] = bootstrapThetas,
): BcaIntervalResult {
  const B = bootstrapThetas.length;
  const n = jackknifeMeans.length;

  if (B === 0) throw new RangeError("computeBcaInterval: bootstrapThetas must not be empty");
  if (n === 0) throw new RangeError("computeBcaInterval: jackknifeMeans must not be empty");
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`computeBcaInterval: alpha must be finite and in (0,1), got ${alpha}`);
  }
  if (![observed, ...bootstrapThetas, ...jackknifeMeans, ...nullThetas].every(Number.isFinite)) {
    throw new RangeError("computeBcaInterval: all statistic values must be finite");
  }

  // Bias-correction z0: proportion of bootstrap values below observed
  const belowCount = bootstrapThetas.filter((t) => t < observed).length;
  const z0 = normalQuantile(Math.max(1 / (B + 1), Math.min(belowCount / B, B / (B + 1))));

  // Jackknife acceleration a
  const jackMean = jackknifeMeans.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (const jv of jackknifeMeans) {
    const diff = jackMean - jv;
    num += diff ** 3;
    den += diff ** 2;
  }
  const accelerationDenominator = 6 * den ** 1.5;
  if (!Number.isFinite(accelerationDenominator) || !Number.isFinite(num)) {
    throw new RangeError("computeBcaInterval: jackknife acceleration denominator is non-finite");
  }
  const accelerationA = den === 0 ? 0 : num / accelerationDenominator;

  // Adjusted quantiles
  const zAlphaLow = normalQuantile(alpha / 2);
  const zAlphaHigh = normalQuantile(1 - alpha / 2);

  const adjustedDenominatorLow = 1 - accelerationA * (z0 + zAlphaLow);
  const adjustedDenominatorHigh = 1 - accelerationA * (z0 + zAlphaHigh);
  if (![adjustedDenominatorLow, adjustedDenominatorHigh].every(
    (denominator) => Number.isFinite(denominator) && denominator !== 0,
  )) {
    throw new RangeError("computeBcaInterval: adjusted quantile denominator is zero or non-finite");
  }
  const adjustedArgumentLow = z0 + (z0 + zAlphaLow) / adjustedDenominatorLow;
  const adjustedArgumentHigh = z0 + (z0 + zAlphaHigh) / adjustedDenominatorHigh;
  if (![adjustedArgumentLow, adjustedArgumentHigh].every(Number.isFinite)) {
    throw new RangeError("computeBcaInterval: adjusted quantile argument is non-finite");
  }
  const alpha1 = normalCdf(adjustedArgumentLow);
  const alpha2 = normalCdf(adjustedArgumentHigh);

  if (!Number.isFinite(alpha1) || !Number.isFinite(alpha2)) {
    throw new RangeError("computeBcaInterval: adjusted quantile is non-finite");
  }

  const sorted = [...bootstrapThetas].sort((a, b) => a - b);
  const idx1 = Math.max(0, Math.min(B - 1, Math.floor(alpha1 * B)));
  const idx2 = Math.max(0, Math.min(B - 1, Math.floor(alpha2 * B)));

  const low = sorted[idx1]!;
  const high = sorted[idx2]!;

  // Two-sided p-value: proportion of bootstrap deltas >= |observed| or <= -|observed|
  const absObs = Math.abs(observed);
  const nullExtremeCount = nullThetas.filter((t) => Math.abs(t) >= absObs).length;
  const pValueTwoSided = (nullExtremeCount + 1) / (nullThetas.length + 1);

  return { low, high, z0, accelerationA, pValueTwoSided };
}
