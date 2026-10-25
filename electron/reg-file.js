// Reads a .reg file that this app exported, and decides whether it is safe to import again.
// A .reg file can do much more than restore a key: it can delete keys (`[-key]`), delete values (`"name"=-`) and write anywhere. So this
// is a strict reader, not a clean-up: it accepts only the shapes `reg export` writes, for one target key and the keys below it, and it
// refuses everything else. What it accepts is imported UNCHANGED (the original text, as UTF-16 with a byte-order mark).

const MAX_BYTES = 64 * 1024;
const MAX_LINES = 4000;
const MAX_KEYS = 300;
const HEADER = 'Windows Registry Editor Version 5.00';

// "name" or @ , then =, then one data token
const NAME = String.raw`(@|"(?:[^"\\]|\\.)*")`;
const STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const HEX = String.raw`hex(?:\([0-9a-fA-F]{1,2}\))?:(?:[0-9a-fA-F]{2}(?:,[0-9a-fA-F]{2})*)?`;
const VALUE = new RegExp(String.raw`^${NAME}=(${STRING}|dword:[0-9a-fA-F]{8}|${HEX})$`);
const HEX_START = new RegExp(String.raw`^${NAME}=hex(?:\([0-9a-fA-F]{1,2}\))?:[0-9a-fA-F,\s]*\\$`);

// UTF-16 (what `reg export` writes) or UTF-8, with or without a byte-order mark.
function decodeReg(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

// The bytes to write back: the original text as UTF-16 little-endian with a byte-order mark, exactly as `reg export` produces it.
const encodeReg = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

const unescapeString = (token) => token.slice(1, -1).replace(/\\(.)/g, '$1'); // \\ -> \ and \" -> "

const under = (key, target) => key.toLowerCase() === target.toLowerCase() || key.toLowerCase().startsWith(`${target.toLowerCase()}\\`);

// target: the key the backup is for. Only that key and its subkeys may appear.
function parseReg(text, { target, maxBytes = MAX_BYTES } = {}) {
  const refuse = (reason) => ({ ok: false, reason });
  if (typeof target !== 'string' || !/^HKEY_(CURRENT_USER|LOCAL_MACHINE)\\/.test(target)) return refuse('The backup does not say which key it is for.');
  if (Buffer.byteLength(text, 'utf16le') > maxBytes) return refuse('The backup file is too big to restore from here.');

  // Join the continuation lines of long hex values ("hex:..,\" goes on at the next line). ONLY those: any other line that ends with a
  // backslash stays as it is and fails the checks below, so this reader and reg.exe cannot disagree about where a line ends.
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  if (raw.length > MAX_LINES) return refuse('The backup file has too many lines.');
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i].replace(/[ \t]+$/, '');
    if (HEX_START.test(line)) {
      while (line.endsWith('\\') && i + 1 < raw.length) line = line.slice(0, -1) + raw[++i].trim();
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  const first = lines.findIndex((l) => l !== '');
  if (first < 0 || lines[first] !== HEADER) return refuse('This is not a registry export of the expected kind.');

  const keys = [];
  const values = [];
  let key = null;
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' || line.startsWith(';')) continue;
    const at = `line ${i + 1}`;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const k = header[1];
      if (k.startsWith('-')) return refuse(`The file would delete a key (${at}).`);
      if (!under(k, target)) return refuse(`The file touches a key other than the one that was backed up (${at}).`);
      key = k;
      keys.push(k);
      if (keys.length > MAX_KEYS) return refuse('The backup file has too many keys.');
      continue;
    }
    const m = VALUE.exec(line);
    if (!m || key === null) {
      // a lone "-" as the data would delete the value; anything else unknown is refused too
      return refuse(/=-$/.test(line) ? `The file would delete a value (${at}).` : `A line is not in a form this app restores (${at}).`);
    }
    const name = m[1] === '@' ? '' : unescapeString(m[1]);
    const data = m[2];
    if (data.startsWith('"')) values.push({ key, name, type: 'sz', data: unescapeString(data) });
    else if (data.startsWith('dword:')) values.push({ key, name, type: 'dword', data: parseInt(data.slice(6), 16) });
    else values.push({ key, name, type: 'hex', data: null }); // binary, expandable and multi-line values: compared by name only
  }
  if (!keys.length) return refuse('The backup file has no key in it.');
  if (!keys.some((k) => k.toLowerCase() === target.toLowerCase())) return refuse('The backup file does not contain the key it is for.');
  return { ok: true, keys, values };
}

module.exports = { parseReg, decodeReg, encodeReg, under, MAX_BYTES, HEADER };
