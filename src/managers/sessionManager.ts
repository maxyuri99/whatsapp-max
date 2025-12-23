import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";
import { AnyMessageContent, DisconnectReason, WAMessage, WASocket, fetchLatestBaileysVersion, makeWASocket, useMultiFileAuthState } from "@whiskeysockets/baileys";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";
import { sendWebhook } from "../utils/webhook";
import type { SessionMeta, SessionStatus } from "../types";
import { buildBaileysMedia } from "../utils/media";

type InMemorySession = {
    sock: WASocket;
    status: SessionStatus;
    qrData?: string;
    qrRaw?: string;
    meta: SessionMeta;
    retryAttempt?: number;
    retryTimer?: NodeJS.Timeout | null;
    closing?: boolean;
    authPath: string;
    saveCreds: () => Promise<void>;
    messages: Map<string, WAMessage[]>;
    chats: Set<string>;
};

export class SessionManager {
    private sessions = new Map<string, InMemorySession>();

    constructor() {
        if (!fs.existsSync(CONFIG.SESSIONS_DIR)) {
            fs.mkdirSync(CONFIG.SESSIONS_DIR, { recursive: true });
        }
    }

    async bootstrapFromDisk() {
        const dirs = fs
            .readdirSync(CONFIG.SESSIONS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        for (const sessionId of dirs) {
            try {
                const ok = await this.startSocket(sessionId);
                const ready = await this.waitForReadyOrTimeout(sessionId, CONFIG.BOOTSTRAP_READY_TIMEOUT_MS);
                logger.info({ sessionId, ready }, "bootstrapped session");
                if (!ok) this.scheduleRetry(sessionId);
            } catch (err: any) {
                logger.warn({ sessionId, err: err?.message }, "bootstrap failed; skipping");
            }
        }
    }

    list() {
        return Array.from(this.sessions.values()).map((s) => ({
            sessionId: s.meta.sessionId,
            status: s.status,
            webhookUrl: s.meta.webhookUrl,
            lastConnectionAt: s.meta.lastConnectionAt,
            updatedAt: s.meta.updatedAt,
        }));
    }

    private sessionDir(sessionId: string) {
        return path.join(CONFIG.SESSIONS_DIR, sessionId);
    }

    private metaPath(sessionId: string) {
        return path.join(this.sessionDir(sessionId), "meta.json");
    }

    private readMeta(sessionId: string): SessionMeta {
        const p = this.metaPath(sessionId);
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        const now = new Date().toISOString();
        return { sessionId, createdAt: now, updatedAt: now };
    }

    private writeMeta(meta: SessionMeta) {
        const dir = this.sessionDir(meta.sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        meta.updatedAt = new Date().toISOString();
        fs.writeFileSync(this.metaPath(meta.sessionId), JSON.stringify(meta, null, 2), "utf-8");
    }

    async createNewSession(sessionId: string) {
        if (this.sessions.has(sessionId)) throw new Error("Session already exists (in memory)");
        const dir = this.sessionDir(sessionId);
        if (fs.existsSync(dir)) throw new Error("Session already exists (on disk)");
        fs.mkdirSync(dir, { recursive: true });
        this.writeMeta(this.readMeta(sessionId));
        return this.startSocket(sessionId);
    }

    private normalizeToJid(to: string) {
        let digits = to.replace(/\D/g, "");
        if (!digits.startsWith(CONFIG.COUNTRY_CODE_DEFAULT)) digits = `${CONFIG.COUNTRY_CODE_DEFAULT}${digits}`;
        if (!digits.endsWith("@s.whatsapp.net") && !digits.endsWith("@g.us")) {
            digits = `${digits}@s.whatsapp.net`;
        }
        return digits;
    }

    private async resolveTarget(sessionId: string, chatId?: string, to?: string): Promise<string> {
        if (chatId) return chatId;
        if (to) return this.normalizeToJid(to);
        throw new Error("chatId or to is required");
    }

    async setWebhook(sessionId: string, url?: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        s.meta.webhookUrl = url;
        this.writeMeta(s.meta);
        return { sessionId, webhookUrl: url || null };
    }

    async getStatus(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        return { sessionId, status: s.status, webhookUrl: s.meta.webhookUrl, lastConnectionAt: s.meta.lastConnectionAt };
    }

    async getQr(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status === "READY" || s.status === "AUTHENTICATED") return { message: "Already authenticated / ready" };
        if (s.status === "INITIALIZING" && !s.qrData) {
            const e: any = new Error("Initializing; QR not ready yet");
            e.code = "INITIALIZING";
            throw e;
        }
        if (!s.qrData) throw new Error("QR not available yet");
        return { dataUrl: s.qrData };
    }

    async getQrPng(sessionId: string, width = 350): Promise<Buffer> {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status === "READY" || s.status === "AUTHENTICATED") {
            const err: any = new Error("Already authenticated / ready");
            err.code = "ALREADY_AUTHENTICATED";
            throw err;
        }
        if (s.status === "INITIALIZING" && !s.qrRaw) {
            const e: any = new Error("Initializing; QR not ready yet");
            e.code = "INITIALIZING";
            throw e;
        }
        if (!s.qrRaw) throw new Error("QR not available yet");
        return QRCode.toBuffer(s.qrRaw, { type: "png", width, margin: 2 });
    }

    private waitForQrRaw(sessionId: string, timeoutMs = 10000): Promise<string> {
        return new Promise((resolve, reject) => {
            const s = this.sessions.get(sessionId);
            if (!s) return reject(new Error("Session not found"));
            const started = Date.now();
            const tick = () => {
                const now = Date.now();
                if (s.status === "READY" || s.status === "AUTHENTICATED") {
                    const e: any = new Error("Already authenticated / ready");
                    e.code = "ALREADY_AUTHENTICATED";
                    return reject(e);
                }
                if (s.qrRaw) return resolve(s.qrRaw);
                if (now - started >= timeoutMs) {
                    const e: any = new Error("QR timeout");
                    e.code = "QR_TIMEOUT";
                    return reject(e);
                }
                setTimeout(tick, 150);
            };
            tick();
        });
    }

    async waitForQrDataUrl(sessionId: string, timeoutMs = 10000): Promise<string> {
        const raw = await this.waitForQrRaw(sessionId, timeoutMs);
        return QRCode.toDataURL(raw);
    }

    async waitForQrPng(sessionId: string, width = 350, timeoutMs = 10000): Promise<Buffer> {
        const raw = await this.waitForQrRaw(sessionId, timeoutMs);
        return QRCode.toBuffer(raw, { type: "png", width, margin: 2 });
    }

    private clearRetry(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        try {
            if (s.retryTimer) clearTimeout(s.retryTimer);
        } catch {}
        s.retryTimer = null;
        s.retryAttempt = 0;
    }

    private scheduleRetry(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        if (s.status !== "FAILED") return;
        if (s.retryTimer) return;
        const attempt = s.retryAttempt || 0;
        if (attempt >= CONFIG.RECONNECT_MAX_ATTEMPTS) return;
        const delay = Math.min(CONFIG.RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), CONFIG.RECONNECT_MAX_DELAY_MS);
        s.retryAttempt = attempt + 1;
        s.retryTimer = setTimeout(async () => {
            s.retryTimer = null;
            try {
                await this.restart(sessionId);
                const cur = this.sessions.get(sessionId);
                if (cur) {
                    cur.retryAttempt = 0;
                    cur.retryTimer = null;
                }
            } catch {
                this.scheduleRetry(sessionId);
            }
        }, delay);
    }

    private waitForReadyOrTimeout(sessionId: string, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            const s = this.sessions.get(sessionId);
            if (!s) return resolve(false);
            if (s.status === "READY") return resolve(true);
            let done = false;
            const t = setTimeout(() => {
                if (!done) {
                    done = true;
                    resolve(false);
                }
            }, timeoutMs);
            const poll = setInterval(() => {
                const st = this.sessions.get(sessionId)?.status;
                if (st === "READY") {
                    clearTimeout(t);
                    clearInterval(poll);
                    if (!done) {
                        done = true;
                        resolve(true);
                    }
                }
            }, 300);
        });
    }

    private buildMessagePayload = async (
        payload: { type?: string; body?: string; media?: { url?: string; base64?: string; mimetype?: string; filename?: string }; caption?: string }
    ): Promise<{ content: AnyMessageContent; type: string }> => {
        const kind = (payload.type || (payload.media ? "media" : "text")).toLowerCase();
        if (kind === "text") {
            if (!payload.body) throw new Error("body is required for text");
            return { type: "text", content: { text: payload.body } };
        }
        if (!payload.media) throw new Error("media is required");
        const media = await buildBaileysMedia(payload.media);
        const caption = payload.caption || payload.body;
        if ((payload.type || "").toLowerCase() === "document") {
            return { type: "document", content: { document: media.data, mimetype: media.mimetype, fileName: media.filename, caption } };
        }
        if (media.mimetype.startsWith("image/")) {
            return { type: "image", content: { image: media.data, mimetype: media.mimetype, caption } };
        }
        if (media.mimetype.startsWith("video/")) {
            return { type: "video", content: { video: media.data, mimetype: media.mimetype, caption } };
        }
        if (media.mimetype.startsWith("audio/")) {
            return { type: "audio", content: { audio: media.data, mimetype: media.mimetype, ptt: false } };
        }
        return { type: "document", content: { document: media.data, mimetype: media.mimetype, fileName: media.filename, caption } };
    };

    private async startSocket(sessionId: string): Promise<InMemorySession> {
        if (this.sessions.has(sessionId)) return this.sessions.get(sessionId)!;
        const dir = this.sessionDir(sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const authPath = path.join(dir, "auth");

        const { state, saveCreds } = await useMultiFileAuthState(authPath);

        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            syncFullHistory: false,
        });
        const entry: InMemorySession = {
            sock,
            status: "INITIALIZING",
            meta: this.readMeta(sessionId),
            retryAttempt: 0,
            retryTimer: null,
            closing: false,
            authPath,
            saveCreds,
            messages: new Map(),
            chats: new Set(),
        };
        this.sessions.set(sessionId, entry);

        sock.ev.on("creds.update", entry.saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                entry.status = "QRCODE";
                entry.qrRaw = qr;
                try {
                    entry.qrData = await QRCode.toDataURL(qr);
                } catch (err: any) {
                    logger.error({ sessionId, err: err?.message }, "qr encode failed");
                }
                await this.emit(sessionId, "qr", { sessionId, status: entry.status });
            }
            if (connection === "open") {
                entry.status = "READY";
                entry.qrData = undefined;
                entry.qrRaw = undefined;
                entry.meta.lastConnectionAt = new Date().toISOString();
                this.writeMeta(entry.meta);
                await this.emit(sessionId, "ready", { sessionId, status: entry.status });
            }
            if (connection === "close") {
                const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
                const reason = statusCode === DisconnectReason.loggedOut ? "logged_out" : "connection_closed";
                logger.warn({ sessionId, statusCode, reason }, "connection closed");
                if (statusCode === DisconnectReason.loggedOut) {
                    entry.status = "AUTH_FAILURE";
                    await this.emit(sessionId, "auth_failure", { sessionId, status: entry.status });
                } else {
                    entry.status = "FAILED";
                    this.scheduleRetry(sessionId);
                    await this.emit(sessionId, "disconnected", { sessionId, status: entry.status });
                }
            }
        });

        sock.ev.on("messages.upsert", async ({ messages }) => {
            for (const msg of messages) {
                const mapped = this.mapMessagePayload(sessionId, msg);
                if (mapped.to) entry.chats.add(mapped.to);
                const list = entry.messages.get(mapped.to || "unknown") || [];
                list.push(msg);
                if (list.length > 500) list.shift();
                entry.messages.set(mapped.to || "unknown", list);
                await this.emit(sessionId, "message", mapped);
            }
        });

        sock.ev.on("messages.update", async (updates) => {
            for (const upd of updates) {
                const ack = (upd.update as any)?.status;
                if (ack === undefined) continue;
                await this.emit(sessionId, "message_ack", {
                    sessionId,
                    id: upd.key.id,
                    to: upd.key.remoteJid,
                    ack,
                });
            }
        });

        return entry;
    }

    private mapMessagePayload(sessionId: string, msg: WAMessage) {
        const id = msg.key.id;
        const remote = msg.key.remoteJid;
        const from = msg.key.fromMe ? sessionId : msg.key.participant || remote;
        const timestamp = Number(msg.messageTimestamp || Date.now());
        const content = msg.message || {};
        const body =
            (content.conversation as string | undefined) ||
            (content.extendedTextMessage?.text as string | undefined) ||
            (content.imageMessage?.caption as string | undefined) ||
            (content.videoMessage?.caption as string | undefined) ||
            "";
        const type = content.imageMessage
            ? "image"
            : content.videoMessage
            ? "video"
            : content.audioMessage
            ? "audio"
            : content.documentMessage
            ? "document"
            : "text";
        const hasMedia = Boolean(content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage);
        return { sessionId, id, from, to: remote, timestamp, type, body, fromMe: msg.key.fromMe, hasMedia, ack: msg.status };
    }

    async listChats(sessionId: string, page = 1, limit = 10) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        const chats = Array.from(s.chats);
        const total = chats.length;
        const l = Math.max(1, Math.min(100, Number(limit) || 10));
        const p = Math.max(1, Number(page) || 1);
        const pages = Math.max(1, Math.ceil(total / l));
        const start = (p - 1) * l;
        const slice = chats.slice(start, start + l);
        const ids = slice;
        return { sessionId, page: p, limit: l, total, pages, ids };
    }

    async sendText(sessionId: string, to: string, message: string) {
        const target = await this.resolveTarget(sessionId, undefined, to);
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const sent = await s.sock.sendMessage(target, { text: message });
        if (!sent) throw new Error("Failed to send message");
        return { id: sent.key.id, to: target, chatId: target, timestamp: Number(sent.messageTimestamp || Date.now()), type: "text", body: message };
    }

    async sendAdvanced(
        sessionId: string,
        payload: { chatId?: string; to?: string; type?: string; body?: string; media?: { url?: string; base64?: string; mimetype?: string; filename?: string }; caption?: string }
    ) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const target = await this.resolveTarget(sessionId, payload.chatId, payload.to);
        const { content, type } = await this.buildMessagePayload(payload);
        const sent = await s.sock.sendMessage(target, content);
        if (!sent) throw new Error("Failed to send message");
        return {
            id: sent.key.id,
            to: target,
            chatId: target,
            timestamp: Number(sent.messageTimestamp || Date.now()),
            type,
            body: payload.body,
        };
    }

    async getMessages(sessionId: string, chatId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const jid = this.normalizeToJid(chatId);
        const msgs = s.messages.get(jid) || [];
        const simplified = msgs.map((m: any) => {
            const mapped = this.mapMessagePayload(sessionId, m);
            return {
                id: m.key?.id,
                from: m.key?.participant || m.key?.remoteJid,
                to: m.key?.remoteJid,
                timestamp: Number(m.messageTimestamp || Date.now()),
                dateSent: new Date(Number(m.messageTimestamp || Date.now()) * 1000).toISOString(),
                type: mapped.type,
                body: mapped.body,
                fromMe: Boolean(m.key?.fromMe),
                hasMedia: mapped.hasMedia,
                ack: m.status,
            };
        });
        return { sessionId, chatId: jid, total: simplified.length, messages: simplified };
    }

    async resolveChatId(sessionId: string, phoneRaw: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (!phoneRaw || !phoneRaw.trim()) throw new Error("phone is required");
        let digits = String(phoneRaw).replace(/\D/g, "");
        if (!digits.startsWith(CONFIG.COUNTRY_CODE_DEFAULT)) digits = `${CONFIG.COUNTRY_CODE_DEFAULT}${digits}`;
        const found = await s.sock.onWhatsApp(digits);
        const match = Array.isArray(found) ? found[0] : undefined;
        const exists = Boolean(match?.exists);
        const chatId = exists && match ? match.jid : `${digits}@s.whatsapp.net`;
        return { sessionId, phone: digits, exists, chatId };
    }

    async destroy(sessionId: string, deleteData = false) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        try {
            s.closing = true;
            await s.sock?.logout();
            await s.sock?.ws.close();
        } catch {}
        s.closing = false;
        this.clearRetry(sessionId);
        this.sessions.delete(sessionId);
        if (deleteData) {
            await this.deleteSessionFolder(sessionId);
        }
        return { sessionId, deletedData: deleteData };
    }

    private async deleteSessionFolder(sessionId: string) {
        const dir = this.sessionDir(sessionId);
        if (fs.existsSync(dir)) {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    }

    async restart(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        try {
            s.closing = true;
            await s.sock?.ws.close();
        } catch {}
        s.closing = false;
        this.clearRetry(sessionId);
        this.sessions.delete(sessionId);
        const entry = await this.startSocket(sessionId);
        return { sessionId, status: entry.status };
    }

    async resetAuth(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (s) {
            try {
                await s.sock?.logout();
                await s.sock?.ws.close();
            } catch {}
            this.sessions.delete(sessionId);
        }
        this.clearRetry(sessionId);
        const dir = this.sessionDir(sessionId);
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        fs.mkdirSync(dir, { recursive: true });
        this.writeMeta(this.readMeta(sessionId));
        const entry = await this.startSocket(sessionId);
        return { sessionId, status: entry.status };
    }

    async unfail(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "FAILED") return { sessionId, status: s.status };
        return this.restart(sessionId);
    }

    private async emit(sessionId: string, event: string, payload: any) {
        const s = this.sessions.get(sessionId);
        if (!s?.meta.webhookUrl) return;
        try {
            await sendWebhook(s.meta.webhookUrl, { event, ...payload, emittedAt: new Date().toISOString() });
        } catch (err: any) {
            logger.warn({ sessionId, event, err: err?.message }, "webhook emit failed");
        }
    }
}

export const sessionManager = new SessionManager();
