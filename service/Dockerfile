# doc2docx 转换服务 Docker 镜像
#
# 基础镜像选 bookworm-slim（glibc）而不是 alpine（musl）：linux-x64 原生转换器
# 是按 glibc 构建的自包含可执行文件，musl 系统上无法运行。
#
# 构建（在仓库根目录执行）：
#   docker build -f service/Dockerfile -t doc2docx-service .
# 运行：
#   docker run -d -p 3100:3100 --memory 4g --cpus 4 doc2docx-service
#
# 内存估算：并发上限 × 2 × MAX_UPLOAD_MB（默认 22 核 × 2 × 100MB 太大，
# 容器里务必显式限制，例如 -e DOC2DOCX_SERVICE_CONCURRENCY=4 --memory 2g）

FROM node:22-bookworm-slim

WORKDIR /app

# 只复制依赖声明，利用 Docker 层缓存；npm ci 需要 lockfile，没有则退回 npm install
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ src/
COPY service/server.js service/queue.js service/

ENV NODE_ENV=production \
    PORT=3100 \
    DOC2DOCX_SERVICE_CONCURRENCY=4 \
    MAX_UPLOAD_MB=100

EXPOSE 3100

# 容器内 PID 1 是 node，SIGTERM 直达，优雅停机逻辑（server.js）可正常工作
CMD ["node", "service/server.js"]
