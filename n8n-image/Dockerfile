# The live n8n image, with jimp baked in.
#
# Why this file exists: the Railway service currently builds from
# Shinyduo/n8n-railway-updated, a third-party repo Railway reports as
# "GitHub Repo not found". Nobody here can edit that Dockerfile, and anything
# installed by hand into the running container is gone on the next deploy.
# That is the whole reason jimp keeps disappearing.
#
# Pinned to the version already running (n8n 2.34.6, Node 24.18.0). Do NOT
# float this to :latest - n8n's database migrations are one-way, so a rebuild
# that lands on an older tag than the data leaves the instance broken.
FROM n8nio/n8n:2.34.6

USER root

# npm's global prefix here is /usr/local, so this lands in
# /usr/local/lib/node_modules/jimp.
#
# That path matters. Code nodes execute inside a separate @n8n/task-runner
# process whose resolver lives at
#   /usr/local/lib/node_modules/n8n/node_modules/.pnpm/@n8n+task-runner…/dist/js-task-runner/require-resolver.js
# Node walks that file's ancestors looking for node_modules directories, and
# /usr/local/lib/node_modules is one of them. The persistent volume at
# /home/node/.n8n is not, and NODE_PATH never reaches the runner - n8n spawns
# it with a fixed env allowlist that does not include NODE_PATH. That is why
# the deployed NODE_PATH variable changed nothing.
#
# Pinned to 0.x deliberately. Node 24 can require() an ESM package, so jimp v1
# would import, but v1 moved fonts out of the main package and the render
# pipeline's branding step calls loadFont/FONT_SANS_16_WHITE. On v1 that path
# silently degrades and the contact line vanishes from branded renders.
RUN npm install -g jimp@0.22.12

USER node
