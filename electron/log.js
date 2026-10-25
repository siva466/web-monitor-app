const fs = require('fs');
const path = require('path');

// A small error log for the installed app: %LOCALAPPDATA%\WebaseSystemMonitor\logs\app.log. It records WHAT went wrong (the channel or
// event and the error message), never the arguments of a request. The folder is created the first time something is logged, so a
// healthy run leaves nothing behind. At 1 MB the file moves to app.old.log (one old file is kept).

const MAX_BYTES = 1024 * 1024;
const MAX_LINE = 600;

const defaultDir = () => path.join(process.env.LOCALAPPDATA || '', 'WebaseSystemMonitor', 'logs');

function createLogger({ dir = defaultDir(), now = () => new Date(), maxBytes = MAX_BYTES } = {}) {
  const file = path.join(dir, 'app.log');
  function write(kind, where, error) {
    try {
      if (!dir || !path.isAbsolute(dir)) return;
      const msg = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
      const line = `${now().toISOString()} ${kind} ${where}: ${msg}\n`;
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size + line.length > maxBytes) fs.renameSync(file, path.join(dir, 'app.old.log')); // replaces the older one
      } catch {
        // no file yet
      }
      fs.appendFileSync(file, line);
    } catch {
      // logging must never be the thing that breaks the app
    }
  }
  return { error: (where, e) => write('ERROR', where, e), crash: (where, e) => write('CRASH', where, e), file };
}

module.exports = { createLogger, defaultDir };
