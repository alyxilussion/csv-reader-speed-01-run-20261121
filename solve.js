// A fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01): run(input)
// returns exactly what the reference returns for {text, header} —
// {columns, rows, errors} — but scans with indexOf instead of the reference's
// character-at-a-time loop.
//
// Two paths through a record:
//   - Line fast path: a record whose line holds no quote and no CR (a trailing
//     CRLF aside) is split on commas in one call.
//   - Field path: the general reader, driven by indexOf for the next delimiter
//     (comma / LF / CR / quote); a quoted field with no doubled quote and no CR
//     inside is sliced in one piece, and the slow walk over specials runs only
//     for quoted fields that actually hold one.
//
// The scans are amortised linear: once an indexOf for a character returns -1,
// no later scan for that character runs (the cursor only moves forward).

const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  // Once an indexOf for one of these returns -1 there is no more of it ahead.
  let noComma = false;
  let noLf = false;
  let noQuote = false;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at p, onto `init`. Returns [value, ended]
  // where ended is COMMA, BREAK or END. The field runs to the first comma or
  // line break (a CRLF counts as one break); a lone CR inside it is dropped
  // (stray_cr) and the field still ends at the same comma or break — so the
  // whole field is one slice, with its CRs taken out only when it holds any.
  function readUnquoted(p, init) {
    const comma = noComma ? -1 : text.indexOf(',', p);
    if (comma === -1) noComma = true;
    const lf = noLf ? -1 : text.indexOf('\n', p);
    if (lf === -1) noLf = true;
    let m = comma;
    let kind = COMMA;
    if (lf !== -1 && (m === -1 || lf < m)) { m = lf; kind = BREAK; }
    if (m === -1) {
      // To the end of the text; every CR in it is a lone one (no LF follows).
      const tail = text.slice(p);
      pos = n;
      if (tail.indexOf('\r') === -1) return [init + tail, END];
      const parts = tail.split('\r');
      for (let i = 1; i < parts.length; i++) error('stray_cr');
      return [init + parts.join(''), END];
    }
    // A CR right before the LF is the CRLF line break, not a stray CR.
    let contentEnd = m;
    if (kind === BREAK && m > p && text.charCodeAt(m - 1) === 13) contentEnd = m - 1;
    const seg = text.slice(p, contentEnd);
    let value;
    if (seg.indexOf('\r') === -1) {
      value = init + seg;
    } else {
      const parts = seg.split('\r');
      for (let i = 1; i < parts.length; i++) error('stray_cr');
      value = init + parts.join('');
    }
    if (kind === COMMA) {
      pos = m + 1;
      return [value, COMMA];
    }
    pos = m + 1;
    line += 1;
    return [value, BREAK];
  }

  // Reads a quoted field whose opening quote is at p. Returns [value, ended].
  function readQuoted(p) {
    const open = p;
    // The closing quote is the first quote not followed by another quote.
    let close = -1;
    let doubled = false;
    let q = noQuote ? -1 : text.indexOf('"', p + 1);
    if (q === -1) noQuote = true;
    while (q !== -1) {
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        q = text.indexOf('"', q + 2);
      } else {
        close = q;
        break;
      }
    }
    if (close === -1) {
      // Never closes: the quote is a literal character, and the text after it
      // is read again as an unquoted field (the line is untouched so far, so
      // no reset is needed — the reference's reset lands on the same number).
      error('unterminated_quote');
      return readUnquoted(open + 1, '"');
    }
    const s = open + 1;
    let value;
    // Slice the content once: the CR check and the LF count then run on the
    // slice, bounded by the field, instead of scanning the rest of the text.
    const content = text.slice(s, close);
    if (!doubled && content.indexOf('\r') === -1) {
      // Clean quoted content: the slice itself, plus the LF count.
      value = content;
      let np = content.indexOf('\n');
      while (np !== -1) {
        line += 1;
        np = content.indexOf('\n', np + 1);
      }
    } else {
      // Doubled quotes and/or CRs inside: walk the specials, one slice each.
      const parts = [];
      let cur = s;
      for (;;) {
        const nq = text.indexOf('"', cur);
        const nr = text.indexOf('\r', cur);
        const nl = text.indexOf('\n', cur);
        let m = nq;
        let kind = 0; // a doubled quote
        if (nr !== -1 && nr < close && (m === -1 || m >= close || nr < m)) { m = nr; kind = 1; }
        if (nl !== -1 && nl < close && (m === -1 || m >= close || nl < m)) { m = nl; kind = 2; }
        if (m === -1 || m >= close) {
          parts.push(text.slice(cur, close));
          break;
        }
        if (kind === 0) {
          parts.push(text.slice(cur, m));
          parts.push('"');
          cur = m + 2;
        } else if (kind === 1) {
          // A CR or CRLF inside quotes is one LF.
          parts.push(text.slice(cur, m));
          parts.push('\n');
          line += 1;
          cur = text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
        } else {
          // An LF inside quotes is kept, and the line moves on.
          parts.push(text.slice(cur, m + 1));
          line += 1;
          cur = m + 1;
        }
      }
      value = parts.join('');
    }
    // What follows the closing quote.
    const after = close + 1;
    if (after >= n) {
      pos = n;
      return [value, END];
    }
    const c = text.charCodeAt(after);
    if (c === 44) {
      pos = after + 1;
      return [value, COMMA];
    }
    if (c === 10) {
      pos = after + 1;
      line += 1;
      return [value, BREAK];
    }
    if (c === 13 && text.charCodeAt(after + 1) === 10) {
      pos = after + 2;
      line += 1;
      return [value, BREAK];
    }
    // Junk after the closing quote, appended as it stands up to the next
    // comma or line break; the error goes in after any stray_cr met inside.
    const junk = readUnquoted(after, value);
    if (junk[0].length > value.length) error('quote_junk');
    return junk;
  }

  // A record's fields, once read: the header, or a row padded or cut to the
  // first record's width, with its error.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Line fast path: the rest of this line holds no quote and no CR (a
    // trailing CRLF aside), so the whole record is one split on commas.
    let nl = text.indexOf('\n', pos);
    const hasNl = nl !== -1;
    if (!hasNl) nl = n;
    let end = nl;
    if (hasNl && text.charCodeAt(nl - 1) === 13) end = nl - 1;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      const fields = seg.split(',');
      pos = hasNl ? nl + 1 : n;
      if (hasNl) line += 1;
      finishRecord(fields);
      continue;
    }

    // General path: one field at a time.
    const fields = [];
    let lastQuoted = false;
    let ended;
    do {
      let field;
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        field = readQuoted(pos);
      } else {
        lastQuoted = false;
        field = readUnquoted(pos, '');
      }
      fields.push(field[0]);
      ended = field[1];
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
