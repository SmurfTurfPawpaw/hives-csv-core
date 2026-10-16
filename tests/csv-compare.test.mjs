import test from 'node:test';
import assert from 'node:assert/strict';
import { CSV_LIMITS, parseCsv, compareCsv } from '../src/shared/csv-compare.mjs';

const errorCode = (code) => (error) => {
  assert.equal(error.name, 'CsvCompareError');
  assert.equal(error.code, code);
  assert.ok(error.message.length > 0 && error.message.length < 200);
  return true;
};
const compare = (a, b, options = {}) =>
  compareCsv(parseCsv(a), parseCsv(b), {
    keyA: 'id',
    keyB: 'id',
    ...options,
  });
function accountForEveryRow(result) {
  const c = result.counts;
  assert.equal(c.totalA, c.matched + c.onlyA + c.unresolvedA);
  assert.equal(c.totalB, c.matched + c.onlyB + c.unresolvedB);
  assert.equal(c.matched, c.unchanged + c.changed);
  for (const name of ['onlyA', 'onlyB', 'unresolvedA', 'unresolvedB', 'changed'])
    assert.equal(c[name], result[name].length);
}

test('fixed limits are immutable and use the admitted caps', () => {
  assert.deepEqual(CSV_LIMITS, { maxBytes: 2_097_152, maxRows: 10_000, maxColumns: 100 });
  assert.equal(Object.isFrozen(CSV_LIMITS), true);
  assert.throws(() => {
    CSV_LIMITS.maxRows = 20_000;
  }, TypeError);
});

test('BOM, Unicode, commas, escaped quotes and embedded line endings preserve exact values', () => {
  const input = '\ufeffid,note,name\r\n001,"one,two","Céline 😀"\r\n002,"a""b\r\nc\nd\re",尾';
  assert.deepEqual(parseCsv(input), {
    headers: ['id', 'note', 'name'],
    rows: [
      ['001', 'one,two', 'Céline 😀'],
      ['002', 'a"b\r\nc\nd\re', '尾'],
    ],
  });
});

test('CRLF, LF and lone CR are supported record separators', () => {
  for (const separator of ['\r\n', '\n', '\r']) {
    assert.deepEqual(parseCsv(`id,note${separator}1,a${separator}2,b${separator}`), {
      headers: ['id', 'note'],
      rows: [
        ['1', 'a'],
        ['2', 'b'],
      ],
    });
  }
});

test('a terminal record separator is not an additional blank record', () => {
  assert.deepEqual(parseCsv('id\n1\n'), { headers: ['id'], rows: [['1']] });
  assert.deepEqual(parseCsv('id\n\n'), { headers: ['id'], rows: [['']] });
  assert.deepEqual(parseCsv('id\n\n2'), { headers: ['id'], rows: [[''], ['2']] });
  assert.throws(() => parseCsv('id,note\n1,a\n\n'), errorCode('ROW_WIDTH'));
});

test('header-only files are valid, but empty/BOM-only and whitespace-only headers are not', () => {
  assert.deepEqual(parseCsv('id,note'), { headers: ['id', 'note'], rows: [] });
  assert.deepEqual(parseCsv('id,note\r\n'), { headers: ['id', 'note'], rows: [] });
  for (const input of ['', '\ufeff']) assert.throws(() => parseCsv(input), errorCode('EMPTY_CSV'));
  for (const input of [' ', '\n', 'id,', 'id,""', 'id,\t'])
    assert.throws(() => parseCsv(input), errorCode('EMPTY_HEADER'));
});

test('exact header strings remain distinct; exact duplicates are rejected', () => {
  assert.deepEqual(parseCsv('ID,id, id \n01,1, 1 '), {
    headers: ['ID', 'id', ' id '],
    rows: [['01', '1', ' 1 ']],
  });
  assert.throws(() => parseCsv('id,id'), errorCode('DUPLICATE_HEADER'));
  assert.throws(() => parseCsv('id,"id"'), errorCode('DUPLICATE_HEADER'));
});

test('empty and trailing fields are retained', () => {
  assert.deepEqual(parseCsv('id,a,b\n1,,\n2,"",x'), {
    headers: ['id', 'a', 'b'],
    rows: [
      ['1', '', ''],
      ['2', '', 'x'],
    ],
  });
});

test('malformed quotes reject without exposing input values in the error', () => {
  const secret = 'PRIVATE-SYNTHETIC-MARKER';
  for (const suffix of [
    `1,"${secret}`,
    `1,${secret}"x`,
    `1,"${secret}"x`,
    `1, "${secret}"`,
    `1,"${secret}" `,
  ]) {
    assert.throws(
      () => parseCsv(`id,note\n${suffix}`),
      (error) => {
        errorCode('MALFORMED_QUOTE')(error);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  }
});

test('row width must agree, including rows after quoted newlines', () => {
  assert.throws(() => parseCsv('id,note\n1,a,b'), errorCode('ROW_WIDTH'));
  assert.throws(() => parseCsv('id,note\n1'), errorCode('ROW_WIDTH'));
  assert.throws(
    () => parseCsv('id,note\n1,"a\nb"\n2'),
    (error) => {
      errorCode('ROW_WIDTH')(error);
      assert.match(error.message, /Data record 2/);
      return true;
    },
  );
});

test('UTF-8 byte caps count multi-byte text and the optional BOM', () => {
  assert.deepEqual(parseCsv('é', { maxBytes: 2 }), { headers: ['é'], rows: [] });
  assert.throws(() => parseCsv('é', { maxBytes: 1 }), errorCode('BYTE_LIMIT'));
  assert.deepEqual(parseCsv('\ufeffh', { maxBytes: 4 }), { headers: ['h'], rows: [] });
  assert.throws(() => parseCsv('\ufeffh', { maxBytes: 3 }), errorCode('BYTE_LIMIT'));
  assert.throws(() => parseCsv('id\n😀', { maxBytes: 6 }), errorCode('BYTE_LIMIT'));
  assert.deepEqual(parseCsv('id\n😀', { maxBytes: 7 }).rows, [['😀']]);
});

test('invalid Unicode is not silently replaced by TextEncoder', () => {
  for (const invalid of ['id\n\ud800', 'id\n\udfff', 'id\n\ud800x'])
    assert.throws(() => parseCsv(invalid), errorCode('INVALID_ENCODING'));
  assert.deepEqual(parseCsv('id\n\ufffd').rows, [['\ufffd']]);
});

test('exact default byte cap is usable and one extra byte rejects', () => {
  const atCap = `h\n${'x'.repeat(CSV_LIMITS.maxBytes - 2)}`;
  const parsed = parseCsv(atCap);
  assert.equal(parsed.rows[0][0].length, CSV_LIMITS.maxBytes - 2);
  assert.throws(() => parseCsv(`${atCap}x`), errorCode('BYTE_LIMIT'));
});

test('exact default row cap is usable and one extra data record rejects', () => {
  const atCap = `id\n${Array.from({ length: CSV_LIMITS.maxRows }, (_, i) => String(i)).join('\n')}`;
  assert.equal(parseCsv(atCap).rows.length, CSV_LIMITS.maxRows);
  assert.throws(() => parseCsv(`${atCap}\nextra`), errorCode('ROW_LIMIT'));
});

test('exact default column cap is usable and an extra column rejects', () => {
  const headers = Array.from({ length: CSV_LIMITS.maxColumns }, (_, i) => `h${i}`);
  assert.equal(parseCsv(headers.join(',')).headers.length, CSV_LIMITS.maxColumns);
  assert.throws(() => parseCsv(`${headers.join(',')},extra`), errorCode('COLUMN_LIMIT'));
});

test('tests may lower caps, including zero data rows, but cannot expand them', () => {
  assert.deepEqual(parseCsv('id', { maxRows: 0 }).rows, []);
  assert.throws(() => parseCsv('id\n1', { maxRows: 0 }), errorCode('ROW_LIMIT'));
  assert.throws(() => parseCsv('a,b', { maxColumns: 1 }), errorCode('COLUMN_LIMIT'));
  for (const key of Object.keys(CSV_LIMITS)) {
    assert.throws(() => parseCsv('id', { [key]: CSV_LIMITS[key] + 1 }), errorCode('INVALID_LIMIT'));
    for (const bad of [-1, 1.5, Infinity, '2', NaN])
      assert.throws(() => parseCsv('id', { [key]: bad }), errorCode('INVALID_LIMIT'));
  }
  assert.throws(() => parseCsv('id', { maxBytes: 0 }), errorCode('INVALID_LIMIT'));
  assert.throws(() => parseCsv('id', { maxColumns: 0 }), errorCode('INVALID_LIMIT'));
  assert.throws(() => parseCsv('id', { maxRow: 1 }), errorCode('INVALID_OPTIONS'));
});

test('input/options types reject deterministically', () => {
  for (const input of [null, undefined, 5, {}, ['id']])
    assert.throws(() => parseCsv(input), errorCode('INVALID_TEXT'));
  for (const options of [null, [], 'x', 1])
    assert.throws(() => parseCsv('id', options), errorCode('INVALID_OPTIONS'));
});

test('golden reconciliation handles changed, missing, reordered and unchanged rows', () => {
  const a =
    'ID,Name,Status,Only A\n001,"Doe, Alice",active,x\n002,Bob,hold,y\n003,Céline,active,z\n004,Delta,,q';
  const b =
    'Status,Name,ID,Only B\nactive,"Doe, Alice",001,p\nactive,Bob,002,p\nactive,Céline,005,p\n"",Delta,004,p';
  const result = compare(a, b, { keyA: 'ID', keyB: 'ID' });
  assert.deepEqual(result.counts, {
    totalA: 4,
    totalB: 4,
    matched: 3,
    unchanged: 2,
    changed: 1,
    onlyA: 1,
    onlyB: 1,
    unresolvedA: 0,
    unresolvedB: 0,
  });
  assert.deepEqual(result.onlyA, [{ key: '003', record: 3 }]);
  assert.deepEqual(result.onlyB, [{ key: '005', record: 3 }]);
  assert.deepEqual(result.changed, [
    {
      key: '002',
      recordA: 2,
      recordB: 2,
      changes: [{ field: 'Status', before: 'hold', after: 'active' }],
    },
  ]);
  assert.deepEqual(result.schema, {
    onlyA: ['Only A'],
    onlyB: ['Only B'],
    common: ['ID', 'Name', 'Status'],
  });
  assert.deepEqual(result.comparedFields, ['Name', 'Status']);
  accountForEveryRow(result);
});

test('reported records are logical data-record positions, independent of physical lines', () => {
  const result = compare(
    'id,note\n1,"first\nsecond"\n2,two\n3,three',
    'id,note\n2,two\n1,"first\nsecond"\n4,four',
  );
  assert.deepEqual(result.onlyA, [{ key: '3', record: 3 }]);
  assert.deepEqual(result.onlyB, [{ key: '4', record: 3 }]);
  assert.equal(result.counts.matched, 2);
  accountForEveryRow(result);
});

test('admitted browser example accounts for six left and five right records', () => {
  const result = compare(
    'id,tier\n001,basic\n002,pro\n003,pro\n004,basic\n004,pro\n,unknown',
    'id,tier\n001,pro\n003,pro\n004,basic\n005,pro\n,unknown',
  );
  assert.deepEqual(result.counts, {
    totalA: 6,
    totalB: 5,
    matched: 2,
    unchanged: 1,
    changed: 1,
    onlyA: 1,
    onlyB: 1,
    unresolvedA: 3,
    unresolvedB: 2,
  });
  assert.deepEqual(result.onlyA, [{ key: '002', record: 2 }]);
  assert.deepEqual(result.onlyB, [{ key: '005', record: 4 }]);
  assert.deepEqual(result.changed, [
    {
      key: '001',
      recordA: 1,
      recordB: 1,
      changes: [{ field: 'tier', before: 'basic', after: 'pro' }],
    },
  ]);
  accountForEveryRow(result);
});

test('duplicate keys on left make every affected row on both sides unresolved', () => {
  const result = compare('id,note\nd,a\nd,b\nok,x', 'id,note\nd,a\nok,x');
  assert.deepEqual(result.unresolvedA, [
    { key: 'd', record: 1, reason: 'duplicate_key' },
    { key: 'd', record: 2, reason: 'duplicate_key' },
  ]);
  assert.deepEqual(result.unresolvedB, [{ key: 'd', record: 1, reason: 'duplicate_key' }]);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.changed.length, 0);
  accountForEveryRow(result);
});

test('duplicate keys on right also exclude the otherwise unique left match', () => {
  const result = compare('id,note\nd,a\nok,x\nleft,z', 'id,note\nd,a\nd,b\nok,x');
  assert.deepEqual(result.unresolvedA, [{ key: 'd', record: 1, reason: 'duplicate_key' }]);
  assert.deepEqual(
    result.unresolvedB.map((r) => r.record),
    [1, 2],
  );
  assert.deepEqual(result.onlyA, [{ key: 'left', record: 3 }]);
  assert.equal(result.counts.matched, 1);
  accountForEveryRow(result);
});

test('duplicate keys without a counterpart remain unresolved rather than only-on-side', () => {
  const result = compare('id\nx\nx\nz', 'id\ny\ny');
  assert.equal(result.onlyA.length, 1);
  assert.equal(result.onlyB.length, 0);
  assert.equal(result.unresolvedA.length, 2);
  assert.equal(result.unresolvedB.length, 2);
  accountForEveryRow(result);
});

test('empty and whitespace-only keys are unresolved while nonblank spaces remain exact', () => {
  const result = compare('id,n\n,a\n" \t",b\n x,c', 'id,n\n,d\n"\t",e\nx,c');
  assert.equal(result.unresolvedA.length, 2);
  assert.equal(result.unresolvedB.length, 2);
  assert.ok(result.unresolvedA.every((r) => r.reason === 'blank_key'));
  assert.ok(result.unresolvedB.every((r) => r.reason === 'blank_key'));
  assert.deepEqual(result.onlyA, [{ key: ' x', record: 3 }]);
  assert.deepEqual(result.onlyB, [{ key: 'x', record: 3 }]);
  accountForEveryRow(result);
});

test('case, leading zeroes, dates and value whitespace are never coerced', () => {
  const result = compare(
    'id,value\n01,2026-01-02\nA,10\nx,Alpha ',
    'id,value\n1,2026-02-01\na,010\nx,Alpha',
  );
  assert.deepEqual(
    result.onlyA.map((r) => r.key),
    ['01', 'A'],
  );
  assert.deepEqual(
    result.onlyB.map((r) => r.key),
    ['1', 'a'],
  );
  assert.deepEqual(result.changed[0].changes, [
    { field: 'value', before: 'Alpha ', after: 'Alpha' },
  ]);
  accountForEveryRow(result);
});

test('different selected key column names match; both key names are excluded from fields', () => {
  const result = compareCsv(
    parseCsv('id,external,value\n1,not-a-key,a'),
    parseCsv('external,id,value\n1,also-not-a-key,a'),
    { keyA: 'id', keyB: 'external' },
  );
  assert.equal(result.counts.unchanged, 1);
  assert.deepEqual(result.comparedFields, ['value']);
  assert.deepEqual(result.schema.common, ['id', 'external', 'value']);
  accountForEveryRow(result);
});

test('explicit field order is honoured and unselected differences are not reported', () => {
  const result = compare('id,a,b,c\n1,A,B,C', 'id,a,b,c\n1,a,b,c', { fields: ['c', 'a'] });
  assert.deepEqual(result.comparedFields, ['c', 'a']);
  assert.deepEqual(result.changed[0].changes, [
    { field: 'c', before: 'C', after: 'c' },
    { field: 'a', before: 'A', after: 'a' },
  ]);
  accountForEveryRow(result);
});

test('explicit empty fields produce an accurately detectable keys-only result', () => {
  const result = compare('id,n\n1,before', 'id,n\n1,after', { fields: [] });
  assert.deepEqual(result.comparedFields, []);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.unchanged, 1);
  assert.deepEqual(result.changed, []);
  accountForEveryRow(result);
});

test('disjoint value schemas are neutral and default to key-only matching', () => {
  const result = compare('id,left\n1,a', 'id,right\n1,b');
  assert.deepEqual(result.schema, { onlyA: ['left'], onlyB: ['right'], common: ['id'] });
  assert.deepEqual(result.comparedFields, []);
  assert.equal(result.counts.matched, 1);
  accountForEveryRow(result);
});

test('header-only and one-empty-side inputs account for every record', () => {
  for (const [a, b] of [
    ['id,n', 'id,n'],
    ['id,n', 'id,n\n1,a'],
    ['id,n\n1,a', 'id,n'],
  ]) {
    const result = compare(a, b);
    assert.equal(result.counts.matched, 0);
    accountForEveryRow(result);
  }
});

test('key and field choices must explicitly name existing exact eligible headers', () => {
  const a = parseCsv(' id ,n\n1,a');
  const b = parseCsv('id,n\n1,b');
  assert.throws(() => compareCsv(a, b, { keyA: 'id', keyB: 'id' }), errorCode('INVALID_KEY'));
  assert.equal(compareCsv(a, b, { keyA: ' id ', keyB: 'id' }).counts.changed, 1);
  assert.throws(() => compareCsv(a, b, {}), errorCode('INVALID_KEY'));
  const left = parseCsv('id,n\n1,a');
  for (const fields of [['id'], ['missing'], ['n', 'n'], [3], null, 'n', new Array(1)])
    assert.throws(
      () => compareCsv(left, b, { keyA: 'id', keyB: 'id', fields }),
      errorCode('INVALID_FIELDS'),
    );
  assert.throws(
    () => compareCsv(left, b, { keyA: 'id', keyB: 'id', ignoreCase: true }),
    errorCode('INVALID_OPTIONS'),
  );
});

test('HTML/formula-like strings and prototype-looking names remain inert exact data', () => {
  const left = parseCsv(
    '__proto__,constructor,toString\nkey,"<img src=x onerror=alert(1)>","=HYPERLINK(""https://example.invalid"")"',
  );
  const right = parseCsv('__proto__,constructor,toString\nkey,"<script>bad</script>","+SUM(1,2)"');
  const result = compareCsv(left, right, { keyA: '__proto__', keyB: '__proto__' });
  assert.equal(result.changed[0].changes[0].before, '<img src=x onerror=alert(1)>');
  assert.equal(result.changed[0].changes[1].after, '+SUM(1,2)');
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  accountForEveryRow(result);
});

test('comparison does not mutate source tables or alias result selections/schema', () => {
  const a = parseCsv('id,n\n1,a');
  const b = parseCsv('id,n\n1,b');
  const options = { keyA: 'id', keyB: 'id', fields: ['n'] };
  const before = JSON.stringify({ a, b, options });
  const result = compareCsv(a, b, options);
  result.comparedFields.push('extra');
  result.schema.common.push('extra');
  result.changed[0].changes[0].before = 'mutated';
  assert.equal(JSON.stringify({ a, b, options }), before);
});

test('invalid or sparse manually supplied tables cannot evade row accounting', () => {
  const valid = parseCsv('id,n\n1,a');
  for (const bad of [
    null,
    {},
    { headers: [], rows: [] },
    { headers: ['id'], rows: [[1]] },
    { headers: ['id'], rows: new Array(1) },
    { headers: new Array(1), rows: [] },
    { headers: ['id'], rows: [new Array(1)] },
    { headers: ['id'], rows: [['a', 'b']] },
  ])
    assert.throws(() => compareCsv(bad, valid, { keyA: 'id', keyB: 'id' }));
  assert.throws(
    () => compareCsv({ headers: ['id'], rows: [['\udfff']] }, valid, { keyA: 'id', keyB: 'id' }),
    errorCode('INVALID_ENCODING'),
  );
  assert.throws(
    () =>
      compareCsv({ headers: ['id'], rows: [['x'.repeat(CSV_LIMITS.maxBytes)]] }, valid, {
        keyA: 'id',
        keyB: 'id',
      }),
    errorCode('BYTE_LIMIT'),
  );
});

test('seeded independent CSV round-trips cover escaping and separator combinations', () => {
  let seed = 0x12345678;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const values = [
    '',
    ' ',
    '001',
    'é',
    '😀',
    'a,b',
    'say "yes"',
    'a\nb',
    'a\rb',
    'a\r\nb',
    '=SUM(1,2)',
    '<b>x</b>',
  ];
  const escapeCell = (cell) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  for (let fixture = 0; fixture < 120; fixture += 1) {
    const rows = Array.from({ length: next() % 8 }, () =>
      Array.from({ length: 3 }, () => values[next() % values.length]),
    );
    const separator = ['\n', '\r\n', '\r'][next() % 3];
    const csv =
      [['id', 'a', 'b'], ...rows].map((row) => row.map(escapeCell).join(',')).join(separator) +
      (next() % 2 ? separator : '');
    const table = parseCsv(csv);
    assert.deepEqual(table, { headers: ['id', 'a', 'b'], rows });
    const result = compareCsv(table, table, { keyA: 'id', keyB: 'id' });
    assert.equal(result.counts.changed, 0);
    assert.equal(result.counts.onlyA, 0);
    assert.equal(result.counts.onlyB, 0);
    accountForEveryRow(result);
  }
});
