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

if [ "$(id -u)" -eq 0 ]; then
  # su-exec is the Alpine equivalent of gosu. It execs the server as node.
  exec su-exec "$run_as" "$@"
fi

exec "$@"
