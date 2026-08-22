# Pinned rather than floating: sharp ships prebuilt binaries per Node ABI, and a
# surprise major bump is exactly the class of change that broke n8n today.
FROM node:22-bookworm-slim

WORKDIR /app

# sharp rasterises the branding overlay through librsvg, and librsvg draws a
# missing-glyph box for every character when the image has no fonts installed -
# which node:22-bookworm-slim does not. The first real branding pass came back
# with the contractor's phone number as a row of tofu boxes. DejaVu is a couple
# of MB and is what fontconfig resolves a generic sans-serif to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first so a code-only change reuses the dependency layer.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
