#!/bin/sh
# Public entrypoint for Axel — used by Dockerfile.public.
# Drops to the non-root `axel` user and optionally wires up git config from env.
set -e
chown -R axel:axel /data/audit /data/embeddings /data/models /home/axel /projects

# Credentials are NEVER baked into the image. First-run users sign in via
# the in-app Claude OAuth flow (Settings → Claude account → Sign in with
# Google). ~/.claude.json lives on the axel-home volume and persists across
# restarts so they only sign in once per fresh install.

# Write git config directly for the axel user (avoids PATH issues with gosu + git).
if [ -n "$GIT_USER_NAME" ] || [ -n "$GIT_USER_EMAIL" ]; then
  cat > /home/axel/.gitconfig << EOF
[user]
	name = ${GIT_USER_NAME:-axel}
	email = ${GIT_USER_EMAIL:-axel@localhost}
[credential]
	helper = store
EOF
  chown axel:axel /home/axel/.gitconfig
  chmod 644 /home/axel/.gitconfig
fi

# Write GitHub credentials so git push/pull work without interactive auth.
if [ -n "$GITHUB_TOKEN" ]; then
  printf "https://%s:%s@github.com\n" "${GIT_USER_NAME:-axel}" "$GITHUB_TOKEN" \
    > /home/axel/.git-credentials
  chown axel:axel /home/axel/.git-credentials
  chmod 600 /home/axel/.git-credentials
fi

exec gosu axel "$@"
