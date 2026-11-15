import {mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {StateFile} from '../config/model-preferences.js';
import type {RunKind} from './service.js';
import type {Marks} from './transcript.js';

const marksSchema = z.record(z.string(), z.number().int().nonnegative());
const watermarkSchema = z.strictObject({version: z.literal(1), recap: marksSchema, dream: marksSchema});
export type Watermarks = z.infer<typeof watermarkSchema>;

/** How much of each owner's journal a recap and a dream have covered, kept beside the journals so a restart does not review the same material again. */
export class WatermarkStore {
  private readonly file: StateFile<Watermarks>;
  constructor(readonly directory: string) {
    this.file = new StateFile(join(directory, 'anamnesis.json'), watermarkSchema);
  }
  /** Missing or unreadable state counts as nothing covered. */
  async read(): Promise<Watermarks> {
    try {return await this.file.read() ?? {version: 1, recap: {}, dream: {}};}
    catch {return {version: 1, recap: {}, dream: {}};}
  }
  async marks(kind: RunKind): Promise<Marks> {return (await this.read())[kind];}
  /** Records the marks of a finished run (the other kind keeps its own). */
  async save(kind: RunKind, marks: Marks): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    try {await this.file.update(current => ({version: 1, recap: {}, dream: {}, ...current, [kind]: {...marks}}));}
    catch {
      // An unreadable file is a lost watermark, not a reason to fail every later run: start it again.
      await rm(this.file.path, {force: true});
      await this.file.update(() => ({version: 1, recap: {}, dream: {}, [kind]: {...marks}}));
    }
  }
}
