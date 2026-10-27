#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
container=${SDC_DATABASE_CONTAINER:-vertex-tech-postgres}
port=${SDC_DATABASE_PORT:-55432}
image=postgres@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe
if ! docker container inspect "$container" >/dev/null 2>&1; then
  mkdir -p "$root/.local/postgres"
  chmod 700 "$root/.local/postgres"
  docker run -d --name "$container" --user "$(id -u):$(id -g)" -e POSTGRES_USER=sdc_dev -e POSTGRES_DB=smart_dental_clinic -e POSTGRES_HOST_AUTH_METHOD=trust -e PGDATA=/var/lib/postgresql/data/pgdata -p "127.0.0.1:$port:5432" -v "$root/.local/postgres:/var/lib/postgresql/data" "$image"
else
  docker start "$container" >/dev/null
fi
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -U sdc_dev -d smart_dental_clinic >/dev/null 2>&1; then echo 'Development PostgreSQL is ready.'; exit 0; fi
  sleep 1
done
echo 'PostgreSQL did not become ready; inspect its container logs.' >&2
exit 1
