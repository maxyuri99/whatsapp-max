import { Router, Request, Response } from "express";
import { sessionManager } from "../managers/sessionManager";

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
        res.json(data);
    } catch (err: any) {
        const msg = err?.message || "Unable to send message";
        if (msg.includes("Session not found")) return res.status(404).json({ error: msg });
        return res.status(400).json({ error: msg });
    }
});
