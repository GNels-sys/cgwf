# ---- build stage: install everything, compile TypeScript and the client ----
FROM node:24-bookworm-slim AS build
# better-sqlite3 ships prebuilt binaries; the toolchain is a fallback if one is missing.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage: only what the server needs ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/server/data ./server/data
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
