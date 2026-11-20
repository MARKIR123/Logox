export function formatTextReport(audit) {
  return audit.findings
    .map(item => {
      const mark = item.passed ? 'PASS' : item.severity.toUpperCase();
      return `[${mark}] ${item.id} ${item.title}: ${item.details}`;
    })
    .join('\n') + '\n';
}

export function formatJsonReport(audit) {
  return JSON.stringify(audit, null, 2) + '\n';
}

export function formatMarkdownReport(audit) {
  const lines = [
    '# Configuration Audit Report',
    '',
    `- Status: **${audit.passed ? 'PASS' : 'FAIL'}**`,
    `- Summary: ${audit.counts.passed}/${audit.counts.total} passed, ${audit.counts.errors} error(s), ${audit.counts.warnings} warning(s)`,
    '',
    '| ID | Severity | Title | Result | Details |',
    '|---|---|---|---|---|',
  ];
  for (const f of audit.findings) {
    lines.push(`| ${f.id} | ${f.severity} | ${f.title} | ${f.passed ? 'PASS' : 'FAIL'} | ${f.details} |`);
  }
  lines.push('');
  return lines.join('\n');
}
