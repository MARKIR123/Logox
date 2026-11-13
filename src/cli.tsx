#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {renderTerminal} from './tui/terminal/terminal.js';
import {createDemo} from './demo.js';
import {createApplication} from './application.js';
import {loadConfig} from './config/config.js';
import {App} from './tui/app.js';
import {ApplicationStage} from './tui/application.js';
import {ProviderRegistry} from './providers/registry.js';
import {applyTheme} from './tui/appearance/theme.js';

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const {values} = parseArgs({options: {
    demo: {type: 'boolean'}, help: {type: 'boolean'}, session: {type: 'string'}, resume: {type: 'boolean'},
    model: {type: 'string'}, provider: {type: 'string'}, 'base-url': {type: 'string'}, 'check-config': {type: 'boolean'},
    'check-provider': {type: 'boolean'}, 'list-providers': {type: 'boolean'}, 'list-models': {type: 'boolean'}, 'auth-file': {type: 'string'},
    'install-profiles': {type: 'boolean'}, doctor: {type: 'boolean'},
  }});

  if (values.doctor) {
    const {runDoctorChecks, formatDoctorReport} = await import('./doctor.js');
    const report = runDoctorChecks();
    process.stdout.write(formatDoctorReport(report));
    if (!report.allPassed) process.exitCode = 1;
    return;
  }
  if (values['install-profiles']) {
    const {seedActorProfiles} = await import('./actors/profiles.js');
    const installed = await seedActorProfiles();
    process.stdout.write((installed.length ? 'Installed actor profiles: ' + installed.join(', ') : 'Actor profiles are already installed.') + '\n');
    return;
  }
  if (values.help) {
    process.stdout.write(
      'LOGOX — Terminal AI Subagent Ensemble\n\n' +
      'Usage:\n' +
      '  logox [options]\n\n' +
      'Options:\n' +
      '  --demo                         Run interactive offline ensemble demo\n' +
      '  --doctor                       Diagnose environment, fonts, and credential readiness\n' +
      '  --model <name>                 Specify active model (e.g. deepseek-chat, gpt-4o)\n' +
      '  --provider <name>              Specify provider preset or custom provider name\n' +
      '  --base-url <url>               Override provider API endpoint URL\n' +
      '  --session <id>                 Open or resume a specific session\n' +
      '  --resume                       Resume the most recent session\n' +
      '  --check-config                 Inspect current configuration without exposing secrets\n' +
      '  --check-provider               Send a live verification request to active provider\n' +
      '  --list-providers               List all available providers\n' +
      '  --list-models                  List available models from active provider\n' +
      '  --auth-file <path>             Specify custom read-only credentials file\n' +
      '  --install-profiles             Install default actor profiles into ~/.logox/actors/\n' +
      '  --help                         Show this help message\n'
    );
    return;
  }
  const overrides: Record<string, unknown> = {provider: {
    ...(values.model ? {model: values.model} : {}),
    ...(values.provider ? {name: values.provider} : {}),
    ...(values['base-url'] ? {base_url: values['base-url']} : {}),
    ...(values['auth-file'] ? {auth_file: values['auth-file']} : {}),
  }};
  if (values['check-config'] || values['check-provider'] || values['list-providers'] || values['list-models']) {
    const registry = new ProviderRegistry(await loadConfig(process.cwd(), overrides));
    try {
      await registry.syncCustom().catch(() => {});
      if (values['list-providers']) {
        const providers = registry.names();
        process.stdout.write(providers.join('\n') + '\n');
        const templates = registry.templateNames().filter(name => !providers.includes(name));
        if (templates.length) process.stdout.write('\nTemplates (add with /login):\n' + templates.map(name => '  ' + name).join('\n') + '\n');
      }
      if (values['check-config']) {
        const settings = await registry.settings(false);
        process.stdout.write(JSON.stringify({...registry.selection(), credentialConfigured: !!settings.key}, null, 2) + '\n');
      }
      if (values['list-models']) process.stdout.write((await registry.models()).join('\n') + '\n');
      if (values['check-provider']) process.stdout.write(JSON.stringify({...registry.selection(), ...await registry.check()}, null, 2) + '\n');
    } finally {await registry.close();}
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error('Interactive terminal required. Please run Logox inside Windows Terminal, iTerm2, Alacritty, or Ghostty.');
  if (values.session !== undefined && !values.session.trim()) throw new Error('--session requires a valid session ID');
  const demo = values.demo ? createDemo(values.session?.trim() ?? 'demo', process.cwd()) : undefined;
  if (demo) await demo.ready;
  const loadedConfig = await loadConfig(process.cwd(), overrides);
  applyTheme(loadedConfig.theme);
  const application = demo ? undefined : await createApplication({cwd: process.cwd(), config: loadedConfig,
    ...(values.session ? {sessionId: values.session} : {}), ...(values.resume ? {resume: true} : {})});
  const runtime = demo ?? application!;
  const interrupts = new Set<() => void>();
  const registerInterrupt = (handler: () => void) => {interrupts.add(handler); return () => {interrupts.delete(handler);};};
  const instance = renderTerminal(demo ? <App store={demo.store} sessionId={values.session ?? 'demo'} demoScene scenario={demo.scenario}
    onSubmit={demo.submit} onDraft={demo.noteDraft} onCancel={demo.cancel} onClose={demo.close} registerInterrupt={registerInterrupt}/> : <ApplicationStage application={application!} registerInterrupt={registerInterrupt}/>, {
    alternateScreen: true, incrementalRendering: true, maxFps: 60, exitOnCtrlC: false,
  });
  const stop = () => {void runtime.close().finally(() => instance.unmount());};
  const interrupt = () => {for (const handler of interrupts) handler();};
  process.once('SIGTERM', stop);
  process.on('SIGINT', interrupt);
  // Leaves the alternate screen before reporting, so a fatal error or a silently drained event loop is visible instead of vanishing with the UI.
  let finished = false;
  const fatal = (reason: string) => () => {
    try {instance.unmount();} catch {/* the screen is being torn down anyway */}
    process.stderr.write(`[Logox] ${reason}
`); process.exitCode = 1;
  };
  const onBeforeExit = () => {if (!finished) fatal('Terminal input ended unexpectedly; exiting.')();};
  const onUncaught = (error: unknown) => {fatal(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)(); process.exit(1);};
  process.once('beforeExit', onBeforeExit);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  try {await instance.waitUntilExit();}
  finally {
    finished = true;
    for (const [name, handler] of [['beforeExit', onBeforeExit], ['uncaughtException', onUncaught], ['unhandledRejection', onUncaught]] as const) process.removeListener(name, handler as () => void);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt); await runtime.close();
  }
}
await main().catch(error => {process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1;});
