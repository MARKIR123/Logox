import {lstat, readFile, readdir, mkdir, open, link, rename, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {immutable} from '../runtime/contracts.js';
import {withFileLock} from '../store/file-lock.js';
import {builtinActors} from './builtins.js';
import {actorIdSchema, parseActor, parseActorProfile, serializeActor, mergeActorPromptLayer, type ActorDefinition} from './definitions.js';
import {ActorModelStorage} from './actor-models-storage.js';
import {refreshShippedCompression} from './compression-migration.js';

export interface ActorIssue {readonly path: string; readonly reason: string}
export interface ActorSnapshot {readonly definitions: readonly ActorDefinition[]; readonly issues: readonly ActorIssue[]; readonly revision: number}
export interface ActorCatalogOptions {home?: string}
export async function assertActorPath(path: string): Promise<void> {
  let current = resolve(path);
  if (current.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy')) throw new Error('legacy paths are not loaded');
  for (;;) {
    try {if ((await lstat(current)).isSymbolicLink()) throw new Error('Actor paths must not be symbolic links');}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function readOptionalProfile(path: string): Promise<Buffer | undefined> {
  try {
    await assertActorPath(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid profile file or exceeds 64 KiB: ' + path);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class ActorCatalog {
  private value: ActorSnapshot = immutable({definitions: builtinActors, issues: [], revision: 0});
  readonly modelStorage: ActorModelStorage;
  constructor(readonly cwd: string, readonly options: ActorCatalogOptions = {}) {
    const home = options.home ?? homedir();
    this.modelStorage = new ActorModelStorage(join(home, '.logox', 'actor-models.json'));
  }
  snapshot(): ActorSnapshot {return this.value;}
  list(): readonly ActorDefinition[] {return this.value.definitions;}
  find(id: string): ActorDefinition | undefined {return this.list().find(actor => actor.id === id);}
  projectPath(id: string): string {return join(resolve(this.cwd), '.logox', 'actors', actorIdSchema.parse(id) + '.md');}
  async load(): Promise<ActorSnapshot> {return this.reload();}
  async reload(): Promise<ActorSnapshot> {
    const definitions = new Map(builtinActors.map(actor => [actor.id, actor])), issues: ActorIssue[] = [];
    const home = this.options.home ?? homedir();
    const directories = [
      join(home, '.logox', 'actors'),
      join(this.cwd, '.logox', 'actors'),
    ];
    for (const directory of [...new Set(directories)]) {
      try {
        await assertActorPath(directory);
        const entries = await readdir(directory, {withFileTypes: true});
        if (entries.length > 256) throw new Error('Actor directory has more than 256 entries');
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            const path = join(directory, entry.name);
            try {
              await assertActorPath(path);
              const stat = await lstat(path);
              if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Not a regular file or exceeds 64 KiB');
              const actor = parseActor(new TextDecoder('utf-8', {fatal: true}).decode(await readFile(path)));
              if (basename(path, '.md') !== actor.id) throw new Error('File name must match the actor id');
              definitions.set(actor.id, definitions.has(actor.id) ? mergeActorPromptLayer(definitions.get(actor.id)!, actor) : actor);
            } catch (error) {issues.push({path, reason: error instanceof Error ? error.message : 'Load failed'});}
            continue;
          }
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.')) continue;
            const actorDir = join(directory, entry.name);
            try {
              await assertActorPath(actorDir);
              let configPath = join(actorDir, 'config.yaml');
              let configRaw: Buffer | undefined;
              try {
                configRaw = await readFile(configPath);
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                  configPath = join(actorDir, 'config.yml');
                  try {configRaw = await readFile(configPath);}
                  catch (e2) {
                    if ((e2 as NodeJS.ErrnoException).code === 'ENOENT') continue;
                    throw e2;
                  }
                } else throw e;
              }
              await assertActorPath(configPath);
              if ((await lstat(configPath)).size > 64 * 1024) throw new Error('config.yaml exceeds 64 KiB');
              const personaPath = join(actorDir, 'persona.md');
              await assertActorPath(personaPath);
              const personaStat = await lstat(personaPath);
              if (!personaStat.isFile() || personaStat.size > 64 * 1024) throw new Error('persona.md is missing or exceeds 64 KiB');
              const personaRaw = await readFile(personaPath);
              const compressionPath = join(actorDir, 'compression.md');
              const [compressionRaw, executionRaw, collaborationRaw] = await Promise.all([
                readOptionalProfile(compressionPath), readOptionalProfile(join(actorDir, 'execution.md')),
                readOptionalProfile(join(actorDir, 'collaboration.md')),
              ]);
              const decoder = new TextDecoder('utf-8', {fatal: true});
              const config = decoder.decode(configRaw);
              const persona = decoder.decode(personaRaw);
              let compression = compressionRaw ? decoder.decode(compressionRaw) : undefined;
              const execution = executionRaw ? decoder.decode(executionRaw) : undefined;
              const collaboration = collaborationRaw ? decoder.decode(collaborationRaw) : undefined;
              let actor = parseActorProfile({config, persona, compression, execution, collaboration});
              if (entry.name !== actor.id) throw new Error('Directory name must match the actor id');
              if (compression !== undefined) {
                await refreshShippedCompression(compressionPath, actor.id, compression);
                await assertActorPath(compressionPath);
                try {compression = decoder.decode(await readFile(compressionPath));}
                catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; compression = undefined;}
                actor = parseActorProfile({config, persona, compression, execution, collaboration});
              }
              definitions.set(actor.id, definitions.has(actor.id) ? mergeActorPromptLayer(definitions.get(actor.id)!, actor) : actor);
            } catch (error) {
              issues.push({path: actorDir, reason: error instanceof Error ? error.message : 'Load failed'});
            }
          }
        }
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({path: directory, reason: error instanceof Error ? error.message : 'Scan failed'});}
    }
    const userModels = this.modelStorage.loadSync();
    for (const [id, model] of Object.entries(userModels)) {
      const def = definitions.get(id);
      if (def) {
        definitions.set(id, {...def, defaultModel: model});
      }
    }
    this.value = immutable({definitions: issues.length ? this.value.definitions : [...definitions.values()], issues,
      revision: this.value.revision + (issues.length ? 0 : 1)});
    return this.value;
  }
  /** expected is the original text seen at approval; overwriting after a concurrent edit is rejected. undefined allows creation only. */
  async writeProject(id: string, content: string, expected?: string): Promise<string> {
    const path = this.projectPath(id); await assertActorPath(path);
    return withFileLock(path, () => this.commitProject(id, content, expected));
  }
  private async commitProject(id: string, content: string, expected?: string): Promise<string> {
    const actor = parseActor(content); if (actor.id !== id) throw new Error('Actor id mismatch');
    const path = this.projectPath(id); await assertActorPath(path);
    await mkdir(dirname(path), {recursive: true}); await assertActorPath(path);
    let previous: string | undefined;
    try {previous = await readFile(path, 'utf8');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (previous !== expected) throw new Error('Actor file already exists or has changed; please re-approve');
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temporary, 'wx');
      try {await handle.writeFile(content, 'utf8'); await handle.sync();} finally {await handle.close();}
      await assertActorPath(path);
      if (expected === undefined) await link(temporary, path);
      else {
        if (await readFile(path, 'utf8') !== expected) throw new Error('Actor file has changed; please re-approve');
        await rename(temporary, path);
      }
    } finally {await unlink(temporary).catch(() => {});}
    return path;
  }
  render(id: string): string {const actor = this.find(id); if (!actor) throw new Error('Actor not found'); return serializeActor(actor);}
}
