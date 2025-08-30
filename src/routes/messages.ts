import { Router, Request, Response } from "express";
import { sessionManager } from "../managers/sessionManager";
import { ok, fail } from "../utils/http";

export const messagesRouter = Router();

messagesRouter.post("/send", async (req: Request, res: Response) => {
    const { sessionId, chatId, to, type, body, media, caption } = req.body as {
        sessionId?: string;
        chatId?: string;
        to?: string;
        type?: string;
        body?: string;
        media?: { url?: string; base64?: string; mimetype?: string; filename?: string };
        caption?: string;
    };
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    try {
        const data = await sessionManager.sendAdvanced(sessionId, { chatId, to, type, body, media, caption });
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to send message";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Listar mensagens de um chat (sessionId nos params, chatId no body)
messagesRouter.get("/:sessionId/history", async (req: Request, res: Response) => {
    const { chatId } = (req.body || {}) as { chatId?: string };
    if (!chatId) return res.status(400).json({ error: "chatId is required in body" });
    try {
        const data = await sessionManager.getMessages(req.params.sessionId, chatId);
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to get messages";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Resolver número para chatId (aceita phone no body ou query; prefixa 55 se faltar)
messagesRouter.get("/:sessionId/resolve", async (req: Request, res: Response) => {
    const phone = (req.body && (req.body as any).phone) || (req.query && (req.query as any).phone);
    if (!phone) return res.status(400).json({ error: "phone is required" });
    try {
        const data = await sessionManager.resolveChatId(req.params.sessionId, String(phone));
        if (!data.exists) return fail(res, "Número não possui WhatsApp", 404, 'no_whatsapp', { phone: data.phone });
        return ok(res, { chatId: data.chatId, phone: data.phone });
    } catch (err: any) {
        const msg = err?.message || "Unable to resolve number";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});
