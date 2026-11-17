# Imagen de producción del back: se compila en una etapa y se ejecuta en otra
# sólo con las dependencias de runtime.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TZ=America/Argentina/Buenos_Aires
RUN apt-get update && apt-get install -y --no-install-recommends tzdata wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
# Con los .map del build, los stacks (y lo que llega a Sentry) muestran el
# archivo y la línea del TypeScript, no los del JavaScript compilado.
CMD ["node", "--enable-source-maps", "dist/main"]
