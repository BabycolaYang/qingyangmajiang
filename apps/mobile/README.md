# Mobile App

目标：React Native + Expo 手机端，优先做横屏好友房牌桌。

当前目录先提供一个零依赖手机网页原型，用来验证规则和交互节奏。

```bash
npm run dev:mobile
```

打开 `http://localhost:4173/apps/mobile/`。

## 页面

- 大厅：首页展示欢乐豆、创建房间、加入房间、战绩。
- 创建房间：局数、底分、是否启用缺一门。
- 加入房间：房间号和邀请链接。
- 牌桌：手牌、碰杠区、弃牌区、赖子、骰子、动作按钮。
- 战绩：历史牌局、分数、回放入口。
- 钱包：欢乐豆余额和流水。

## 客户端原则

- 客户端只提交动作意图。
- 胡牌、跑风、杠上、欢乐豆结算由服务端判定。
- 客户端可以调用 `@qingyang/mahjong-core` 做提示，但不能作为最终结果。

## 后续初始化

```bash
npx create-expo-app apps/mobile --template
```

初始化后保留本文页面规划，并接入 `packages/mahjong-core`。
