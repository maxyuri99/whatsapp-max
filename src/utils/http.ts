import { Response } from 'express';

export function ok(res: Response, data?: any, message: string = 'ok', status = 200) {
  const payload = data && typeof data === 'object' ? { message, ...data } : { message };
  return res.status(status).json(payload);
}

export function fail(res: Response, error: string, status = 400, message?: string, extra?: any) {
  const payload: any = { error };
  if (message) payload.message = message;
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  return res.status(status).json(payload);
}

