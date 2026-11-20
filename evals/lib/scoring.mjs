const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function budgetScore(actual, budget, maxPoints) {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || typeof budget !== 'number' || budget <= 0) {
    return 0;
  }
  const ratio = actual / budget;
  if (ratio <= 0.5) return maxPoints;
  if (ratio <= 1.0) return maxPoints * (1 - 0.4 * ((ratio - 0.5) / 0.5));
  if (ratio >= 2.0) return 0;
  return maxPoints * 0.6 * (1 - (ratio - 1.0));
}

/**
 * Computes a 0-100 composite score for a single task evaluation run:
 * - outcome (40): check pass & sub-check ratio
 * - chain (10): completion status + director/automa expectation alignment
 * - cache (20): cacheReadTokens / inputTokens (full 20 at >= 90%)
 * - cost (10): costUsd vs meta.expect.maxCostUsd
 * - tokens (10): total tokens vs token budget derived from maxCostUsd
 * - orchestration (5): brief check discipline when dispatching
 * - speed (5): wall/headless duration vs meta.timeoutMinutes
 */
export function computeCompositeScore({meta, checkResult, headless, session, durationMs}) {
  const expect = meta.expect ?? {};
  const checks = Array.isArray(checkResult?.checks) ? checkResult.checks : [];
  const passedCount = checks.filter(c => c.pass === true).length;
  const checkRatio = checks.length > 0 ? passedCount / checks.length : 0;

  // 1. Outcome (40 pts)
  const outcome = checkResult?.pass === true ? 40 : 20 * checkRatio;

  // 2. Chain compliance (10 pts)
  let chain = 0;
  if (headless?.status === 'completed') chain += 4;

  const dispatches = session?.dispatches ?? null;
  if (expect.director === 'any' || expect.director === undefined) {
    chain += 3;
  } else if (expect.director === 'direct') {
    if (dispatches === 0) chain += 3;
  } else if (expect.director === 'dispatch') {
    if (dispatches !== null && dispatches > 0) chain += 3;
  }

  const automaJobs = session?.automa?.jobs ?? headless?.automa?.jobs ?? null;
  if (expect.automa === 'any' || expect.automa === undefined) {
    chain += 3;
  } else if (expect.automa === 'expected') {
    if (automaJobs !== null && automaJobs > 0) chain += 3;
  } else if (expect.automa === 'unexpected') {
    if (automaJobs === 0) chain += 3;
  }

  // 3. Cache hit rate (20 pts, full marks at >= 90%)
  const usage = headless?.usage ?? {};
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : null;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : null;
  const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : null;
  const cacheRate = inputTokens && inputTokens > 0 && cacheReadTokens !== null
    ? clamp(cacheReadTokens / inputTokens, 0, 1)
    : null;
  const cache = cacheRate !== null ? 20 * clamp(cacheRate / 0.9, 0, 1) : 0;

  // 4. Cost efficiency (10 pts)
  const maxCost = typeof expect.maxCostUsd === 'number' ? expect.maxCostUsd : 0.5;
  const cost = budgetScore(usage.costUsd, maxCost, 10);

  // 5. Token consumption efficiency (10 pts)
  const tokenBudget = typeof expect.maxTokens === 'number' ? expect.maxTokens : maxCost * 1_500_000;
  const totalTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const tokens = budgetScore(totalTokens, tokenBudget, 10);

  // 6. Orchestration / Brief check discipline (5 pts)
  let orchestration = 0;
  if (session) {
    if (session.dispatches === 0) {
      orchestration = 5;
    } else {
      const bc = session.briefChecks ?? {clear: 0, skipped: 0, failed: 0, gaps: 0};
      const totalBc = bc.clear + bc.skipped + bc.failed + bc.gaps;
      if (totalBc === 0) {
        orchestration = expect.briefCheck === 'expected' ? 1 : 4;
      } else {
        const pts = bc.clear * 5 + bc.skipped * (expect.briefCheck === 'expected' ? 1 : 2) + bc.gaps * 2 + bc.failed * 1;
        orchestration = pts / totalBc;
      }
    }
  }

  // 7. Speed (5 pts)
  const timeoutMs = (typeof meta.timeoutMinutes === 'number' ? meta.timeoutMinutes : 15) * 60_000;
  let speed = 0;
  if (typeof durationMs === 'number' && durationMs >= 0) {
    const ratio = durationMs / timeoutMs;
    if (ratio <= 0.35) speed = 5;
    else if (ratio <= 0.8) speed = 5 - 3 * ((ratio - 0.35) / 0.45);
    else if (ratio < 1.0) speed = 2 * ((1.0 - ratio) / 0.2);
  }

  const breakdown = {
    outcome: Number(outcome.toFixed(1)),
    chain: Number(chain.toFixed(1)),
    cache: Number(cache.toFixed(1)),
    cost: Number(cost.toFixed(1)),
    tokens: Number(tokens.toFixed(1)),
    orchestration: Number(orchestration.toFixed(1)),
    speed: Number(speed.toFixed(1)),
  };
  const total = Number(clamp(
    outcome + chain + cache + cost + tokens + orchestration + speed,
    0,
    100
  ).toFixed(1));

  return {total, breakdown};
}
