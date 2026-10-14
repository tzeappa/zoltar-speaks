import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { service: 'zoltar' },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname,service' } } }
      : {}),
  });
}

export const silentLogger: Logger = pino({ level: 'silent' });
