# Hives CSV core

The exact-key parser and comparison core behind [Hives CSV Compare](https://hives.gent/tools/compare-csv), with its synthetic Node tests.

Use the browser tool to compare two exports, inspect highlighted changes and download a report. This repository contains the core algorithm and tests. The browser interface, charts, file decoding and report generation are separate.

## Run the tests

Use Node.js 22 or later. No package installation is required.

```sh
node --test tests/csv-compare.test.mjs
```

The fixtures cover quoted commas and newlines, Unicode, malformed input, exact limits, reordered columns, changed and missing records, duplicate and blank keys, and record accounting. All fixtures are synthetic.

## Compare two tables

An ES module example, run from the repository root:

```js
import { parseCsv, compareCsv } from './src/shared/csv-compare.mjs';

const before = parseCsv('id,status\n001,queued\n002,done');
const after = parseCsv('id,status\n001,done\n003,queued');

const result = compareCsv(before, after, { keyA: 'id', keyB: 'id' });
console.log(result.counts);
```

This reports one changed record, one record only in `before`, and one only in `after`. Leading zeros remain part of each key.

## Comparison rules

- `parseCsv` takes a string already decoded from UTF-8. It supports an optional BOM, comma separators, quoted fields, escaped quotes and quoted newlines.
- Fixed caps are 2 MiB of UTF-8 input, 10,000 data records and 100 columns per table. Options may lower the caps.
- Keys and selected shared non-key fields use exact string comparisons. Case, whitespace, dates and leading zeros are preserved.
- Blank or whitespace-only keys are unresolved. A duplicated key on either side makes every affected record on both sides unresolved; the algorithm does not guess a pairing.
- Results account for every input record. With no selected shared value fields, results compare keys only; they do not establish that all record values agree.

The module performs no network, filesystem or storage operations. It does not merge files, update systems, or certify a migration. Applications using its results need their own display escaping, data handling and acceptance checks.

## About this sample

Hives prepared this implementation with AI-assisted development. These are the existing core and synthetic tests extracted for inspection without behaviour changes. Automated tests do not establish an independent human audit, customer adoption or business results. No additional open-source licence is included.

For software work, see [Hives](https://hives.gent/) or contact [hello@hives.gent](mailto:hello@hives.gent). Keep private CSV contents and credentials out of public discussions.
