#!/bin/sh
set -e
cd "$(dirname "$0")"
entrypoint=$1
shift
exec docker run --rm -i --user "$(id -u):$(id -g)" -e HOME=/tmp \
	--env-file .env -v "$PWD:/work" -w /work \
	--entrypoint "$entrypoint" cf-tools "$@"
