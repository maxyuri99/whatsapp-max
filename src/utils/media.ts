import axios from "axios";
import path from "path";

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

export type BuiltMedia = { data: Buffer; mimetype: string; filename: string };

export async function buildBaileysMedia(input: MediaInput): Promise<BuiltMedia> {
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
        return { mimetype: mime || "application/octet-stream", filename, data: Buffer.from(data, "base64") };
    }
    if (input.url) {
        const resp = await axios.get(input.url, { responseType: "arraybuffer" });
        const mime = input.mimetype || String(resp.headers["content-type"] || "application/octet-stream");
        const filename = ensureFilename(input.filename || filenameFromUrl(input.url), mime);
        return { mimetype: mime, filename, data: Buffer.from(resp.data) };
    }
    throw new Error("media.url or media.base64 is required");
}

export function toDataUrl(media: BuiltMedia): string {
    return `data:${media.mimetype};base64,${media.data.toString("base64")}`;
}
