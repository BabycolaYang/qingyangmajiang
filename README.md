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
- 机器人自动摸打
- 碰牌和暗杠交互

## 项目结构

- `babykylin_scmj/client`：Cocos Creator 客户端（源码 + web-mobile 构建产物）
- `babykylin_scmj/server`：线上服务端三进程（account_server / hall_server / game_server）
- `packages/mahjong-core`：规则引擎（胡牌、对对胡、跑风等判定，被 game_server 引用）
- `tools/static_web_server.cjs`：gzip + ETag 静态资源托管

## 本地验证

```bash
npm test
```

当前测试不需要安装第三方依赖，直接使用 Node.js 内置测试框架。

## 开发记录

后续任务、验收条件和每项实现记录统一维护在 [docs/backlog.md](docs/backlog.md)。
