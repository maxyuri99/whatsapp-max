import axios from "axios";
import path from "path";
import { MessageMedia } from "whatsapp-web.js";

type MediaInput = {
    url?: string;
    base64?: string;
    mimetype?: string;
    filename?: string;
};

function extFromMime(mime: string | undefined): string {
    if (!mime) return "";
    const map: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/svg+xml": "svg",
        "application/pdf": "pdf",
        "application/zip": "zip",
        "audio/mpeg": "mp3",
        "audio/ogg": "ogg",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "application/octet-stream": "bin",
    };
    return map[mime] || "";
}

function filenameFromUrl(u: string): string {
    try {
        const clean = u.split("?")[0].split("#")[0];
        const base = path.basename(clean);
        return decodeURIComponent(base || "file");
    } catch {
        return "file";
    }
}

function ensureFilename(name: string | undefined, mime: string | undefined): string {
    const n = (name || "file").trim();
    if (n.includes(".")) return n;
    const ext = extFromMime(mime);
    return ext ? `${n}.${ext}` : n;
}

export async function buildMessageMedia(input: MediaInput): Promise<MessageMedia> {
    if (input.base64) {
        let mime = input.mimetype;
        let data = input.base64;
        if (data.startsWith("data:")) {
            const m = data.match(/^data:([^;]+);base64,(.+)$/);
            if (!m) throw new Error("Invalid data URL");
            mime = mime || m[1];
            data = m[2];
        }
        const filename = ensureFilename(input.filename, mime || "application/octet-stream");
        return new MessageMedia(mime || "application/octet-stream", data, filename);
    }
    if (input.url) {
        const resp = await axios.get(input.url, { responseType: "arraybuffer" });
        const mime = input.mimetype || String(resp.headers["content-type"] || "application/octet-stream");
        const filename = ensureFilename(input.filename || filenameFromUrl(input.url), mime);
        const b64 = Buffer.from(resp.data).toString("base64");
        return new MessageMedia(mime, b64, filename);
    }
    throw new Error("media.url or media.base64 is required");
}
