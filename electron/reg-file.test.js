const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReg, decodeReg, encodeReg, under } = require('./reg-file');

const T = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY';
const reg = (...lines) => ['Windows Registry Editor Version 5.00', '', ...lines, ''].join('\r\n');
const ok = (text, target = T) => { const r = parseReg(text, { target }); assert.ok(r.ok, r.reason); return r; };
const bad = (text, pattern, target = T) => { const r = parseReg(text, { target }); assert.equal(r.ok, false, 'should be refused'); assert.match(r.reason, pattern); };

test('a normal export is accepted: strings, numbers, the default value, binary, expandable and multi-line hex values', () => {
  const r = ok(reg(
    `[${T}]`, '@="default"', '"Name"="a value"', '"Count"=dword:0000002a', '"Blob"=hex:01,02,ff', '"Path"=hex(2):25,00,50,00,41,00,54,00,48,00,25,00,00,00',
    '"Long"=hex:00,01,02,03,04,05,\\', '  06,07,08,09,0a,0b,\\', '  0c,0d', '"Empty"=hex:',
    `[${T}\\Sessions\\Default%20Settings]`, '"HostName"="example.org"',
  ));
  assert.deepEqual(r.keys, [T, `${T}\\Sessions\\Default%20Settings`]);
  const by = (n) => r.values.find((v) => v.name === n);
  assert.deepEqual([by('').type, by('').data], ['sz', 'default']);
  assert.deepEqual([by('Count').type, by('Count').data], ['dword', 42]);
  assert.equal(by('Blob').type, 'hex');
  assert.equal(r.values.length, 8);
});

test('what looks like a deletion inside a string is just text; real deletions are refused', () => {
  const r = ok(reg(`[${T}]`, '"Args"="-x=-1"', '"Odd"="=-"'));
  assert.equal(r.values[0].data, '-x=-1');
  bad(reg(`[-${T}]`), /delete a key/);
  bad(reg(`[${T}]`, '"Gone"=-'), /delete a value/);
  bad(reg(`[${T}]`, '@=-'), /delete a value/);
});

test('only the backed-up key and the keys below it may appear', () => {
  bad(reg(`[${T}]`, '"x"="1"', '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]', '"evil"="calc.exe"'), /other than the one/);
  bad(reg(`[HKEY_LOCAL_MACHINE\\SOFTWARE\\SimonTatham\\PuTTY]`, '"x"="1"'), /other than the one/);
  bad(reg(`[${T}Evil]`, '"x"="1"'), /other than the one/);
  bad(reg('"x"="1"'), /expected form|not in a form/i);
  bad(reg(`[HKEY_CURRENT_USER\\Software\\SimonTatham]`, '"x"="1"'), /other than the one/);
  assert.ok(under(`${T}\\Sessions`, T) && under(T.toUpperCase(), T) && !under(`${T}2`, T));
  bad(reg(`[${T}\\Sessions]`, '"x"="1"'), /does not contain the key it is for/);
  assert.deepEqual(ok(reg(`[${T}]`)).keys, [T], 'an empty key is a valid backup: reg export writes just the header');
  bad(reg(), /does not contain|no key/);
});

test('the target must be a key of the two supported kinds', () => {
  for (const t of [undefined, '', 'HKEY_USERS\\S-1\\Software\\X', 'Software\\X', 'HKEY_CLASSES_ROOT\\Foo']) {
    const r = parseReg(reg(`[${T}]`), { target: t });
    assert.equal(r.ok, false, String(t));
    assert.match(r.reason, /does not say which key/);
  }
  ok(reg('[HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor]', '"a"="b"'), 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor');
});

test('the header must be exactly the version 5 one; older or missing headers are refused', () => {
  bad(['REGEDIT4', '', `[${T}]`, '"a"="b"'].join('\r\n'), /not a registry export/);
  bad(`[${T}]\r\n"a"="b"\r\n`, /not a registry export/);
  bad('', /not a registry export/);
  ok(`\r\n\r\n${reg(`[${T}]`, '"a"="b"')}`); // blank lines first are fine
  ok(reg('; a comment', `[${T}]`, '"a"="b"'));
});

test('a line this app does not recognise is refused, with its number and never its content', () => {
  const r = parseReg(reg(`[${T}]`, '"a"="b"', 'something odd here'), { target: T });
  assert.equal(r.ok, false);
  assert.match(r.reason, /line 5/);
  assert.doesNotMatch(r.reason, /odd/);
  bad(reg(`[${T}]`, '"a"=dword:xyz'), /not in a form/);
  bad(reg(`[${T}]`, '"a"=dword:1'), /not in a form/);
  bad(reg(`[${T}]`, '"a"=hex(zz):00'), /not in a form/);
  bad(reg(`[${T}]`, '"a"=hex:0'), /not in a form/);
  bad(reg(`[${T}]`, '"unterminated=hex:00'), /not in a form/);
});

test('a trailing backslash does not hide a second line: only real hex continuations are joined', () => {
  // as reg.exe may see it: line one is broken, line two is a key deletion. Joined naively it would look like one harmless string.
  bad(reg(`[${T}]`, '"a"="x\\', `[-${T}]"`), /not in a form|delete a key/);
  bad(reg(`[${T}]`, '"a"="x"\\', '[-HKEY_CURRENT_USER\\Software\\Other]'), /not in a form|delete a key/);
  bad(reg(`[${T}]`, '"a"=hex:00,\\', '[-HKEY_CURRENT_USER\\Software\\Other]'), /not in a form/);
  bad(reg(`[${T}]`, '"a"=dword:00000001\\', '"b"="c"'), /not in a form/);
});

test('escapes in names and strings are read back as the real characters', () => {
  const r = ok(reg(`[${T}]`, '"na\\"me"="va\\\\lue \\"q\\""'));
  assert.equal(r.values[0].name, 'na"me');
  assert.equal(r.values[0].data, 'va\\lue "q"');
});

test('size limits: a huge file, too many lines and too many keys are refused', () => {
  bad(reg(`[${T}]`, `"a"="${'x'.repeat(70000)}"`), /too big/);
  bad(['Windows Registry Editor Version 5.00', `[${T}]`, ...Array.from({ length: 4100 }, () => '@=""')].join('\n'), /too many lines/);
  bad(reg(...Array.from({ length: 305 }, (_, i) => `[${T}\\k${i}]`).concat([`[${T}]`])), /too many keys/);
});

test('text round trips as UTF-16 with a byte-order mark, byte for byte, as reg export writes it', () => {
  const text = reg(`[${T}]`, '"Name"="Grüße, 日本語"', '"Path"="C:\\\\Program Files\\\\X"');
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeReg(original), text);
  assert.deepEqual(encodeReg(decodeReg(original)), original);
  assert.equal(decodeReg(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), text);
  assert.equal(decodeReg(Buffer.from(text, 'utf8')), text);
  assert.equal(ok(decodeReg(original)).values[0].data, 'Grüße, 日本語');
});
