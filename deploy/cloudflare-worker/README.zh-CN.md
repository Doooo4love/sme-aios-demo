# SME AIOS｜Cloudflare Worker 固定入口部署与域名迁移说明

本目录包含用于固定演示入口 **`https://aios-demo.hk-demo.workers.dev`** 的 **零秘钥（Zero-Secret）Cloudflare Worker** 反向代理、单元测试与部署脚本。

> **架构说明（方案 2：Worker 入口 + Workers VPC + 已有 Tunnel + ECS 私有后端）**  
> `https://aios-demo.hk-demo.workers.dev` (Cloudflare Access 门禁 + Worker `aios-demo`)  
> → **Cloudflare Workers VPC** (`env.AIOS_ORIGIN`)  
> → **Cloudflare Tunnel `hk-aios-demo`** (`3d90b761-eeb9-491f-a608-3079b4d4b0e4`)  
> → **阿里云香港 ECS (`47.242.128.179`) 回环端口 `http://127.0.0.1:3000`** (Next.js Standalone BFF)  
> → `127.0.0.1:8760` (FastAPI Core) & `127.0.0.1:8761` (Assurance Companion)

---

## 为什么选择该方案

1. **无需提前注册正式域名**：`workers.dev` 不能充当普通 Tunnel Public Hostname 的 DNS Zone，但 Cloudflare **Workers VPC** 可通过已有 Tunnel `hk-aios-demo` 直接安全打通 `127.0.0.1:3000`（Workers Free 计划在 Open Beta 期间可使用）。
2. **ECS 公网端口零暴露**：无需开放 TCP `80 / 443 / 3000 / 8760 / 8761`，所有公网流量都先经过 Cloudflare Access 门禁，再由 Worker 经加密 Tunnel 转发回环服务。
3. **不改动现有 AIOS 核心与 BFF 语义**：保留 SSE 流式对话、`x-csrf-token`、`idempotency-key`、多条 `Set-Cookie`（`__Host-aios_session`）、自动将回环 `Location` 重写为 `https://aios-demo.hk-demo.workers.dev`，并强制非静态路径 `Cache-Control: no-store`、剥离 `x-powered-by`、屏蔽 `502/503` 内部细节。
4. **日后切换正式域名平滑**：未来只需在同一个 `aios-demo` Worker 上绑定 Custom Domain（例如 `demo.<你的正式域名>`），Cloudflare Access 策略会自动随 Worker 生效。

---

## 正式切换上线步骤（3 步）

> 在以下 3 步全部执行并验证通过之前，`https://aios-demo.hk-demo.workers.dev` 仍处于 Cloudflare Access 拦截后返回占位 `Hello World!` 的状态，**并非真实 AIOS 线上服务**。

### 第 1 步：在 Cloudflare Zero Trust 启用 One-time PIN 并核对白名单

1. 登录 Cloudflare Dashboard → **Zero Trust**（团队名：`aged-lake-87d1`）→ **Integrations** → **Identity providers**。
2. 确认已添加并启用 **One-time PIN**（否则登录页只会看到 Cloudflare 账户入口，团队成员无法使用邮箱验证码登录）。
3. 进入 **Access** → **Applications** → 找到 `aios-demo`（覆盖 **All traffic**）：
   - 认证方式绑定 **One-time PIN**；
   - 策略确认仅启用 `SME AIOS Demo - Authorized Stakeholders` Allow 规则，且白名单严格只有：
     - `ysunfw@connect.ust.hk`
     - `hfmchen@connect.ust.hk`
     - `bzhengah@connect.ust.hk`
     - `hylaubc@connect.ust.hk`
   - 确认没有 `Everyone`、`Bypass` 或其他多余规则；`wrangler.jsonc` 已设置 `"preview_urls": false` 关闭预览地址。

### 第 2 步：在阿里云香港 ECS（`47.242.128.179`）写入凭据、启动服务并连接 Tunnel

> 如在本机执行 SSH 超时，先确认阿里云控制台安全组 TCP `22` 来源放行列表是否包含你当前网络的公网出口 IP。

1. SSH 登录到 ECS（使用密钥 `~/Downloads/hk-aios-ssh.pem`）。
2. 初始化隔离环境变量与强口令 / 模型 Key（交互式静默输入，切勿明文写入命令历史或文档）：
   ```bash
   sudo /opt/aios/deploy/integrai/02-init-secrets.sh --origin https://aios-demo.hk-demo.workers.dev
   ```
3. 获取已有 Tunnel `hk-aios-demo`（ID：`3d90b761-eeb9-491f-a608-3079b4d4b0e4`，不要新建重复 Tunnel）的 connector install token（Zero Trust → Networks → Tunnels → `hk-aios-demo`），在 ECS 静默安装并启动：
   ```bash
   # 注意在 bash 中用 read -rs 静默读取 token，避免进入 ~/.bash_history
   read -rs CF_TUNNEL_TOKEN && echo && sudo cloudflared service install "$CF_TUNNEL_TOKEN" && unset CF_TUNNEL_TOKEN
   ```
4. 启动并检查后端服务与 Tunnel 状态（确认均为 `active` 且未开启公网业务端口）：
   ```bash
   sudo systemctl enable --now aios-demo-api aios-demo-assurance aios-demo-web cloudflared
   sudo systemctl is-active aios-demo-api aios-demo-assurance aios-demo-web cloudflared
   curl -fsS http://127.0.0.1:3000/readyz
   ```

### 第 3 步：在本机 Mac 登录 Wrangler 并部署 Workers VPC + `aios-demo` Worker

1. 安装依赖与运行本地校验（仓库根目录执行）：
   ```bash
   pnpm --dir deploy/cloudflare-worker install
   pnpm --dir deploy/cloudflare-worker run typecheck
   pnpm --dir deploy/cloudflare-worker run test
   ```
2. 完成 Wrangler OAuth 登录：
   ```bash
   pnpm --dir deploy/cloudflare-worker exec wrangler login
   ```
3. 运行一键部署脚本（会自动创建或复用 Workers VPC 服务 `aios-demo-origin` 并部署 `aios-demo` Worker）：
   ```bash
   ./deploy/cloudflare-worker/deploy-worker.sh
   ```
4. 上线验收：
   - 在 ECS 上运行公开来源核验：
     ```bash
     sudo /opt/aios/deploy/integrai/06-verify-live.sh --public-origin https://aios-demo.hk-demo.workers.dev
     ```
   - 在无痕浏览器访问 `https://aios-demo.hk-demo.workers.dev`：
     - 用非白名单邮箱测试，确认被 Cloudflare Access 拒绝；
     - 用四位 `@connect.ust.hk` 白名单邮箱之一接收 One-time PIN 验证码登录，验证 AIOS 登录页、工作台加载、模型对话（SSE）、下载与退出恢复正常。

---

## 日后迁移到正式域名

选定并购买正式域名（将其接入同一 Cloudflare 账户的 DNS Zone）后，保持现有 `aios-demo` Worker 与 `hk-aios-demo` Tunnel 不变：

1. 在 Cloudflare Dashboard → **Workers & Pages** → **`aios-demo`** → **Settings** → **Domains & Routes** 中添加 **Custom Domain**（例如 `demo.<你的正式域名>`），确认 HTTPS 证书生效，并核对 Cloudflare Access 策略已覆盖该 Custom Domain。
2. 在 ECS 重新执行环境配置脚本以更新 `AIOS_BROWSER_ORIGIN`（不会覆盖 `/var/lib/aios/state` 中的业务数据库）：
   ```bash
   sudo /opt/aios/deploy/integrai/02-init-secrets.sh --origin https://demo.<你的正式域名>
   sudo systemctl restart aios-demo-api aios-demo-assurance aios-demo-web
   ```
3. 因 `__Host-aios_session` 为 host-only Cookie，切换域名后用户需要在新域名重新登录一次。
4. 在 ECS 上重新运行 `/opt/aios/deploy/integrai/06-verify-live.sh --public-origin https://demo.<你的正式域名>` 并完成浏览器端到端回归后，再决定是否关闭 `aios-demo.hk-demo.workers.dev` 入口。
