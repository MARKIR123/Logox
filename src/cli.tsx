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
    'install-profiles': {type: 'boolean'},
  }});

  if (values['install-profiles']) {
    const {seedActorProfiles} = await import('./actors/profiles.js');
    const installed = await seedActorProfiles();
    process.stdout.write((installed.length ? 'Installed actor profiles: ' + installed.join(', ') : 'Actor profiles are already installed.') + '\n');
    return;
  }
  if (values.help) {
    process.stdout.write('LOGOX TS\n  npm run build && npm start     真实模型与工具，全屏舞台\n  npm run demo                   独立演示\n  --model <名称>                 选择模型\n  --provider <名称>              选择接口预设或自定义 provider\n  --base-url <HTTP(S)地址>       覆盖模型接口地址\n  --session <id>                 指定会话（存在时恢复）\n  --resume                       恢复上次会话\n  --check-config                 检查配置，不显示密钥\n  --auth-file <路径>             只读 pi API key 认证文件\n  --list-providers               列出提供商\n  --list-models                  查询当前提供商模型\n  --check-provider               请求真实模型并检查完整回复\n');
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
      if (values['list-providers']) process.stdout.write(registry.names().join('\n') + '\n');
      if (values['check-config']) {
        const settings = await registry.settings(false);
        process.stdout.write(JSON.stringify({...registry.selection(), credentialConfigured: !!settings.key}, null, 2) + '\n');
      }
      if (values['list-models']) process.stdout.write((await registry.models()).join('\n') + '\n');
      if (values['check-provider']) process.stdout.write(JSON.stringify({...registry.selection(), ...await registry.check()}, null, 2) + '\n');
    } finally {await registry.close();}
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error('全屏界面需要交互终端。请在 Windows Terminal 中运行 npm start 或 npm run demo。');
  if (values.session !== undefined && !values.session.trim()) throw new Error('--session 需要有效会话 ID');
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
  try {await instance.waitUntilExit();}
  finally {process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt); await runtime.close();}
}
await main().catch(error => {process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1;});
