# wordfreq-cli

A small CLI and library for counting word frequencies in text files.

## CLI Usage

```bash
node src/cli.mjs <file>
node src/cli.mjs <file> --format json
```

By default (`--format text`), prints words sorted by descending frequency (ties broken alphabetically) in a plain-text table.
With `--format json`, outputs a JSON array of `{"word": string, "count": number}` entries in the same sorted order.

## Library Usage

```js
import {countWords, getSortedWordCounts} from './src/count.mjs';

const counts = countWords('hello world hello');
// Map { 'hello' => 2, 'world' => 1 }

const sorted = getSortedWordCounts('hello world hello');
// [ { word: 'hello', count: 2 }, { word: 'world', count: 1 } ]
```
