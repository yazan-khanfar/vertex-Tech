#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
mkdir -p .local
bash scripts/dev-database.sh
npm run db:migrate
if [[ -f .local/server.pid ]] && pid=$(cat .local/server.pid) && [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ "$(ps -p "$pid" -o args=)" == "node $root/server.js" ]]; then
  echo 'Using the recorded application server.'
else
  if node -e 'const s=require("node:net").connect(3000,"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))'; then
    echo 'Port 3000 is occupied by another process. Inspect it before changing any service.' >&2
    exit 1
  fi
  nohup node "$root/server.js" >> .local/server.log 2>&1 < /dev/null &
  echo "$!" > .local/server.pid
fi
for attempt in {1..30}; do
  if node -e 'fetch("http://127.0.0.1:3000/auth/login").then(async r=>{if(r.status!==200 || !(await r.text()).includes("csrf_token"))process.exit(1)}).catch(()=>process.exit(1))' 2>/dev/null; then
    echo 'Application login page is ready on port 3000.'
    exit 0
  fi
  sleep 1
done
echo 'Application readiness failed. Inspect .local/server.log without exposing credentials or reset links.' >&2
exit 1
