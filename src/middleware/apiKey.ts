import { Request, Response, NextFunction } from "express";
import { CONFIG } from "../config";

export function apiKey(req: Request, res: Response, next: NextFunction) {
    const open = ["/health", "/openapi.json"];
    if (req.path === "/health" || req.path === "/openapi.json" || req.path.startsWith("/docs")) return next();
    if (!CONFIG.API_KEY) return next();
    const key = req.header("x-api-key");
    if (key && key === CONFIG.API_KEY) return next();
    res.status(401).json({ error: "Unauthorized" });
}
