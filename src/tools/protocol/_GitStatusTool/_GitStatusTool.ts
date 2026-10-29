import {promisify} from 'node:util';
import {execFile as execFileCb} from 'node:child_process';
import {z} from 'zod';
import type {ToolResult} from '../../types.js';

const execFile = promisify(execFileCb);

export const gitStatusSchema = z.strictObject({
  mode: z.enum(['compact', 'detailed']).optional().describe('Reporting mode: "compact" (summary line and top changes) or "detailed" (full porcelain output). Defaults to "compact"'),
  path: z.string().optional().describe('Optional relative path or directory to filter git status for'),
});

export type GitStatusArgs = z.infer<typeof gitStatusSchema>;

export async function executeGitStatus(args: GitStatusArgs, cwd: string): Promise<ToolResult> {
  try {
    const branchRes = await execFile('git', ['branch', '--show-current'], {cwd, timeout: 5000}).catch(() => null);
    if (!branchRes) {
      return {text: 'Not a git repository (or git command unavailable)', isError: false};
    }

    const branchName = branchRes.stdout.trim() || 'detached';
    const statusArgs = ['status', '--porcelain'];
    if (args.path) {
      statusArgs.push('--', args.path);
    }

    const {stdout: statusOut} = await execFile('git', statusArgs, {cwd, timeout: 5000}).catch(() => ({stdout: ''}));
    const lines = statusOut.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      return {text: `Branch ${branchName} (clean working tree)`, isError: false};
    }

    if (args.mode === 'detailed') {
      return {
        text: `Branch ${branchName} (${lines.length} uncommitted changes):\n${statusOut.trim()}`,
        isError: false,
      };
    }

    // Default: compact
    const topLines = lines.slice(0, 10).map(l => '  ' + l).join('\n');
    const remaining = lines.length > 10 ? `\n  ... and ${lines.length - 10} more` : '';
    return {
      text: `Branch ${branchName} (${lines.length} uncommitted changes):\n${topLines}${remaining}`,
      isError: false,
    };
  } catch (error) {
    return {
      text: `Failed to inspect git status: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: '_GitStatus', category: 'protocol', roles: 'all', terminalVisibility: 'silent', description: 'Fetch current Git branch, tracking status, and clean/dirty working tree state on demand'};
