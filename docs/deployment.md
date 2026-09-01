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
