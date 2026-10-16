// Pure local CSV parsing and exact-key reconciliation. No I/O or persistence.
export const CSV_LIMITS = Object.freeze({
  maxBytes: 2_097_152,
  maxRows: 10_000,
  maxColumns: 100,
});

const encoder = new TextEncoder();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'CsvCompareError';
  error.code = code;
  throw error;
}

function requireOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    fail('INVALID_OPTIONS', 'Options must be an object.');
  if (Object.keys(options).some((key) => !allowed.includes(key)))
    fail('INVALID_OPTIONS', 'An unsupported option was supplied.');
}

function limitsFor(options) {
  requireOptions(options, Object.keys(CSV_LIMITS));
  const limits = { ...CSV_LIMITS };
  for (const key of Object.keys(CSV_LIMITS)) {
    if (!own(options, key)) continue;
    const value = options[key];
    const minimum = key === 'maxRows' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > CSV_LIMITS[key])
      fail('INVALID_LIMIT', 'Limits may only lower the fixed byte, row and column caps.');
    limits[key] = value;
  }
  return limits;
}

function requireUnicode(value) {
  // TextEncoder replaces lone surrogates. Reject them rather than silently changing input.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        fail('INVALID_ENCODING', 'Input must contain valid Unicode decoded from UTF-8.');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('INVALID_ENCODING', 'Input must contain valid Unicode decoded from UTF-8.');
    }
  }
}

function validateHeaders(headers) {
  if (headers.some((header) => header.trim().length === 0))
    fail('EMPTY_HEADER', 'Every column needs a non-empty header.');
  if (new Set(headers).size !== headers.length)
    fail('DUPLICATE_HEADER', 'Column headers must be unique exact strings.');
}

export function parseCsv(text, options = {}) {
  const limits = limitsFor(options);
  if (typeof text !== 'string') fail('INVALID_TEXT', 'CSV input must be text.');
  // A valid UTF-8 encoding cannot use fewer bytes than UTF-16 code units.
  if (text.length > limits.maxBytes)
    fail('BYTE_LIMIT', `CSV exceeds the ${limits.maxBytes}-byte limit.`);
  requireUnicode(text);
  if (encoder.encode(text).byteLength > limits.maxBytes)
    fail('BYTE_LIMIT', `CSV exceeds the ${limits.maxBytes}-byte limit.`);
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (source.length === 0) fail('EMPTY_CSV', 'CSV needs a header record.');

  let headers = null;
  const rows = [];
  let record = [];
  let fieldParts = [];
  let chunkStart = 0;
  let inQuotes = false;
  let closedQuote = false;
  let pendingRecord = false;

  function location() {
    return `${headers ? `data record ${rows.length + 1}` : 'header record'}, column ${record.length + 1}`;
  }

  function finishField() {
    if (record.length >= limits.maxColumns)
      fail('COLUMN_LIMIT', `CSV exceeds the ${limits.maxColumns}-column limit.`);
    record.push(fieldParts.join(''));
    fieldParts = [];
    closedQuote = false;
  }

  function appendChunk(end) {
    if (end > chunkStart) fieldParts.push(source.slice(chunkStart, end));
  }

  function finishRecord() {
    finishField();
    if (headers === null) {
      validateHeaders(record);
      headers = record;
    } else {
      if (rows.length >= limits.maxRows)
        fail('ROW_LIMIT', `CSV exceeds the ${limits.maxRows}-data-record limit.`);
      if (record.length !== headers.length)
        fail('ROW_WIDTH', `Data record ${rows.length + 1} does not match the header width.`);
      rows.push(record);
    }
    record = [];
    pendingRecord = false;
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          appendChunk(index);
          fieldParts.push('"');
          index += 1;
          chunkStart = index + 1;
        } else {
          appendChunk(index);
          inQuotes = false;
          closedQuote = true;
          chunkStart = index + 1;
        }
      }
      continue;
    }
    if (char === ',') {
      if (!closedQuote) appendChunk(index);
      finishField();
      chunkStart = index + 1;
      pendingRecord = true;
    } else if (char === '\r' || char === '\n') {
      if (!closedQuote) appendChunk(index);
      finishRecord();
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      chunkStart = index + 1;
    } else if (char === '"') {
      if (index !== chunkStart || fieldParts.length !== 0 || closedQuote)
        fail('MALFORMED_QUOTE', `Unexpected quote in ${location()}.`);
      inQuotes = true;
      chunkStart = index + 1;
      pendingRecord = true;
    } else {
      if (closedQuote)
        fail(
          'MALFORMED_QUOTE',
          `Only a delimiter or record end may follow a closing quote in ${location()}.`,
        );
      pendingRecord = true;
    }
  }
  if (inQuotes) fail('MALFORMED_QUOTE', `Unclosed quoted field in ${location()}.`);
  // A single terminal separator ends the previous record; extra blank records are parsed.
  if (pendingRecord) {
    if (!closedQuote) appendChunk(source.length);
    finishRecord();
  }
  if (headers === null) fail('EMPTY_CSV', 'CSV needs a header record.');
  return { headers, rows };
}

function validateTable(table, side) {
  if (
    !table ||
    typeof table !== 'object' ||
    !Array.isArray(table.headers) ||
    !Array.isArray(table.rows)
  )
    fail('INVALID_TABLE', `${side} input must be a parsed CSV table.`);
  if (table.headers.length < 1 || table.headers.length > CSV_LIMITS.maxColumns)
    fail('COLUMN_LIMIT', `${side} input must have 1-${CSV_LIMITS.maxColumns} columns.`);
  if (table.rows.length > CSV_LIMITS.maxRows)
    fail('ROW_LIMIT', `${side} input exceeds the fixed data-record limit.`);
  let bytes = 0;
  const countString = (value) => {
    if (typeof value !== 'string') fail('INVALID_TABLE', `${side} input cells must be strings.`);
    if (value.length > CSV_LIMITS.maxBytes - bytes)
      fail('BYTE_LIMIT', `${side} input exceeds the fixed byte limit.`);
    requireUnicode(value);
    bytes += encoder.encode(value).byteLength;
    if (bytes > CSV_LIMITS.maxBytes)
      fail('BYTE_LIMIT', `${side} input exceeds the fixed byte limit.`);
  };
  for (const header of table.headers) countString(header);
  validateHeaders(table.headers);
  for (const [index, row] of table.rows.entries()) {
    if (!Array.isArray(row) || row.length !== table.headers.length)
      fail('ROW_WIDTH', `${side} data record ${index + 1} does not match its header width.`);
    for (const cell of row) countString(cell);
  }
}

function keyGroups(table, keyIndex) {
  const groups = new Map();
  table.rows.forEach((row, index) => {
    const key = row[keyIndex];
    if (key.trim().length === 0) return;
    const group = groups.get(key);
    if (group) group.push(index + 1);
    else groups.set(key, [index + 1]);
  });
  return groups;
}

export function compareCsv(left, right, options = {}) {
  requireOptions(options, ['keyA', 'keyB', 'fields']);
  validateTable(left, 'Left');
  validateTable(right, 'Right');
  const { keyA, keyB } = options;
  if (typeof keyA !== 'string' || !left.headers.includes(keyA))
    fail('INVALID_KEY', 'Choose an existing left key column.');
  if (typeof keyB !== 'string' || !right.headers.includes(keyB))
    fail('INVALID_KEY', 'Choose an existing right key column.');

  const leftHeaderSet = new Set(left.headers);
  const rightHeaderSet = new Set(right.headers);
  const common = left.headers.filter((header) => rightHeaderSet.has(header));
  const eligibleFields = common.filter((header) => header !== keyA && header !== keyB);
  const fields = options.fields === undefined ? eligibleFields : options.fields;
  if (
    !Array.isArray(fields) ||
    fields.length > eligibleFields.length ||
    new Set(fields).size !== fields.length ||
    Array.from(fields).some((field) => typeof field !== 'string' || !eligibleFields.includes(field))
  )
    fail('INVALID_FIELDS', 'Comparison fields must be unique shared non-key columns.');
  const comparedFields = fields.slice();
  const fieldIndexes = comparedFields.map((field) => ({
    field,
    left: left.headers.indexOf(field),
    right: right.headers.indexOf(field),
  }));
  const leftKeyIndex = left.headers.indexOf(keyA);
  const rightKeyIndex = right.headers.indexOf(keyB);
  const leftGroups = keyGroups(left, leftKeyIndex);
  const rightGroups = keyGroups(right, rightKeyIndex);
  const duplicateKeys = new Set();
  for (const [key, group] of leftGroups) if (group.length > 1) duplicateKeys.add(key);
  for (const [key, group] of rightGroups) if (group.length > 1) duplicateKeys.add(key);

  const onlyA = [];
  const onlyB = [];
  const unresolvedA = [];
  const unresolvedB = [];
  const changed = [];
  let matched = 0;
  let unchanged = 0;
  left.rows.forEach((row, index) => {
    const key = row[leftKeyIndex];
    const record = index + 1;
    if (key.trim().length === 0) unresolvedA.push({ key, record, reason: 'blank_key' });
    else if (duplicateKeys.has(key)) unresolvedA.push({ key, record, reason: 'duplicate_key' });
    else if (!rightGroups.has(key)) onlyA.push({ key, record });
    else {
      matched += 1;
      const recordB = rightGroups.get(key)[0];
      const rowB = right.rows[recordB - 1];
      const changes = fieldIndexes
        .filter((item) => row[item.left] !== rowB[item.right])
        .map((item) => ({ field: item.field, before: row[item.left], after: rowB[item.right] }));
      if (changes.length === 0) unchanged += 1;
      else changed.push({ key, recordA: record, recordB, changes });
    }
  });
  right.rows.forEach((row, index) => {
    const key = row[rightKeyIndex];
    const record = index + 1;
    if (key.trim().length === 0) unresolvedB.push({ key, record, reason: 'blank_key' });
    else if (duplicateKeys.has(key)) unresolvedB.push({ key, record, reason: 'duplicate_key' });
    else if (!leftGroups.has(key)) onlyB.push({ key, record });
  });

  return {
    counts: {
      totalA: left.rows.length,
      totalB: right.rows.length,
      matched,
      unchanged,
      changed: changed.length,
      onlyA: onlyA.length,
      onlyB: onlyB.length,
      unresolvedA: unresolvedA.length,
      unresolvedB: unresolvedB.length,
    },
    onlyA,
    onlyB,
    unresolvedA,
    unresolvedB,
    changed,
    schema: {
      onlyA: left.headers.filter((header) => !rightHeaderSet.has(header)),
      onlyB: right.headers.filter((header) => !leftHeaderSet.has(header)),
      common,
    },
    comparedFields,
  };
}
