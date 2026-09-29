<p align="right">
  <strong>English</strong> | <a href="./README.md">中文</a>
</p>

# simple-one-api

Expose multiple LLM providers through one gateway with OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages client protocols, plus embedded Web chat, visual configuration, and a Wails desktop app.

This project does not track provider billing or account balances. Capacity shown in the UI comes from the local rolling limiter window and is not a provider bill. Model names, prices, free tiers, and upstream endpoints should always be checked against the provider's current official documentation.

## Quick start

No `config.json` is needed for a new installation:

```sh
docker run -d --name simple-one-api -p 9090:9090 \
  -v simple-one-api-data:/app/data \
  -e SIMPLE_ONE_API_DB=/app/data/config.db \
  --restart unless-stopped \
  ghcr.io/fruitbars/simple-one-api:latest
docker logs --tail 100 simple-one-api
```

Open `http://your-server:9090/`. In `/setup`, enter the temporary token from the log if prompted, create and copy a permanent gateway key, then add a provider using its upstream key, URL, and model ID. **Test connection** sends one short generation request from the server to the first model (20-second timeout; provider charges may apply). Save, open Chat, and send a message. A failed or skipped test is clearly marked and does not prevent saving.

Use `http://your-server:9090/v1` as an OpenAI-compatible client's Base URL, the **gateway key** as its API Key, and a configured model ID. The provider's upstream key stays in the provider configuration. See the [step-by-step guide and troubleshooting (Chinese)](docs/quick-start.md).

## Highlights

- `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `GET /v1/models`, `GET /v1/models/:model`, and Embeddings endpoints.
- Multiple providers, models, and API key pools with random, first, round-robin, or hash base routing.
- Capacity-aware key scheduling: estimate remaining TPM per `key + model`, fail over on 429, cool down saturated keys, and calculate their recovery time.
- Combined limits at four scopes: provider, provider-model, key, and key-model. QPS, QPM, RPM, TPM, and concurrency constraints can all apply together.
- Embedded React Web chat with Markdown, streaming metrics, and up to 50 local conversations; production assets are compiled into the server binary with `go:embed`.
- Visual configuration for system settings, providers, upstream protocols, models, key pools, proxies, and access keys, plus a source editor. Each key shows live reservations, remaining capacity, cooldown state, and expected recovery time.
- Optional real-time logs with level filters, follow mode, bounded memory, and secret redaction.
- SQLite configuration repository with JSON/YAML import, validation, save, and atomic runtime activation.
- Wails v2 desktop app that starts a loopback gateway with the app and shuts it down on exit, so local clients such as Codex and zcode can connect directly.
- Global and per-provider proxies, rate limits, model aliases, translation, and multimodal routing.
- Provider-key-model circuit breaking with half-open recovery, passthrough vendor parameters, and streamed reasoning display.
- GitHub Release automation for server and desktop artifacts plus amd64/arm64 images published to GHCR.

See the [configuration reference](docs/configuration-reference.md) for the authoritative provider list, fields, and samples. Historical provider guides remain under [`docs/`](docs/README.md); quota and model examples may be outdated, so verify them with the provider.

## Run

### Server

The server reads `config.json` from the current working directory (with a fallback to `config/config.json`), using built-in Web-enabled defaults when both are missing. You can also pass the path to an existing JSON or YAML file:

```sh
./simple-one-api
./simple-one-api ./config.json
```

Minimal Web configuration:

```json
{
  "server_port": ":9090",
  "enable_web": true,
  "log_level": "info",
  "services": {}
}
```

Open `http://localhost:9090/` after startup. When no primary `api_key` has been configured, the UI automatically opens the `/setup` wizard to create a permanent key and add the first provider, then continues to the configuration console. Use `http://localhost:9090/chat` for chat; the compatibility path `/admin` also opens configuration.

### Admin and SQLite

- With a primary `api_key`, `/api/admin/*` requires `Authorization: Bearer <api_key>`.
- Without a primary `api_key`, loopback requests can perform first-run setup. Remote users unlock setup with the temporary bootstrap token printed at startup; publishing a permanent `api_key` immediately invalidates that token.
- SQLite defaults to the configuration file's directory and basename (`config.json` → `config.db`). Override it with `SIMPLE_ONE_API_DB`.
- Draft responses mask secrets, and unchanged placeholders are restored when a revision is published.
- SQLite data is not encrypted at rest. The database is created with `0600` permissions when possible; restrict access to its directory.

See the [configuration reference](docs/configuration-reference.md) for the complete workflow.

### Local key-pool quick start

Put multiple keys in one provider's `credential_list`, with total or per-model limits on each key:

```json
{
  "load_balancing": "round_robin",
  "services": {
    "openai": [{
      "id": "local-pool",
      "provider": "openai",
      "upstream_protocol": "responses",
      "enabled": true,
      "models": ["your-model"],
      "server_url": "https://api.example.com/v1",
      "credential_list": [{
        "id": "key-1",
        "name": "Key 1",
        "enabled": true,
        "api_key": "your-upstream-key",
        "model_limits": {
          "your-model": {"tpm": 1000000, "concurrency": 2}
        }
      }]
    }]
  }
}
```

Add `key-2`, `key-3`, and so on to grow the pool. The scheduler starts with the configured load-balancing order, then prefers keys that can fit the request and have more remaining capacity. An upstream 429 temporarily cools down that `key + model`. The admin UI reads runtime state from `GET /api/admin/capacity`. See the [provider configuration reference](docs/configuration-reference.md#provider-配置) for all fields and the four limit scopes.

### Why this is more than round-robin

Round-robin only answers “which key is next”; it does not know whether that key can accept the request. A large Codex context, long conversation, or tool-heavy request can consume most of a key's 1M TPM window in one call. Random or fixed rotation then keeps hitting the same saturated key and produces repeated 429 responses.

simple-one-api estimates request cost before contacting the upstream and keeps a 60-second rolling reservation window for each `provider + API key + model`:

1. Disabled, circuit-broken, and clearly unavailable keys are filtered first.
2. Request cost is estimated conservatively. Chat considers messages, tools, and maximum output; Responses uses the original request body; Embeddings use input size.
3. Keys that can fit the request are preferred, with higher remaining capacity ranked first. Keys without enough capacity are ordered by their expected recovery time.
4. Tokens are reserved after the limiter accepts the attempt. Reservations are not refunded when an upstream finishes early because providers generally count the request already.
5. A 429 cools down only the affected `key + model` for 30 seconds by default. If no response has been written, the gateway tries the next healthy key.

This spreads large requests across the pool, measures different models independently on the same key, and prevents one provider key from stalling the entire provider. Recovery time combines the TPM window and 429 cooldown and is shown live in the admin UI.

The boundary is intentional: key and key-model limits can use another key's capacity, but provider-wide and provider-model shared limits cannot be bypassed by switching keys. QPS, QPM, RPM, TPM, and concurrency constraints may all apply together. Runtime reservations and cooldowns live only in process memory and reset on restart; they are scheduling data, not provider balances or billing data.

### Docker

```sh
docker pull ghcr.io/fruitbars/simple-one-api:latest

docker run -d --name simple-one-api -p 9090:9090 \
  -v simple-one-api-data:/app/data \
  -e SIMPLE_ONE_API_DB=/app/data/config.db \
  ghcr.io/fruitbars/simple-one-api:latest
```

For production, choose a fixed release supporting the features you need. The image supports both `linux/amd64` and `linux/arm64` and includes a `/healthz` health check. The bundled `docker-compose.yml` now uses a named data volume: run `docker compose up -d` without preparing a config file. Compose prefixes the volume with its project name; this differs from the volume used by the `docker run` example.

**Existing Compose deployments:** retain `./data:/app/data` until you have backed up and migrated your data; switching directly to the new empty volume would open first-run setup again. To import a file, additionally mount an **existing** JSON/YAML file at `/app/config.json:ro`. Keep SQLite in a directory writable by the container's `app` user. `docker compose down` preserves data; `docker compose down -v` removes it.

Other deployment options: [systemd](docs/startup/systemd_startup.md) · [nohup](docs/startup/nohup_startup.md).

## Build: which script should I use?

| Goal | Command | Output |
| --- | --- | --- |
| Fast build for this platform | `./quick_build.sh` | Root-level `simple-one-api` |
| Build one target | `./quick_build.sh linux amd64` | Root-level target binary |
| Multi-platform release | `./build.sh --release` | Binaries and archives under `build/` |
| Development build | `./build.sh --development` | Platform binaries under `build/` |
| Docker image | `./build_docker.sh vX.Y.Z` | Local image only; it is not pushed |

Building requires Go 1.25+, Node.js, and pnpm. Each entry point builds `web/` before compiling Go so stale frontend assets are not embedded. See [Build and Release](docs/build-and-release.md) for the complete matrix.

On Windows, run `quick_build.bat`; optional `GOOS GOARCH` arguments are supported.

### Web development

```sh
cd web
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The Web build writes to `internal/webui/dist/`. A subsequent Go build produces a single-file server.

### Wails desktop app

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0
cd cmd/desktop
wails dev
wails build -clean
```

Artifacts are written to `cmd/desktop/build/bin/`. See [`cmd/desktop/README.md`](cmd/desktop/README.md) for desktop details.

The desktop app also listens on `127.0.0.1:<server_port>` (port `9090` by default). Local clients can therefore use `http://127.0.0.1:9090/v1` as their Base URL. With `enable_web: true`, browsers can also open `/`, `/admin`, and `/chat`; the configuration workspace prompts for the gateway key. Closing the app shuts down the gateway process and releases the port.

## API examples

```sh
curl http://localhost:9090/v1/models \
  -H 'Authorization: Bearer your-gateway-key'

curl http://localhost:9090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-gateway-key' \
  -d '{"model":"random","messages":[{"role":"user","content":"Hello"}]}'

curl http://localhost:9090/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-gateway-key' \
  -d '{"model":"random","input":"Hello"}'

curl http://localhost:9090/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: your-gateway-key' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"random","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

OpenAI-compatible SDKs can set `base_url` to `http://host:9090/v1`. Codex uses the Responses wire protocol, while Claude Code uses Anthropic Messages; see the [configuration reference](docs/configuration-reference.md) for limits.

## Documentation

- [Documentation index](docs/README.md)
- [Configuration reference: fields, providers, Admin, and SQLite](docs/configuration-reference.md)
- [Build and release](docs/build-and-release.md)
- [Architecture](docs/architecture-v1.md)
- [Changelog](docs/CHANGELOG.md)
- [Configuration samples](samples/)

Provider setup guides are retained as historical aids. Models, quotas, URLs, and authentication methods may change; prefer official provider documentation.

## Release artifacts

- [GitHub Releases](https://github.com/fruitbars/simple-one-api/releases) provides multi-platform server archives, desktop packages, and `SHA256SUMS`.
- [GHCR](https://github.com/fruitbars/simple-one-api/pkgs/container/simple-one-api) provides multi-architecture `linux/amd64` and `linux/arm64` images.
- A `v*` tag builds both channels in one workflow. The GitHub Release is created only after every platform and the container image succeed.

## Contributing

Issues and pull requests are welcome. Before submitting, run `go test ./...`, `go vet ./...`, and `cd web && pnpm typecheck && pnpm test && pnpm build`.
