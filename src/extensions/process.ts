import {spawn, type ChildProcess} from 'node:child_process';

/** 等待 close，确保取消和关闭不会遗留扩展进程。 */
export async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    await new Promise<void>(resolve => {
      killer.once('error', () => {child.kill(); resolve();});
      killer.once('close', code => {if (code) child.kill(); resolve();});
    });
  } else {try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
  await closed;
}
