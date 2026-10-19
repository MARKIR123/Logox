import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, dirname} from 'node:path';

const INITIAL_BULLETIN_TEMPLATE = `# LOGOX Project Bulletin (知识黑板)

This bulletin board is a persistent, shared collaboration and experience-sharing space for all actors (Logox, Techne, Kalon, Aletheia) and developers.
Before executing heavy, frontend, or visual tasks, check this board for tested solutions and environment pitfalls.
When you discover significant environment quirks or successful reusable procedures, append an entry here with your name and timestamp.

## Format
## [YYYY-MM-DD HH:mm] <Actor> · <Topic>
- **Finding/Pitfall**: ...
- **Solution/Standard Procedure**: ...
`;

export async function ensureProjectBulletin(projectDir: string): Promise<string> {
  const bulletinPath = join(projectDir, '.logox', 'bulletin.md');
  try {
    await mkdir(dirname(bulletinPath), {recursive: true});
    if (!existsSync(bulletinPath)) {
      await writeFile(bulletinPath, INITIAL_BULLETIN_TEMPLATE, {encoding: 'utf8', flag: 'wx'});
    }
  } catch {}
  return bulletinPath;
}

export async function appendProjectBulletin(
  projectDir: string,
  author: string,
  topic: string,
  content: string,
): Promise<void> {
  const bulletinPath = await ensureProjectBulletin(projectDir);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const entry = `\n\n## [${timestamp}] ${author} · ${topic}\n${content.trim()}\n`;
  try {
    const existing = await readFile(bulletinPath, 'utf8').catch(() => INITIAL_BULLETIN_TEMPLATE);
    await writeFile(bulletinPath, existing + entry, 'utf8');
  } catch {}
}
