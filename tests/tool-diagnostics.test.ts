import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseToolError} from '../src/tools/diagnostics.js';

test('EditTool diagnostics: string not found returns two-part context and Read prescription', () => {
  const result = diagnoseToolError(
    {id: '1', name: 'Edit', arguments: JSON.stringify({file_path: 'src/app.ts', old_string: 'const a = 1;'})},
    {isError: true, text: 'String to replace not found in file: const a = 1;'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'String "const a = 1;" not found in file "src/app.ts". Call Read("src/app.ts") on surrounding lines to verify current indentation and exact characters before retrying. Do not guess.'
  );
});

test('EditTool diagnostics: multiple matches returns two-part context and uniqueness prescription', () => {
  const result = diagnoseToolError(
    {id: '1', name: 'Edit', arguments: JSON.stringify({file_path: 'src/app.ts', old_string: 'foo'})},
    {isError: true, text: 'Multiple matches found for old_string (3); set replace_all: true'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'Found 3 matches for "foo" in "src/app.ts". Include 2-4 surrounding lines of context in old_string to make it uniquely identifiable, or set replace_all: true if intended.'
  );
});

test('ReadTool diagnostics: ENOENT missing file returns two-part context and Glob prescription', () => {
  const result = diagnoseToolError(
    {id: '2', name: 'Read', arguments: JSON.stringify({file_path: 'missing.ts'})},
    {isError: true, text: 'File not found: missing.ts (ENOENT)'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'File "missing.ts" does not exist. Call Glob to locate the actual file path before retrying. Do not guess file names.'
  );
});

test('WriteTool diagnostics: directory path error returns two-part context and file path prescription', () => {
  const result = diagnoseToolError(
    {id: '3', name: 'Write', arguments: JSON.stringify({file_path: 'src/'})},
    {isError: true, text: 'EISDIR: illegal operation on a directory'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'Path "src/" is a directory. Specify a full file path including filename.'
  );
});

test('ShellTool diagnostics: command not found 127 returns two-part context and alternative prescription', () => {
  const result = diagnoseToolError(
    {id: '4', name: 'Shell', arguments: JSON.stringify({command: 'unknown-cli --flag'})},
    {isError: true, text: 'Exit code: 127\nunknown-cli: command not found'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'Command "unknown-cli" is not installed or not recognized in PATH. Use built-in tools (Read, Grep, or a Node.js script) instead of retrying the missing command.'
  );
});

test('GrepTool diagnostics: 0 matches returns two-part context and regex broadening prescription', () => {
  const result = diagnoseToolError(
    {id: '5', name: 'Grep', arguments: JSON.stringify({pattern: 'myPattern'})},
    {isError: true, text: 'No matches found.'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'No matches found for pattern "myPattern". Do NOT repeat identical search. Check file extensions, broaden regex pattern, or try case-insensitive search with -i: true.'
  );
});

test('GlobTool diagnostics: 0 files matched returns two-part context and directory verification prescription', () => {
  const result = diagnoseToolError(
    {id: '6', name: 'Glob', arguments: JSON.stringify({pattern: '**/*.xyz'})},
    {isError: true, text: 'No files found'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'No files matched pattern "**/*.xyz". Verify the target directory path or use a broader pattern (e.g. "**/*needle*") to locate files.'
  );
});

test('UpdateTaskProgress diagnostics: obsolete plan parameters point to the activity label contract', () => {
  const result = diagnoseToolError(
    {id: '7', name: 'UpdateTaskProgress', arguments: JSON.stringify({stages: [{title: 'Build'}]})},
    {isError: true, text: 'Parameter validation failed: label: Required'}
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /short, single-line label and optional detail/);
  assert.match(result.text, /omit stages, status, result, and reason/);
});

test('SendMessage diagnostics: unknown target returns two-part context and ListActors prescription', () => {
  const result = diagnoseToolError(
    {id: '8', name: 'SendMessage', arguments: JSON.stringify({to: 'nobody', message: 'hello'})},
    {isError: true, text: 'Unknown recipient: nobody'}
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.text,
    'Cannot deliver message to "nobody". Valid recipient actors are: "techne", "aletheia", "kalon", "logox", or "all". Use ListActors to inspect active companions.'
  );
});

test('successful tool results pass through byte-identical with zero overhead', () => {
  const original = {isError: false, text: '1: line 1\n2: line 2'};
  const result = diagnoseToolError(
    {id: '9', name: 'Read', arguments: JSON.stringify({file_path: 'src/app.ts'})},
    original
  );
  assert.equal(result, original);
});

const mcpCall = (tool: string, extra: Record<string, unknown> = {}) =>
  ({id: 'm', name: 'mcp', arguments: JSON.stringify({server: 'playwright', action: 'call', tool, arguments: {}, ...extra})});

test('MCP diagnostics: blocked file: protocol prescribes serving over HTTP', () => {
  const result = diagnoseToolError(mcpCall('browser_navigate'), {isError: true, text: 'Error: Access to "file:" protocol is blocked'});
  assert.equal(result.isError, true);
  assert.match(result.text, /^Error: Access to "file:" protocol is blocked\. Serve the folder over HTTP first/);
  assert.match(result.text, /python -m http\.server <free-port>/);
  assert.match(result.text, /http:\/\/127\.0\.0\.1:<port>\/<file>/);
});

test('MCP diagnostics: additionalProperties error names the unexpected property and points at list', () => {
  const raw = 'MCP arguments do not satisfy the full schema: [{"instancePath":"","schemaPath":"#/additionalProperties","keyword":"additionalProperties","params":{"additionalProperty":"newTab"},"message":"must NOT have additional properties"}]';
  const result = diagnoseToolError(mcpCall('browser_navigate'), {isError: true, text: raw});
  assert.match(result.text, /"browser_navigate"/);
  assert.match(result.text, /unexpected properties: newTab/);
  assert.match(result.text, /"action":"list"/);
  assert.match(result.text, /"server":"playwright"/);
});

test('MCP diagnostics: missing required property is named', () => {
  const raw = 'MCP arguments do not satisfy the full schema: [{"keyword":"required","params":{"missingProperty":"url"},"message":"must have required property url"}]';
  const result = diagnoseToolError(mcpCall('browser_navigate'), {isError: true, text: raw});
  assert.match(result.text, /missing required properties: url/);
});

test('MCP diagnostics: browser_close errors say the browser is already closed', () => {
  const first = diagnoseToolError(mcpCall('browser_close'), {isError: true, text: 'Invalid MCP parameters or response content'});
  assert.match(first.text, /The browser is already closed; do not retry close\.$/);
  const second = diagnoseToolError(mcpCall('browser_close'), {isError: true, text: 'No open tabs. Navigate to a URL to create one.'});
  assert.match(second.text, /do not retry close\.$/);
  const other = diagnoseToolError(mcpCall('browser_click'), {isError: true, text: 'No open tabs. Navigate to a URL to create one.'});
  assert.match(other.text, /already closed/);
});

test('MCP diagnostics: direct mcp__ names reuse the same rules and unrelated errors pass through', () => {
  const direct = diagnoseToolError({id: 'd', name: 'mcp__playwright__browser_navigate', arguments: '{"url":"file:///a.html"}'},
    {isError: true, text: 'Error: Access to "file:" protocol is blocked'});
  assert.match(direct.text, /Serve the folder over HTTP/);
  const close = diagnoseToolError({id: 'd', name: 'mcp__playwright__browser_close', arguments: '{}'}, {isError: true, text: 'boom'});
  assert.match(close.text, /do not retry close/);
  const unrelated = diagnoseToolError(mcpCall('browser_click'), {isError: true, text: 'Timeout 5000ms exceeded'});
  assert.equal(unrelated.text, 'Timeout 5000ms exceeded');
});
