# wordfreq-cli

A small CLI and library for counting word frequencies in text files.

## CLI Usage

```bash
node src/cli.mjs <file>
```

Prints words sorted by descending frequency (ties broken alphabetically) in a plain-text table.

## Library Usage

```js
import {countWords} from './src/count.mjs';

const counts = countWords('hello world hello');
// Map { 'hello' => 2, 'world' => 1 }
```
