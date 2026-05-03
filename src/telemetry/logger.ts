import pino from 'pino';

let _logger: pino.Logger | null = null;

export function createLogger(verbose: boolean): pino.Logger {
  _logger = pino({
    level: verbose ? 'debug' : 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: 'info' });
  }
  return _logger;
}
