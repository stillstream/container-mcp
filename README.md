# dlvins-dev Container MCP

此仓库在 dlvins-dev 容器内 /opt/container-mcp 以 Git 管理。服务由容器内 Container MCP Gateway（官方 MCP SDK）、OpenAI Secure Tunnel client、以及容器已有的 OpenCode Server 组成。链路：ChatGPT 网页 → OpenAI Tunnel → 容器内 tunnel-client → 127.0.0.1:18878/mcp → 容器 root shell / OpenCode CLI 与 Server。服务不发布容器端口。

安全注意：container_exec 是容器 root 任意 shell，不是只读服务；能修改容器挂载的宿主机文件。仅在可信 ChatGPT workspace 使用。API key、Tunnel ID（虽非密码仍按敏感配置）、MCP Bearer token 不得提交 Git；API key/token 不得放入 ChatGPT。

## 组成与位置

- Container MCP/Gateway：127.0.0.1:18878/mcp，健康检查 /healthz；container_exec、container_poll、container_stop。源码 src/server.mjs。
- MCP Bearer token：runtime/access-token，首次启动自动生成，文件权限 0600。
- Secure Tunnel client：容器内 /usr/local/bin/tunnel-client-runtime-cloudflared；健康端口 127.0.0.1:38434。
- Tunnel API key 与 ID：runtime/control-plane-api-key、runtime/tunnel-id，均为容器内文件。
- OpenCode Server：容器已有实例，由 OpenCode 本身管理；本项目不会启动/停止/修改它。

## 启动、查看、停止

进入容器后运行管理命令：

    docker exec -it dlvins-dev bash
    cd /opt/container-mcp
    ./container-mcp.sh status
    ./tunnel-client.sh status

启动（首次配置凭据并安装 tunnel-client 二进制后）：

    ./container-mcp.sh up
    ./tunnel-client.sh up

查看状态与日志：

    ./container-mcp.sh status
    ./tunnel-client.sh status
    ./container-mcp.sh logs -f
    ./tunnel-client.sh logs

停止本项目的 MCP 与 tunnel-client（不会触碰 OpenCode Server 或其他 tunnel）：

    ./tunnel-client.sh down
    ./container-mcp.sh down

日志位于 /var/log/container-mcp/server.log 和 /var/log/container-mcp/tunnel-client.log。容器重启会中断进程，容器恢复运行后在容器内重新执行 up。

## 配置或更新 API key / Tunnel

先在容器 shell 中安全输入 API key（不会回显，明文仅短暂留在容器 shell 变量中）：

    read -rsp 'OpenAI Tunnel API key: ' KEY; echo
    printf '%s' "$KEY" | /opt/container-mcp/tunnel-client.sh set-api-key
    unset KEY

设置/更新 Tunnel ID：

    /opt/container-mcp/tunnel-client.sh set-tunnel-id tunnel_<Platform中的ID>

更改任一项后，重启容器内 tunnel-client 加载配置：

    /opt/container-mcp/tunnel-client.sh down
    /opt/container-mcp/tunnel-client.sh up

API key 以 mode 0600 存在容器 runtime/control-plane-api-key；ID 在 runtime/tunnel-id；二者均在 .gitignore 中。不要在镜像构建层中写凭据。Tunnel client 从 runtime/access-token 读取 MCP Bearer token，并将认证头注入到本地 MCP 请求。

## ChatGPT 网页设置

在 OpenAI Platform 创建专用 Tunnel 并关联目标 ChatGPT workspace，确保 API key 有该 Tunnel 的 Read/Use 权限。ChatGPT 添加自定义 MCP server 时 Connection 选择 Tunnel，选取对应 Tunnel ID，Authentication 选择 No authentication（由 tunnel-client 注入本地 Bearer）。启动两个容器内服务后，在目标 workspace 新对话启用 MCP。网页端实调仍需在 ChatGPT 中验收。

## 部署到新的容器

新容器需 Node.js >=22.19、npm、bash、curl、unzip、Git。当前官方 release 为 v0.0.18（Linux AMD64，官方 OpenAI 仓库）；在容器内安装 bundled-cloudflared 版本，客户端与 cloudflared companion 保持同目录：

    cd /tmp
    curl -fL -o tunnel-client.zip https://github.com/openai/tunnel-client/releases/download/v0.0.18/tunnel-client-runtime-cloudflared-v0.0.18-linux-amd64.zip
    unzip -l tunnel-client.zip
    mkdir -p /tmp/tunnel-client-unpack
    unzip -q tunnel-client.zip -d /tmp/tunnel-client-unpack
    install -m 0755 /tmp/tunnel-client-unpack/tunnel-client-runtime-cloudflared /usr/local/bin/tunnel-client-runtime-cloudflared
    install -m 0755 /tmp/tunnel-client-unpack/cloudflared /usr/local/bin/cloudflared
    /usr/local/bin/tunnel-client-runtime-cloudflared --help

若压缩包实际文件名/目录布局有变化，先根据 unzip -l 输出按官方 release 内容调整安装源，不能把不匹配文件误装为客户端。OpenCode Server 如需使用，应独立安装并由其自身管理；本仓库不会替新容器安装或启动 OpenCode。

在新容器内部克隆本仓库到 /opt/container-mcp（该路径应是容器自身文件系统，而非宿主机 bind mount），安装依赖：

    git clone <本仓库URL> /opt/container-mcp
    cd /opt/container-mcp
    npm ci --omit=dev

然后在容器内配置 API key、Tunnel ID，执行：

    ./container-mcp.sh up
    ./tunnel-client.sh up
    ./container-mcp.sh status
    ./tunnel-client.sh status

新容器需要独立的 Platform Tunnel 与 ChatGPT workspace 关联。容器创建、网络和 Platform 设置不由本项目脚本代办。不要将 runtime 凭据烘焙入镜像或提交 Git。

## 开发与验证

仓库 Git 工作树是容器内 /opt/container-mcp。运行态 node_modules、runtime 凭据、PID 和日志不应提交。修改后在容器执行：

    git status --short
    bash -n container-mcp.sh tunnel-client.sh
    npm test
    ./container-mcp.sh smoke

MCP smoke 在容器 /tmp 下执行；ChatGPT Web 的真实工具调用未验证时，不得宣称端到端验收通过。
