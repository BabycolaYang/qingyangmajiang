# 青阳平胡麻将

青阳县平胡麻将手机端游戏项目。当前阶段先固定规则、规则引擎和工程边界，后续再补移动端 UI、好友房实时对战、欢乐豆账户和后台管理。

## 当前已实现

- 青阳平胡规则文档：`docs/rules/qingyang-pinghu.md`
- 技术架构草案：`docs/architecture.md`
- 无花牌 136 张牌定义
- 赖子翻牌顺序
- 平胡判定，赖子可作任意牌
- 跑风判定
- 缺一门检查开关
- 平胡、跑风、杠上平胡、直杠计分
- 欢乐豆 1 分 = 1 豆结算
- 本地手机端好友房原型
- 机器人自动摸打
- 碰牌和暗杠交互

## 手机端原型

```bash
npm run dev:mobile
```

打开 `http://127.0.0.1:4173/apps/mobile/`。

## 最小联机版

```bash
npm run dev:online
```

打开 `http://127.0.0.1:4174/apps/mobile/?online=1`，创建联机房后复制邀请链接。

部署说明见 `docs/deployment.md`。

## 本地验证

```bash
npm test
```

当前测试不需要安装第三方依赖，直接使用 Node.js 内置测试框架。

## 推荐开发路线

1. 完善 `packages/mahjong-core`：补齐明杠、补杠、回放校验。
2. 将 `apps/mobile` 从网页原型升级为 React Native + Expo。
3. 启动 `apps/server`：用 NestJS + Socket.IO 做真实好友房和服务端权威判定。
4. 接入 PostgreSQL、Redis、Prisma，落地欢乐豆流水和牌局记录。

## 开发记录

后续任务、验收条件和每项实现记录统一维护在 [docs/backlog.md](docs/backlog.md)。
