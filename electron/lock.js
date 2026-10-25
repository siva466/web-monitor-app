// Installing and uninstalling must not overlap: Windows runs only one installer at a time, and two prompts at once confuse people.
let busy = false;

async function withLock(fn) {
  if (busy) throw new Error('Another install or uninstall is already running. Wait for it to finish.');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

module.exports = { withLock };
