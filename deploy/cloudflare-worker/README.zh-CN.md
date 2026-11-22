# SME AIOS｜Cloudflare Worker 固定入口部署、Reviewer Gate 切换与域名迁移说明

本目录包含用于固定演示入口 **`https://aios-demo.hk-demo.workers.dev`** 的 Cloudflare Worker 反向代理、**Edge Cryptographic Reviewer Gate（Live MVP 评审加密门禁）**、单元测试与部署脚本。

> **架构说明（Worker Edge Gate + Workers VPC + 已有 Tunnel + ECS 私有后端）**  
> `https://aios-demo.hk-demo.workers.dev` (Worker `aios-demo`：Edge Reviewer Gate 校验 + 限流 + 沙盒保护)  
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

1. 在 Cloudflare Dashboard → **Workers & Pages** → **`aios-demo`** → **Settings** → **Domains & Routes** 中添加 **Custom Domain**（例如 `demo.<你的正式域名>`），确认 HTTPS 证书生效，并核对 Cloudflare Access / Worker Reviewer Gate 策略覆盖该 Custom Domain。
2. 在 ECS 重新执行环境配置脚本以更新 `AIOS_BROWSER_ORIGIN`（不会覆盖 `/var/lib/aios/state` 中的业务数据库）：
   ```bash
   sudo /opt/aios/deploy/integrai/02-init-secrets.sh --origin https://demo.<你的正式域名>
   sudo systemctl restart aios-demo-api aios-demo-assurance aios-demo-web
   ```
3. 因 `__Host-aios_session` 与 `__Host-aios_gate` 均为 host-only Cookie，切换域名后用户需要在新域名重新通过门禁与登录一次。
4. 在 ECS 上重新运行 `/opt/aios/deploy/integrai/06-verify-live.sh --public-origin https://demo.<你的正式域名>` 并完成浏览器端到端回归后，再决定是否关闭 `aios-demo.hk-demo.workers.dev` 入口。

---

## Live MVP 评审加密门禁（Theodic · 从 4 人邮箱白名单切换）

原先 Cloudflare Zero Trust（`aged-lake-87d1`）的 `One-time PIN` 策略仅允许 4 位 `@connect.ust.hk` 团队邮箱登录，外部评委无法通过 Appendix 二维码直接体验 MVP。现在 Worker 内置 `src/reviewer-gate.ts`（**Theodic · Live MVP Reviewer Gate**），可在**不暴露 ECS 与付费 LLM 配额**的前提下，让评委通过扫码或专属链接直接进入英文版登录沙盒。

### 门禁安全能力（当配置 `AIOS_GATE_SECRET` 时生效）

1. **未认证零穿透**：所有业务路径、静态资源与 API 在调用 `env.AIOS_ORIGIN` 之前必须持有有效且未过期的 `__Host-aios_gate` HMAC 签名 Cookie（`HttpOnly; Secure; SameSite=Lax; Max-Age=28800`），否则浏览器请求返回 `401` Theodic Warm Ivory (`#FAF7F2`) 门禁页，API 请求返回 `401 REVIEWER_PASS_REQUIRED`。
2. **双形态评审入口 (`/review`) & 自动英文界面**：
   - **二维码 / Fragment URL**（`https://aios-demo.hk-demo.workers.dev/review#THEODIC-DEMO-...`）：口令保留在 URL `#fragment`（不经 HTTP 请求头或 `Referer` 外泄），页面内联 JS 读取 `window.location.hash.slice(1)`，立即通过 `history.replaceState(null, "", "/review")` 擦除地址栏记录并 `POST /__gate/verify` 换取 Cookie，同时提供手动输入口令表单兜底。
   - **签名能力直链**（`https://aios-demo.hk-demo.workers.dev/review?pass=<exp_unix>.<scope>.<sig_hex>`）：使用 WebCrypto 常量时间校验（SHA-256 / HMAC-SHA256）与 `AIOS_REVIEWER_EXPIRES_AT`（默认 `2027-03-31T23:59:59Z`），校验通过后返回 `303 See Other` → `https://aios-demo.hk-demo.workers.dev/login`，附带 `Referrer-Policy: no-referrer` 与 `Cache-Control: no-store`；同时写入 `aios_locale=en` Cookie 确保评委直接落入英文界面。
3. **防暴力破解与 LLM / 写操作限流**：
   - `/__gate/verify`（及 `/review?pass=`）按 `cf-connecting-ip` 限流：**10 分钟内失败 5 次**返回 `429` + `Retry-After: 600`。
   - 认证后按 IP 滑动窗口限流：`POST /v1/workbench/turns` 上限 **`8/min` 与 `40/hr`**（`429 REVIEWER_LLM_RATE_LIMITED`）；其余写请求（`POST|PUT|PATCH|DELETE`）上限 **`30/min`** 并拒绝 `Content-Length > 8388608`（`413`）。
4. **Judge 沙盒保护（`scope === "judge"`）**：
   - 拦截破坏性管理写操作（`/v1/admin/*`、含 `/pause` 或 `/suspend` 的写路径、`/v1/operations/write-control`、`/v1/operations/subjects/*/suspension`），返回 `403 JUDGE_SANDBOX_PROTECTED`。
   - 完整保留演示核心路径：`POST /api/auth/demo-login`、PO OCR 录入、Proposal Diff / 审批、ERP 回执核验与 Assurance 审计检查点。
   - 转发给 `AIOS_ORIGIN` 前自动剥离 `__Host-aios_gate` Cookie。
5. **全站防收录与主动登出**：全量响应强制附加 `X-Robots-Tag: noindex, nofollow, noarchive`，直接提供 `GET /robots.txt`（`Disallow: /`），并支持 `POST /__gate/logout` 与 `GET /review/logout` 清除门禁 Cookie。

### 切换步骤（从 Cloudflare Access 4 人邮箱白名单 → Worker Reviewer Gate）

> 注意：`.reviewer-pass.local.json` 已被 `.gitignore` 忽略，**严禁提交到 Git 或在公开渠道粘贴明文 Secret**。

1. **生成本地评审口令与签名密钥**（若已生成可跳过；如需轮换请加 `--force`）：
   ```bash
   node ./deploy/cloudflare-worker/scripts/generate-reviewer-pass.mjs
   ```
   将生成仅本机可见（`0600`）的 `deploy/cloudflare-worker/.reviewer-pass.local.json`，内含 `reviewer_passcode`、`team_passcode`、`reviewer_fragment_url`、`reviewer_signed_url`、`expires_at` 与 `gate_secret`。
2. **先做本地校验与 Dry-Run（不触碰线上 Cloudflare）**：
   ```bash
   ./deploy/cloudflare-worker/activate-reviewer-gate.sh --dry-run
   ```
3. **登录 Wrangler 并推送 Worker Secrets + 部署代码**：
   ```bash
   pnpm --dir deploy/cloudflare-worker exec wrangler login
   ./deploy/cloudflare-worker/activate-reviewer-gate.sh
   ```
   该脚本会通过 `stdin` 管道安全写入 `AIOS_GATE_SECRET`、`AIOS_REVIEWER_PASSCODE`、`AIOS_TEAM_PASSCODE` 与 `AIOS_REVIEWER_EXPIRES_AT`（不回显、不进命令历史），随后执行 `./deploy-worker.sh`。
4. **放开 Cloudflare Zero Trust Access（关键切换）**：
   - 登录 Cloudflare Dashboard → **Zero Trust**（团队 `aged-lake-87d1`）→ **Access** → **Applications** → `aios-demo`；
   - 在已确认 Worker Secrets 生效且 `/login` 未携带 Cookie 返回 `401` 后，停用或删除此前仅限 4 个 `@connect.ust.hk` 邮箱的 Access 拦截规则（或将策略改为 `Bypass`），让评委请求直接进入 `aios-demo` Worker 的 Edge Cryptographic Gate。
5. **切换后验收**：
   - 确认 `curl -fsS https://aios-demo.hk-demo.workers.dev/robots.txt` 返回 `Disallow: /` 且带 `X-Robots-Tag: noindex, nofollow, noarchive`；
   - 确认未认证 `curl -i https://aios-demo.hk-demo.workers.dev/api/auth/demo-personas` 返回 `401 REVIEWER_PASS_REQUIRED`；
   - 使用 `.reviewer-pass.local.json` 中的 `reviewer_fragment_url`（或 `reviewer_signed_url`）在无痕浏览器验证自动跳转英文 `/login`、Demo 角色登录、PO 审批与 `/review/logout` 退出。

### 评审结束后的撤销、轮换与回滚

1. **立即一键到期熔断（零停机立即失效所有口令与签名链接）**：
   ```bash
   printf '%s' '2020-01-01T00:00:00Z' | pnpm --dir deploy/cloudflare-worker exec wrangler secret put AIOS_REVIEWER_EXPIRES_AT --name aios-demo
   ```
2. **轮换所有口令与签名密钥（立即吊销所有已签发 Cookie 与历史二维码）**：
   ```bash
   node ./deploy/cloudflare-worker/scripts/generate-reviewer-pass.mjs --force
   ./deploy/cloudflare-worker/activate-reviewer-gate.sh
   ```
3. **完全切回 4 人 `@connect.ust.hk` Zero Trust Access 白名单**：
   - 先在 Cloudflare Zero Trust（`aged-lake-87d1`）重新启用 `aios-demo` 的 4 人邮箱 `One-time PIN` Allow 策略并确认拦截生效；
   - 如需关闭 Worker 门禁恢复纯透传模式，可删除 `AIOS_GATE_SECRET`：
     ```bash
     pnpm --dir deploy/cloudflare-worker exec wrangler secret delete AIOS_GATE_SECRET --name aios-demo
     ```
