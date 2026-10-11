# Minimal runtime image: the bot has no dependencies, so nothing is installed.
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /app /data
USER node

# Conversation history and the polling offset live here; mount a volume to keep
# them across container recreations.
VOLUME ["/data"]

# Add --use-env-proxy when the container must reach Telegram through HTTPS_PROXY.
CMD ["node", "src/index.mjs"]
