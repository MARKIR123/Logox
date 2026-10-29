import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
import {z} from 'zod';
import {toolCategorySchema} from './metadata.js';

const categoriesSchema = z.record(toolCategorySchema, z.string().trim().min(1).regex(/^[^\r\n]+$/));

export function readToolCategories(directory: string): ReadonlyMap<string, string> {
  try {
    const raw = readFileSync(join(directory, 'AGENTS.md'), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
    if (!header) return new Map();
    const document = parseDocument(header[1]!, {uniqueKeys: true});
    if (document.errors.length) return new Map();
    const fields = z.object({categories: categoriesSchema}).parse(document.toJS({maxAliasCount: 0}));
    return new Map(Object.entries(fields.categories));
  } catch {
    return new Map();
  }
}
