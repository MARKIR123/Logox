import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';

const [log, mode = 'normal'] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({pid: process.pid}) + '\n');
const tools = [{name: 'echo', description: '合成回声', inputSchema: {
  type: 'object', additionalProperties: false, required: ['value'], properties: {
    value: {type: 'integer', minimum: 1}, mode: {enum: ['normal', 'wait', 'bad', 'error']},
    email: {type: 'string', format: 'email'},
    nested: {type: 'object', required: ['tag'], properties: {tag: {type: 'string', pattern: '^ok$'}}},
  },
}}, {name: 'choice', inputSchema: {$schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', required: ['value'], properties: {value: {oneOf: [{const: 'yes'}, {type: 'integer', minimum: 3}]}},
}}];
let generation = 0;
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  appendFileSync(log, JSON.stringify({method: message.method, params: message.params}) + '\n');
  const respond = result => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: message.id, result}) + '\n');
  if (message.method === 'initialize') {
    if (mode === 'wait-init') continue;
    if (mode === 'bad-init') {process.stdout.write('not-json\n'); continue;}
    respond({protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}});
  } else if (message.method === 'tools/list') {
    if (mode.startsWith('schema-id-')) {
      generation++;
      const modern = mode === 'schema-id-2020';
      const value = mode === 'schema-id-other' ? 'other' : generation === 1 ? 'old' : 'new';
      const schema = expected => ({$id: 'https://fixture.invalid/shared',
        ...(modern ? {$schema: 'https://json-schema.org/draft/2020-12/schema'} : {}),
        type: 'object', required: ['value'], additionalProperties: false,
        [modern ? '$defs' : 'definitions']: {value: {const: expected}},
        properties: {value: {$ref: modern ? '#/$defs/value' : '#/definitions/value'}}});
      respond({tools: [{name: 'echo', inputSchema: schema(value)}, {name: 'choice', inputSchema: schema('choice')}]});
      continue;
    }
    if (mode === 'bad-list') {process.stdout.write('not-json\n'); continue;}
    if (mode === 'repeat-page') {respond({tools: [], nextCursor: 'same'}); continue;}
    respond(message.params.cursor ? {tools: [tools[1]]} : {tools: [tools[0]], nextCursor: 'second'});
  } else if (message.method === 'tools/call') {
    const args = message.params.arguments;
    if (args.mode === 'wait') continue;
    if (args.mode === 'bad') {process.stdout.write('bad-json\n'); continue;}
    if (['image', 'large-image', 'bad-image'].includes(mode)) {
      const image = {type: 'image', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
      if (mode === 'bad-image') delete image.data;
      respond({content: [{type: 'text', text: mode === 'large-image' ? 'x'.repeat(1_100_000) : 'Screenshot captured'}, image]});
      continue;
    }
    respond({content: [{type: 'text', text: 'echo:' + args.value}], isError: args.mode === 'error'});
  }
}
