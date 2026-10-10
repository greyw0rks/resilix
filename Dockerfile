# Resilix — hosted dev ledger.
#
# The deployed website needs a real Canton participant to talk to, and Vercel
# cannot run one: a sandbox is a long-lived JVM, not a serverless function. So
# the ledger is deployed as its own service from this Dockerfile, and the web app
# points at it with LEDGER_URL. It is the same bring-up as scripts/localnet.sh,
# packaged — see scripts/ledger-host.sh, which is the entrypoint.
#
#   docker build -t resilix-ledger .
#   docker run -p 7575:7575 -e RESET_SECONDS=1800 resilix-ledger
#
# LEDGER_PARTY_MAP is deliberately NOT required here. A sandbox that restarts
# re-allocates every party under a new namespace, so a party map baked into the
# web app's environment would go stale on the first reset; app/api/ledger/route.ts
# resolves slugs from the ledger's own /v2/parties instead.

FROM eclipse-temurin:17-jdk-jammy

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl ca-certificates tar gzip \
 && rm -rf /var/lib/apt/lists/*

# The SDK version daml/daml.yaml pins and .github/workflows/ci.yml installs.
RUN curl -sSL https://get.daml.com | sh -s 3.5.0-snapshot.20260403.0
ENV PATH="/root/.daml/bin:${PATH}"

WORKDIR /app
COPY daml/ ./daml/
# Compile at build time: a cold start should start a ledger, not a compiler.
RUN cd daml && daml build

COPY scripts/ledger-host.sh scripts/canton-hosted.conf ./scripts/
RUN chmod +x ./scripts/ledger-host.sh

# The JSON Ledger API is the public port; gRPC stays internal. ledger-host.sh
# passes this through to --json-api-port, and canton-hosted.conf is what makes
# that listener reachable from outside the container rather than loopback-only.
ENV PORT=7575
EXPOSE 7575

CMD ["bash", "scripts/ledger-host.sh"]
