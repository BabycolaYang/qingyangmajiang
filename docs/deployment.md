# 最小联机部署

当前联机版是内存房间服务，适合邀请朋友测试玩法，不适合直接商业上线。

## 本地运行

```bash
npm run dev:online
```

打开：

```text
http://127.0.0.1:4174/apps/mobile/?online=1
```

创建联机房后，页面会生成邀请链接：

```text
http://127.0.0.1:4174/apps/mobile/?online=1&room=123456
```

本地地址只能同一台机器访问。要邀请外网朋友，需要部署到公网平台。

## 局域网测试

两台机器在同一个 Wi-Fi 或同一个局域网里时，可以先不用 Render。

在作为主机的电脑上运行：

```bash
npm run dev:lan
```

然后找到主机电脑的局域网 IP，例如：

```bash
ifconfig | grep "inet "
```

常见形态是：

```text
192.168.1.23
```

在主机电脑和另一台设备上都打开：

```text
http://192.168.1.23:4174/apps/mobile/?online=1
```

注意不要用 `127.0.0.1` 或 `localhost` 发给另一台机器，因为那只代表“另一台机器自己”。

创建房间时，也要先用 `http://局域网IP:4174/...` 打开页面，这样生成的邀请链接才会带局域网 IP。

如果另一台机器打不开：

- 确认两台设备在同一个 Wi-Fi。
- 确认主机服务还在运行。
- macOS 弹出防火墙提示时，允许 Node 接收传入连接。
- 尝试关闭 VPN 或公司网络隔离。

## 云服务器部署（京东云等）

适合长期稳定联机，不受免费平台休眠限制。以京东云 Debian 12 为例（代码经 GitHub/Gitee 用 Git 管理，更新最方便）：

### 0. 本机首次推送（只需一次）

本机安装 [Git for Windows](https://git-scm.com/download/win)（安装一路默认即可），然后在项目目录：

```bash
git init
git add .
git commit -m "初始版本"
# 在 GitHub 或 Gitee 上新建空仓库后：
git remote add origin https://gitee.com/你的用户名/qingyangmajiang.git
git push -u origin master
```

说明：

- `data/`（账号数据）与 `logs/` 已在 `.gitignore` 中，本地测试账号不会被推上去。
- 服务器访问 GitHub 慢时优先 Gitee，或为 GitHub 配置代理。

### 1. 安全组放行端口

京东云控制台 → 云主机 → 安全组 → 添加入站规则：

```text
协议 TCP，端口 4174，源地址 0.0.0.0/0
```

把该安全组绑定到云主机。服务器本机防火墙（如启用）也要放行：

```bash
# Ubuntu（ufw 启用时）
sudo ufw allow 4174/tcp
# CentOS（firewalld 启用时）
sudo firewall-cmd --permanent --add-port=4174/tcp && sudo firewall-cmd --reload
```

### 2. 安装 Node.js 18+

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

node -v   # 确认 >= 18
```

国内服务器拉包慢时换镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

### 3. 克隆代码并启动

```bash
sudo apt-get update && sudo apt-get install -y git   # Debian 12 自带 git，此为兜底
git clone https://gitee.com/你的用户名/qingyangmajiang.git /opt/qingyangmajiang
cd /opt/qingyangmajiang
```

安装依赖并用 PM2 常驻（断开 SSH 不退出、崩溃自动重启）：

```bash
npm install
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # 开机自启
pm2 logs qingyang-majiang # 看实时日志确认启动成功
```

### 4. 访问

```text
http://服务器公网IP:4174/apps/mobile/?online=1
```

把这个链接发给朋友，创建房间后把带房间号的邀请链接发给他即可。

### 常用运维命令

```bash
pm2 status                 # 进程状态
pm2 logs qingyang-majiang  # 实时日志
pm2 restart qingyang-majiang # 更新代码后重启
pm2 delete qingyang-majiang # 停止并移除
```

### 以后更新代码（Git 工作流）

本机改完代码推送后，服务器上只需：

```bash
cd /opt/qingyangmajiang
git pull
npm install        # 依赖有变化时才需要
pm2 restart qingyang-majiang
```

`data/users.json` 不在仓库里，`git pull` 不会动服务器上的账号数据。

### 注意事项

- 用户账号存于 `data/users.json`，`git pull` 更新前先备份该文件，避免和远端冲突。
- 房间状态在内存里，`pm2 restart` 后进行中的牌局会丢，挑没人打牌时重启。
- 想用域名 + HTTPS 时，前置 nginx 反代并保留 WebSocket 升级头：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:4174;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Render 部署

1. 把项目推到 GitHub。
2. 在 Render 新建 `Web Service`。
3. 选择这个仓库。
4. Runtime 选择 Node。
5. Build Command 留空或填：

```bash
npm install
```

当前项目没有外部依赖，安装会很快。

6. Start Command 填：

```bash
npm run start:server
```

7. 部署完成后，Render 会给一个公网地址，例如：

```text
https://qingyang-majiang.onrender.com
```

8. 打开：

```text
https://qingyang-majiang.onrender.com/apps/mobile/?online=1
```

创建房间后复制邀请链接发给朋友。

## 当前限制

- 房间状态保存在内存里，服务重启后会消失。
- 没有账号系统，昵称只是临时昵称。
- 欢乐豆是测试余额，不是正式账户流水。
- 没有 Redis，所以不要横向扩容多实例。
- WebSocket 服务使用原生实现，后续正式版可以换 Socket.IO 或 Cloudflare Durable Objects。
