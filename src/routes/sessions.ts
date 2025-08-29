import { Router, Request, Response } from "express";
import { sessionManager } from "../managers/sessionManager";

export const sessionsRouter = Router();

sessionsRouter.post("/", async (req: Request, res: Response) => {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId || !sessionId.trim()) return res.status(400).json({ error: "sessionId is required" });
    try {
        const s = await sessionManager.createNewSession(sessionId.trim());
        return res.status(201).json({ sessionId: sessionId.trim(), status: s.status });
    } catch (err: any) {
        const msg = String(err?.message || "");
        if (msg.includes("already exists")) return res.status(409).json({ error: msg });
        return res.status(400).json({ error: msg || "Unable to create session" });
    }
});

sessionsRouter.get("/", async (_req: Request, res: Response) => {
    res.json(sessionManager.list());
});

sessionsRouter.get("/:id/status", async (req: Request, res: Response) => {
    try {
        const data = await sessionManager.getStatus(req.params.id);
        res.json(data);
    } catch (err: any) {
        if ((err?.message || "").includes("Session not found")) return res.status(404).json({ error: "Session not found" });
        return res.status(400).json({ error: err?.message || "Unable to get status" });
    }
});

sessionsRouter.get("/:id/qr", async (req: Request, res: Response) => {
    const { wait, timeout } = req.query as any;
    const timeoutMs = Math.min(Math.max(Number(timeout || 10000), 1000), 60000);
    try {
        if (wait === "1" || String(wait).toLowerCase() === "true") {
            const dataUrl = await sessionManager.waitForQrDataUrl(req.params.id, timeoutMs);
            return res.json({ dataUrl });
        } else {
            const data = await sessionManager.getQr(req.params.id);
            return res.json(data);
        }
    } catch (err: any) {
        if (err?.code === "ALREADY_AUTHENTICATED") return res.status(204).end();
        if (err?.code === "QR_TIMEOUT") return res.status(202).json({ status: "PENDING", error: "QR timeout" });
        const msg = err?.message || "QR not available";
        if (msg.includes("Session not found")) return res.status(404).json({ error: msg });
        return res.status(400).json({ error: msg });
    }
});

sessionsRouter.get("/:id/qr.png", async (req: Request, res: Response) => {
    try {
        const sizeParam = Number(req.query.w || req.query.size || 350);
        const width = Number.isFinite(sizeParam) && sizeParam > 50 && sizeParam <= 1000 ? sizeParam : 350;
        const { wait, timeout } = req.query as any;
        const timeoutMs = Math.min(Math.max(Number(timeout || 10000), 1000), 60000);
        const png = wait === "1" || String(wait).toLowerCase() === "true" ? await sessionManager.waitForQrPng(req.params.id, width, timeoutMs) : await sessionManager.getQrPng(req.params.id, width);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(png);
    } catch (err: any) {
        if (err?.code === "ALREADY_AUTHENTICATED") return res.status(204).end();
        if (err?.code === "QR_TIMEOUT") return res.status(202).json({ status: "PENDING", error: "QR timeout" });
        const msg = err?.message || "QR not available";
        if (msg.includes("Session not found")) return res.status(404).json({ error: msg });
        return res.status(400).json({ error: msg });
    }
});

sessionsRouter.get("/:id/chats", async (req: Request, res: Response) => {
    try {
        const page = Number(req.query.page || 1);
        const limit = Number(req.query.limit || 10);
        const data = await sessionManager.listChats(req.params.id, page, limit);
        res.json(data);
    } catch (err: any) {
        const msg = err?.message || "Unable to list chats";
        if (msg.includes("Session not found")) return res.status(404).json({ error: msg });
        return res.status(400).json({ error: msg });
    }
});
