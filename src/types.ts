export type SessionStatus =
  | 'INITIALIZING'
  | 'QRCODE'
  | 'AUTHENTICATED'
  | 'READY'
  | 'DISCONNECTED'
  | 'AUTH_FAILURE'
  | 'FAILED';

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  webhookUrl?: string;
  lastStatus?: SessionStatus;
  lastConnectionAt?: string;
}
