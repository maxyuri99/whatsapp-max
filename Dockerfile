# ===== STAGE: DEV (hot-reload) =====
FROM node:20-bookworm AS dev
WORKDIR /app

# Não baixar Chromium do puppeteer (usaremos do SO)
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Instala Chromium p/ Puppeteer no dev
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=development
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json tsconfig.json ./
RUN npm install

# copia fontes (serão sobrescritas pelo volume no compose)
COPY src ./src

EXPOSE 3000
CMD ["npm", "run", "dev"]

# ===== STAGE: BUILD (compila TypeScript) =====
FROM node:20-bookworm AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# ===== STAGE: RUNTIME (produção) =====
FROM node:20-bookworm AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

# pasta de sessões persistente
RUN mkdir -p /app/sessions
VOLUME ["/app/sessions"]

EXPOSE 3000
CMD ["node", "dist/index.js"]
