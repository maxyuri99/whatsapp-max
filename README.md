# WhatsApp Max API

API em Node.js/TypeScript para gerenciar **sessões do WhatsApp Web** usando [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), com recursos de:

* criação/recuperação de sessões
* QR Code (dataURL e PNG)
* envio de mensagens (texto e mídias)
* webhooks de eventos (mensagens, ACKs, status)
* paginação de conversas (IDs de chats)
* persistência em disco (LocalAuth) e **reconexão automática**
* limpeza de perfis órfãos/duplicados
* documentação **Swagger** em `/docs`
* pronto para **Docker**/**Easypanel**

> ⚠️ Este projeto usa WhatsApp Web (não é API oficial do WhatsApp). Use com responsabilidade e de acordo com os termos de serviço da plataforma.

---

## Sumário

* [Arquitetura](#arquitetura)
* [Requisitos](#requisitos)
* [Configuração](#configuração)

  * [Variáveis de Ambiente](#variáveis-de-ambiente)
  * [Instalação local](#instalação-local)
  * [Rodando em Docker](#rodando-em-docker)
* [Como usar](#como-usar)

  * [Autenticação via API Key](#autenticação-via-api-key)
  * [Swagger](#swagger)
  * [Rotas](#rotas)
  * [Exemplos com cURL](#exemplos-com-curl)
* [Webhooks](#webhooks)
* [Persistência, memória e limpeza](#persistência-memória-e-limpeza)
* [Boas práticas em produção](#boas-práticas-em-produção)
* [Solução de problemas](#solução-de-problemas)
* [Licença](#licença)

---

## Arquitetura

* **Express + TypeScript**
* **whatsapp-web.js** para controlar o WhatsApp Web (Puppeteer/Chromium)
* **LocalAuth**: dados de sessão persistidos por pasta
* **Pino** para logs
* **Swagger UI** em `/docs` e `/openapi.json`
* **Docker** com Chromium já instalado
* **Gerenciador de sessões** com:

  * reconexão automática
  * limpeza de locks do Chromium
  * varredura de sessões no boot e exclusão de órfãos
  * envio de eventos via webhook (opcional)

---

## Requisitos

* Node.js 18+ (recomendado 20+)
* npm 9+
* Docker (opcional, mas recomendado em produção)
* Chromium/Chrome local **apenas** se for rodar fora do Docker (o container já instala)

---

## Configuração

### Variáveis de Ambiente

Crie um arquivo `.env` na raiz (ou configure no Easypanel). Exemplo:

```
PORT=3000
SESSIONS_DIR=/app/sessions
API_KEY=change-me
HEADLESS=true
CHROME_EXECUTABLE_PATH=/usr/bin/chromium
CHROME_EXTRA_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu
WEBHOOK_TIMEOUT_MS=6000
WEBHOOK_MAX_RETRIES=3
MAX_CONCURRENT_SESSIONS=0
BOOTSTRAP_READY_TIMEOUT_MS=30000
DESTROY_MAX_RETRIES=5
```

**Descrição rápida:**

| Variável                     |      Default | Descrição                                                                                          |
| ---------------------------- | -----------: | -------------------------------------------------------------------------------------------------- |
| `PORT`                       |       `3000` | Porta HTTP da API                                                                                  |
| `SESSIONS_DIR`               | `./sessions` | Pasta onde o **LocalAuth** persiste as sessões                                                     |
| `API_KEY`                    |        vazio | Se definido, todas as rotas (exceto `/health`, `/docs`, `/openapi.json`) exigem header `x-api-key` |
| `HEADLESS`                   |       `true` | Executa Chromium sem UI                                                                            |
| `CHROME_EXECUTABLE_PATH`     |    detectado | Caminho do Chromium/Chrome. No Windows, deixe **vazio**; no Docker já usamos `/usr/bin/chromium`   |
| `CHROME_EXTRA_ARGS`          |    ver acima | Flags recomendadas ao Chromium no container                                                        |
| `WEBHOOK_TIMEOUT_MS`         |       `6000` | Timeout da chamada HTTP do webhook                                                                 |
| `WEBHOOK_MAX_RETRIES`        |          `3` | Tentativas do webhook                                                                              |
| `MAX_CONCURRENT_SESSIONS`    |          `0` | Limite de sessões simultâneas (`0` = sem limite)                                                   |
| `BOOTSTRAP_READY_TIMEOUT_MS` |      `30000` | Tempo esperado para sessão voltar `READY` no boot; se não, é removida                              |
| `DESTROY_MAX_RETRIES`        |          `5` | Tentativas ao remover pastas de sessão/caches                                                      |

> Windows (dev): **deixe `CHROME_EXECUTABLE_PATH` vazio** para o Puppeteer localizar seu navegador automaticamente.

---

### Instalação local

```bash
git clone https://github.com/seu-usuario/whatsapp-max.git
cd whatsapp-max

# 1) crie o .env (veja seção acima)
cp .env.example .env   # se houver o arquivo de exemplo

# 2) dependências
npm i

# 3) dev
npm run dev

# UI do Swagger:
# http://localhost:3000/docs
```

---

### Rodando em Docker

Exemplo de `docker compose` (ajuste volumes/portas conforme sua infra):

```yaml
services:
  api:
    image: whatsapp-max-api:latest
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    env_file: .env
    volumes:
      - ./sessions:/app/sessions  # persistência entre reinícios
    restart: unless-stopped
```

Suba:

```bash
docker compose up -d --build
docker logs -f <nome-do-container>
```

> Em **Easypanel**, crie um **Volume** persistente e monte em `/app/sessions`. Adicione as variáveis do `.env` na interface.

---

## Como usar

### Autenticação via API Key

Se `API_KEY` estiver definida, envie nas requisições:

```
x-api-key: <sua-chave>
```

No **Swagger UI** (`/docs`), clique em **Authorize** e informe a mesma chave.

### Swagger

* UI: `GET /docs`
* JSON: `GET /openapi.json`

### Rotas

| Método   | Path                                  | Descrição                                                                               |
| -------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET`    | `/health`                             | Healthcheck (público)                                                                   |
| `POST`   | `/sessions`                           | Criar sessão `{ "sessionId": "MINHA-SESSAO" }`                                          |
| `GET`    | `/sessions`                           | Listar sessões ativas no processo                                                       |
| `GET`    | `/sessions/:id/status`                | Status de uma sessão                                                                    |
| `GET`    | `/sessions/:id/qr`                    | QR Code em `dataUrl` (`?wait=1&timeout=10000`)                                          |
| `GET`    | `/sessions/:id/qr.png`                | QR Code como PNG (`?w=350&wait=1&timeout=10000`)                                        |
| `POST`   | `/sessions/:id/webhook`               | Definir/remover webhook `{ "url": "https://..." }`                                      |
| `DELETE` | `/sessions/:id?deleteData=true`       | Destruir sessão; com `deleteData=true` apaga **tudo** (pasta raiz e caches `session-*`) |
| `GET`    | `/sessions/:id/chats?page=1&limit=10` | Lista **IDs** de conversas com paginação                                                |
| `POST`   | `/messages/send`                      | Enviar texto ou mídia (por `chatId` **ou** `to`)                                        |

**Envio de mensagens — corpo JSON:**

```json
{
  "sessionId": "MINHA-SESSAO",
  "chatId": "554888211762@c.us",
  "type": "text",
  "body": "Olá!"
}
```

Ou mídia:

```json
{
  "sessionId": "MINHA-SESSAO",
  "chatId": "554888211762@c.us",
  "type": "media",
  "caption": "veja isso",
  "media": {
    "url": "https://site.com/arquivo.pdf",
    "mimetype": "application/pdf",
    "filename": "arquivo.pdf"
  }
}
```

Também aceita `media.base64` (data URL ou base64 puro):

```json
{
  "sessionId": "MINHA-SESSAO",
  "to": "554888211762",
  "type": "media",
  "media": {
    "base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ..."
  },
  "caption": "foto"
}
```

**Observações:**

* Use **`chatId`** (ex.: `554888211762@c.us`) ou **`to`** (número). Um dos dois é obrigatório.
* `type` pode ser `text` ou `media`. Para mídia, informe `media.url` **ou** `media.base64` e, opcionalmente, `mimetype` e `filename`.
* Retorno típico de envio:

```json
{
  "id": "true_554888211762@c.us_3EB0EC5FB79068AFBD5A95",
  "to": "554888211762@c.us",
  "chatId": "554888211762@c.us",
  "timestamp": 1756492403,
  "type": "text",
  "body": "Olá do Max teste!"
}
```

---

### Exemplos com cURL

**Criar sessão:**

```bash
curl -X POST http://localhost:3000/sessions \
 -H "Content-Type: application/json" \
 -H "x-api-key: change-me" \
 -d '{ "sessionId": "ROBOCELL1" }'
```

**Obter QR (dataURL) aguardando até 10s:**

```bash
curl "http://localhost:3000/sessions/ROBOCELL1/qr?wait=1&timeout=10000" \
 -H "x-api-key: change-me"
```

**Obter QR (PNG 400px):**

```bash
curl -L "http://localhost:3000/sessions/ROBOCELL1/qr.png?w=400&wait=1&timeout=10000" \
 -H "x-api-key: change-me" --output qr.png
```

**Listar chats (página 1, 10 itens):**

```bash
curl "http://localhost:3000/sessions/ROBOCELL1/chats?page=1&limit=10" \
 -H "x-api-key: change-me"
```

**Enviar texto por chatId:**

```bash
curl -X POST http://localhost:3000/messages/send \
 -H "Content-Type: application/json" \
 -H "x-api-key: change-me" \
 -d '{ "sessionId":"ROBOCELL1", "chatId":"554888211762@c.us", "type":"text", "body":"Olá!" }'
```

**Enviar documento por URL com legenda:**

```bash
curl -X POST http://localhost:3000/messages/send \
 -H "Content-Type: application/json" \
 -H "x-api-key: change-me" \
 -d '{ "sessionId":"ROBOCELL1", "to":"554888211762", "type":"media",
       "media": { "url":"https://example.com/contrato.pdf", "mimetype":"application/pdf", "filename":"contrato.pdf" },
       "caption":"segue o contrato" }'
```

**Destruir sessão e apagar tudo (inclusive caches `session-*`):**

```bash
curl -X DELETE "http://localhost:3000/sessions/ROBOCELL1?deleteData=true" \
 -H "x-api-key: change-me"
```

---

## Webhooks

Defina via `POST /sessions/:id/webhook`:

```json
{ "url": "https://minha.app/webhooks/whatsapp" }
```

Eventos enviados (JSON):

* `qr` — `{ event, sessionId, status }`
* `authenticated` — `{ event, sessionId, status }`
* `auth_failure` — `{ event, sessionId, status, message }`
* `ready` — `{ event, sessionId, status }`
* `disconnected` — `{ event, sessionId, status, reason }`
* `message` — `{ event, sessionId, from, to, body, timestamp, type, id }`
* `message_ack` — `{ event, sessionId, id, to, ack }`

Timeout e tentativas são controlados por `WEBHOOK_TIMEOUT_MS` e `WEBHOOK_MAX_RETRIES`.

---

## Persistência, memória e limpeza

* **Memória**: o processo guarda as sessões ativas em um `Map` (status, QR em cache, client).
* **Disco (`SESSIONS_DIR`)**: o LocalAuth e o perfil do Chromium vivem numa pasta por sessão.
* No boot, o sistema:

  1. Limpa **pastas órfãs** e duplicadas (`session-*`, `session-session-*` sem raiz).
  2. Tenta inicializar cada pasta “raiz”.
  3. Se não ficar `READY` dentro de `BOOTSTRAP_READY_TIMEOUT_MS`, a pasta é **removida**.
* `DELETE /sessions/:id?deleteData=true` remove a pasta da sessão **e** todas as variações `session-<id>`, `session-session-<id>`, etc.

> Em Docker/Easypanel, **monte um volume** em `/app/sessions` para manter o login entre reinícios.

---

## Boas práticas em produção

* **Não compartilhe** o mesmo `SESSIONS_DIR` entre dois processos simultâneos.
* Separe pastas de **dev** e **prod**.
* Mantenha `HEADLESS=true` no Docker.
* Se usar proxy/rede restrita, garanta que o Chromium tenha acesso.
* Trate rate limiting do seu lado (não incluso por padrão).
* Monitore logs de `auth_failure` e `disconnected`.

---

## Solução de problemas

* **401 Unauthorized**: faltou header `x-api-key` (ou clique **Authorize** no Swagger).
* **`spawn /usr/bin/chromium ENOENT`** no Windows: deixe `CHROME_EXECUTABLE_PATH` **vazio**; o Puppeteer encontra o navegador local.
* **“The profile appears to be in use”**: o código já limpa locks; evite rodar duas instâncias na mesma pasta.
* **`QR not available yet`**: use `?wait=1&timeout=10000` nas rotas de QR.
* **`Session already exists`**: já existe pasta/instância com esse id; apague com `deleteData=true` ou use outro id.
* **`Session not READY` ao enviar**: aguarde `status=READY` em `/sessions/:id/status`.
* **Docker não atualiza após alterar código**: use o serviço de **dev** com bind-mount do código ou `--build` a cada mudança, ou configure um container de dev com `ts-node-dev`.

---

## Licença

Livre para uso educacional e comercial, sem garantias. Verifique as licenças das dependências e os termos do WhatsApp.

---