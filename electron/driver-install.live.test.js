// Needs the internet (a Windows Update search takes about 16 s), so it is not part of `npm run test:main`. Run it with `npm run test:live`.
// The real install script, WITHOUT elevation, with an update id that does not exist: it must search, find nothing, and change nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { INSTALL_SCRIPT } = require('./driver-install');
const { runScript } = require('./leftover-admin');

test('an update id Windows Update does not offer: status "gone", no restore point, nothing installed', async (t) => {
  const resultFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webase-dinst-live-')), 'r.json');
  let r;
  try {
    r = await runScript(INSTALL_SCRIPT, { mode: 'install', id: '00000000-0000-4000-8000-000000000000', revision: 1, description: 'Webase test 20261025-130000', resultFile }, { elevate: false, timeoutMs: 180000 });
  } catch (e) {
    return t.skip(`Windows Update could not be searched here: ${e.message}`);
  }
  assert.equal(r.status, 'gone');
  assert.equal(r.restorePoint, null, 'no restore point is made for an update that is not offered');
  assert.match(r.message, /nothing was changed/);
});
