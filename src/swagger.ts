export const swaggerSpec = {
    openapi: "3.0.3",
    info: { title: "WhatsApp Max API", description: "API de sessões WhatsApp usando whatsapp-web.js", version: "1.3.0" },
    servers: [{ url: "/", description: "Local" }],
    components: {
        securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" } },
        schemas: {
            CreateSessionRequest: {
                type: "object",
                required: ["sessionId"],
                properties: { sessionId: { type: "string", example: "minha-sessao-01" } },
            },
            SessionListItem: {
                type: "object",
                properties: {
                    sessionId: { type: "string" },
                    status: { type: "string", enum: ["INITIALIZING", "QRCODE", "AUTHENTICATED", "READY", "DISCONNECTED", "AUTH_FAILURE", "FAILED"] },
                    webhookUrl: { type: "string", nullable: true },
                    lastConnectionAt: { type: "string", format: "date-time", nullable: true },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            SessionStatusResponse: {
                type: "object",
                properties: {
                    sessionId: { type: "string" },
                    status: { type: "string" },
                    webhookUrl: { type: "string", nullable: true },
                    lastConnectionAt: { type: "string", format: "date-time", nullable: true },
                },
            },
            WebhookRequest: {
                type: "object",
                properties: { url: { type: "string", example: "https://example.com/webhooks/whatsapp", nullable: true } },
            },
            SendMessageRequest: {
                type: "object",
                required: ["sessionId"],
                properties: {
                    sessionId: { type: "string", example: "minha-sessao-01" },
                    chatId: { type: "string", example: "554888211762@c.us", nullable: true },
                    to: { type: "string", example: "554888211762", nullable: true },
                    type: { type: "string", enum: ["text", "media", "image", "document", "audio", "video"], nullable: true },
                    body: { type: "string", example: "Olá!", nullable: true },
                    caption: { type: "string", example: "veja isso", nullable: true },
                    media: {
                        type: "object",
                        nullable: true,
                        properties: {
                            url: { type: "string", example: "https://site.com/arquivo.pdf", nullable: true },
                            base64: { type: "string", example: "data:application/pdf;base64,JVBERi0xL...", nullable: true },
                            mimetype: { type: "string", example: "application/pdf", nullable: true },
                            filename: { type: "string", example: "arquivo.pdf", nullable: true },
                        },
                    },
                },
            },
            ListChatsResponse: {
                type: "object",
                properties: {
                    message: { type: "string", example: "ok" },
                    sessionId: { type: "string" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                    total: { type: "integer" },
                    pages: { type: "integer" },
                    ids: { type: "array", items: { type: "string" } },
                },
            },
            HistoryRequest: {
                type: "object",
                required: ["chatId"],
                properties: { chatId: { type: "string", example: "554888211762@c.us" } },
            },
            HistoryMessage: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    from: { type: "string" },
                    to: { type: "string" },
                    timestamp: { type: "integer" },
                    dateSent: { type: "string", format: "date-time" },
                    type: { type: "string" },
                    body: { type: "string" },
                    fromMe: { type: "boolean" },
                    hasMedia: { type: "boolean" },
                    ack: { type: "integer" },
                },
            },
            HistoryResponse: {
                type: "object",
                properties: {
                    message: { type: "string", example: "ok" },
                    sessionId: { type: "string" },
                    chatId: { type: "string" },
                    total: { type: "integer" },
                    messages: { type: "array", items: { $ref: "#/components/schemas/HistoryMessage" } },
                },
            },
            ResolveNumberResponse: {
                type: "object",
                properties: { message: { type: "string", example: "ok" }, chatId: { type: "string" }, phone: { type: "string" } },
            },
        },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
        "/health": {
            get: { security: [], tags: ["system"], summary: "Healthcheck", responses: { "200": { description: "OK" } } },
        },
        "/sessions": {
            post: {
                tags: ["sessions"],
                summary: "Criar sessão",
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateSessionRequest" } } } },
                responses: { "201": { description: "Criado" }, "409": { description: "Já existe" }, "400": { description: "Erro de validação" } },
            },
            get: {
                tags: ["sessions"],
                summary: "Listar sessões",
                responses: {
                    "200": { description: "Lista", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/SessionListItem" } } } } },
                },
            },
        },
        "/sessions/{id}/status": {
            get: {
                tags: ["sessions"],
                summary: "Status da sessão",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: {
                    "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/SessionStatusResponse" } } } },
                    "404": { description: "Não encontrada" },
                },
            },
        },
        "/sessions/{id}/qr": {
            get: {
                tags: ["sessions"],
                summary: "Obter QR em dataURL",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                    { name: "wait", in: "query", required: false, schema: { type: "string", enum: ["1", "true", "0", "false"] } },
                    { name: "timeout", in: "query", required: false, schema: { type: "integer", minimum: 1000, maximum: 60000, default: 10000 } },
                ],
                responses: {
                    "200": { description: "QR dataURL", content: { "application/json": { schema: { type: "object", properties: { dataUrl: { type: "string" } } } } } },
                    "202": { description: "Ainda aguardando" },
                    "204": { description: "Já autenticado" },
                    "404": { description: "Não encontrada" },
                    "400": { description: "Indisponível" },
                },
            },
        },
        "/sessions/{id}/qr.png": {
            get: {
                tags: ["sessions"],
                summary: "Obter QR como PNG",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                    { name: "w", in: "query", required: false, schema: { type: "integer", minimum: 50, maximum: 1000, default: 350 } },
                    { name: "wait", in: "query", required: false, schema: { type: "string", enum: ["1", "true", "0", "false"] } },
                    { name: "timeout", in: "query", required: false, schema: { type: "integer", minimum: 1000, maximum: 60000, default: 10000 } },
                ],
                responses: {
                    "200": { description: "PNG", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
                    "202": { description: "Ainda aguardando" },
                    "204": { description: "Já autenticado" },
                    "404": { description: "Não encontrada" },
                    "400": { description: "Indisponível" },
                },
            },
        },
        "/sessions/{id}/webhook": {
            post: {
                tags: ["sessions"],
                summary: "Definir ou remover webhook",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookRequest" } } } },
                responses: { "200": { description: "OK" }, "404": { description: "Não encontrada" } },
            },
        },
        "/sessions/{id}": {
            delete: {
                tags: ["sessions"],
                summary: "Destruir sessão",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                    { name: "deleteData", in: "query", required: false, schema: { type: "boolean", default: false } },
                ],
                responses: { "200": { description: "OK" }, "404": { description: "Não encontrada" } },
            },
        },
        "/sessions/{id}/chats": {
            get: {
                tags: ["sessions"],
                summary: "Listar IDs de conversas",
                parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                    { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
                    { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
                ],
                responses: {
                    "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/ListChatsResponse" } } } },
                    "404": { description: "Sessão não encontrada" },
                },
            },
        },
        "/messages/send": {
            post: {
                tags: ["messages"],
                summary: "Enviar mensagem (texto ou mídia) por chatId ou número",
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SendMessageRequest" } } } },
                responses: { "200": { description: "Enviado" }, "400": { description: "Erro" }, "404": { description: "Sessão não encontrada" } },
            },
        },
        "/sessions/{id}/restart": {
            post: {
                tags: ["sessions"],
                summary: "Reiniciar sessão",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "OK" }, "404": { description: "Nǜo encontrada" } },
            },
        },
        "/sessions/{id}/reset-auth": {
            post: {
                tags: ["sessions"],
                summary: "Resetar credenciais (LocalAuth) e reiniciar",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "OK" }, "404": { description: "Nǜo encontrada" } },
            },
        },
        "/sessions/{id}/unfail": {
            post: {
                tags: ["sessions"],
                summary: "Forçar recuperação se estado for FAILED",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "OK" }, "404": { description: "Nǜo encontrada" } },
            },
        },
    },
};

