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

# Stay root. The base image would drop to `node`, and that crash-loops here:
#   Error: EACCES: permission denied, open '/home/node/.n8n/config'
# Railway creates the volume mount point owned by root, so an unprivileged
# process cannot write into it. A chown in this file cannot help - the volume
# is mounted at run time, long after the image is built.
#
# The volume was EMPTY before 20 Aug 2026, not merely root-owned. The old
# container ran as root with HOME=/root, so n8n kept its state in /root/.n8n on
# the ephemeral container filesystem and never touched the mount. Proof: the
# first successful root boot could read /home/node/.n8n/config and still logged
# `Credentials could not be decrypted` - it had just generated that config
# itself. Had a valid config been sitting on the volume, root would have read
# it and the credentials would have decrypted.
#
# So the encryption key was always one image swap away from being destroyed.
# The durable fix is not this line - it is setting N8N_ENCRYPTION_KEY as a
# Railway variable, after which n8n never generates a key whatever the volume
# holds. Treat that variable as required, not optional.
