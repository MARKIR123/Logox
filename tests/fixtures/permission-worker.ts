import {PermissionEngine} from '../../src/permissions/engine.js';
import {withFileLock} from '../../src/store/file-lock.js';
import {join} from 'node:path';

const root = process.argv[2]!, operation = process.argv[3]!, value = process.argv[4]!;
const engine = new PermissionEngine(root);
await engine.load();
process.send?.({kind: 'ready'});
process.once('message', () => {
  void (async () => {
    if (operation === 'hold') await withFileLock(join(root, '.logox', 'permissions.json'), async () => {
      process.send?.({kind: 'locked'});
      // IPC 保持进程存活；父测试中断进程来覆盖真正遗留锁。
      process.on('message', () => {});
      await new Promise<void>(() => {});
    });
    else if (operation === 'revoke') await engine.revoke(value);
    else await engine.add({scope: 'project', decision: 'allow', tool: 'write', pattern: value});
  })().then(() => {process.send?.({kind: 'done'}); process.disconnect();}, error => {
    process.send?.({kind: 'error', message: error instanceof Error ? error.message : String(error)});
    process.exitCode = 1; process.disconnect();
  });
});
