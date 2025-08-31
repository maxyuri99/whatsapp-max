import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const pretty = String(process.env.LOG_PRETTY ?? (process.env.NODE_ENV !== 'production')).toLowerCase() === 'true';
const colorize = String(process.env.LOG_COLOR ?? (process.env.NODE_ENV !== 'production')).toLowerCase() === 'true';

export const logger = pino({
  level,
  transport: pretty ? {
    target: 'pino-pretty',
    options: {
      colorize,
      translateTime: 'SYS:standard',
      singleLine: true,
      ignore: 'pid,hostname',
      messageFormat: '{msg} session={sessionId} status={status} reason={reason} err={err} port={port}'
    }
  } : undefined
});
