#!/bin/sh
# Fly volumes mount root-owned. This entrypoint starts as root, gives /data to
# the node user, then drops privileges. A missing /data (local docker run with
# no volume) is created so the server can still write USAGE_LOG_PATH.
set -eu

data_dir="${ADVAN_DATA_DIR:-/data}"
run_as="${ADVAN_RUN_AS:-node}"

if [ -d "$data_dir" ]; then
  chown -R "${run_as}:${run_as}" "$data_dir"
elif [ ! -e "$data_dir" ]; then
  mkdir -p "$data_dir"
  chown "${run_as}:${run_as}" "$data_dir"
else
  echo "advan: ${data_dir} exists and is not a directory" >&2
  exit 1
fi

# Fly init logs "Preparing to run: docker-entrypoint.sh … as root" from the image
# USER, which stays root so this script can chown the volume. That line is not
# the server uid. `exec su-exec` replaces this process; pid 1 is the node user.
if [ "$(id -u)" -eq 0 ]; then
  echo "advan: entrypoint uid 0, exec su-exec ${run_as}" >&2
  exec su-exec "$run_as" "$@"
fi

echo "advan: entrypoint uid $(id -u), already unprivileged" >&2
exec "$@"
