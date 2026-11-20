# config-auditor

Audits service JSON configuration files against built-in security and reliability rules.

## Usage

```bash
node src/cli.mjs <config.json>
```

Prints a plain-text summary of rule checks and exits non-zero when any `error`-level rule fails.
