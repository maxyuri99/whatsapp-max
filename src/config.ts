import "dotenv/config";

function parseBool(v: string | undefined, d = true) {
    if (v === undefined) return d;
    return String(v).trim().toLowerCase() === "true";
}

function num(v: string | undefined, d: number) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

export const CONFIG = {
    PORT: num(process.env.PORT, 3000),
    SESSIONS_DIR: process.env.SESSIONS_DIR || "./sessions",
    API_KEY: process.env.API_KEY || "",
    WEBHOOK_TIMEOUT_MS: num(process.env.WEBHOOK_TIMEOUT_MS, 6000),
    WEBHOOK_MAX_RETRIES: num(process.env.WEBHOOK_MAX_RETRIES, 3),
    BOOTSTRAP_READY_TIMEOUT_MS: num(process.env.BOOTSTRAP_READY_TIMEOUT_MS, 120000),
    RECONNECT_MAX_ATTEMPTS: num(process.env.RECONNECT_MAX_ATTEMPTS, 5),
    RECONNECT_BASE_DELAY_MS: num(process.env.RECONNECT_BASE_DELAY_MS, 2000),
    RECONNECT_MAX_DELAY_MS: num(process.env.RECONNECT_MAX_DELAY_MS, 15000),
    STORE_ENABLED: parseBool(process.env.STORE_ENABLED, true),
    STORE_PERSIST_INTERVAL_MS: num(process.env.STORE_PERSIST_INTERVAL_MS, 15000),
    COUNTRY_CODE_DEFAULT: (process.env.COUNTRY_CODE_DEFAULT || "55").replace(/\D/g, "") || "55",
};
