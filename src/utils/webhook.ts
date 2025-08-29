import axios from 'axios';
import { CONFIG } from '../config';
import { logger } from './logger';

export async function sendWebhook(url: string, payload: any) {
  let attempts = 0;
  const max = CONFIG.WEBHOOK_MAX_RETRIES;

  while (true) {
    attempts++;
    try {
      await axios.post(url, payload, { timeout: CONFIG.WEBHOOK_TIMEOUT_MS });
      return;
    } catch (err: any) {
      logger.warn({ err: err?.message, attempts, url }, 'webhook failed');
      if (attempts >= max) throw err;
      await new Promise(r => setTimeout(r, attempts * 1000));
    }
  }
}
