FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/zerqon.sqlite
USER node
EXPOSE 3000
CMD ["npm", "start"]
