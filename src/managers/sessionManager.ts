import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import child_process from "child_process";
import { Client, LocalAuth, Message, MessageAck, MessageMedia } from "whatsapp-web.js";
import { CONFIG } from "../config";
import { logger } from "../utils/logger";
import { sendWebhook } from "../utils/webhook";
import type { SessionMeta, SessionStatus } from "../types";
import { buildMessageMedia } from "../utils/media";

type InMemorySession = {
    client: Client;
    status: SessionStatus;
    qrData?: string;
    qrRaw?: string;
    meta: SessionMeta;
    initializing?: boolean;
};

function safeUnlink(p: string) {
    try {
        fs.unlinkSync(p);
    } catch {}
}

async function unlockProfileIfStale(sessionDir: string) {
    try {
        const hasChromium = child_process.spawnSync("bash", ["-lc", "pgrep -fa chromium || true"], { stdio: "pipe" });
        const chromiumList = (hasChromium.stdout || "").toString().trim();
        if (!chromiumList) {
            const patterns = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];
            const walk = (dir: string) => {
                for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, f.name);
                    if (f.isDirectory()) walk(full);
                    else if (patterns.some((p) => f.name.startsWith(p))) safeUnlink(full);
                }
            };
            walk(sessionDir);
        }
    } catch {}
}

export class SessionManager {
    private sessions = new Map<string, InMemorySession>();

    constructor() {
        if (!fs.existsSync(CONFIG.SESSIONS_DIR)) {
            fs.mkdirSync(CONFIG.SESSIONS_DIR, { recursive: true });
        }
    }

    private nonLocalAuthDirs(): string[] {
        if (!fs.existsSync(CONFIG.SESSIONS_DIR)) return [];
        return fs
            .readdirSync(CONFIG.SESSIONS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("session-"))
            .map((d) => d.name);
    }

    private async rmDirRetry(dir: string) {
        if (!fs.existsSync(dir)) return;
        await unlockProfileIfStale(dir);
        for (let i = 0; i < CONFIG.DESTROY_MAX_RETRIES; i++) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                break;
            } catch {
                await new Promise((r) => setTimeout(r, 300));
            }
        }
    }

    private async cleanupOrphans() {
        if (!fs.existsSync(CONFIG.SESSIONS_DIR)) return;
        const all = fs
            .readdirSync(CONFIG.SESSIONS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        const roots = new Set(all.filter((n) => !n.startsWith("session-")));
        for (const name of all) {
            if (name.startsWith("session-session-")) {
                await this.rmDirRetry(path.join(CONFIG.SESSIONS_DIR, name));
                continue;
            }
            if (name.startsWith("session-")) {
                const suffix = name.slice(8);
                if (!roots.has(suffix)) {
                    await this.rmDirRetry(path.join(CONFIG.SESSIONS_DIR, name));
                }
            }
        }
    }

    async bootstrapFromDisk() {
        await this.cleanupOrphans();
        const ids = this.nonLocalAuthDirs();
        for (const sessionId of ids) {
            try {
                const connected = await this.loadExistingAndEnsureReady(sessionId);
                if (connected) {
                    logger.info({ sessionId }, "bootstrapped session from disk");
                } else {
                    logger.warn({ sessionId }, "session not READY in time, deleting...");
                    await this.hardDeleteSessionFolder(sessionId);
                }
            } catch (err: any) {
                logger.error({ sessionId, err: err?.message }, "bootstrap failed");
                await this.hardDeleteSessionFolder(sessionId);
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
        if (!s.qrRaw) throw new Error("QR not available yet");
        const buf = await QRCode.toBuffer(s.qrRaw, { type: "png", width, margin: 2 });
        return buf;
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

    private normalizeToJid(to: string) {
        let t = to.replace(/\D/g, "");
        if (!t.endsWith("@c.us")) t = `${t}@c.us`;
        return t;
    }

    async createNewSession(sessionId: string) {
        if (this.sessions.has(sessionId)) throw new Error("Session already exists (in memory)");
        const dir = this.sessionDir(sessionId);
        if (fs.existsSync(dir)) throw new Error("Session already exists (on disk)");
        fs.mkdirSync(dir, { recursive: true });
        this.writeMeta(this.readMeta(sessionId));
        return this.startClient(sessionId);
    }

    private async loadExistingAndEnsureReady(sessionId: string): Promise<boolean> {
        try {
            await this.startClient(sessionId);
            const ready = await this.waitForReadyOrTimeout(sessionId, CONFIG.BOOTSTRAP_READY_TIMEOUT_MS);
            if (!ready) {
                await this.destroy(sessionId, true);
                return false;
            }
            return true;
        } catch (e: any) {
            logger.error({ sessionId, err: e?.message }, "loadExisting failed");
            return false;
        }
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
            }, 250);
        });
    }

    private async startClient(sessionId: string): Promise<InMemorySession> {
        if (this.sessions.has(sessionId)) return this.sessions.get(sessionId)!;
        const dir = this.sessionDir(sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const meta = this.readMeta(sessionId);
        await unlockProfileIfStale(dir);
        const execPath = CONFIG.CHROME_EXECUTABLE_PATH && fs.existsSync(CONFIG.CHROME_EXECUTABLE_PATH) ? CONFIG.CHROME_EXECUTABLE_PATH : undefined;
        if (CONFIG.CHROME_EXECUTABLE_PATH && !execPath) {
            logger.warn({ wanted: CONFIG.CHROME_EXECUTABLE_PATH }, "CHROME_EXECUTABLE_PATH not found; using Puppeteer default");
        }
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId, dataPath: CONFIG.SESSIONS_DIR }),
            puppeteer: {
                headless: CONFIG.HEADLESS as any,
                executablePath: execPath,
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=site-per-process", ...CONFIG.CHROME_EXTRA_ARGS],
            },
        });
        const entry: InMemorySession = { client, status: "INITIALIZING", meta, initializing: true };
        this.sessions.set(sessionId, entry);

        client.on("qr", async (qr: string) => {
            entry.status = "QRCODE";
            entry.qrRaw = qr;
            try {
                entry.qrData = await QRCode.toDataURL(qr);
            } catch (err: any) {
                logger.error({ err: err?.message, sessionId }, "qr encode failed");
            }
            await this.emit(sessionId, "qr", { sessionId, status: entry.status });
        });

        client.on("authenticated", async () => {
            entry.status = "AUTHENTICATED";
            entry.qrData = undefined;
            await this.emit(sessionId, "authenticated", { sessionId, status: entry.status });
        });

        client.on("auth_failure", async (m: string) => {
            entry.status = "AUTH_FAILURE";
            await this.emit(sessionId, "auth_failure", { sessionId, status: entry.status, message: m });
        });

        client.on("ready", async () => {
            entry.status = "READY";
            entry.initializing = false;
            entry.qrData = undefined;
            entry.qrRaw = undefined;
            entry.meta.lastConnectionAt = new Date().toISOString();
            this.writeMeta(entry.meta);
            await this.emit(sessionId, "ready", { sessionId, status: entry.status });
        });

        client.on("disconnected", async (reason: string) => {
            entry.status = "DISCONNECTED";
            await this.emit(sessionId, "disconnected", { sessionId, status: entry.status, reason });
            try {
                logger.warn({ sessionId, reason }, "disconnected: restarting client");
                await client.initialize();
            } catch (err: any) {
                logger.error({ sessionId, err: err?.message }, "reinitialize failed");
            }
        });

        client.on("message", async (msg: Message) => {
            await this.emit(sessionId, "message", {
                sessionId,
                from: msg.from,
                to: msg.to,
                body: msg.body,
                timestamp: msg.timestamp,
                type: msg.type,
                id: msg.id?._serialized,
            });
        });

        client.on("message_ack", async (msg: Message, ack: MessageAck) => {
            await this.emit(sessionId, "message_ack", {
                sessionId,
                id: msg.id?._serialized,
                to: msg.to,
                ack,
            });
        });

        await client.initialize();
        return entry;
    }

    async destroy(sessionId: string, deleteData = false) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        try {
            await s.client.destroy();
        } catch {}
        this.sessions.delete(sessionId);
        if (deleteData) {
            await this.hardDeleteSessionFolder(sessionId);
        }
        return { sessionId, deletedData: deleteData };
    }

    private async hardDeleteSessionFolder(sessionId: string) {
        const base = CONFIG.SESSIONS_DIR;
        const root = this.sessionDir(sessionId);
        try {
            child_process.execSync("pkill -9 chromium || true", { stdio: "ignore" });
        } catch {}
        await unlockProfileIfStale(root);
        await this.rmDirRetry(root);
        let name = `session-${sessionId}`;
        for (let i = 0; i < 6; i++) {
            const dir = path.join(base, name);
            if (fs.existsSync(dir)) {
                await unlockProfileIfStale(dir);
                await this.rmDirRetry(dir);
            }
            name = `session-${name}`;
        }
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

    async listChats(sessionId: string, page = 1, limit = 10) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        const chats = await s.client.getChats();
        const total = chats.length;
        const l = Math.max(1, Math.min(100, Number(limit) || 10));
        const p = Math.max(1, Number(page) || 1);
        const pages = Math.max(1, Math.ceil(total / l));
        const start = (p - 1) * l;
        const slice = chats.slice(start, start + l);
        const ids = slice.map((c) => c.id?._serialized || String(c.id));
        return { sessionId, page: p, limit: l, total, pages, ids };
    }

    async sendText(sessionId: string, to: string, message: string) {
        const target = await this.resolveTarget(sessionId, undefined, to);
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const sent = await s.client.sendMessage(target, message);
        return { id: sent.id._serialized, to: sent.to, chatId: target, timestamp: sent.timestamp, type: "text", body: sent.body };
    }

    private async resolveTarget(sessionId: string, chatId?: string, to?: string): Promise<string> {
        if (chatId) return chatId;
        if (to) return this.normalizeToJid(to);
        throw new Error("chatId or to is required");
    }

    async sendAdvanced(
        sessionId: string,
        payload: { chatId?: string; to?: string; type?: string; body?: string; media?: { url?: string; base64?: string; mimetype?: string; filename?: string }; caption?: string }
    ) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error("Session not found");
        if (s.status !== "READY") throw new Error(`Session not READY (status=${s.status})`);
        const target = await this.resolveTarget(sessionId, payload.chatId, payload.to);
        const kind = (payload.type || (payload.media ? "media" : "text")).toLowerCase();
        let sent: any;
        if (kind === "text") {
            if (!payload.body) throw new Error("body is required for text");
            sent = await s.client.sendMessage(target, payload.body);
            return { id: sent.id._serialized, to: sent.to, chatId: target, timestamp: sent.timestamp, type: "text", body: sent.body };
        } else {
            if (!payload.media) throw new Error("media is required");
            const mm: MessageMedia = await buildMessageMedia(payload.media);
            const opts: any = {};
            if (payload.caption) opts.caption = payload.caption;
            sent = await s.client.sendMessage(target, mm, opts);
            return { id: sent.id._serialized, to: sent.to, chatId: target, timestamp: sent.timestamp, type: "media", body: sent.body, filename: mm.filename, mimetype: mm.mimetype };
        }
    }
}

export const sessionManager = new SessionManager();
