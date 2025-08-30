import { Router, Request, Response } from "express";
import { sessionManager } from "../managers/sessionManager";
import { ok, fail } from "../utils/http";

export const sessionsRouter = Router();

sessionsRouter.post("/", async (req: Request, res: Response) => {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId || !sessionId.trim()) return fail(res, "sessionId is required", 400, 'invalid');
    try {
        const s = await sessionManager.createNewSession(sessionId.trim());
        return ok(res, { sessionId: sessionId.trim(), status: s.status }, 'ok', 201);
    } catch (err: any) {
        const msg = String(err?.message || "");
        if (msg.includes("already exists")) return fail(res, msg, 409, 'conflict');
        return fail(res, msg || "Unable to create session", 400, 'error');
    }
});

sessionsRouter.get("/", async (_req: Request, res: Response) => ok(res, { sessions: sessionManager.list() }));

sessionsRouter.get("/:id/status", async (req: Request, res: Response) => {
    try {
        const data = await sessionManager.getStatus(req.params.id);
        return ok(res, data);
    } catch (err: any) {
        if ((err?.message || "").includes("Session not found")) return fail(res, "Session not found", 404, 'not_found');
        return fail(res, err?.message || "Unable to get status", 400, 'error');
    }
});

sessionsRouter.get("/:id/qr", async (req: Request, res: Response) => {
    const { wait, timeout } = req.query as any;
    const timeoutMs = Math.min(Math.max(Number(timeout || 10000), 1000), 60000);
    try {
        if (wait === "1" || String(wait).toLowerCase() === "true") {
            const dataUrl = await sessionManager.waitForQrDataUrl(req.params.id, timeoutMs);
            return ok(res, { dataUrl });
        } else {
            const data = await sessionManager.getQr(req.params.id);
            return ok(res, data);
        }
    } catch (err: any) {
        if (err?.code === "ALREADY_AUTHENTICATED") return res.status(204).end();
        if (err?.code === "INITIALIZING") return fail(res, "Initializing; QR not ready yet", 202, 'initializing', { status: 'INITIALIZING' });
        if (err?.code === "QR_TIMEOUT") return fail(res, "QR timeout", 202, 'pending', { status: 'PENDING' });
        const msg = err?.message || "QR not available";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
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
        if (err?.code === "INITIALIZING") return res.status(202).json({ status: "INITIALIZING" });
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
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to list chats";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Definir/atualizar webhook da sessão
sessionsRouter.post("/:id/webhook", async (req: Request, res: Response) => {
    try {
        const { url } = req.body as { url?: string };
        const data = await sessionManager.setWebhook(req.params.id, url);
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to set webhook";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Destruir sessão (com opção de apagar dados do disco)
sessionsRouter.delete("/:id", async (req: Request, res: Response) => {
    try {
        const del = String(req.query.deleteData || "false").toLowerCase();
        const deleteData = del === "1" || del === "true";
        const data = await sessionManager.destroy(req.params.id, deleteData);
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to destroy session";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Reiniciar sessão mantendo credenciais
sessionsRouter.post("/:id/restart", async (req: Request, res: Response) => {
    try {
        const data = await sessionManager.restart(req.params.id);
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to restart session";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Resetar credenciais (apaga LocalAuth) e reiniciar pedindo novo QR
sessionsRouter.post("/:id/reset-auth", async (req: Request, res: Response) => {
    try {
        const data = await sessionManager.resetAuth(req.params.id);
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to reset session auth";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});

// Se estado for FAILED, força tentativa de recuperação
sessionsRouter.post("/:id/unfail", async (req: Request, res: Response) => {
    try {
        const data = await sessionManager.unfail(req.params.id);
        return ok(res, data);
    } catch (err: any) {
        const msg = err?.message || "Unable to unfail session";
        if (msg.includes("Session not found")) return fail(res, msg, 404, 'not_found');
        return fail(res, msg, 400, 'error');
    }
});
