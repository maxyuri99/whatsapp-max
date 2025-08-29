import "dotenv/config";
import fs from "fs";

function parseBool(v: string | undefined, d = true) {
    if (v === undefined) return d;
    return String(v).trim().toLowerCase() === "true";
}

function num(v: string | undefined, d: number) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

function effectiveChromeExecPath(): string | undefined {
    const raw = (process.env.CHROME_EXECUTABLE_PATH || "").trim();
    if (!raw) return undefined;
    try {
        if (fs.existsSync(raw)) return raw;
        console.warn(`[CONFIG] CHROME_EXECUTABLE_PATH="${raw}" inexistente. Fallback para Puppeteer.`);
    } catch {}
    return undefined;
}

export const CONFIG = {
    PORT: num(process.env.PORT, 3000),
    SESSIONS_DIR: process.env.SESSIONS_DIR || "./sessions",
    API_KEY: process.env.API_KEY || "",
    HEADLESS: parseBool(process.env.HEADLESS, true),
    CHROME_EXECUTABLE_PATH: effectiveChromeExecPath(),
    CHROME_EXTRA_ARGS: (process.env.CHROME_EXTRA_ARGS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    WEBHOOK_TIMEOUT_MS: num(process.env.WEBHOOK_TIMEOUT_MS, 6000),
    WEBHOOK_MAX_RETRIES: num(process.env.WEBHOOK_MAX_RETRIES, 3),
    MAX_CONCURRENT_SESSIONS: num(process.env.MAX_CONCURRENT_SESSIONS, 0),
    BOOTSTRAP_READY_TIMEOUT_MS: num(process.env.BOOTSTRAP_READY_TIMEOUT_MS, 30000),
    DESTROY_MAX_RETRIES: num(process.env.DESTROY_MAX_RETRIES, 5),
};
