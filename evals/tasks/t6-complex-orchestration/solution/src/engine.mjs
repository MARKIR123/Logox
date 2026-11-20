import * as r01 from './rules/r01-port-range.mjs';
import * as r02 from './rules/r02-host-bind.mjs';
import * as r03 from './rules/r03-tls-prod.mjs';
import * as r04 from './rules/r04-log-level.mjs';
import * as r05 from './rules/r05-timeout-positive.mjs';
import * as r06 from './rules/r06-max-body.mjs';
import * as r07 from './rules/r07-auth-secret.mjs';
import * as r08 from './rules/r08-rate-limit.mjs';
import * as r09 from './rules/r09-db-pool.mjs';
import * as r10 from './rules/r10-cors-origin.mjs';

export const ALL_RULES = [r01, r02, r03, r04, r05, r06, r07, r08, r09, r10];

export function auditConfig(config, options = {}) {
  const strict = Boolean(options.strict);
  const findings = ALL_RULES.map(rule => {
    const out = rule.evaluate(config);
    return {
      id: rule.ruleMeta.id,
      severity: rule.ruleMeta.severity,
      title: rule.ruleMeta.title,
      passed: out.passed,
      details: out.details,
    };
  });
  const errors = findings.filter(f => !f.passed && f.severity === 'error').length;
  const warnings = findings.filter(f => !f.passed && f.severity === 'warn').length;
  const passedCount = findings.filter(f => f.passed).length;
  const passed = strict ? (errors === 0 && warnings === 0) : errors === 0;
  return {
    passed,
    counts: {
      total: findings.length,
      passed: passedCount,
      errors,
      warnings,
    },
    findings,
  };
}
