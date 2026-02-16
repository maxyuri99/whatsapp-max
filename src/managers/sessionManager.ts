import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import * as wppconnect from "@wppconnect-team/wppconnect";
import { Message as WppMessage, Whatsapp } from "@wppconnect-team/wppconnect";
import { StatusFind } from "@wppconnect-team/wppconnect/dist/api/model/enum";
import { SocketState } from "@wppconnect-team/wppconnect/dist/api/model/enum/socket-state";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";
import { sendWebhook } from "../utils/webhook";
import type { SessionMeta, SessionStatus } from "../types";
import { buildBaileysMedia, toDataUrl } from "../utils/media";

type InMemorySession = {
    client: Whatsapp;
    status: SessionStatus;
    qrData?: string;
    qrRaw?: string;
    meta: SessionMeta;
    closing?: boolean;
    messages: Map<string, WppMessage[]>;
    chats: Set<string>;
    disposers: Array<{ dispose: () => void }>;
};

type SendButton =
    | { id: string; text: string }
    | { phoneNumber: string; text: string }
    | { url: string; text: string }
    | { code: string; text: string };

type SendPayload = {
    chatId?: string;
    to?: string;
    type?: string;
    body?: string;
    media?: { url?: string; base64?: string; mimetype?: string; filename?: string };
    caption?: string;
    buttons?: SendButton[];
    title?: string;
    footer?: string;
    useInteractiveMessage?: boolean;
    copyCode?: string;
    copyButtonText?: string;
};

type ListRow = { rowId: string; title: string; description?: string };
type ListSection = { title: string; rows: ListRow[] };
type SendListPayload = {
    chatId?: string;
    to?: string;
    buttonText: string;
    description: string;
    title?: string;
    footer?: string;
    sections: ListSection[];
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
            .filter((d) => d.isDirectory() && fs.existsSync(this.metaPath(d.name)))
            .map((d) => d.name);

        for (const sessionId of dirs) {
            try {
                await this.startSocket(sessionId);
                const ready = await this.waitForReadyOrTimeout(sessionId, CONFIG.BOOTSTRAP_READY_TIMEOUT_MS);
                logger.info({ sessionId, ready }, "bootstrapped session");
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

    private legacySessionDirs(sessionId: string) {
        return [
            path.join(CONFIG.SESSIONS_DIR, "tokens", sessionId),
            path.join(process.cwd(), "tokens", sessionId),
        ];
    }

    private getTokenStore(sessionId: string) {
        return new wppconnect.tokenStore.FileTokenStore({
            path: this.sessionDir(sessionId),
        });
    }

    private async migrateLegacySessionData(sessionId: string) {
        const targetDir = this.sessionDir(sessionId);
        for (const legacyDir of this.legacySessionDirs(sessionId)) {
            const resolvedLegacyDir = path.resolve(legacyDir);
            const resolvedTargetDir = path.resolve(targetDir);
            if (resolvedLegacyDir === resolvedTargetDir || !fs.existsSync(legacyDir)) continue;
            const names = await fs.promises.readdir(legacyDir).catch(() => []);
            if (!names.length) continue;
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

            for (const name of names) {
                const sourcePath = path.join(legacyDir, name);
                const targetPath = path.join(targetDir, name);
                if (fs.existsSync(targetPath)) continue;
                try {
                    await fs.promises.cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
                } catch (err: any) {
                    logger.warn(
                        { sessionId, sourcePath, targetPath, err: err?.message },
                        "failed to migrate legacy session file"
                    );
                }
            }
        }
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
        const raw = String(to || "").trim();
        if (raw.endsWith("@c.us") || raw.endsWith("@g.us")) return raw;
        let digits = raw.replace(/\D/g, "");
        if (!digits.startsWith(CONFIG.COUNTRY_CODE_DEFAULT)) digits = `${CONFIG.COUNTRY_CODE_DEFAULT}${digits}`;
        return `${digits}@c.us`;
    }

    private async resolveTarget(_sessionId: string, chatId?: string, to?: string): Promise<string> {
        if (chatId) return this.normalizeToJid(chatId);
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
        if (s.status === "INITIALIZING" && !s.qrRaw && !s.qrData) {
            const e: any = new Error("Initializing; QR not ready yet");
            e.code = "INITIALIZING";
            throw e;
        }
        if (s.qrRaw) return QRCode.toBuffer(s.qrRaw, { type: "png", width, margin: 2 });
        if (s.qrData) {
            const base64 = s.qrData.replace(/^data:image\/\w+;base64,/, "");
            return Buffer.from(base64, "base64");
        }
        throw new Error("QR not available yet");
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
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (s.status === "READY" || s.status === "AUTHENTICATED") {
                const e: any = new Error("Already authenticated / ready");
                e.code = "ALREADY_AUTHENTICATED";
                throw e;
            }
            if (s.qrData) return s.qrData;
            if (s.qrRaw) return QRCode.toDataURL(s.qrRaw);
            await new Promise((r) => setTimeout(r, 150));
        }
        const e: any = new Error("QR timeout");
        e.code = "QR_TIMEOUT";
        throw e;
    }

    async waitForQrPng(sessionId: string, width = 350, timeoutMs = 10000): Promise<Buffer> {
        const dataUrl = await this.waitForQrDataUrl(sessionId, timeoutMs);
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
        return Buffer.from(base64, "base64");
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

    private mapMessagePayload(sessionId: string, msg: WppMessage) {
        const chatId = typeof msg.chatId === "string" ? msg.chatId : msg.chatId?._serialized;
        const remote = chatId || (msg.fromMe ? msg.to : msg.from) || "";
        const from = msg.fromMe ? sessionId : msg.author || msg.from;
        const timestampRaw = Number(msg.timestamp || msg.t || Date.now());
        const timestamp = timestampRaw > 1e12 ? timestampRaw : timestampRaw * 1000;
        const body = String(msg.body || msg.caption || msg.content || "");
        const rawType = String(msg.type || "chat").toLowerCase();
        const type = rawType === "chat" ? "text" : rawType;
        const hasMedia = Boolean(msg.isMedia || ["image", "video", "audio", "ptt", "document", "sticker"].includes(type));
        const id = msg.id || `${remote}-${timestamp}`;
        return { sessionId, id, from, to: remote, timestamp, type, body, fromMe: Boolean(msg.fromMe), hasMedia, ack: msg.ack };
    }

    private markReady(sessionId: string, entry: InMemorySession) {
        const wasReady = entry.status === "READY";
        entry.status = "READY";
        entry.qrData = undefined;
        entry.qrRaw = undefined;
        entry.meta.lastConnectionAt = new Date().toISOString();
        this.writeMeta(entry.meta);
        if (!wasReady) {
            void this.emit(sessionId, "ready", { sessionId, status: entry.status });
        }
    }

    private markDisconnected(sessionId: string, entry: InMemorySession, reason: string) {
        if (entry.closing) return;
        entry.status = "DISCONNECTED";
        logger.warn({ sessionId, reason }, "connection closed");
        void this.emit(sessionId, "disconnected", { sessionId, status: entry.status, reason });
    }

    private mapStatusFindToSessionStatus(status: StatusFind | string): SessionStatus | undefined {
        switch (status) {
            case StatusFind.inChat:
            case StatusFind.isLogged:
                return "READY";
            case StatusFind.qrReadSuccess:
                return "AUTHENTICATED";
            case StatusFind.notLogged:
                return "QRCODE";
            case StatusFind.qrReadError:
            case StatusFind.qrReadFail:
                return "AUTH_FAILURE";
            case StatusFind.serverClose:
            case StatusFind.disconnectedMobile:
            case StatusFind.browserClose:
                return "DISCONNECTED";
            default:
                return undefined;
        }
    }

    private async startSocket(sessionId: string): Promise<InMemorySession> {
        if (this.sessions.has(sessionId)) return this.sessions.get(sessionId)!;
        const dir = this.sessionDir(sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await this.migrateLegacySessionData(sessionId);

        const meta = this.readMeta(sessionId);
        const entryBase: Omit<InMemorySession, "client"> = {
            status: "INITIALIZING",
            meta,
            closing: false,
            messages: new Map(),
            chats: new Set(),
            disposers: [],
        };

        const client = await wppconnect.create({
            session: sessionId,
            tokenStore: this.getTokenStore(sessionId),
            folderNameToken: CONFIG.SESSIONS_DIR,
            headless: true,
            logQR: false,
            updatesLog: false,
            autoClose: 0,
            waitForLogin: false,
            deviceName: "WhatsApp Max",
            catchQR: async (qrCode, _asciiQR, _attempt, urlCode) => {
                const current = this.sessions.get(sessionId);
                if (!current) return;
                current.status = "QRCODE";
                if (urlCode) {
                    current.qrRaw = urlCode;
                    current.qrData = await QRCode.toDataURL(urlCode);
                } else if (qrCode?.startsWith("data:image/")) {
                    current.qrData = qrCode;
                }
                await this.emit(sessionId, "qr", { sessionId, status: current.status });
            },
            statusFind: async (status) => {
                const current = this.sessions.get(sessionId);
                if (!current) return;
                const mapped = this.mapStatusFindToSessionStatus(status);
                if (!mapped) return;
                if (mapped === "READY") {
                    this.markReady(sessionId, current);
                    return;
                }
                current.status = mapped;
                if (mapped === "AUTH_FAILURE") {
                    await this.emit(sessionId, "auth_failure", { sessionId, status: current.status });
                }
                if (mapped === "DISCONNECTED") {
                    this.markDisconnected(sessionId, current, String(status));
                }
            },
        });

        const entry: InMemorySession = { ...entryBase, client };
        this.sessions.set(sessionId, entry);

        entry.disposers.push(
            client.onMessage(async (msg) => {
                const mapped = this.mapMessagePayload(sessionId, msg);
                if (mapped.to) entry.chats.add(mapped.to);
                const key = mapped.to || "unknown";
                const list = entry.messages.get(key) || [];
                list.push(msg);
                if (list.length > 500) list.shift();
                entry.messages.set(key, list);
                await this.emit(sessionId, "message", mapped);
            })
        );

        entry.disposers.push(
            client.onAck(async (ack) => {
                await this.emit(sessionId, "message_ack", {
                    sessionId,
                    id: ack?.id?.id || ack?.id?._serialized || "",
                    to: ack?.to || ack?.id?.remote || "",
                    ack: ack?.ack,
                });
            })
        );

        entry.disposers.push(
            client.onStateChange((state) => {
                const current = this.sessions.get(sessionId);
                if (!current) return;
                if (state === SocketState.CONNECTED) {
                    this.markReady(sessionId, current);
                    return;
                }
                if (
                    state === SocketState.UNPAIRED ||
                    state === SocketState.UNPAIRED_IDLE ||
                    state === SocketState.TIMEOUT ||
                    state === SocketState.CONFLICT ||
                    state === SocketState.TOS_BLOCK ||
                    state === SocketState.SMB_TOS_BLOCK ||
                    state === SocketState.PROXYBLOCK
                ) {
                    this.markDisconnected(sessionId, current, state);
                }
            })
        );

        return entry;
    }

    async listChats(sessionId: string, page = 1, limit = 10) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const chats = await s.client.listChats();
        const ids = chats.map((c: any) => c?.id?._serialized).filter(Boolean);
        const total = ids.length;
        const l = Math.max(1, Math.min(100, Number(limit) || 10));
        const p = Math.max(1, Number(page) || 1);
        const pages = Math.max(1, Math.ceil(total / l));
        const start = (p - 1) * l;
        const slice = ids.slice(start, start + l);
        return { sessionId, page: p, limit: l, total, pages, ids: slice };
    }

    async sendText(sessionId: string, to: string, message: string) {
        const target = await this.resolveTarget(sessionId, undefined, to);
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const sent: any = await s.client.sendText(target, message);
        const id = sent?.id || sent?.id?._serialized || "";
        const tsRaw = Number(sent?.timestamp || sent?.t || Date.now());
        const timestamp = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
        return { id, to: target, chatId: target, timestamp, type: "text", body: message };
    }

    private parseSentMeta(sent: any) {
        const id = sent?.id || sent?.id?._serialized || "";
        const tsRaw = Number(sent?.timestamp || sent?.t || Date.now());
        const timestamp = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
        return { id, timestamp };
    }

    private async sendMedia(
        session: InMemorySession,
        target: string,
        payload: SendPayload
    ) {
        if (!payload.media) throw new Error("media is required");
        const media = await buildBaileysMedia(payload.media);
        const dataUrl = toDataUrl(media);
        const caption = payload.caption || payload.body || "";
        const type = (payload.type || "").toLowerCase();

        if (type === "image" || media.mimetype.startsWith("image/")) {
            return session.client.sendImageFromBase64(target, dataUrl, media.filename, caption);
        }
        if (type === "audio" || media.mimetype.startsWith("audio/")) {
            return session.client.sendPttFromBase64(target, dataUrl, media.filename, caption, undefined, undefined, false);
        }
        return (session.client as any).sendFile(target, dataUrl, media.filename, caption);
    }

    private normalizeButtons(payload: SendPayload): SendButton[] | undefined {
        const baseButtons = Array.isArray(payload.buttons) ? payload.buttons : [];
        const copyCode = String(payload.copyCode || "").trim();
        const copyButtonText = String(payload.copyButtonText || "").trim() || "Copiar codigo";
        const withCopy = copyCode ? [...baseButtons, { code: copyCode, text: copyButtonText }] : baseButtons;
        const normalized = withCopy.filter((b) => b && typeof b.text === "string" && b.text.trim());
        if (!normalized.length) return undefined;
        return normalized.slice(0, 3);
    }

    private validateButtons(buttons?: SendButton[]) {
        if (!buttons?.length) throw new Error("buttons is required");
        if (buttons.length < 1 || buttons.length > 3) throw new Error("buttons must have between 1 and 3 options");
        let hasReply = false;
        let hasAction = false;
        for (const b of buttons) {
            const hasId = Boolean((b as any).id);
            const hasActionKey = Boolean((b as any).url || (b as any).phoneNumber || (b as any).code);
            if (hasId) hasReply = true;
            if (hasActionKey) hasAction = true;
        }
        if (hasReply && hasAction) {
            throw new Error("Do not mix reply buttons (id) with action buttons (url/phoneNumber/code)");
        }
    }

    async sendAdvanced(sessionId: string, payload: SendPayload) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const target = await this.resolveTarget(sessionId, payload.chatId, payload.to);
        const kind = (payload.type || (payload.media ? "media" : "text")).toLowerCase();
        const buttons = this.normalizeButtons(payload);
        if (buttons?.length) this.validateButtons(buttons);
        const textOptions: any =
            buttons || payload.title || payload.footer || payload.useInteractiveMessage !== undefined
                ? {
                      buttons,
                      title: payload.title,
                      footer: payload.footer,
                      useInteractiveMessage: payload.useInteractiveMessage ?? true,
                  }
                : undefined;
        const sent: any =
            kind === "text"
                ? await s.client.sendText(target, payload.body || "", textOptions)
                : await this.sendMedia(s, target, payload);
        const { id, timestamp } = this.parseSentMeta(sent);
        return {
            id,
            to: target,
            chatId: target,
            timestamp,
            type: kind === "text" ? "text" : (payload.type || "media"),
            body: payload.body,
        };
    }

    async sendButtons(
        sessionId: string,
        payload: {
            chatId?: string;
            to?: string;
            body: string;
            buttons: SendButton[];
            title?: string;
            footer?: string;
            useInteractiveMessage?: boolean;
        }
    ) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        if (!payload.body || !String(payload.body).trim()) throw new Error("body is required");
        this.validateButtons(payload.buttons);
        const target = await this.resolveTarget(sessionId, payload.chatId, payload.to);
        const options: any = {
            buttons: payload.buttons,
            title: payload.title,
            footer: payload.footer,
            useInteractiveMessage: payload.useInteractiveMessage ?? true,
        };
        const sent: any = await (s.client as any).sendText(target, payload.body, options);
        const { id, timestamp } = this.parseSentMeta(sent);
        return {
            id,
            to: target,
            chatId: target,
            timestamp,
            type: "text",
            body: payload.body,
            buttons: payload.buttons,
        };
    }

    async sendCopyCode(
        sessionId: string,
        payload: {
            chatId?: string;
            to?: string;
            body?: string;
            code: string;
            copyButtonText?: string;
            title?: string;
            footer?: string;
            useInteractiveMessage?: boolean;
            fallbackToText?: boolean;
        }
    ) {
        const code = String(payload.code || "").trim();
        if (!code) throw new Error("code is required");
        const body = String(payload.body || `Use este codigo: ${code}`).trim();
        const copyButtonText = String(payload.copyButtonText || "Copiar codigo").trim() || "Copiar codigo";
        try {
            const sent = await this.sendButtons(sessionId, {
                chatId: payload.chatId,
                to: payload.to,
                body,
                title: payload.title,
                footer: payload.footer,
                useInteractiveMessage: payload.useInteractiveMessage ?? true,
                buttons: [{ code, text: copyButtonText }],
            });
            return { ...sent, copyCode: code, fallbackUsed: false };
        } catch (err: any) {
            if (payload.fallbackToText === false) throw err;
            const text = `${body}\n\nCodigo: ${code}`;
            const target = payload.chatId ? payload.chatId : String(payload.to || "");
            const sent = await this.sendAdvanced(sessionId, { chatId: payload.chatId, to: payload.to, type: "text", body: text });
            return {
                ...sent,
                chatId: sent.chatId || target,
                copyCode: code,
                fallbackUsed: true,
                fallbackReason: err?.message || "copy button failed",
            };
        }
    }

    async sendList(
        sessionId: string,
        payload: SendListPayload
    ) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        if (!payload.buttonText || !payload.description) throw new Error("buttonText and description are required");
        if (!Array.isArray(payload.sections) || payload.sections.length < 1) throw new Error("sections is required");
        for (const sec of payload.sections) {
            if (!sec?.title || !Array.isArray(sec.rows) || sec.rows.length < 1) {
                throw new Error("each section must have title and at least one row");
            }
            for (const row of sec.rows) {
                if (!row?.rowId || !row?.title) throw new Error("each row must have rowId and title");
            }
        }
        const target = await this.resolveTarget(sessionId, payload.chatId, payload.to);
        const sent: any = await s.client.sendListMessage(target, {
            buttonText: payload.buttonText,
            description: payload.description,
            title: payload.title,
            footer: payload.footer,
            sections: payload.sections.map((sec) => ({
                title: sec.title,
                rows: sec.rows.map((row) => ({
                    rowId: row.rowId,
                    title: row.title,
                    description: row.description || "",
                })),
            })),
        });
        const { id, timestamp } = this.parseSentMeta(sent);
        return {
            id,
            to: target,
            chatId: target,
            timestamp,
            type: "list",
            body: payload.description,
        };
    }

    async getMessages(sessionId: string, chatId: string) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const jid = this.normalizeToJid(chatId);
        const msgs = s.messages.get(jid) || [];
        const simplified = msgs.map((m) => {
            const mapped = this.mapMessagePayload(sessionId, m);
            return {
                id: mapped.id,
                from: mapped.from,
                to: mapped.to,
                timestamp: mapped.timestamp,
                dateSent: new Date(mapped.timestamp).toISOString(),
                type: mapped.type,
                body: mapped.body,
                fromMe: mapped.fromMe,
                hasMedia: mapped.hasMedia,
                ack: mapped.ack,
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
        const jid = `${digits}@c.us`;
        const found = await s.client.checkNumberStatus(jid);
        const exists = Boolean(found?.numberExists && found?.canReceiveMessage);
        return { sessionId, phone: digits, exists, chatId: jid };
    }

    private async closeSession(entry: InMemorySession, logout = false) {
        entry.closing = true;
        for (const d of entry.disposers) {
            try {
                d.dispose();
            } catch {}
        }
        entry.disposers = [];
        try {
            if (logout) await entry.client.logout();
        } catch {}
        try {
            await entry.client.close();
        } catch {}
        entry.closing = false;
    }

    async destroy(sessionId: string, deleteData = false) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        await this.closeSession(s, true);
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
        await this.closeSession(s, false);
        this.sessions.delete(sessionId);
        const entry = await this.startSocket(sessionId);
        return { sessionId, status: entry.status };
    }

    async resetAuth(sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (s) {
            await this.closeSession(s, true);
            this.sessions.delete(sessionId);
        }
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
        if (s.status !== "DISCONNECTED" && s.status !== "AUTH_FAILURE") {
            return { sessionId, status: s.status };
        }
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
