import "express-async-errors";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { CONFIG } from "./config";
import { logger } from "./utils/logger";
import { apiKey } from "./middleware/apiKey";
import { sessionManager } from "./managers/sessionManager";
import { sessionsRouter } from "./routes/sessions";
import { messagesRouter } from "./routes/messages";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { swaggerOptions: { persistAuthorization: true } }));
app.get("/openapi.json", (_req, res) => res.json(swaggerSpec));

app.use(apiKey);

app.use("/sessions", sessionsRouter);
app.use("/messages", messagesRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.stack || err?.message || err }, "unhandled error");
    res.status(500).json({ error: err?.message || "Internal error" });
});

const server = app.listen(CONFIG.PORT, async () => {
    logger.info({ port: CONFIG.PORT }, "server up");
    await sessionManager.bootstrapFromDisk();
});

const shutdown = () => {
    logger.info("shutting down...");
    server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
