# doc2docx 转换服务

把 `@jitword/doc2docx` 库包装成与语言无关的 HTTP 微服务（裸 `node:http`，零额外依赖），
供 Python / Java / 任意语言通过 HTTP 调用 `.doc` → `.docx` 转换。

## 启动

```bash
npm install        # 首次：拉取当前平台的原生转换器（可选依赖）
npm run service    # 默认监听 3100 端口
```

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST /convert` | 请求体 = `.doc` 原始字节 → 响应 = `.docx` 二进制。响应头带 `X-Passthrough`（输入本来就是 .docx 时为 `true`，原样返回）、`X-Duration-Ms` |
| `GET /health` | JSON：`{ status, uptimeSeconds, queue: { running, waiting, concurrency, maxWaiting } }`，供探活与监控 |

### 错误码

| 状态码 | 情形 |
| --- | --- |
| 400 | 请求体为空、既不是 .doc 也不是 .docx、文件受密码保护 |
| 413 | 请求体超过上传上限（默认 100MB） |
| 422 | 转换失败（转换器报错、产物校验不过、转换超时） |
| 503 | 队列已满或排队超时，响应带 `Retry-After: 5`，客户端可退避重试 |

## 并发与大文档

- 每次转换 spawn 一个原生进程，且转换期间输入+输出两份字节驻留内存，所以：
  - **并发上限**：同时在途的转换数，默认 = CPU 核数；超出的请求 FIFO 排队
  - **队列上限**：等待中的请求数（默认 100），满了立即返回 503——等待中的请求也持有完整输入 Buffer，不是免费的
  - **排队超时**：默认 300s，超时返回 503
- **上传上限**：默认 100MB；读取 body 过程中一旦超限立即掐断，不把超限部分读进内存
- 最坏内存占用 ≈ `并发上限 × 2 × 上传上限`。内存紧张的机器优先调低并发上限
- 优雅停机：收到 `SIGTERM`/`SIGINT` 后停止接收新请求，等待在途转换完成（上限 30s）再退出

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址；无鉴权服务，公网机器建议绑内网地址 |
| `DOC2DOCX_SERVICE_CONCURRENCY` | CPU 核数 | 同时转换数上限 |
| `DOC2DOCX_SERVICE_QUEUE_MAX` | `100` | 排队等待上限 |
| `DOC2DOCX_SERVICE_QUEUE_WAIT_MS` | `300000` | 排队超时 |
| `MAX_UPLOAD_MB` | `100` | 单请求体积上限 |
| `DOC2DOCX_TIMEOUT_MS` | `120000` | 单次转换超时（库级配置） |
| `DOC2DOCX_SERVICE_SHUTDOWN_MS` | `30000` | 停机时在途请求的最长等待 |
| `DOC2DOCX_PATH` | — | 自建转换器二进制路径（库级配置） |

数值型变量写了非法值（如 `MAX_UPLOAD_MB=abc`）会回退默认值并在启动日志告警，
不会静默失效。

## 已知边界

- **强制停机的残留**：停机等待超时后强制退出时，在途转换的 `doc2x` 原生进程
  不会被带走（Windows 上父子进程无信号关联），`%TEMP%\doc2x-*` 临时目录可能
  残留，由操作系统清理。
- **无鉴权**：本服务不鉴权，请部署在内网或前面挡一层网关。
- **分发范围**：`service/` 不随 npm 包发布（`files` 白名单只含 `src`），
  本服务定位是仓库内直接部署使用。

## 部署方案

### 直接部署（物理机 / 虚拟机）

```bash
git clone <repo> && cd doc2docx
npm install                # 拉取当前平台的原生转换器
npm run service            # 前台运行，调试用
```

### 进程守护

**Linux（systemd）** —— `/etc/systemd/system/doc2docx.service`：

```ini
[Unit]
Description=doc2docx conversion service
After=network.target

[Service]
WorkingDirectory=/opt/doc2docx
ExecStart=/usr/bin/node service/server.js
Restart=always
RestartSec=3
# 优雅停机等待在途转换完成；要长于 DOC2DOCX_SERVICE_SHUTDOWN_MS（默认 30s）
TimeoutStopSec=45
Environment=PORT=3100
Environment=DOC2DOCX_SERVICE_CONCURRENCY=4
Environment=MAX_UPLOAD_MB=100

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now doc2docx`。systemd 默认发 SIGTERM，服务的优雅停机
逻辑会先完成在途转换再退出。

**跨平台（PM2）**：

```bash
pm2 start service/server.js --name doc2docx
pm2 save && pm2 startup
```

**Windows**：用 [NSSM](https://nssm.cc/) 注册为系统服务（`nssm install doc2docx "C:\Program Files\nodejs\node.exe" "D:\doc2docx\service\server.js"`），
或任务计划程序配置"系统启动时运行"。

### Docker

仓库内带 `service/Dockerfile`（基于 node:22-bookworm-slim，glibc）：

```bash
docker build -f service/Dockerfile -t doc2docx-service .
docker run -d -p 3100:3100 \
  -e DOC2DOCX_SERVICE_CONCURRENCY=4 \
  --memory 2g --cpus 4 \
  --restart unless-stopped \
  doc2docx-service
```

注意基础镜像不能用 alpine（musl）——linux-x64 原生转换器是按 glibc 构建的。

### 反向代理（nginx）

服务本身无鉴权，建议只在前面挡一层网关/鉴权后再对外：

```nginx
server {
    listen 443 ssl;
    server_name doc2docx.internal.example.com;

    # 必须与服务的 MAX_UPLOAD_MB 对齐，否则 nginx 先一步 413
    client_max_body_size 100m;
    # 必须覆盖 排队 + 转换 全程（默认 300s + 120s），否则长任务被网关掐断
    proxy_read_timeout 480s;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
    }
}
```

负载均衡 / K8s 探活用 `GET /health`（liveness 与 readiness 都可以指它；
队列打满时服务仍返回 200，看响应体里的 `queue` 字段判断饱和度）。

### 资源估算

| 项 | 估算 |
| --- | --- |
| 内存峰值 | `并发上限 × 2 × MAX_UPLOAD_MB` + Node 基础（约 100MB） |
| CPU | 每次转换吃满约 1 核（0.2~1s），并发上限建议 ≤ 物理核数 |
| 磁盘 | 每次转换在系统临时目录读写各一份（转换完即清理） |

例：4 核 8GB 机器建议 `DOC2DOCX_SERVICE_CONCURRENCY=4`、`MAX_UPLOAD_MB=100`，
内存峰值约 4×2×100MB + 100MB ≈ 0.9GB，留足余量。

## 调用示例

### curl

```bash
curl -X POST --data-binary @合同.doc http://localhost:3100/convert -o 合同.docx -D -
```

### Python

```python
import requests

with open('合同.doc', 'rb') as f:
    r = requests.post('http://localhost:3100/convert', data=f.read(), timeout=600)
if r.status_code == 200:
    open('合同.docx', 'wb').write(r.content)
    print('passthrough:', r.headers.get('X-Passthrough'))
elif r.status_code == 503:
    # 队列满，按 Retry-After 退避重试
    print('服务忙，稍后重试:', r.headers.get('Retry-After'))
else:
    print('转换失败:', r.json()['error'])
```

### Java（JDK 11+ HttpClient）

```java
var client = HttpClient.newHttpClient();
var request = HttpRequest.newBuilder(URI.create("http://localhost:3100/convert"))
    .timeout(Duration.ofMinutes(10))
    .POST(HttpRequest.BodyPublishers.ofFile(Path.of("合同.doc")))
    .build();
var response = client.send(request, HttpResponse.BodyHandlers.ofFile(Path.of("合同.docx")));
if (response.statusCode() == 200) {
    System.out.println("passthrough: " + response.headers().firstValue("X-Passthrough"));
} else {
    System.err.println("转换失败: HTTP " + response.statusCode());
}
```

注意：`BodyHandlers.ofFile` 在 4xx/5xx 时也会写文件，生产代码建议先收到内存
（`ofByteArray()`）判断状态码后再落盘。

## 测试

```bash
npm run test:service
```

单元/集成测试不依赖真实转换器二进制（用假任务与 passthrough 分支覆盖）。
真实 `.doc` 转换的端到端冒烟：

```bash
npm install && npm run service
# 另开一个终端：
curl -X POST --data-binary @sample.doc http://localhost:3100/convert -o out.docx -v
# 用 Word/LibreOffice 打开 out.docx 验证
```
