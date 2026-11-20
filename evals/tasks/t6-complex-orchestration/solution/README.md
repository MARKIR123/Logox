# config-auditor

Audits service JSON configuration files against built-in security and reliability rules.

## Usage

```bash
node src/cli.mjs <config.json> [--format text|json|markdown] [--strict]
```

- `--format text|json|markdown`: output format (defaults to `text`).
- `--strict`: fail (non-zero exit code) on `warn`-level findings in addition to `error`-level findings.

## Rule Contract

Each rule module under `src/rules/*.mjs` exports:
- `ruleMeta`: `{ id, severity: 'error' | 'warn', title }`
- `evaluate(config)`: returns `{ passed: boolean, details: string }`
