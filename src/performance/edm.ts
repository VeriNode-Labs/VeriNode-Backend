/**
 * VeriNode Backend — E-Divisive with Medians (EDM) Change Point Detection
 *
 * Implements the EDM algorithm for detecting statistically significant
 * change points in a univariate time series.
 *
 * Algorithm overview:
 *   1. Compute the energy statistic for every candidate split point.
 *   2. Select the split that maximises the energy.
 *   3. Accept the split only if the energy exceeds a significance
 *      threshold (alpha * series length).
 *   4. Recurse on each resulting segment.
 *
 * Reference:
 *   James & Matteson (2013) — ecp: An R Package for Nonparametric
 *   Multiple Change Point Analysis of Multivariate Data.
 */

/**
 * Compute the median of an array of numbers.
 * The input array must not be empty.
 */
export function median(arr: number[]): number {
  if (arr.length === 0) throw new Error('Cannot compute median of empty array');
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Compute the Energy statistic between two independent samples x and y.
 *
 * E(x,y) = (2/(n*m)) * Σ|x_i - y_j| - (1/n^2) * Σ|x_i - x_j| - (1/m^2) * Σ|y_i - y_j|
 *
 * Uses the median-based approximation for O(n log n) performance:
 * replaces the double-sum pairwise distances with median absolute deviations.
 */
export function energyStatistic(x: number[], y: number[]): number {
  if (x.length === 0 || y.length === 0) return 0;

  const n = x.length;
  const m = y.length;

  // Cross-sample mean absolute distance: use all pairs when both samples
  // are small (<= 100 points), otherwise fall back to median estimator.
  let crossDist: number;
  if (n * m <= 10_000) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        sum += Math.abs(x[i] - y[j]);
      }
    }
    crossDist = sum / (n * m);
  } else {
    // Median-based approximation
    const medX = median(x);
    const medY = median(y);
    crossDist = Math.abs(medX - medY);
  }

  // Within-sample dispersion
  const dispX = withinDispersion(x);
  const dispY = withinDispersion(y);

  return 2 * crossDist - dispX - dispY;
}

/** Mean absolute pairwise distance within a sample (O(n²) for small n). */
function withinDispersion(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const n = arr.length;
  if (n <= 200) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        sum += Math.abs(arr[i] - arr[j]);
      }
    }
    return (2 * sum) / (n * n);
  }
  // For larger samples use MAD around median as approximation.
  const med = median(arr);
  const mad = median(arr.map((v) => Math.abs(v - med)));
  return mad;
}

/**
 * Find change points in a univariate time series using EDM.
 *
 * @param series   The time series (must be in chronological order).
 * @param minSize  Minimum segment size (default: 5).
 * @param alpha    Significance scale factor (default: 1.0).
 *                 Higher = fewer change points detected.
 * @returns Sorted array of change-point indices (split positions).
 */
export function findChangePoints(
  series: number[],
  minSize = 5,
  alpha = 1.0,
): number[] {
  const results: number[] = [];
  searchSegment(series, 0, series.length, minSize, alpha, results);
  return results.sort((a, b) => a - b);
}

/**
 * Recursively search a segment [start, end) for the best split.
 */
function searchSegment(
  series: number[],
  start: number,
  end: number,
  minSize: number,
  alpha: number,
  results: number[],
): void {
  const segLen = end - start;
  if (segLen < 2 * minSize) return;

  let bestSplit = -1;
  let bestEnergy = -Infinity;

  for (let split = start + minSize; split <= end - minSize; split++) {
    const left = series.slice(start, split);
    const right = series.slice(split, end);
    const e = energyStatistic(left, right);
    if (e > bestEnergy) {
      bestEnergy = e;
      bestSplit = split;
    }
  }

  if (bestSplit === -1) return;

  // Significance threshold scales with segment length.
  const threshold = alpha * Math.sqrt(segLen);
  if (bestEnergy < threshold) return;

  results.push(bestSplit);

  // Recurse on each sub-segment.
  searchSegment(series, start, bestSplit, minSize, alpha, results);
  searchSegment(series, bestSplit, end, minSize, alpha, results);
}
