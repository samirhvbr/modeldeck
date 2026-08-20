import fs from 'node:fs';
import { isSea } from 'node:sea';
import { bootstrapDaemonStderr } from './daemon-error-log.mjs';
import { DAEMON_ERROR_LOG_PATH } from './paths.mjs';

function redactObviousSecrets(value) {
  return value
    .replace(/\?[A-Za-z0-9_.~%-]+=[^\s,;#]*/g, '?[REDACTED]')
    .replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, 'Bearer [REDACTED]')
    .replace(
      /\b((?:api[_-]?)?key|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function errorName(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'Error';
  try {
    return typeof error.name === 'string' && error.name.trim() ? error.name : 'Error';
  } catch {
    return 'Error';
  }
}

function errorMessage(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      return typeof error.message === 'string' && error.message.trim()
        ? error.message
        : 'Unknown error';
    } catch {
      return 'Unknown error';
    }
  }
  return error == null ? 'Unknown error' : String(error);
}

function writeStartupError(message) {
  try {
    process.stderr.write(message);
  } catch {
    // Startup must not fail only because its diagnostic sink is unavailable.
  }
}

function writeFatalError(kind, error) {
  const name = redactObviousSecrets(errorName(error));
  const message = redactObviousSecrets(errorMessage(error));
  try {
    fs.writeSync(2, `[modeldeck] ${kind}: ${name}: ${message}\n`);
  } catch {
    // There is no safe fallback once fd 2 itself is unavailable.
  }
}

function exitAfterFatalError(kind, error) {
  writeFatalError(kind, error);
  process.exit(1);
}

process.once('uncaughtException', (error) => {
  exitAfterFatalError('uncaughtException', error);
});
process.once('unhandledRejection', (reason) => {
  // Node's default is fatal. Installing a listener suppresses that default,
  // so terminate explicitly after replacing its raw dump with one safe line.
  exitAfterFatalError('unhandledRejection', reason);
});

async function start() {
  try {
    bootstrapDaemonStderr({
      logPath: DAEMON_ERROR_LOG_PATH,
      enabled: isSea(),
    });
  } catch (error) {
    // A logging-path problem must not turn into a daemon outage. This write
    // reaches launchd's inherited stderr when redirection could not be set up.
    writeStartupError(`[modeldeck] could not redirect daemon stderr: ${redactObviousSecrets(errorMessage(error))}\n`);
  }
  await import('./server.mjs');
}

void start().catch((error) => {
  writeStartupError(`ModelDeck failed before server startup: ${redactObviousSecrets(errorMessage(error))}\n`);
  process.exitCode = 1;
});
