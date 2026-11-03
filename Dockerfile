# fckscrn server with LibreOffice for PPTX/Keynote → PDF conversion
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress fonts-dejavu fonts-liberation fonts-noto-core fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY server/public ./public
COPY player/renderer ./player
ENV PLAYER_DIR=/app/player

ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
# the app runs as "node", so it must own the data volume
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
