# WhatsApp Max API

API em Node.js/TypeScript para gerenciar sessões do WhatsApp Web usando WPPConnect, com:

- Criação/recuperação de sessões (token store em disco)
- QR Code (dataURL e PNG)
- Envio de mensagens (texto e mídia)
- Webhooks de eventos (mensagens, ACKs, status)
- Paginação/listagem de conversas (IDs de chats)
- Reconexão manual/sob demanda (sem retry agressivo automático)
- Documentação Swagger em `/docs`
- Pronto para Docker (prod e dev)

> Aviso: Este projeto usa WhatsApp Web (não é a API oficial do WhatsApp). Use com responsabilidade e de acordo com os termos de serviço da plataforma.

---

## Sumário

- Arquitetura
- Requisitos
- Configuração
  - Variáveis de Ambiente
  - Instalação local
  - Rodando em Docker (profiles)
- Como usar
  - Autenticação via API Key
  - Swagger
  - Rotas
  - Exemplos com cURL
- Webhooks
- Persistência e limpeza
- Boas práticas
- Solução de problemas

---

## Arquitetura

- Express + TypeScript
- WPPConnect (Puppeteer/Chromium)
- Persistência de sessão em disco (`SESSIONS_DIR/<sessionId>`)
- Pino (logs)
- Swagger UI (`/docs`, `/openapi.json`)
- Docker (chromium instalado)

---

## Requisitos

- Node.js 18+ (recomendado 20+)
- npm 9+
- Docker (opcional, recomendado em produção)
- Chrome/Chromium local (apenas fora do Docker)

---

## Configuração

### Variáveis de Ambiente

Crie um `.env` na raiz (ou configure no provedor):

```
NODE_ENV=production
PORT=3000
SESSIONS_DIR=./sessions
API_KEY=change-me
HEADLESS=true
CHROME_EXECUTABLE_PATH=
CHROME_EXTRA_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu
WEBHOOK_TIMEOUT_MS=6000
WEBHOOK_MAX_RETRIES=3
MAX_CONCURRENT_SESSIONS=0
BOOTSTRAP_READY_TIMEOUT_MS=180000
DESTROY_MAX_RETRIES=5
READY_FALLBACK_MS=30000
WWEB_READY_CHECK_TIMEOUT_MS=60000
```

Notas rápidas:

- `SESSIONS_DIR`: raiz das pastas de sessão; o LocalAuth cria também `session-<id>`.
- `HEADLESS`: mantenha true em produção.
- `CHROME_EXECUTABLE_PATH`: deixe vazio no Windows/local; no Docker já usamos chromium do container.
- `READY_FALLBACK_MS`: se o evento `ready` não ocorrer, promovemos a READY quando `getState()` ficar CONNECTED por esse tempo (com injeção do wwebjs pronta).
- `WWEB_READY_CHECK_TIMEOUT_MS`: tempo máximo para considerar a injeção concluída antes de operações como `getChats`/`sendMessage`.

### Instalação local

```bash
npm i
npm run dev
# Swagger: http://localhost:3000/docs
```

### Rodando em Docker (profiles)

docker-compose.yml inclui dois serviços e perfis:

- prod: `api` (build runtime, porta `${PORT}`)
- dev: `api-dev` (ts-node-dev, porta `${DEV_PORT:-3001}` -> `${PORT}`)

Comandos:

```bash
# Produção
docker compose --profile prod up -d --build

# Desenvolvimento
docker compose --profile dev up -d --build

# Logs
docker compose logs -f api
docker compose logs -f api-dev
```

Importante: não suba `api` e `api-dev` simultaneamente no mesmo host/volume.

---

## Como usar

### Autenticação via API Key

Se `API_KEY` estiver definida, envie:

```
x-api-key: <sua-chave>
```

### Swagger

- UI: `GET /docs`
- JSON: `GET /openapi.json`

### Rotas

| Método | Path                                   | Descrição                                                                                 |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/health`                              | Healthcheck (público)                                                                      |
| POST   | `/sessions`                            | Criar sessão `{ "sessionId": "MINHA-SESSAO" }`                                           |
| GET    | `/sessions`                            | Listar sessões ativas no processo                                                          |
| GET    | `/sessions/:id/status`                 | Status de uma sessão                                                                       |
| GET    | `/sessions/:id/qr`                     | QR Code em dataUrl (`?wait=1&timeout=10000`)                                               |
| GET    | `/sessions/:id/qr.png`                 | QR Code como PNG (`?w=350&wait=1&timeout=10000`)                                           |
| POST   | `/sessions/:id/webhook`                | Definir/remover webhook `{ "url": "https://..." }`                                       |
| DELETE | `/sessions/:id?deleteData=true`        | Destruir sessão; com `deleteData=true` apaga tudo (pasta raiz e caches `session-*`)        |
| GET    | `/sessions/:id/chats?page=1&limit=10`  | Lista IDs de conversas com paginação                                                       |
| POST   | `/messages/send`                       | Enviar texto ou mídia (por `chatId` ou `to`)                                               |
| GET    | `/messages/:sessionId/history`         | Listar mensagens do chat; body `{ "chatId": "...@c.us" }` (cada item inclui `dateSent`)   |
| GET    | `/messages/:sessionId/resolve`         | Resolver número para chatId (`phone` em query/body; prefixa 55 se faltar)                  |

Padrão de resposta JSON: sempre traz `message` (ex.: `ok`, `pending`, `initializing`, `no_whatsapp`, `error`).

### Exemplos com cURL

Criar sessão

```bash
curl -X POST http://localhost:3000/sessions \
 -H "Content-Type: application/json" \
 -H "x-api-key: change-me" \
 -d '{ "sessionId": "ROBOCELL1" }'
```

Obter QR (dataURL) aguardando até 10s

```bash
curl "http://localhost:3000/sessions/ROBOCELL1/qr?wait=1&timeout=10000" -H "x-api-key: change-me"
```

Obter QR (PNG 400px)

```bash
curl -L "http://localhost:3000/sessions/ROBOCELL1/qr.png?w=400&wait=1&timeout=10000" \
 -H "x-api-key: change-me" --output qr.png
```

Listar chats

```bash
curl "http://localhost:3000/sessions/ROBOCELL1/chats?page=1&limit=10" -H "x-api-key: change-me"
```

Enviar texto por chatId

```bash
curl -X POST http://localhost:3000/messages/send \
 -H "Content-Type: application/json" -H "x-api-key: change-me" \
 -d '{ "sessionId":"ROBOCELL1", "chatId":"554888211762@c.us", "type":"text", "body":"Olá!" }'
```

Enviar documento por URL com legenda

```bash
curl -X POST http://localhost:3000/messages/send \
 -H "Content-Type: application/json" -H "x-api-key: change-me" \
 -d '{ "sessionId":"ROBOCELL1", "to":"554888211762", "type":"media",
       "media": { "url":"https://example.com/contrato.pdf", "mimetype":"application/pdf", "filename":"contrato.pdf" },
       "caption":"segue o contrato" }'
```

Resolver número para chatId (prefixa 55)

```bash
curl -G "http://localhost:3000/messages/ROBOCELL1/resolve" \
 -H "x-api-key: change-me" --data-urlencode "phone=48988211762"
```

Histórico de mensagens (inclui dateSent)

```bash
curl -X GET "http://localhost:3000/messages/ROBOCELL1/history" \
 -H "x-api-key: change-me" -H "Content-Type: application/json" \
 -d '{ "chatId": "554888211762@c.us" }'
```

Destruir sessão e apagar tudo (inclusive caches `session-*`)

```bash
curl -X DELETE "http://localhost:3000/sessions/ROBOCELL1?deleteData=true" -H "x-api-key: change-me"
```

---

## Webhooks

Defina via `POST /sessions/:id/webhook`:

```json
{ "url": "https://minha.app/webhooks/whatsapp" }
```

Eventos enviados (JSON):

- `qr`: `{ event, sessionId, status }`
- `authenticated`: `{ event, sessionId, status }`
- `auth_failure`: `{ event, sessionId, status, message }`
- `ready`: `{ event, sessionId, status }`
- `disconnected`: `{ event, sessionId, status, reason }`
- `message`: `{ event, sessionId, from, to, body, timestamp, type, id }`
- `message_ack`: `{ event, sessionId, id, to, ack }`

Timeout e tentativas são controlados por `WEBHOOK_TIMEOUT_MS` e `WEBHOOK_MAX_RETRIES`.

---

## Persistência e limpeza

- Memória: o processo guarda as sessões ativas em um Map (status, QR em cache, client).
- Disco (`SESSIONS_DIR`): LocalAuth e perfil do Chromium por sessão.
- Boot: o sistema tenta inicializar cada pasta; se não ficar READY dentro de `BOOTSTRAP_READY_TIMEOUT_MS`, mantém os dados e registra aviso (não apaga automaticamente).
- `DELETE /sessions/:id?deleteData=true` remove a pasta da sessão e as variações `session-<id>`, `session-session-<id>`, etc.

> Em Docker, monte um volume em `/app/sessions` para manter o login entre reinícios.

---

## Boas práticas

- Não compartilhe o mesmo `SESSIONS_DIR` entre dois processos simultâneos.
- Separe pastas de dev e prod (use os profiles do compose).
- Mantenha `HEADLESS=true` no Docker.
- Garanta rede estável para o Chromium.
- Trate rate limiting do seu lado.
- Monitore logs de `auth_failure` e `disconnected`.

---

## Solução de problemas

- 401 Unauthorized: faltou header `x-api-key` (ou clique Authorize no Swagger).
- `spawn /usr/bin/chromium ENOENT` (Windows): deixe `CHROME_EXECUTABLE_PATH` vazio; o Puppeteer encontra o navegador.
- "The profile appears to be in use": evite rodar duas instâncias na mesma pasta; use um perfil por serviço (prod/dev).
- `QR not available yet`: use `?wait=1&timeout=10000` nas rotas de QR.
- `Session already exists`: já existe pasta/instância com esse id; apague com `deleteData=true` ou use outro id.
- `Session not READY` ao enviar: aguarde `status=READY` em `/sessions/:id/status`.

---
