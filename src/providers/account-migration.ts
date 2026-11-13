import {randomUUID} from 'node:crypto';
import {readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
import {presets} from '../config/config.js';
import type {AuthStorage} from './auth.js';
import type {CustomProviderStorage} from './custom-storage.js';

/** The provider name the ChatGPT account sign-in lived under before it became its own provider, and the name it moved to. */
const OLD = 'openai', NEW = 'openai-auth';

export interface AccountMigrationOptions {
  readonly auth: AuthStorage;
  readonly customStorage: CustomProviderStorage;
  /** The user home that holds `.logox/`. */
  readonly home: string;
  /** The project root whose `.logox/state` and `.logox/actors` are rewritten; other projects are never touched. */
  readonly project?: string | undefined;
}
export interface AccountMigrationResult {
  readonly status: 'none' | 'migrated' | 'skipped' | 'failed';
  /** One line for the user when the migration ran. */
  readonly notice?: string;
  /** Files whose references were rewritten. */
  readonly rewritten: readonly string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

async function replaceText(path: string, content: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, {flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally {await rm(temporary, {force: true}).catch(() => {});}
}
/** Reads a text file; a missing or unreadable file is "nothing to do". */
async function readText(path: string): Promise<string | undefined> {
  try {return await readFile(path, 'utf8');} catch {return undefined;}
}
/** Rewrites one JSON file in place when `edit` reports a change; any problem leaves the file as it was. */
async function rewriteJson(path: string, edit: (value: unknown) => boolean, indent?: number): Promise<boolean> {
  const text = await readText(path);
  if (text === undefined) return false;
  try {
    const bom = text.startsWith('﻿');
    const value: unknown = JSON.parse(bom ? text.slice(1) : text);
    if (!edit(value)) return false;
    await replaceText(path, JSON.stringify(value, null, indent) + '\n');
    return true;
  } catch {return false;}
}
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** `{provider, model}` object: moves it to the new provider. */
function moveBinding(value: unknown): boolean {
  if (!isObject(value) || value['provider'] !== OLD) return false;
  value['provider'] = NEW;
  return true;
}
/** A map of id to `{provider, model}` (actor and tool model files). */
function moveBindings(value: unknown): boolean {
  if (!isObject(value)) return false;
  let changed = false;
  for (const binding of Object.values(value)) changed = moveBinding(binding) || changed;
  return changed;
}
/** `defaultModel.provider` in actor YAML; returns the new text or undefined when there is nothing to change. */
function moveActorYaml(yaml: string): string | undefined {
  const document = parseDocument(yaml);
  if (document.errors.length || document.getIn(['defaultModel', 'provider']) !== OLD) return undefined;
  document.setIn(['defaultModel', 'provider'], NEW);
  return document.toString();
}
async function rewriteActorFile(path: string, markdown: boolean): Promise<boolean> {
  const text = await readText(path);
  if (text === undefined) return false;
  try {
    if (!markdown) {
      const next = moveActorYaml(text);
      if (next === undefined) return false;
      await replaceText(path, next);
      return true;
    }
    const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n[\s\S]*)$/.exec(text);
    const next = match ? moveActorYaml(match[2]!) : undefined;
    if (!match || next === undefined) return false;
    await replaceText(path, match[1]! + next.replace(/\r?\n$/, '') + match[3]!);
    return true;
  } catch {return false;}
}
/** Actor definition files of one `.logox/actors` directory: `<id>.md` front matter and `<id>/config.yaml`. */
async function rewriteActorDirectory(directory: string): Promise<string[]> {
  const done: string[] = [];
  let entries;
  try {entries = await readdir(directory, {withFileTypes: true});} catch {return done;}
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const path = join(directory, entry.name);
      if (await rewriteActorFile(path, true)) done.push(path);
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      for (const name of ['config.yaml', 'config.yml']) {
        const path = join(directory, entry.name, name);
        if (await rewriteActorFile(path, false)) done.push(path);
      }
    }
  }
  return done;
}

/**
 * One-time move of the ChatGPT account sign-in from the provider `openai` to the provider `openai-auth`.
 * Runs only when the credential stored under `openai` is an OAuth login and `openai-auth` has none. The credential is written under the new name
 * and read back before the old one is removed, so a failure never leaves it under neither name (the old one stays and the copy is rolled back).
 * Afterwards the selections that named `openai` while it was the account provider are rewritten in the user-level files and the current project's
 * state: saved model selections, actor and Automa bindings, the model store and project/user actor definitions. Session ledgers and other
 * projects are deliberately left alone; a stale `openai` model there fails with the normal "not logged in" error instead of silently using the account.
 */
export async function migrateOpenAiAccount(options: AccountMigrationOptions): Promise<AccountMigrationResult> {
  const {auth, customStorage, home, project} = options;
  const none = (status: AccountMigrationResult['status']): AccountMigrationResult => ({status, rewritten: []});
  let old, target;
  try {[old, target] = [await auth.credential(OLD), await auth.credential(NEW)];}
  catch {return none('failed');}
  if (old?.type !== 'oauth') return none('none');
  if (target) return none('skipped');

  const {type: _type, ...token} = old;
  let createdRecord = false;
  let removedRecord: Awaited<ReturnType<CustomProviderStorage['get']>>;
  const rollback = async (): Promise<void> => {
    await auth.remove(NEW).catch(() => {});
    if (createdRecord) await customStorage.remove(NEW).catch(() => {});
    // The old record comes back with its model list if it was already removed when a later step failed.
    if (removedRecord) await customStorage.save(removedRecord).catch(() => {});
  };
  try {
    await auth.saveOAuth(NEW, token, new AbortController().signal);
    const copy = await auth.credential(NEW);
    if (copy?.type !== 'oauth' || !same(copy, old)) throw new Error('The copied credential does not read back');
    // The record follows: models and default model carry over, the endpoint comes from the new template.
    const record = await customStorage.get(OLD);
    if (record && !await customStorage.get(NEW)) {
      const template = presets[NEW]!;
      await customStorage.save({name: NEW, base_url: template.base_url, kind: template.kind, catalog: true,
        ...(record.models ? {models: record.models} : {}), ...(record.default_model ? {default_model: record.default_model} : {})});
      createdRecord = true;
      await customStorage.remove(OLD);
      removedRecord = record;
    }
    await auth.remove(OLD);
  } catch {
    await rollback();
    return none('failed');
  }

  const rewritten: string[] = [];
  const logox = join(home, '.logox');
  const jobs: Array<[string, (value: unknown) => boolean, number?]> = [
    [join(logox, 'model-preferences.json'), moveBinding],
    ...(project ? [[join(project, '.logox', 'state', 'model-preferences.json'), moveBinding] as [string, (value: unknown) => boolean]] : []),
    [join(logox, 'actor-models.json'), moveBindings, 2],
    [join(logox, 'tool-models.json'), moveBindings, 2],
    ...['models-store.json', 'models-cache.json'].map((name): [string, (value: unknown) => boolean, number] => [join(logox, name), value => {
      if (!isObject(value) || !Array.isArray(value['models'])) return false;
      const present = new Set(value['models'].filter(isObject).filter(item => item['provider'] === NEW).map(item => item['id']));
      let changed = false;
      value['models'] = value['models'].flatMap((item: unknown) => {
        if (!isObject(item) || item['provider'] !== OLD) return [item];
        changed = true;
        if (present.has(item['id'])) return [];
        item['provider'] = NEW;
        return [item];
      });
      return changed;
    }, 2]),
  ];
  for (const [path, edit, indent] of jobs) if (await rewriteJson(path, edit, indent)) rewritten.push(path);
  rewritten.push(...await rewriteActorDirectory(join(logox, 'actors')));
  if (project) rewritten.push(...await rewriteActorDirectory(join(project, '.logox', 'actors')));
  return {status: 'migrated', rewritten, notice: 'OpenAI account sign-in is now the provider ' + NEW + '; your saved model choices were updated.'};
}
