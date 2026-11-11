#!/bin/bash
# 12redflags-deploy.sh
# Publishes the site/ folder of github.com/CNS-hub/12redflags to 12redflags.com
# whenever main has a new commit. Runs from /etc/cron.d/12redflags-deploy every 5 min.
#
# GitHub is the source of truth. Edits made directly on the server are overwritten
# on the next new commit (a backup of the replaced version is kept first).

set -uo pipefail

REPO_URL="https://github.com/CNS-hub/12redflags.git"
SRC=/opt/12redflags-src                       # local clone of the repo
HOME_DIR=/home/12redflags.com
DST=$HOME_DIR/public_html                     # live web root
BACKUPS=$HOME_DIR/backups/auto                # one tarball per replaced version
OWNER=redfl5031
LOG=/var/log/12redflags-deploy.log
KEEP_BACKUPS=20

log(){ echo "$(date -u '+%Y-%m-%d %H:%M:%S UTC') $*" >> "$LOG"; }

# Never run two at once.
exec 9>/run/12redflags-deploy.lock
flock -n 9 || exit 0

# First run: clone.
if [ ! -d "$SRC/.git" ]; then
  git clone -q --depth 1 --branch main "$REPO_URL" "$SRC" || { log "ERROR clone failed"; exit 1; }
  log "cloned $REPO_URL"
fi

cd "$SRC" || exit 1
git fetch -q --depth 1 origin main || { log "ERROR fetch failed"; exit 1; }
NEW=$(git rev-parse origin/main)
LIVE=$(cat "$DST/version.txt" 2>/dev/null | head -1)

# Nothing new: stay quiet.
[ "$NEW" = "$LIVE" ] && exit 0

git reset -q --hard "$NEW"
[ -f "$SRC/site/index.html" ] || { log "ERROR $NEW has no site/index.html, not deploying"; exit 1; }

# Back up what's live now.
mkdir -p "$BACKUPS"; chmod 700 "$HOME_DIR/backups" "$BACKUPS"
STAMP=$(date -u +%Y%m%d-%H%M%S)
BK="$BACKUPS/site-$STAMP-${LIVE:0:7}.tgz"
tar -czf "$BK" -C "$DST" . 2>/dev/null || { log "ERROR backup failed, not deploying"; exit 1; }
ls -1t "$BACKUPS"/site-*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f

# Record the web root's own permissions so we never change them.
ROOT_MODE=$(stat -c '%a' "$DST"); ROOT_GROUP=$(stat -c '%G' "$DST")

# Copy site/ into the web root. -rlt only: no owner/group/perm changes from the source.
# Keep server-only files: .htaccess, Let's Encrypt challenges, version.txt.
rsync -rlt --delete \
  --exclude '.htaccess' --exclude '.well-known/' --exclude 'version.txt' \
  "$SRC/site/" "$DST/" || { log "ERROR rsync failed for $NEW"; exit 1; }

# Fix ownership and modes of the contents only (never the web root itself).
find "$DST" -mindepth 1 -exec chown -h "$OWNER:$OWNER" {} +
find "$DST" -mindepth 1 -type d -exec chmod 755 {} +
find "$DST" -mindepth 1 -type f -exec chmod 644 {} +
printf '%s\n%s\n' "$NEW" "deployed $(date -u '+%Y-%m-%d %H:%M:%S UTC')" > "$DST/version.txt"
chown "$OWNER:$OWNER" "$DST/version.txt"; chmod 644 "$DST/version.txt"

# Guard: the web root must still be readable by the web server.
if [ "$(stat -c '%a' "$DST")" != "$ROOT_MODE" ] || [ "$(stat -c '%G' "$DST")" != "$ROOT_GROUP" ]; then
  chmod "$ROOT_MODE" "$DST"; chgrp "$ROOT_GROUP" "$DST"
  log "WARN web root perms changed during deploy, restored to $ROOT_MODE $ROOT_GROUP"
fi

# Health check. If the site is not serving, roll back to the backup.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 15 --resolve 12redflags.com:443:127.0.0.1 https://12redflags.com/)
if [ "$CODE" != "200" ]; then
  find "$DST" -mindepth 1 -maxdepth 1 ! -name '.htaccess' ! -name '.well-known' -exec rm -rf {} +
  tar -xzf "$BK" -C "$DST"
  chmod "$ROOT_MODE" "$DST"; chgrp "$ROOT_GROUP" "$DST"
  PREV=${LIVE:-none}
  log "ERROR health check got $CODE for ${NEW:0:7}, ROLLED BACK to ${PREV:0:7}"
  exit 1
fi

PREV=${LIVE:-none}
log "deployed ${NEW:0:7} (was ${PREV:0:7}) health=$CODE backup=$(basename "$BK")"
