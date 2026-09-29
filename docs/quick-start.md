# 5 分钟快速开始

这条路径适合首次安装：启动网关 → 设置管理密钥 → 连接模型服务 → 发出第一次请求。无需先编写 `config.json`。

## 1. 启动服务器

选择 Docker 或单文件服务端中的一种。

### Docker（推荐）

```sh
docker run -d --name simple-one-api -p 9090:9090 \
  -v simple-one-api-data:/app/data \
  -e SIMPLE_ONE_API_DB=/app/data/config.db \
  --restart unless-stopped \
  ghcr.io/fruitbars/simple-one-api:latest
docker logs --tail 100 simple-one-api
```

Docker 会自动创建数据卷。配置保存在卷中的 `config.db`，以后重建容器仍挂载同一个卷即可保留配置。生产部署请使用发布页中支持这些功能的固定版本。

从源码仓库使用 Compose：

```sh
docker compose up -d
docker compose logs --tail 100 simple-one-api
```

Compose 会创建带项目名前缀的数据卷，和上面 `docker run` 的卷名不同；选定一种方式后继续使用它。`docker compose down` 保留卷，`docker compose down -v` 会删除卷及配置。

**已有部署升级：** 旧 Compose 使用 `./data:/app/data`，现在默认使用命名卷。已有数据时应先保留旧挂载 `./data:/app/data`，不要直接切换到空卷；备份和确认迁移完成后再更换。已有配置文件仍可额外挂载到 `/app/config.json:ro`，该文件必须事先存在。数据库路径继续保持 `/app/data/config.db`，数据目录必须对容器内 `app` 用户可写。

### 单文件服务端

从 [Releases](https://github.com/fruitbars/simple-one-api/releases) 下载对应系统和架构的服务端包，解压后启动。Linux/macOS 示例：

```sh
chmod +x ./simple-one-api
./simple-one-api
```

没有默认 `config.json` 时会使用内置配置，默认端口为 `9090`、Web 开启。默认数据库位于配置路径旁；需要单独指定数据目录时，先创建该目录，再设置 `SIMPLE_ONE_API_DB=/可写目录/config.db`。Windows 解压后运行 `simple-one-api.exe`。

已有 JSON/YAML 可作为首次导入配置：`./simple-one-api /绝对路径/config.json`。显式指定的非默认配置路径必须存在。

## 2. 打开初始化向导

本机打开 `http://localhost:9090/`，远程打开 `http://服务器地址:9090/`。未设置主密钥时自动进入 `/setup`；已有主密钥时直接进入配置台登录。

远程访问或通过 Docker 端口映射访问时，通常会要求启动日志里的临时初始化密钥：

```text
Admin temporary bootstrap token: …
```

复制这一行冒号后面的值。找不到日志时：

| 启动方式 | 查看日志 |
| --- | --- |
| Docker | `docker logs --tail 100 simple-one-api` |
| Compose | `docker compose logs --tail 100 simple-one-api` |
| systemd | `sudo journalctl -u simple-one-api -n 100 --no-pager` |
| nohup | `tail -n 100 simple-one-api.log` |
| 直接运行 | 查看启动终端 |

如果设置了 `SIMPLE_ONE_API_BOOTSTRAP_TOKEN`，使用该环境变量的值；服务不会把它打印出来。随机生成的临时 token 会在服务重启后更换。公网管理建议通过 HTTPS 反向代理或 SSH 隧道访问。

## 3. 设置主密钥、添加 Provider

先生成或填写网关主密钥（至少 16 个字符），复制并妥善保存。浏览器不允许自动复制时，点击“显示主密钥”后手动复制。

这里有三类不同的密钥：

| 名称 | 来源与用途 |
| --- | --- |
| 临时初始化密钥（bootstrap token） | 来自启动日志，仅用于首次远程解锁；设置主密钥后立即失效 |
| 网关主密钥 | 你在向导里设置；用于管理配置和调用这个网关。可在配置台另外创建权限更小的客户端访问密钥 |
| 上游 API Key | 来自模型供应商；用于网关访问供应商，填在 Provider 中 |

以 OpenAI 兼容服务为例：

- 服务类型选择 **OpenAI / OpenAI 兼容**。
- 服务地址填写供应商给出的 API Base URL，例如 `https://api.example.com/v1`，不要填官网首页。
- 上游协议通常选择 **OpenAI Chat Completions**；供应商提供 Responses 时选择 **OpenAI Responses**。
- 聊天模型填写供应商提供且账户有权限使用的模型 ID，可用逗号分隔多个模型。
- 上游 API Key 填供应商密钥。

Claude 预设使用完整的 `/v1/messages` 地址，Ollama 自动协议使用 `/api/chat` 地址。其他 Provider 可先跳过，在配置台中添加。

点击“测试连接”。测试从网关服务器发送一次简短生成请求，只测第一个模型，最多等待 20 秒，可能产生少量费用；它不会保存草稿，也不会验证所有模型或完整流式能力。测试成功后保存；测试失败也可以选择“保存配置（未验证）”，之后继续排查。只有保存成功才完成初始化。

Ollama 或代理和网关不在同一容器时，`127.0.0.1` 指向网关容器自身。在 Docker Desktop 上，宿主机可用 `host.docker.internal`；Linux 上需配置可达的宿主机地址或 `host-gateway` 映射，同时确保上游监听容器可访问的地址。

## 4. 验证第一次调用

在配置台切换 **Chat**，选一个模型，发送“你好”。也可以用终端验证：

```sh
export GATEWAY_URL='http://localhost:9090'
export GATEWAY_KEY='替换为刚保存的网关主密钥'

curl -fsS "$GATEWAY_URL/v1/models" \
  -H "Authorization: Bearer $GATEWAY_KEY"

curl -fsS "$GATEWAY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"替换为上一步返回的模型ID","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

模型列表来自本地配置，能列出模型不等于上游调用成功；聊天请求返回回答才算完成首次接入。

## 5. 接入客户端

支持 OpenAI 兼容接口的客户端一般填写：

| 项目 | 填写值 |
| --- | --- |
| Base URL | `http://服务器地址:9090/v1` |
| API Key | 网关主密钥，或配置台创建的客户端访问密钥 |
| Model | `/v1/models` 返回的模型 ID |

若客户端要求完整 Chat Completions URL，则填 `http://服务器地址:9090/v1/chat/completions`。Responses 入口为 `/v1/responses`，Anthropic Messages 入口为 `/v1/messages`；按客户端要求选择协议，避免重复添加 `/v1`。

## 遇到问题

| 现象 | 优先检查 |
| --- | --- |
| 页面打不开 | 服务是否启动、9090 端口映射/防火墙、是否显式设置了 `enable_web: false` |
| 初始化密钥不正确 | 是否使用当前这次启动的 token；是否设置了 bootstrap 环境变量 |
| 测试返回 401/403 | 供应商 API Key、账户权限和模型授权；此处不是网关主密钥 |
| 测试返回 404 | API 路径和模型 ID；Claude/Ollama 自动协议需要完整端点 |
| 测试返回 429 | 供应商配额或限流；正式请求还需检查本地号池及 Provider 限流 |
| 网络错误或超时 | 从服务器/容器检查上游网络、DNS、TLS、代理；本机 Ollama 首次加载可能超过 20 秒 |
| 配置保存了但 Chat 没有模型 | 是否跳过了 Provider、Provider 是否启用、模型列表是否填写 |
| 重启后回到向导 | 是否挂载了同一数据卷、数据库路径是否改变、是否修改启动文件覆盖了数据库配置 |

更多字段见[配置参考](configuration-reference.md)。使用 systemd/nohup 前请按[systemd](startup/systemd_startup.md)或[nohup](startup/nohup_startup.md)文档准备配置文件。
