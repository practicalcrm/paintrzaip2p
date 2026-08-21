# Pinned rather than floating: sharp ships prebuilt binaries per Node ABI, and a
# surprise major bump is exactly the class of change that broke n8n today.
FROM node:22-bookworm-slim

WORKDIR /app

# Copy manifests first so a code-only change reuses the dependency layer.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
