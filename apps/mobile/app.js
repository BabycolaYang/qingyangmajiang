import {
  WIN_TYPES,
  DEFAULT_RULE_CONFIG,
  RULE_LABELS,
  anGang,
  buGang,
  chooseBotDiscardIndex,
  chooseBotReaction,
  discardTile,
  drawForCurrentSeat,
  finishWin,
  getAnGangOptions,
  getBuGangOptions,
  getMingGangOptions,
  getPengOptions,
  mergeDrawnTile,
  mingGangDiscard,
  normalizeRuleConfig,
  pengDiscard,
  rollDice,
  skipReactions,
  sortTiles,
  startRound,
  tileLabel,
} from "../../packages/mahjong-core/src/index.js";
import { Application, Container, Graphics, Sprite, Text, Texture } from "/node_modules/pixi.js/dist/pixi.mjs";


const app = document.querySelector("#app");
const storageKey = "qingyang-pinghu-mobile";
const botNames = ["下家", "对家", "上家"];

// 账号凭据存 localStorage（同浏览器共享登录态，业界标准行为）：
// 新 tab / 邀请链接打开时自动登录，无需重复登录；座位 token 才用 sessionStorage（短时效、关 tab 即弃）。
// 注意：必须位于下方 `const state = loadState()` 之前——初始化链路会调用 loadAuthSession()，
// 若定义在其后，AUTH_SESSION_KEY 处于暂时性死区（TDZ），读取会静默失败导致永远游客。
const AUTH_SESSION_KEY = "qingyang-mahjong-auth";

function loadAuthSession() {
  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed?.user && parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

function saveAuthSession(auth) {
  try {
    if (auth?.user && auth?.token) {
      window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
        user: auth.user,
        token: auth.token,
      }));
    } else {
      window.localStorage.removeItem(AUTH_SESSION_KEY);
    }
  } catch {
    /* 隐私模式等场景不可用：静默退化（无自动登录） */
  }
}

const state = loadState();
let botTimer = null;
let socket = null;
let pixiTable = null;
let pixiRoot = null;
let pixiInit = null;
// 摸牌动画状态：记录已播放过动画的摸牌标识，避免重绘时重复播放；
// mergeTimer/merging 用于摸牌展示片刻后自动并入手牌排序（并带归位滑动）。
// active 计数：进行中的飞入/滑入动画数量；动画期间倒计时重绘跳过，避免打断瞬移。
const pixiAnim = { drawToken: null, mergeTimer: null, merging: null, active: 0 };
// 杠牌掷骰特效：复用开局骰子的画法，但计时/图层独立（不碰 roundIntro 流程状态）；
// token 记录已播过的杠（跨重绘去重），releaseDraw/releaseToken 用于延迟放行杠补飞牌。
const gangFx = { token: null, layer: null, timers: [], rollInterval: null, rolling: false, releaseDraw: null, releaseToken: null };
// 悬停状态：记录当前悬停的手牌索引，倒计时重绘后保持上抬；手牌张数变化时复位。
const pixiHover = { handIndex: null, handCount: 0 };

// 麻将图片资源：34 张牌面 + 牌背 PNG（assets/tiles/），文件名与牌编码一致。
// 挂载牌桌前预加载；任一图加载失败则保持空表，drawPixiTile 回退到文字画法。
const TILE_IMAGE_BASE = "assets/tiles/";
const TILE_IMAGE_NAMES = [
  ...["wan", "tiao", "tong"].flatMap((suit) => Array.from({ length: 9 }, (_, i) => `${suit}-${i + 1}`)),
  "east", "south", "west", "north", "zhong", "fa", "bai", "back",
];
const tileTextures = new Map();
let tileTexturesPromise = null;
function loadTileTextures() {
  if (!tileTexturesPromise) {
    // 用原生 Image 加载（不依赖 Pixi Assets 的初始化与解析），再经 canvas 生成纹理。
    tileTexturesPromise = Promise
      .all(TILE_IMAGE_NAMES.map((name) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ name, image });
        image.onerror = () => reject(new Error(`牌面图片请求失败: ${name}`));
        image.src = `${TILE_IMAGE_BASE}${name}.png`;
      })))
      .then((items) => {
        for (const { name, image } of items) {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d").drawImage(image, 0, 0);
          tileTextures.set(name, Texture.from(canvas));
        }
        console.log(`[tiles] 牌面图片已加载 ${tileTextures.size} 张`);
        return tileTextures;
      })
      .catch((error) => {
        console.warn("麻将图片加载失败，回退到文字绘制", error);
        return null;
      });
  }
  return tileTexturesPromise;
}

// 安全销毁 Pixi 应用：init 未落定时 destroy 会抛错（_cancelResize 缺失），
// 统一等 init 结束（无论成败）后再销毁，避免快速切换大厅/下一局时渲染中断。
function destroyPixiTable() {
  const table = pixiTable;
  const initPromise = pixiInit;
  pixiTable = null;
  pixiRoot = null;
  pixiInit = null;
  if (!table) {
    return;
  }
  const teardown = () => {
    try {
      table.destroy(true, { children: true, texture: true, baseTexture: true });
    } catch {
      // 重复销毁或初始化失败时忽略
    }
  };
  if (initPromise) {
    initPromise.then(teardown, teardown);
  } else {
    teardown();
  }
}
// 开局流程动画：庄家开局骰（和定开墙家、小点定留墩）→ 发牌飞牌 → 翻牌骰 → 指示牌翻开。
// layer/fxLayer 挂在 stage 上（pixiRoot 的兄弟），桌面重绘时不会被清掉。
const roundIntro = {
  gameId: null,
  phase: "idle", // idle | dice1 | deal | dice2 | flip | done
  revealed: false, // 指示牌翻牌动画已启动（横幅翻/赖角标与手牌金框此刻才亮真值）
  dealtTiles: 0, // 发牌动画已抓【张数】（牌墙按张消耗）
  shownHands: [0, 0, 0, 0], // 各家手牌区已亮出的张数（每抓 4 张即时显示）
  sorting: false, // 本家手牌排序滑动中（手牌由 fx 层接管）
  sortDone: false, // 排序完成，本家显示理好的手牌
  rolling: false,
  rollInterval: null,
  timers: [],
  layer: null,
  fxLayer: null,
  metrics: null,
  wallHead: null,
  indicatorPos: null,
  anchors: null,
};
// 调试句柄：便于浏览器控制台/自动化验证开局动画进度（只读引用，无副作用）。
window.__roundIntro = roundIntro;
window.__state = state;
window.__render = () => render();
// 出牌倒计时：轮到我出牌时启动，超时自动打出最右侧一张。
const DISCARD_TIME_LIMIT = 20;
const discardClock = { token: null, deadline: 0, timer: null };
// 碰/杠反应倒计时：与出牌同为 20s，超时自动"过"。
const REACTION_TIME_LIMIT = DISCARD_TIME_LIMIT;
const reactionClock = { token: null, deadline: 0, timer: null };
window.__clocks = { discardClock, reactionClock };

function roundIntroActive() {
  return roundIntro.phase !== "idle" && roundIntro.phase !== "done";
}

// 赖子身份只有在指示牌翻开后才公开：开局动画进行中（掷骰/发牌阶段）以及
// 新局尚未开启动画（turn 0 且无弃牌/碰杠，动画即将播放）时，翻/赖打码、手牌不标赖。
// 联机模式例外：保密期由服务端控制（不下发指示牌/赖子），下发即为公开事实；
// 本地开局动画依赖 Pixi ticker，窗口最小化会被挂起，不能作为联机的公开依据。
function laiziPublic(game) {
  if (!game) {
    return false;
  }
  if (isOnlineMode()) {
    return game.indicatorTile != null && game.laiziTile != null;
  }
  if (roundIntro.gameId === game.id) {
    if (roundIntro.phase === "done") {
      return true;
    }
    return roundIntro.phase === "flip";
  }
  const introPending = game.status === "playing" && game.turn === 0
    && game.players.every((p) => p.discards.length === 0 && p.melds.length === 0);
  return !introPending;
}

// 展示层公开判定（横幅翻/赖角标、手牌金框用）：数据公开 ≠ 立即亮出。
// 联机保密期的公开广播比开局动画的翻牌阶段早约 1.5s 到达，若直接用 laiziPublic，
// 横幅和手牌会在掷骰/翻牌动画还没播时就提前揭晓赖子身份——这里强制等指示牌
// 真正开始翻出（revealed 置位）再说；动画收尾（done）后自然保持公开。
function laiziShown(game) {
  if (!laiziPublic(game)) {
    return false;
  }
  if (roundIntro.gameId === game.id && roundIntroActive()) {
    return roundIntro.revealed === true || roundIntro.phase === "done";
  }
  return true;
}
const initialParams = new URLSearchParams(window.location.search);

render();
queueInitialOnlineJoin();

function loadState() {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    return normalizeState(JSON.parse(saved));
  }
  return normalizeState({
    view: "lobby",
    beans: 1000,
    room: null,
    game: null,
    mustLackOneSuit: false,
    ledger: [],
  });
}

function normalizeState(nextState) {
  const params = new URLSearchParams(window.location.search);
  const initialOnline = params.get("online") === "1" || Boolean(params.get("room"));

  return {
    view: nextState.view ?? "lobby",
    beans: nextState.beans ?? 1000,
    room: initialOnline ? null : nextState.room ?? null,
    game: initialOnline ? null : nextState.game ?? null,
    mustLackOneSuit: nextState.mustLackOneSuit ?? false,
    // 房间规则草稿（倍率 + 各规则开关）：创建房间时快照进 state.room，
    // 联机创建/快速加入时随消息发给服务器，开出的房间即按此规则进行。
    ruleConfig: normalizeRuleConfig(nextState.ruleConfig),
    ledger: nextState.ledger ?? [],
    nickname: nextState.nickname || `玩家${Math.floor(1000 + Math.random() * 9000)}`,
    // 简易账号：注册/登录后以账号昵称联机（服务器持久化），token 用于自动登录。
    // 凭据走 localStorage（loadAuthSession）：同浏览器共享登录态，邀请链接/新 tab 免登录。
    auth: (() => {
      const savedAuth = loadAuthSession();
      return {
        user: savedAuth?.user ?? null,
        token: savedAuth?.token ?? null,
        // 登录面板的展开状态与当前模式（login / register）。
        panelOpen: false,
        mode: nextState.auth?.mode ?? "login",
        error: "",
        busy: false,
      };
    })(),
    online: {
      connected: false,
      connecting: false,
      // URL 带联机意图（?online=1 / ?room=）时，大厅按钮直接走联机路径。
      mode: initialOnline,
      // 用户在对局/结算界面主动点了"大厅"：服务器广播不再把视图拉回牌桌。
      lobbyIntent: false,
      clientId: nextState.online?.clientId ?? null,
      room: null,
      error: "",
    },
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify({
    ...state,
    // 账号凭据不入 localStorage（避免 tab 间串扰与 token 死副本），只保留面板模式偏好。
    auth: { mode: state.auth?.mode ?? "login" },
    game: state.game,
  }));
}

function render() {
  clearTimeout(botTimer);
  saveState();

  // 登录门槛：未登录只能看到登录/注册页，不能进入大厅与牌桌游玩。
  if (!state.auth.user) {
    resetRoundIntro();
    clearDiscardClock();
    clearReactionClock();
    destroyPixiTable();
    app.innerHTML = renderAuthGate();
    bindLobby();
    return;
  }

  if (state.view === "table" && state.game) {
    if (state.game.status !== "ended" && pixiTable && pixiRoot && app.querySelector("#table-canvas")) {
      // 下一局后走的是刷新路径（不重建 DOM），这里要主动清掉上一局的结算浮层。
      app.querySelector(".settlement")?.remove();
      app.querySelector(".table")?.classList.remove("ended");
      updateExistingPixiTable(state.game);
      if (state.room) {
        const title = app.querySelector(".table-head h1");
        const badges = app.querySelector(".badge-row");
        if (title) title.textContent = `房号 ${state.room.code}`;
        if (badges) {
          badges.innerHTML = badgeRowHtml(state.game);
        }
      }
      const controls = app.querySelector(".controls");
      if (controls) {
        controls.innerHTML = renderControls();
        bindTable();
      }
      updateDiscardClock();
      updateReactionClock();
      if (!isOnlineMode()) {
        scheduleBots();
      }
      return;
    }
    resetRoundIntro();
    destroyPixiTable();
    app.innerHTML = renderTable();
    bindTable();
    void mountPixiTable(state.game).then(() => {
      updateDiscardClock();
      updateReactionClock();
    });
    if (!isOnlineMode()) {
      scheduleBots();
    }
    return;
  }

  resetRoundIntro();
  clearDiscardClock();
  clearReactionClock();
  destroyPixiTable();
  app.innerHTML = renderLobby();
  bindLobby();
}

// 大厅登录/注册面板：提交走联机 WebSocket（register / login），
// 服务器回 authResult 后由 handleOnlineMessage 统一落地登录态。
// hideClose：登录门槛页使用（没有"关闭"可点，必须登录才能进游戏）。
function renderAuthPanel({ hideClose = false } = {}) {
  const isRegister = state.auth.mode === "register";
  return `
    <div class="panel home-room auth-panel">
      <h3>${isRegister ? "注册账号" : "账号登录"}</h3>
      <p class="status-text">注册后联机房间内以账号昵称显示，用于区分不同玩家。</p>
      <input id="auth-username" maxlength="16" autocomplete="username" placeholder="用户名（2-16 位）" />
      <input id="auth-password" type="password" maxlength="32" autocomplete="current-password" placeholder="密码（4-32 位）" />
      ${isRegister ? `<input id="auth-nickname" maxlength="8" placeholder="游戏昵称（默认同用户名）" />` : ""}
      <div class="actions">
        <button class="gold" data-action="auth-submit" ${state.auth.busy ? "disabled" : ""}>${isRegister ? "注册并登录" : "登录"}</button>
        <button class="secondary" data-action="auth-switch">${isRegister ? "已有账号？去登录" : "没有账号？去注册"}</button>
        ${hideClose ? "" : `<button class="secondary" data-action="auth-close">关闭</button>`}
      </div>
      ${state.auth.error ? `<p class="status-text error">${escapeHtml(state.auth.error)}</p>` : ""}
    </div>
  `;
}

// 最外层登录门槛页：未登录时替代大厅渲染，登录成功后 authResult 触发 render 自然进入。
function renderAuthGate() {
  return `
    <div class="home">
      <main class="home-screen">
        <div class="home-logo">
          <h1>青阳平胡</h1>
          <p>血战到底 · 缺一门 · 平胡</p>
        </div>
        ${renderAuthPanel({ hideClose: true })}
      </main>
    </div>
  `;
}

function renderLobby() {
  const room = state.room;
  const onlineRoom = state.online.room;
  const isOnline = isOnlineMode();
  const tab = state.lobbyTab ?? "game";

  // 房间内（本地好友房 / 联机房）：游戏页签直接展示房间面板。
  const roomPanel = onlineRoom
    ? `<div class="panel home-room">${renderOnlineRoomPanel(onlineRoom)}</div>`
    : room
    ? `
      <div class="panel home-room">
        <p class="room-meta">房号</p>
        <p><span class="room-code">${room.code}</span></p>
        <div class="setting-row"><span>局数</span><strong>${room.rounds}</strong></div>
        <div class="setting-row"><span>倍率</span><strong>${(room.ruleConfig ?? state.ruleConfig).multiplier}</strong></div>
        <div class="setting-row"><span>缺一门</span><strong>${room.mustLackOneSuit ? "开" : "关"}</strong></div>
        <div class="actions">
          <button class="gold" data-action="start">开局</button>
          <button class="secondary" data-action="leave">离开</button>
        </div>
      </div>
    `
    : "";

  const navButton = (key, label) =>
    `<button class="${tab === key ? "on" : ""}" data-action="tab-${key}">${label}</button>`;

  const tabContent =
    tab === "join" && !onlineRoom && !room
      ? `
        <div class="panel home-room">
          <h3>加入房号</h3>
          <input id="roomCode" maxlength="6" inputmode="latin" placeholder="输入 6 位房号" />
          <div style="height:10px"></div>
          <div class="actions">
            <button class="gold" data-action="online-join">联机加入</button>
            <button class="secondary" data-action="join-room">本地加入</button>
            <button class="secondary" data-action="tab-game">返回</button>
          </div>
          ${state.online.error ? `<p class="status-text error">${escapeHtml(state.online.error)}</p>` : ""}
          <p class="status-text">${onlineStatusText()}</p>
        </div>
      `
      : tab === "config" && !onlineRoom && !room
      ? renderRoomConfigPanel(isOnline)
      : tab === "records"
      ? `
        <div class="panel home-room">
          <h3>战绩流水</h3>
          ${renderLedger()}
        </div>
      `
      : tab === "settings"
      ? `
        <div class="panel home-room">
          <h3>设置</h3>
          <input id="nickname" maxlength="8" placeholder="昵称" value="${escapeHtml(state.nickname)}" />
          <div style="height:10px"></div>
          <div class="setting-row"><span>缺一门</span>
            <button class="toggle ${state.mustLackOneSuit ? "on" : ""}" data-action="toggle-lack" aria-label="缺一门"><span></span></button>
          </div>
          <p class="status-text">${onlineStatusText()}</p>
        </div>
      `
      : roomPanel ||
        `
        <div class="home-actions">
          <button class="home-btn primary" data-action="quick-start">
            <span>快速开始</span>
            <small>${isOnline ? "自动加入有空位的房间" : "和电脑来一局"}</small>
          </button>
          <div class="home-btn-row">
            <button class="home-btn" data-action="show-config">创建好友房</button>
            <button class="home-btn" data-action="show-join">加入房号</button>
          </div>
        </div>
      `;

  return `
    <div class="app home">
      <header class="home-topbar">
        <div class="home-user">
          <span class="avatar">${escapeHtml((state.nickname || "客").slice(0, 1))}</span>
          <div class="home-user-meta">
            <strong>${escapeHtml(state.nickname)}</strong>
            <span class="bean-pill"><i></i>${state.beans}</span>
          </div>
        </div>
        <div class="home-topbar-right">
          ${state.auth?.user
            ? `<span class="home-auth-badge">已登录 · ${escapeHtml(state.auth.user.username)}</span>
               <button class="home-auth-btn" data-action="logout">退出</button>`
            : `<button class="home-auth-btn" data-action="show-auth">登录 / 注册</button>`}
          <span class="home-status">${isOnline ? "联机模式" : "单机模式"}</span>
        </div>
      </header>

      <main class="home-screen">
        ${state.auth?.panelOpen ? renderAuthPanel() : ""}
        <div class="home-logo">
          <h1>青阳平胡</h1>
          <p>血战到底 · 缺一门 · 平胡</p>
        </div>
        ${tabContent}
      </main>

      <nav class="home-nav">
        ${navButton("game", "游戏")}
        ${navButton("records", "战绩")}
        ${navButton("settings", "设置")}
      </nav>
    </div>
  `;
}

// 创建房间的规则配置页：倍率、缺一门与各计分规则开关，确认后开出的房间即按此规则进行。
function renderRoomConfigPanel(isOnline) {
  const config = state.ruleConfig;
  const ruleRows = Object.keys(DEFAULT_RULE_CONFIG.rules)
    .map(
      (key) => `
        <div class="setting-row"><span class="rule-name">${RULE_LABELS[key]}</span>
          <button class="toggle ${config.rules[key] ? "on" : ""}" data-action="rule-toggle" data-rule="${key}" aria-label="${RULE_LABELS[key]}"><span></span></button>
        </div>
      `,
    )
    .join("");

  return `
    <div class="panel home-room">
      <h3>房间规则</h3>
      <div class="setting-row"><span>${RULE_LABELS.multiplier}</span><strong>1 子 = ${config.multiplier} 豆</strong></div>
      <div class="mult-row">
        ${[5, 10, 20, 50]
          .map(
            (value) =>
              `<button class="mult-btn ${config.multiplier === value ? "on" : ""}" data-action="multiplier" data-value="${value}">${value} 倍</button>`,
          )
          .join("")}
      </div>
      <div class="setting-row"><span>缺一门（打缺）</span>
        <button class="toggle ${state.mustLackOneSuit ? "on" : ""}" data-action="toggle-lack" aria-label="缺一门"><span></span></button>
      </div>
      <div class="rule-list">${ruleRows}</div>
      <div style="height:12px"></div>
      <div class="actions">
        <button class="gold" data-action="config-create">${isOnline ? "创建联机房" : "创建房间"}</button>
        <button class="secondary" data-action="tab-game">返回</button>
      </div>
      <p class="status-text">${isOnline ? "创建成功后规则即时生效" : "开局后按本规则进行"}</p>
    </div>
  `;
}

function renderOnlineRoomPanel(room) {
  const inviteUrl = `${window.location.origin}${room.invitePath}`;
  return `
    ${onlineDisconnectBannerHtml()}
    <p class="room-meta">房号</p>
    <p><span class="room-code">${room.code}</span></p>
    <div class="invite-box">${escapeHtml(inviteUrl)}</div>
    <div class="setting-row"><span>倍率</span><strong>${room.ruleConfig?.multiplier ?? state.ruleConfig.multiplier}</strong></div>
    <div class="setting-row"><span>缺一门</span><strong>${room.mustLackOneSuit ? "开" : "关"}</strong></div>
    <div class="actions">
      <button class="secondary" data-action="copy-invite">复制邀请</button>
      ${room.isOwner ? `<button class="gold" data-action="online-start">开局</button>` : ""}
      ${room.isOwner ? `<button class="secondary" data-action="online-dissolve">解散房间</button>` : ""}
      <button class="secondary" data-action="online-leave">离开</button>
    </div>
    <div class="seat-list">
      ${room.players
        .map(
          (player) => `
            <div class="seat-row ${player.isYou ? "you" : ""}">
              <span>${player.seat + 1} 座</span>
              <strong>${player.name || "空位"}${player.isOwner ? " 房主" : ""}${player.isYou ? " 我" : ""}${player.name && !player.connected ? "（离线）" : ""}</strong>
            </div>
          `,
        )
        .join("")}
    </div>
    <p class="status-text">空位开局后会由电脑补位。</p>
    ${state.online.error ? `<p class="status-text error">${escapeHtml(state.online.error)}</p>` : ""}
  `;
}

function renderLedger() {
  if (state.ledger.length === 0) {
    return `<div class="ledger-row"><span>暂无</span><strong>0</strong></div>`;
  }
  return state.ledger
    .slice(0, 6)
    .map(
      (item) => `
        <div class="ledger-row">
          <span>${item.text}</span>
          <strong>${item.delta > 0 ? "+" : ""}${item.delta}</strong>
        </div>
      `,
    )
    .join("");
}

// 头部徽章：开局动画翻牌阶段之前翻/赖打码为"？"（即使保密期数据已下发也不提前亮出），
// 等掷骰结束、指示牌翻出来的那一刻才显示真实牌面，避免提前泄露赖子身份。
function badgeRowHtml(game) {
  const revealed = laiziShown(game);
  // 有效摸牌区：墙内张数扣除死墙即"还可摸"，便于对局者判断荒庄边界。
  const drawable = Math.max(0, game.wall.length - (game.deadWallTiles ?? 0));
  return `<span class="badge">墙 ${game.wall.length}</span>`
    + `<span class="badge">可摸 ${drawable}</span>`
    + `<span class="badge">翻 ${revealed ? tileLabel(game.indicatorTile) : "？"}</span>`
    + `<span class="badge">赖 ${revealed ? tileLabel(game.laiziTile) : "？"}</span>`;
}

function renderTable() {
  const game = state.game;
  const positions = ["bottom", "right", "top", "left"];
  const message = getMessage();

  return `
    ${onlineDisconnectBannerHtml()}
    <div class="table ${game.status === "ended" ? "ended" : ""}">
      <header class="table-head">
        <button class="secondary" data-action="back">大厅</button>
        <h1>房号 ${state.room.code}</h1>
        <div class="badge-row">
          ${badgeRowHtml(game)}
        </div>
      </header>
      <section class="board">
        <canvas id="table-canvas" aria-label="PixiJS 麻将牌桌"></canvas>
        ${game.status === "ended" ? renderSettlement() : ""}
      </section>
      <footer class="controls">
        ${renderControls()}
      </footer>
    </div>
  `;
}

async function mountPixiTable(game) {
  const canvas = app.querySelector("#table-canvas");
  const board = app.querySelector(".board");
  if (!canvas || !board) {
    return;
  }

  // 等牌面图片就绪（仅首次加载；失败时回退文字画法）。
  await loadTileTextures();
  destroyPixiTable();
  const table = new Application();
  pixiTable = table;
  const initPromise = table.init({
    canvas,
    resizeTo: board,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    backgroundAlpha: 0,
  });
  pixiInit = initPromise;
  await initPromise;
  // 等待期间桌面已被重建/销毁：本次挂载作废（销毁由 destroyPixiTable 的回调接管）。
  if (pixiTable !== table) {
    return;
  }
  pixiInit = null;

  const width = board.clientWidth;
  const height = board.clientHeight;
  const root = new Container();
  pixiRoot = root;
  table.stage.addChild(root);
  drawPixiTable(root, game, width, height);
}

function updateExistingPixiTable(game) {
  if (!pixiRoot) return;
  for (const child of pixiRoot.removeChildren()) {
    child.destroy?.({ children: true });
  }
  const board = app.querySelector(".board");
  drawPixiTable(pixiRoot, game, board.clientWidth, board.clientHeight);
}

// 布局参考 docs/huanle.jpeg（欢乐麻将）：
// 中心是八角罗盘（东南西北 + 剩余张数），四家弃牌围绕罗盘按座位朝向摆放；
// 牌墙每家面前 17 墩，位于各家手牌与弃牌区之间，随摸牌逐墩消耗，
// 翻开的指示牌显示在牌墙尾部对应位置；碰/杠牌区贴近各家手牌；
// 我（下）的手牌在底边明牌，抓到的牌在手牌右端单独隔开抬高。
const WALL_TOTAL_TILES = 136;
const WALL_STACKS_PER_SIDE = 17;

function drawPixiTable(root, game, width, height) {
  const scale = Math.max(0.62, Math.min(width / 1060, height / 600, 1.35));
  const cx = width / 2;
  const cy = height * 0.47;
  // 整体牌面放大；牌墙、弃牌与手牌（三家小牌）同尺寸，我的手牌保持前景大牌。
  const tileW = Math.max(26, 48 * scale);
  const tileH = Math.max(36, 69 * scale);
  const smallW = Math.max(19, 36 * scale);
  const smallH = Math.max(26, 50 * scale);
  // 罗盘加大：牌墙/弃牌环位仍按基准罗盘半径推算（位置不变），
  // 罗盘本身向中心空区扩张，上限以不触到首排弃牌为准。
  const dialBase = 44 * scale;
  const laneX = Math.max(width * 0.13, 92 * scale);
  // 弃牌区：四家弃牌围绕罗盘按座位朝向摆放，与手牌同大；每行/列 6 张。
  // discardStart（首排离中心距离）= 半行宽 + 一张牌宽，保证相邻两家在角落不会叠在一起。
  const discardW = smallW;
  const discardH = smallH;
  const discardGapX = discardW * 1.12;
  const discardGapY = discardH * 1.12;
  const discardPerLine = 6;
  const discardSpan = ((discardPerLine - 1) / 2) * discardGapX;
  const discardStart = discardSpan + (discardW + discardH) / 2 + 6 * scale;
  // 牌墙半径：刚好容纳 罗盘 + 3 行弃牌 + 牌墙，让整圈紧凑地居于牌桌中心（牌墙往中心靠），
  // 四周手牌与牌墙之间留出绒面；同时不超过手牌 clearance 允许的最大半径。
  const stackHalf = smallH * 0.6;
  const clearance = 14 * scale;
  const minRing = dialBase + discardH * 1.2 + stackHalf;
  const ringNeed = discardStart + 3 * discardGapY + stackHalf + 10 * scale;
  // 桌角防叠：每条边 17 墩的端墩中心距角点至少 cornerPad（≈ 半张牌宽 + 半张牌高），
  // 否则相邻两边端部的墩会在四个角上叠在一起；半径不够时压缩墩距，优先保证角部不叠。
  const wallPitchDesired = smallW * 1.06;
  const cornerPad = (smallW + smallH) * 0.5 + 4 * scale;
  const ringForStacks = 8 * wallPitchDesired + cornerPad;
  const maxFit = Math.min(
    cx - laneX - smallW * 0.5 - stackHalf - clearance,
    cy - smallH * 1.1 - stackHalf - clearance,
    height - cy - tileH * 1.1 - stackHalf - clearance,
  );
  const wallOffset = Math.max(minRing, Math.min(Math.max(ringNeed, ringForStacks), maxFit));
  const wallPitch = Math.min(wallPitchDesired, (wallOffset - cornerPad) / 8);
  // 实际罗盘半径：向中心空区做大（目标 1.55 倍基准），但不得挤压弃牌首排、也不外推牌墙。
  const dialR = Math.max(
    dialBase,
    Math.min(
      68 * scale,
      discardStart - discardH * 0.55 - 8 * scale,
      wallOffset - discardH * 1.2 - stackHalf - 6 * scale,
    ),
  );
  const layout = { cx, cy, dialR, wallOffset, wallPitch, laneX, width, height, tileW, tileH, smallW, smallH, scale, discardW, discardH, discardGapX, discardGapY, discardPerLine, discardStart };
  // 每帧记录布局度量：开局动画层与杠骰特效层共用（骰子遮罩尺寸、中心落点等由此推导）。
  roundIntro.metrics = { cx, cy, width, height, scale, smallW, smallH, laneX, tileW, tileH };

  // 摸牌令牌：检测到新的摸牌（回合 + 剩余墙数 + 座位 + 牌唯一标识）时，
  // 由 drawPixiHand 让这张牌先从牌墙位置显示，再动画飞入手牌对应位置。
  const drawToken = game.lastDraw && game.status === "playing"
    ? `${game.id}:${game.wall.length}:${game.lastDraw.seat}:${game.lastDraw.tile}`
    : null;

  // 开局流程动画（掷骰 → 发牌 → 掷骰 → 翻牌）进行期间：只画整圈牌墙/罗盘/玩家信息，
  // 手牌、弃牌、碰杠与指示牌由动画层逐步呈现；动画结束后恢复正常绘制。
  maybeStartRoundIntro(game);
  const introOn = roundIntroActive() && roundIntro.gameId === game.id;
  layout.introActive = introOn;
  layout.introDealtTiles = introOn ? roundIntro.dealtTiles : undefined;
  layout.countdown = currentDiscardCountdown() ?? currentReactionCountdown();

  // 杠检测（含空过不补的杠）：log 尾部的杠条目作令牌，每条只播一次掷骰画面；
  // 开局的翻牌骰走 roundIntro 流程，这里只负责游戏中途的明杠/暗杠/补杠。
  const lastLog = game.log?.[game.log.length - 1];
  const isGangLog = lastLog && (lastLog.type === "mingGang" || lastLog.type === "anGang" || lastLog.type === "buGang");
  const gangToken = isGangLog && game.status === "playing" && !introOn
    ? `${game.id}:${game.log.length}:${lastLog.type}:${lastLog.seat}:${lastLog.dice?.total ?? "?"}`
    : null;
  if (gangToken && gangToken !== gangFx.token) {
    gangFx.token = gangToken;
    // 有补牌时记录待放行令牌（骰子落定才从墙尾飞入手牌）；空过则只播骰子。
    gangFx.releaseDraw = lastLog.drawnTile != null && game.lastDraw?.fromGang ? drawToken : null;
    startGangDiceFx(lastLog, game);
  }
  // 杠骰落定后的放行重绘：这一帧让 drawPixiHand 从墙尾起飞杠补的牌。
  if (gangFx.releaseToken && game.lastDraw?.fromGang && drawToken) {
    layout.animateDraw = game.lastDraw;
    gangFx.releaseToken = null;
    if (game.lastDraw.seat === 0 && !isOnlineMode()) {
      scheduleDrawnMerge(drawToken);
    }
  }
  if (drawToken && drawToken !== pixiAnim.drawToken) {
    // 杠补的牌在骰子落定前不放行（上方已记录待放行令牌），普通摸牌立即飞。
    if (drawToken !== gangFx.releaseDraw) {
      layout.animateDraw = game.lastDraw;
      // 我的摸牌：展示片刻后自动并入手牌排序（仅单机；联机状态由服务端持有）。
      if (game.lastDraw.seat === 0 && !isOnlineMode()) {
        scheduleDrawnMerge(drawToken);
      }
    }
  }
  pixiAnim.drawToken = drawToken;

  drawPixiWalls(root, game, layout);
  drawPixiDial(root, game, cx, cy, dialR, scale, layout.countdown);

  game.players.forEach((player, seat) => {
    drawPixiPlayerPanel(root, player, seat, game, layout);
    if (introOn) {
      return;
    }
    drawPixiDiscards(root, player.discards, seat, { ...layout, laiziTile: game.laiziTile });
    drawPixiMelds(root, player.melds, seat, { ...layout, laiziTile: game.laiziTile, handCount: player.hand.length });
    drawPixiHand(root, player, seat, game, layout);
  });

  if (introOn) {
    // 发牌进度手牌（每抓 4 张即时亮出；本家明牌按抓牌顺序，翻牌后才滑动理出真实排序）。
    drawIntroHands(root, game, layout);
    // 给动画层记录布局锚点（指示牌位置、各家手牌落点等；布局度量已在上方每帧更新）。
    roundIntro.wallHead = layout.wallHead;
    roundIntro.indicatorPos = layout.indicatorPos;
    roundIntro.anchors = {
      0: { x: cx, y: height - tileH * 0.62 },
      1: { x: width - laneX, y: cy },
      2: { x: cx, y: smallH * 0.62 },
      3: { x: laneX, y: cy },
    };
    return;
  }

  addPixiText(root, getMessage(), cx, height - tileH - 26 * scale, 15 * scale, 0xf5fff8, true);
}

function seatRotation(seat) {
  return seat === 1 ? -Math.PI / 2 : seat === 3 ? Math.PI / 2 : seat === 2 ? Math.PI : 0;
}

// 上层牌相对下层的偏移（乘 scale 使用）：主偏移一律朝桌心，次偏移沿墙方向错缝，
// 四边视觉统一为"上层牌向牌墙内侧微微错开"，指示牌替换上层时也复用同一偏移。
function wallStackOffsets(side, scale) {
  const unit = side === 1
    ? { dx: -3, dy: 1.5 }   // 右边：上层向左（朝桌心）
    : side === 2
      ? { dx: 1.5, dy: 3 }  // 顶边：上层向下（朝桌心）
      : side === 3
        ? { dx: 3, dy: 1.5 } // 左边：上层向右（朝桌心）
        : { dx: 1.5, dy: -3 }; // 底边：上层向上（朝桌心）
  return { dx: unit.dx * scale, dy: unit.dy * scale };
}

// 牌墙：四家各 17 墩（每墩 2 张）围成一圈。破口（墙头）由开局骰定位：
// 点数和从庄家数起决定在哪家面前开墙，较小的骰子数决定在该家墙边留几墩后开抓；
// 发牌/摸牌从墙头沿圈消耗，墙尾按翻牌骰翻出指示牌并亮在对应墩上，随游戏进行整圈逐渐缩短。
function drawPixiWalls(root, game, layout) {
  const { cx, cy, wallOffset, wallPitch: pitch, smallW, smallH, scale } = layout;
  const totalStacks = WALL_STACKS_PER_SIDE * 4; // 68 墩
  // 墙尾取牌记录（指示牌 1 次 + 每次杠补 1 次），用于换算墙头真实消耗与空缺重放。
  const backEntries = (game.diceHistory ?? [{ reason: "laizi" }]).filter((entry) => entry.reason !== "opening");
  const backTaken = backEntries.length;
  // 死墙（有效摸牌区）墩数：deadWallTiles 为界内现存张数，界内已被翻牌/杠补
  // 取走的张数恰为 backTaken，故死墙墩数 = (deadWallTiles + backTaken) / 2。
  // 例：翻牌骰 3 → 4 墩不可摸；杠后边界 = max(翻牌骰, 杠骰)+1+杠次数 墩。
  const deadStacks = game.deadWallTiles != null ? Math.round((game.deadWallTiles + backTaken) / 2) : 0;
  // 翻牌骰掷出前（开局动画翻牌阶段之前）不标色，避免提前泄露死墙范围。
  const deadVisible = !layout.introActive || roundIntro.phase === "flip" || roundIntro.phase === "done";
  // 已消耗【张数】（每墩 2 张，抓 1 张只少 1 张）：发牌 53 张 + 其后每次墙头摸牌；
  // 开局动画期间按发牌进度（张）展示。奇数时墙头墩只剩底层（上层已被抓走）。
  const consumedTiles = layout.introDealtTiles ?? Math.max(0, WALL_TOTAL_TILES - game.wall.length - backTaken);
  const consumedStacks = Math.floor(consumedTiles / 2);
  const headHalfTaken = consumedTiles % 2 === 1;
  // 墩位沿圈顺时针排布（与真实抓牌方向一致）：
  // 底边右→左、左边下→上、顶边左→右、右边上→下，四边首尾相接成一整圈。
  // 墩号每 17 个一段，按顺时针依次对应边：底(0) → 左(3) → 顶(2) → 右(1)。
  const SLOT_SIDE = [0, 3, 2, 1];
  // 各座位（0底/1右/2顶/3左）所在边的起始墩号。
  const SIDE_START_SLOT = [0, 51, 34, 17];
  // 开局骰：和从庄家数起定开墙方位，小点定留墩数（从该家右手边留起）。
  const opening = game.openingDice ?? { dice: [3, 4], total: 7 };
  const breakSeat = (game.dealerSeat + opening.total - 1) % 4;
  const leaveStacks = Math.min(opening.dice[0], opening.dice[1]);
  const headSlot = (SIDE_START_SLOT[breakSeat] + leaveStacks) % totalStacks;

  const slotPosition = (slot) => {
    const side = SLOT_SIDE[Math.floor(slot / WALL_STACKS_PER_SIDE)];
    const s = slot % WALL_STACKS_PER_SIDE;
    if (side === 0) {
      return { x: cx + (8 - s) * pitch, y: cy + wallOffset, rotation: 0, side };
    }
    if (side === 1) {
      return { x: cx + wallOffset, y: cy + (s - 8) * pitch, rotation: Math.PI / 2, side };
    }
    if (side === 2) {
      return { x: cx + (s - 8) * pitch, y: cy - wallOffset, rotation: 0, side };
    }
    return { x: cx - wallOffset, y: cy + (8 - s) * pitch, rotation: Math.PI / 2, side };
  };

  // 指示牌位置：墙尾（破口另一侧）按翻牌骰点数【按墩】数出，替换对应墩的上层牌。
  // 排尾最后一墩为第 1 墩，与 game.js 的 drawIndicatorFromBack 取牌位置一一对应。
  const laiziTotal = game.laiziDice?.total ?? 7;
  const tailSlot = (headSlot - 1 + totalStacks) % totalStacks;
  let indicatorSlot = (tailSlot - (laiziTotal - 1) + totalStacks) % totalStacks;
  // 残局若翻到已消耗区，顺延到剩余墙的第一墩。
  const relIndicator = (indicatorSlot - headSlot + totalStacks) % totalStacks;
  if (relIndicator < consumedStacks) {
    indicatorSlot = (headSlot + consumedStacks) % totalStacks;
  }

  // 重放墙尾取牌序列，得到每个被取墩的已取层数（1=只剩底层，2=整墩取空）。
  // 与核心包 takeGangReplacement 同式重放：骰点 n 从排尾数第 n 墩（每墩 2 张），
  // 更早取过牌的墩会顶偏位置（nearer），同墩第二次取剩下的下层（taken）。
  // 空过（引擎未补牌，log 杠条目无 drawnTile）不产生空缺，但骰点仍计入取牌序列。
  const backTakenLayers = new Map();
  {
    const consumed = [];
    const gangLogs = (game.log ?? []).filter((entry) => entry.type === "mingGang" || entry.type === "anGang" || entry.type === "buGang");
    let gangIndex = 0;
    for (const entry of backEntries) {
      const total = entry.total ?? (entry.reason === "laizi" ? game.laiziDice?.total : null);
      if (total == null) {
        break;
      }
      const taken = consumed.filter((stack) => stack === total).length;
      const nearer = consumed.filter((stack) => stack < total).length;
      const position = taken === 0 ? 2 * total - nearer : 2 * total - 1 - nearer;
      const isLaizi = entry.reason === "laizi";
      const gangLog = isLaizi ? null : gangLogs[gangIndex++];
      // 翻牌墩由 indicatorSlot 逻辑专门呈现（翻开的指示牌盖在上层），不在此重复留缺。
      if (!isLaizi && gangLog && gangLog.drawnTile != null) {
        const stackFromTail = Math.ceil(position / 2); // 从排尾数第几墩（1 起）
        const slot = (tailSlot - (stackFromTail - 1) + totalStacks) % totalStacks;
        backTakenLayers.set(slot, (backTakenLayers.get(slot) ?? 0) + 1);
      }
      consumed.push(total);
    }
  }

  // 记录墙头/墙尾位置，供摸牌动画作为起飞点（杠上补牌从墙尾摸）。
  layout.wallHead = slotPosition((headSlot + consumedStacks) % totalStacks);
  layout.wallTail = slotPosition((headSlot - 1 + totalStacks) % totalStacks);

  // 画出尚未消耗的墩（墙头到已消耗处留空）；消耗张数为奇数时墙头墩只画底层（上层已抓走）。
  // 指示牌所在墩在【翻牌骰掷出前】保持完整两层的背面（不能提前剧透翻牌位置），
  // 进入翻牌阶段后才只画底层，上层由翻出的指示牌顶替。
  const indicatorRevealed = !layout.introActive || roundIntro.phase === "flip" || roundIntro.phase === "done";
  for (let i = consumedStacks; i < totalStacks; i += 1) {
    const slot = (headSlot + i) % totalStacks;
    // 杠补/翻牌取走的墩：取 1 张画半墩（只剩底层），取空 2 张整墩留缺不画。
    const takenLayers = backTakenLayers.get(slot) ?? 0;
    if (takenLayers >= 2) {
      continue;
    }
    const { x, y, rotation, side } = slotPosition(slot);
    const lowerOnly = (slot === indicatorSlot && indicatorRevealed) || (i === consumedStacks && headHalfTaken) || takenLayers >= 1;
    // 排尾方向计入死墙的墩用棕色标记，提示此处不可再摸。
    const isDead = deadVisible && i >= totalStacks - deadStacks;
    drawWallStack(root, x, y, rotation, smallW, smallH, scale, lowerOnly, isDead, side);
  }

  // 翻出的指示牌：精确落在该墩上层牌的位置（与 drawWallStack 的上层偏移和 0.98 缩放一致），
  // 视觉上就是"这张牌被翻开盖在原位"，不额外抬起/外移，避免浮在牌墙之外。
  const pos = slotPosition(indicatorSlot);
  const stackOffset = wallStackOffsets(pos.side, scale);
  const indicatorX = pos.x + stackOffset.dx;
  const indicatorY = pos.y + stackOffset.dy;
  layout.indicatorPos = { x: indicatorX, y: indicatorY, rotation: pos.rotation };
  // 开局动画期间指示牌由翻开动画呈现，这里先不画。
  if (!layout.introActive) {
    drawPixiTile(root, game.indicatorTile, indicatorX, indicatorY, smallW * 0.98, smallH * 0.98, pos.rotation, game.indicatorTile === game.laiziTile, true, false, scale);
  }
}

function drawWallStack(root, x, y, rotation, width, height, scale, lowerOnly = false, dead = false, side = 0) {
  const horizontal = rotation === 0;
  const stackW = (horizontal ? width : height) * 0.98;
  const stackH = (horizontal ? height : width) * 0.98;
  // 上层偏移按边区分（主偏移朝桌心），与指示牌落点共用 wallStackOffsets。
  const { dx, dy } = wallStackOffsets(side, scale);
  // 死墙墩用棕色系标记，与可摸区的绿色牌墙区分。
  const lowerFill = dead ? 0x8a4a1f : 0x1c7a5c;
  const upperFill = dead ? 0xc47a35 : 0x2ea878;
  const edge = dead ? 0x5a2f12 : 0x0a4636;
  const lower = new Graphics()
    .roundRect(x - stackW / 2 - dx, y - stackH / 2 - dy, stackW, stackH, 2.5 * scale)
    .fill(lowerFill)
    .stroke({ color: edge, width: 1 });
  root.addChild(lower);
  if (lowerOnly) {
    return;
  }
  const upper = new Graphics()
    .roundRect(x - stackW / 2 + dx, y - stackH / 2 + dy, stackW, stackH, 2.5 * scale)
    .fill(upperFill)
    .stroke({ color: edge, width: 1 });
  root.addChild(upper);
}

// 中心罗盘：八角形，四边标注东南西北（庄家为东），当前出牌方位高亮；
// 轮到我出牌时中心显示倒计时秒数（金色），墙数缩到上方。
function drawPixiDial(root, game, cx, cy, dialR, scale, countdown = null) {
  const points = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI / 4) * index + Math.PI / 8;
    points.push(cx + dialR * Math.cos(angle), cy + dialR * Math.sin(angle));
  }
  const dial = new Graphics()
    .poly(points)
    .fill({ color: 0x101b22, alpha: 0.94 })
    .stroke({ color: 0x45b8dd, alpha: 0.5, width: 3 });
  root.addChild(dial);

  const winds = ["东", "南", "西", "北"];
  const angles = [Math.PI / 2, 0, -Math.PI / 2, Math.PI];
  game.players.forEach((_, seat) => {
    const wind = winds[(seat - game.dealerSeat + 4) % 4];
    const x = cx + dialR * 0.68 * Math.cos(angles[seat]);
    const y = cy + dialR * 0.68 * Math.sin(angles[seat]);
    addPixiText(root, wind, x, y, 15 * scale, game.currentSeat === seat ? 0xffd85b : 0x9ad7c9, true);
  });
  if (countdown != null) {
    addPixiText(root, String(game.wall.length).padStart(2, "0"), cx, cy - 15 * scale, 12 * scale, 0x66ddff, true);
    addPixiText(root, String(countdown), cx, cy + 5 * scale, 26 * scale, countdown <= 5 ? 0xff6b5b : 0xffd85b, true);
  } else {
    addPixiText(root, String(game.wall.length).padStart(2, "0"), cx, cy, 24 * scale, 0x66ddff, true);
  }
}

// 玩家信息牌：正方形，贴各自手牌区外侧摆放——
// 我=手牌行左端上方，上家/下家=左右边缘、手牌列外侧，对家=顶墙右端上方（指示牌外侧）；
// 当前行牌方金框高亮。
function drawPixiPlayerPanel(root, player, seat, game, layout) {
  const { cx, cy, laneX, width, height, scale, tileH, smallH, wallOffset } = layout;
  const side = 64 * scale;
  const margin = 10 * scale;
  const gap = 8 * scale;
  // 竖排手牌（上/下家）与左右墙列的横向占位 = smallH（旋转 90° 后宽高互换）。
  const spots = [
    { x: Math.max(margin + side / 2, laneX), y: height - tileH * 0.62 - tileH / 2 - side / 2 - gap }, // seat0 我：手牌行左端上方
    { x: Math.min(width - margin - side / 2, width - laneX + smallH / 2 + side / 2 + gap), y: height / 2 }, // seat1 下家：手牌列右外侧
    { x: cx + wallOffset + side / 2 + gap * 3, y: cy - wallOffset - smallH * 0.7 - side / 2 - gap }, // seat2 对家：顶墙右端上方
    { x: Math.max(margin + side / 2, laneX - smallH / 2 - side / 2 - gap), y: height / 2 }, // seat3 上家：手牌列左外侧
  ];
  const spot = spots[seat];
  const current = game.currentSeat === seat && game.status === "playing";
  const panel = new Graphics()
    .roundRect(-side / 2, -side / 2, side, side, 10 * scale)
    .fill({ color: 0x0a2420, alpha: 0.82 })
    .stroke({ color: current ? 0xffd85b : 0x9adcc8, width: current ? 2.5 : 1, alpha: current ? 0.95 : 0.35 });
  panel.position.set(spot.x, spot.y);
  root.addChild(panel);
  addPixiText(root, player.name, spot.x, spot.y - side * 0.18, 14 * scale, current ? 0xffe18a : 0xffffff, true);
  if (seat === game.dealerSeat) {
    const markR = 9 * scale;
    const markX = spot.x + side / 2 - markR * 0.7;
    const markY = spot.y - side / 2 + markR * 0.7;
    root.addChild(new Graphics().circle(markX, markY, markR).fill(0xd03428).stroke({ color: 0xffd85b, width: Math.max(1, 1.2 * scale) }));
    addPixiText(root, "庄", markX, markY, markR * 1.05, 0xffffff, true);
  }
  addPixiText(root, `${player.beans} 豆`, spot.x, spot.y + side * 0.2, 11 * scale, 0x9fc4bd, false);
}

// 手牌区：我在底边明牌（摸牌按排序插入，以抬高+金框突出，不额外挤开间隔），其余三家在各边的暗牌。
function drawPixiHand(root, player, seat, game, layout) {
  const { cx, cy, laneX, width, height, tileW, tileH, smallW, smallH, scale } = layout;
  const revealed = seat === 0 || game.status === "ended";
  const count = player.hand.length;
  // 摸牌即理牌（核心层已排序插入）：在排序后的位置突出展示摸到的牌。
  const drawnTile = game.lastDraw?.seat === seat ? game.lastDraw.tile : null;
  const drawnIndex = drawnTile != null ? player.hand.lastIndexOf(drawnTile) : -1;
  const rotation = seatRotation(seat);

  if (seat === 0) {
    const pitch = tileW * 1.08;
    const totalW = (count - 1) * pitch;
    const y = height - tileH * 0.62;
    // 手牌张数变化（摸/打/碰/杠）时复位悬停记忆，避免索引错位。
    if (pixiHover.handCount !== count) {
      pixiHover.handIndex = null;
      pixiHover.handCount = count;
    }
    // 有人打出我可碰的牌时，手牌里能碰的对子高亮（金框提亮）。
    const pengSet = game.phase === "reaction" && game.status === "playing" ? new Set(getPengOptions(game, 0)) : null;
    player.hand.forEach((tile, index) => {
      const drawn = index === drawnIndex;
      const x = cx - totalW / 2 + index * pitch;
      const tileNode = drawPixiTile(root, tile, x, y, tileW, tileH, 0, tile === game.laiziTile, drawn, false, scale, pengSet?.has(tile) === true);
      if (drawn && layout.animateDraw?.seat === seat) {
        // 新摸的牌：先显示在牌墙位置，再飞入其在手牌中的排序位；落定前不可点击。
        animateDrawnTile(tileNode, layout.animateDraw, layout, 0);
        return;
      }
      if (tile && game.status === "playing") {
        tileNode.eventMode = "static";
        tileNode.cursor = "pointer";
        // 悬停上抬（选中感），移出复位；倒计时重绘后仍保持上抬（按索引记忆）。
        const baseY = tileNode.position.y;
        if (pixiHover.handIndex === index) {
          tileNode.position.y = baseY - 8 * scale;
        }
        tileNode.on("pointerover", () => {
          pixiHover.handIndex = index;
          tileNode.position.y = baseY - 8 * scale;
        });
        tileNode.on("pointerout", () => {
          if (pixiHover.handIndex === index) {
            pixiHover.handIndex = null;
          }
          tileNode.position.y = baseY;
        });
        tileNode.on("pointertap", () => triggerPixiAction("discard", { handIndex: index }));
      }
    });
    return;
  }

  const pitch = smallW * 1.08;
  const total = (count - 1) * pitch;
  player.hand.forEach((tile, index) => {
    const offset = -total / 2 + index * pitch;
    const face = revealed ? tile : null;
    const isLaizi = revealed && tile === game.laiziTile;
    let tileNode;
    if (seat === 2) {
      tileNode = drawPixiTile(root, face, cx + offset, smallH * 0.62, smallW, smallH, rotation, isLaizi, false, !revealed, scale);
    } else if (seat === 1) {
      tileNode = drawPixiTile(root, face, width - laneX, cy + offset, smallW, smallH, rotation, isLaizi, false, !revealed, scale);
    } else {
      tileNode = drawPixiTile(root, face, laneX, cy + offset, smallW, smallH, rotation, isLaizi, false, !revealed, scale);
    }
    if (index === drawnIndex && layout.animateDraw?.seat === seat) {
      animateDrawnTile(tileNode, layout.animateDraw, layout, rotation);
    }
  });
}

// 开局发牌期间的手牌呈现：每抓 4 张落定后即时亮出（本家按抓牌顺序明牌，其余家牌背），
// 位置按最终张数定位从左到右填入；翻牌后的理牌滑动期间本家由 fx 层接管（这里跳过），
// 理牌完成（sortDone）后才显示真实排序的手牌。
function drawIntroHands(root, game, layout) {
  game.players.forEach((player, seat) => {
    const shown = Math.min(roundIntro.shownHands[seat] ?? 0, introHandCount(game, seat));
    if (shown <= 0) {
      return;
    }
    if (seat === 0 && roundIntro.sorting && !roundIntro.sortDone) {
      return;
    }
    if (seat === 0) {
      // 翻牌理牌完成前一直按抓牌顺序（initialHand）明牌展示，不提前排序（位置会暴露赖子）；
      // 翻牌并理牌完成后显示真实手牌（赖子最左、带金框）。
      const revealLaizi = laiziShown(game);
      const tiles = roundIntro.sortDone
        ? player.hand
        : (player.initialHand ?? player.hand);
      for (let index = 0; index < shown; index += 1) {
        const slot = introHandSlot(0, index, introHandCount(game, 0), layout);
        const tile = tiles[index] ?? null;
        drawPixiTile(root, tile, slot.x, slot.y, layout.tileW, layout.tileH, 0, revealLaizi && tile === game.laiziTile, false, !tile, layout.scale);
      }
      return;
    }
    for (let index = 0; index < shown; index += 1) {
      const slot = introHandSlot(seat, index, introHandCount(game, seat), layout);
      drawPixiTile(root, null, slot.x, slot.y, layout.smallW, layout.smallH, slot.rotation, false, false, true, layout.scale);
    }
  });
}

// 摸牌高亮停留 DRAWN_MERGE_DELAY 后落下（核心层摸牌时已理牌，这里只清除摸牌单放态）；
// 若期间玩家已打出或状态已变（lastDraw 对不上）则自动跳过。
const DRAWN_MERGE_DELAY = 800;
function scheduleDrawnMerge(token) {
  clearTimeout(pixiAnim.mergeTimer);
  pixiAnim.mergeTimer = setTimeout(() => {
    const game = state.game;
    if (state.view !== "table" || !game || game.status !== "playing" || !game.lastDraw || game.lastDraw.seat !== 0) {
      return;
    }
    const currentToken = `${game.id}:${game.wall.length}:${game.lastDraw.seat}:${game.lastDraw.tile}`;
    if (currentToken !== token) {
      return;
    }
    state.game = mergeDrawnTile(state.game, 0);
    render();
  }, DRAWN_MERGE_DELAY);
}

// 摸牌动画：摸到的牌先显示在牌墙墙头（杠上补牌在墙尾），再 ease-out 飞入本家手牌位置；
// 动画结束后重绘一次牌桌，恢复精确坐标与点击交互。
function animateDrawnTile(node, lastDraw, layout, targetRotation, fromOverride = null) {
  if (!pixiTable || !node) {
    return;
  }
  const from = fromOverride ?? (lastDraw.fromGang ? layout.wallTail : layout.wallHead) ?? { x: layout.cx, y: layout.cy, rotation: 0 };
  const toX = node.position.x;
  const toY = node.position.y;
  const fromRotation = from.rotation ?? 0;
  const rotationDelta = normalizeAngle(targetRotation - fromRotation);
  const duration = 420;
  let elapsed = 0;
  node.eventMode = "none";
  node.position.set(from.x, from.y);
  node.rotation = fromRotation;
  node.scale.set(1.18);
  if (node.parent) {
    node.parent.setChildIndex(node, node.parent.children.length - 1);
  }
  const tick = (ticker) => {
    if (node.destroyed || !node.parent) {
      pixiTable?.ticker?.remove(tick);
      pixiAnim.active = Math.max(0, pixiAnim.active - 1);
      return;
    }
    elapsed += ticker.deltaMS;
    const t = Math.min(1, elapsed / duration);
    const ease = 1 - (1 - t) ** 3;
    node.position.set(from.x + (toX - from.x) * ease, from.y + (toY - from.y) * ease);
    node.rotation = fromRotation + rotationDelta * ease;
    node.scale.set(1.18 + (1 - 1.18) * ease);
    if (t >= 1) {
      pixiTable?.ticker?.remove(tick);
      pixiAnim.active = Math.max(0, pixiAnim.active - 1);
      if (state.view === "table" && state.game && pixiRoot && app.querySelector("#table-canvas")) {
        updateExistingPixiTable(state.game);
      }
    }
  };
  pixiAnim.active++;
  pixiTable.ticker.add(tick);
}

function normalizeAngle(angle) {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

// ── 开局流程动画：掷骰（遮罩 + 双骰）→ 发牌飞牌 → 再掷骰 → 翻开指示牌 ──

// 新一轮（turn=0 且各家无弃牌/碰杠）首次绘制时启动开局动画；每局只播一次。
function maybeStartRoundIntro(game) {
  if (!pixiTable || roundIntro.gameId === game.id) {
    return;
  }
  if (game.status !== "playing" || game.turn !== 0) {
    return;
  }
  if (!game.players.every((player) => player.discards.length === 0 && player.melds.length === 0)) {
    return;
  }
  clearIntroTimers();
  roundIntro.gameId = game.id;
  roundIntro.phase = "dice1";
  roundIntro.revealed = false;
  roundIntro.dealtTiles = 0;
  roundIntro.shownHands = [0, 0, 0, 0];
  roundIntro.sorting = false;
  roundIntro.sortDone = false;
  runIntroDicePhase(game.openingDice, "庄家掷骰开墙", () => runIntroDealPhase(game));
}

function clearIntroTimers() {
  roundIntro.timers.forEach((timer) => clearTimeout(timer));
  roundIntro.timers = [];
  clearInterval(roundIntro.rollInterval);
  roundIntro.rollInterval = null;
  clearInterval(roundIntro.revealInterval);
  roundIntro.revealInterval = null;
  roundIntro.rolling = false;
}

function clearIntroLayer() {
  if (roundIntro.layer) {
    roundIntro.layer.removeFromParent();
    roundIntro.layer.destroy({ children: true });
    roundIntro.layer = null;
  }
}

function clearIntroFxLayer() {
  if (roundIntro.fxLayer) {
    roundIntro.fxLayer.removeFromParent();
    roundIntro.fxLayer.destroy({ children: true });
    roundIntro.fxLayer = null;
  }
}

// 离开牌桌/桌面重建时清理动画与计时；phase 复位为 idle（新局会重新触发）。
function resetRoundIntro() {
  clearIntroTimers();
  clearIntroLayer();
  clearIntroFxLayer();
  // 杠骰特效同样清理（图层/计时随桌面销毁）；token 保留，防止重进牌桌同一杠重复播放。
  clearGangFxTimers();
  clearGangFxLayer();
  gangFx.releaseDraw = null;
  gangFx.releaseToken = null;
  roundIntro.gameId = null;
  roundIntro.phase = "idle";
  roundIntro.revealed = false;
  roundIntro.dealtTiles = 0;
  roundIntro.shownHands = [0, 0, 0, 0];
  roundIntro.sorting = false;
  roundIntro.sortDone = false;
}

function queueIntroTimer(fn, ms) {
  roundIntro.timers.push(setTimeout(fn, ms));
}

function refreshIntroBase() {
  // 飞入/滑入动画进行中跳过全量重绘：重绘会销毁动画节点造成位置瞬移（"最后一张牌跳动"）。
  // 动画 tick 结束时会自行调用 updateExistingPixiTable 补上这次重绘，倒计时数字最多延迟一个动画时长。
  if (pixiAnim.active > 0) {
    return;
  }
  if (state.view === "table" && state.game && pixiRoot && app.querySelector("#table-canvas")) {
    updateExistingPixiTable(state.game);
  }
}

// 骰子点面布局（3×3 网格归一化坐标）。1 和 4 用红色点，其余黑色。
const DICE_PIPS = {
  1: [[0.5, 0.5]],
  2: [[0.28, 0.28], [0.72, 0.72]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.27, 0.27], [0.73, 0.27], [0.5, 0.5], [0.27, 0.73], [0.73, 0.73]],
  6: [[0.3, 0.25], [0.7, 0.25], [0.3, 0.5], [0.7, 0.5], [0.3, 0.75], [0.7, 0.75]],
};

function drawIntroDie(layer, x, y, size, value, rotation) {
  const die = new Container();
  die.position.set(x, y);
  die.rotation = rotation;
  const face = new Graphics()
    .roundRect(-size / 2, -size / 2, size, size, size * 0.18)
    .fill(0xf8f6ef)
    .stroke({ color: 0x9a917d, width: 1.5 });
  die.addChild(face);
  const pipColor = value === 1 || value === 4 ? 0xd03428 : 0x2d3533;
  const pipR = size * (value === 1 ? 0.13 : 0.085);
  for (const [fx, fy] of DICE_PIPS[value]) {
    die.addChild(new Graphics().circle((fx - 0.5) * size * 0.92, (fy - 0.5) * size * 0.92, pipR).fill(pipColor));
  }
  layer.addChild(die);
  return die;
}

// 遮罩 + 双骰；rolling=true 时随机点面与抖动，模拟滚动。
function buildDiceOverlay(dice, label, rolling) {
  const metrics = roundIntro.metrics;
  if (!pixiTable || !metrics) {
    return;
  }
  clearIntroLayer();
  const layer = new Container();
  roundIntro.layer = layer;
  const { width, height, cx, cy, scale } = metrics;
  layer.addChild(new Graphics().rect(0, 0, width, height).fill({ color: 0x02120e, alpha: 0.55 }));

  const size = 58 * scale;
  const gap = 20 * scale;
  dice.forEach((value, index) => {
    const jitterX = rolling ? (Math.random() - 0.5) * 14 * scale : 0;
    const jitterY = rolling ? (Math.random() - 0.5) * 10 * scale : 0;
    const rotation = rolling ? (Math.random() - 0.5) * 0.9 : 0;
    drawIntroDie(layer, cx + (index === 0 ? -(size / 2 + gap / 2) : size / 2 + gap / 2) + jitterX, cy + jitterY, size, value, rotation);
  });
  addPixiText(layer, label, cx, cy + size * 0.95, 15 * scale, 0xffe18a, true);
  pixiTable.stage.addChild(layer);
}

function runIntroDicePhase(dice, label, next) {
  // 兼容 rollDice 结果对象（{dice:[a,b],total}）与纯数组两种入参，缺失时兜底。
  const faces = Array.isArray(dice) ? dice : Array.isArray(dice?.dice) ? dice.dice : [3, 4];
  roundIntro.rolling = true;
  const randomFaces = () => [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  buildDiceOverlay(randomFaces(), label, true);
  clearInterval(roundIntro.rollInterval);
  roundIntro.rollInterval = setInterval(() => {
    if (roundIntro.rolling) {
      buildDiceOverlay(randomFaces(), label, true);
    }
  }, 90);
  // 滚动 0.95s 后落定到真实点数，再停留 0.4s 进入下一阶段。
  queueIntroTimer(() => {
    roundIntro.rolling = false;
    clearInterval(roundIntro.rollInterval);
    roundIntro.rollInterval = null;
    buildDiceOverlay(faces, label, false);
    queueIntroTimer(next, 400);
  }, 950);
}

// ── 杠牌掷骰特效：画法与开局骰子一致（遮罩 + 双骰 + 文案），但图层/计时独立，
// 挂在 pixiTable.stage（与牌桌 root 平级），重绘不会销毁特效画面。──

function clearGangFxTimers() {
  gangFx.timers.forEach((timer) => clearTimeout(timer));
  gangFx.timers = [];
  clearInterval(gangFx.rollInterval);
  gangFx.rollInterval = null;
  gangFx.rolling = false;
}

function clearGangFxLayer() {
  if (gangFx.layer) {
    gangFx.layer.removeFromParent();
    gangFx.layer.destroy({ children: true });
    gangFx.layer = null;
  }
}

function buildGangDiceOverlay(dice, label, rolling) {
  if (!pixiTable || !roundIntro.metrics) {
    return;
  }
  clearGangFxLayer();
  const layer = new Container();
  gangFx.layer = layer;
  const { width, height, cx, cy, scale } = roundIntro.metrics;
  layer.addChild(new Graphics().rect(0, 0, width, height).fill({ color: 0x02120e, alpha: 0.45 }));
  const size = 58 * scale;
  const gap = 20 * scale;
  dice.forEach((value, index) => {
    const jitterX = rolling ? (Math.random() - 0.5) * 14 * scale : 0;
    const jitterY = rolling ? (Math.random() - 0.5) * 10 * scale : 0;
    const rotation = rolling ? (Math.random() - 0.5) * 0.9 : 0;
    drawIntroDie(layer, cx + (index === 0 ? -(size / 2 + gap / 2) : size / 2 + gap / 2) + jitterX, cy + jitterY, size, value, rotation);
  });
  addPixiText(layer, label, cx, cy + size * 0.95, 15 * scale, 0xffe18a, true);
  pixiTable.stage.addChild(layer);
}

// 杠骰流程：滚动 0.95s → 落定真实点数停 0.4s → 收起画面并回调（放行杠补飞牌）。
function runGangDicePhase(dice, label, next) {
  // 兼容 rollDice 结果对象（{dice:[a,b],total}）与纯数组两种入参，缺失时兜底。
  const faces = Array.isArray(dice) ? dice : Array.isArray(dice?.dice) ? dice.dice : [3, 4];
  clearGangFxTimers();
  gangFx.rolling = true;
  const randomFaces = () => [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  buildGangDiceOverlay(randomFaces(), label, true);
  gangFx.rollInterval = setInterval(() => {
    if (gangFx.rolling) {
      buildGangDiceOverlay(randomFaces(), label, true);
    }
  }, 90);
  gangFx.timers.push(setTimeout(() => {
    gangFx.rolling = false;
    clearInterval(gangFx.rollInterval);
    gangFx.rollInterval = null;
    buildGangDiceOverlay(faces, label, false);
    gangFx.timers.push(setTimeout(() => {
      clearGangFxLayer();
      next?.();
    }, 400));
  }, 950));
}

// 杠条目 → 掷骰画面；落定后放行杠补飞牌（releaseDraw → releaseToken 交给重绘消费）。
function startGangDiceFx(logEntry, game) {
  const seatName = game.players?.[logEntry.seat]?.name ?? "玩家";
  const gangName = logEntry.type === "mingGang" ? "明杠" : logEntry.type === "anGang" ? "暗杠" : "补杠";
  runGangDicePhase(logEntry.dice, `${seatName} ${gangName} · 掷骰`, () => {
    if (gangFx.releaseDraw) {
      gangFx.releaseToken = gangFx.releaseDraw;
      gangFx.releaseDraw = null;
      refreshIntroBase();
    }
  });
}

// 发牌节奏：每批（一次抓 4 张）间隔 320ms；牌背飞行 230ms（批内逐张错开 30ms），
// 落定 250ms 后该批手牌即时亮出、牌墙按【张】消耗。
const DEAL_STEP_MS = 320;
const DEAL_FLY_MS = 230;
const DEAL_FLY_STAGGER = 30;
const DEAL_LAND_MS = 250;

function introHandCount(game, seat) {
  return seat === game.dealerSeat ? 14 : 13;
}

// 手牌区第 index 张（共 count 张）的落点，与 drawPixiHand 正常布局一致。
// 发牌期间始终按最终张数定位，从左到右依次填入，已亮出的牌不位移。
function introHandSlot(seat, index, count, m) {
  const { cx, cy, width, height, laneX, tileW, tileH, smallW, smallH } = m;
  if (seat === 0) {
    const pitch = tileW * 1.08;
    return { x: cx - ((count - 1) * pitch) / 2 + index * pitch, y: height - tileH * 0.62, rotation: 0 };
  }
  const pitch = smallW * 1.08;
  const offset = -((count - 1) * pitch) / 2 + index * pitch;
  const rotation = seatRotation(seat);
  if (seat === 2) {
    return { x: cx + offset, y: smallH * 0.62, rotation };
  }
  if (seat === 1) {
    return { x: width - laneX, y: cy + offset, rotation };
  }
  return { x: laneX, y: cy + offset, rotation };
}

// 发牌：按真实抓牌顺序（每轮每家 4 张 × 3 轮，再每家 1 张，庄家多 1 张），
// 每批牌背从墙头飞到该批手牌落点，落定后即时亮出该批手牌并让牌墙按张消耗；
// 全部抓完后进入本家理牌排序阶段，再掷翻牌骰。
function runIntroDealPhase(game) {
  roundIntro.phase = "deal";
  clearIntroLayer();
  const steps = [];
  for (let round = 0; round < 3; round += 1) {
    for (let offset = 0; offset < 4; offset += 1) {
      steps.push({ seat: (game.dealerSeat + offset) % 4, tiles: 4 });
    }
  }
  for (let offset = 0; offset < 4; offset += 1) {
    steps.push({ seat: (game.dealerSeat + offset) % 4, tiles: 1 });
  }
  steps.push({ seat: game.dealerSeat, tiles: 1 });

  steps.forEach((step, index) => {
    const at = 140 + index * DEAL_STEP_MS;
    // 飞牌：从当前墙头飞向该批手牌即将落入的位置。
    queueIntroTimer(() => {
      const from = roundIntro.wallHead ?? { x: roundIntro.metrics?.cx ?? 0, y: roundIntro.metrics?.cy ?? 0, rotation: 0 };
      const base = roundIntro.shownHands[step.seat];
      const count = introHandCount(game, step.seat);
      const m = roundIntro.metrics;
      if (!m) {
        return;
      }
      for (let k = 0; k < step.tiles; k += 1) {
        flyIntroTile(from, introHandSlot(step.seat, base + k, count, m), seatRotation(step.seat), DEAL_FLY_MS + k * DEAL_FLY_STAGGER);
      }
    }, at);
    // 落定：亮出该批手牌，牌墙按张消耗（奇数时墙头墩只画底层）。
    queueIntroTimer(() => {
      roundIntro.shownHands[step.seat] += step.tiles;
      roundIntro.dealtTiles += step.tiles;
      refreshIntroBase();
    }, at + DEAL_LAND_MS);
  });

  const dealDone = 140 + (steps.length - 1) * DEAL_STEP_MS + DEAL_LAND_MS;
  // 发牌完直接掷骰翻牌；手牌理牌挪到翻牌揭晓之后（翻牌前排序会让赖子提前归左、暴露身份）。
  queueIntroTimer(() => {
    runIntroDicePhase(game.laiziDice, "庄家掷骰翻牌", () => runIntroFlipPhase(game));
  }, dealDone + 140);
}

// 本家手牌滑动动画（fromTiles 顺序 → toTiles 顺序），滑动期间由 fx 层接管绘制。
// 只在翻牌揭晓后调用（起始理牌）：赖子带着金框滑到最左。
function slideIntroHand(game, fromTiles, toTiles, duration, done) {
  const metrics = roundIntro.metrics;
  const count = fromTiles.length;
  if (!pixiTable || !metrics) {
    done();
    return;
  }
  // 稳定匹配：当前顺序的第 i 张 → 目标位置（同值牌按先后对应）。
  const used = new Array(toTiles.length).fill(false);
  const targetOf = fromTiles.map((tile) => {
    let target = -1;
    for (let j = 0; j < toTiles.length; j += 1) {
      if (!used[j] && toTiles[j] === tile) {
        target = j;
        break;
      }
    }
    if (target < 0) {
      target = toTiles.length - 1;
    }
    used[target] = true;
    return target;
  });

  if (!roundIntro.fxLayer) {
    roundIntro.fxLayer = new Container();
    pixiTable.stage.addChild(roundIntro.fxLayer);
  }
  const { tileW, tileH, scale } = metrics;
  // 翻牌前理牌动画不标赖（赖子身份由翻牌骰决定）。
  const revealLaizi = laiziPublic(game);
  const nodes = fromTiles.map((tile, index) => {
    const slot = introHandSlot(0, index, count, metrics);
    return drawPixiTile(roundIntro.fxLayer, tile, slot.x, slot.y, tileW, tileH, 0, revealLaizi && tile === game.laiziTile, false, !tile, scale);
  });

  let elapsed = 0;
  const tick = (ticker) => {
    const alive = nodes.some((node) => !node.destroyed && node.parent);
    if (!alive) {
      pixiTable?.ticker?.remove(tick);
      return;
    }
    elapsed += ticker.deltaMS;
    const t = Math.min(1, elapsed / duration);
    const ease = 1 - (1 - t) ** 3;
    nodes.forEach((node, index) => {
      if (node.destroyed || !node.parent) {
        return;
      }
      const from = introHandSlot(0, index, count, metrics);
      const to = introHandSlot(0, targetOf[index], count, metrics);
      // 滑向目标位，途中微微上抬划出小弧线。
      node.position.set(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease - Math.sin(t * Math.PI) * 6 * scale);
    });
    if (t >= 1) {
      pixiTable?.ticker?.remove(tick);
      roundIntro.sorting = false;
      roundIntro.sortDone = true;
      clearIntroFxLayer();
      refreshIntroBase();
      done();
    }
  };
  pixiTable.ticker.add(tick);
}

// 起始理牌（翻牌揭晓后）：本家手牌从抓牌顺序一次性滑到真实排序，赖子带着金框滑到最左，
// 随后收尾进入正常对局。翻牌前不排序——抓牌顺序不会暴露赖子位置。
// 联机模式下若服务端尚未下发赖子（理论兜底），无 Pixi 环境时直接放行，不影响对局。
function runIntroReSortPhase(game, next) {
  const player = game.players[0];
  if (!pixiTable || !roundIntro.metrics || !player) {
    roundIntro.sortDone = true;
    next();
    return;
  }
  roundIntro.sorting = true;
  roundIntro.sortDone = false;
  const from = player.initialHand ?? sortTiles(player.hand, null);
  slideIntroHand(game, from, player.hand, 430, () => queueIntroTimer(next, 120));
}

// 牌背从墙头飞到目标位置的短动画（画在 fxLayer，结束自毁）。
function flyIntroTile(from, target, targetRotation, duration) {
  const metrics = roundIntro.metrics;
  if (!pixiTable || !metrics) {
    return;
  }
  if (!roundIntro.fxLayer) {
    roundIntro.fxLayer = new Container();
    pixiTable.stage.addChild(roundIntro.fxLayer);
  }
  const { smallW, smallH, scale } = metrics;
  const node = drawPixiTile(roundIntro.fxLayer, null, from.x, from.y, smallW, smallH, from.rotation ?? 0, false, false, true, scale);
  const rotationDelta = normalizeAngle(targetRotation - (from.rotation ?? 0));
  let elapsed = 0;
  const tick = (ticker) => {
    if (node.destroyed || !node.parent) {
      pixiTable?.ticker?.remove(tick);
      return;
    }
    elapsed += ticker.deltaMS;
    const t = Math.min(1, elapsed / duration);
    const ease = 1 - (1 - t) ** 3;
    node.position.set(from.x + (target.x - from.x) * ease, from.y + (target.y - from.y) * ease);
    node.rotation = (from.rotation ?? 0) + rotationDelta * ease;
    if (t >= 1) {
      pixiTable?.ticker?.remove(tick);
      node.destroy();
    }
  };
  pixiTable.ticker.add(tick);
}

// 翻开指示牌：从牌墙对应墩位弹出（缩放 + 金框），播完后收尾进入正常对局。
// 联机保密期内服务器尚未下发指示牌牌面（indicatorTile 为 null），此时不能翻出空白牌——
// 先轮询等待赖子公开，到手后再播放翻开动画，保证翻开瞬间即亮牌面。
function runIntroFlipPhase(game) {
  roundIntro.phase = "flip";
  clearIntroLayer();
  refreshIntroBase();
  if (!laiziPublic(game)) {
    waitForIntroReveal();
    return;
  }
  playIntroFlipReveal();
}

// 保密期兜底：轮询 state.game（必须取最新引用，闭包里的旧 game 的 indicatorTile 永远是 null），
// 赖子一到手就用最新数据继续翻牌；阶段被打断（离开牌桌/断线重连）则静默退出。
function waitForIntroReveal() {
  clearInterval(roundIntro.revealInterval);
  roundIntro.revealInterval = setInterval(() => {
    if (roundIntro.phase !== "flip" || !pixiTable) {
      clearInterval(roundIntro.revealInterval);
      roundIntro.revealInterval = null;
      return;
    }
    const latest = state.game;
    if (latest && latest.id === roundIntro.gameId && laiziPublic(latest)) {
      clearInterval(roundIntro.revealInterval);
      roundIntro.revealInterval = null;
      playIntroFlipReveal();
    }
  }, 80);
}

// 翻开动画本体：指示牌弹出（缩放 + 金框）→ 短暂停留 → 手牌从抓牌顺序滑到真实排序 → 收尾进对局。
function playIntroFlipReveal() {
  const game = state.game;
  const metrics = roundIntro.metrics;
  const target = roundIntro.indicatorPos;
  if (!game || !pixiTable || !metrics || !target) {
    finishRoundIntro();
    return;
  }
  // 指示牌从这一刻开始翻出：横幅翻/赖角标与手牌金框同步亮出真值（不能更早）。
  roundIntro.revealed = true;
  render();
  if (!roundIntro.fxLayer) {
    roundIntro.fxLayer = new Container();
    pixiTable.stage.addChild(roundIntro.fxLayer);
  }
  const { smallW, smallH, scale } = metrics;
  const node = drawPixiTile(roundIntro.fxLayer, game.indicatorTile, target.x, target.y, smallW, smallH, target.rotation, game.indicatorTile === game.laiziTile, true, false, scale);
  node.scale.set(0.15);
  let elapsed = 0;
  const duration = 420;
  const tick = (ticker) => {
    if (node.destroyed || !node.parent) {
      pixiTable?.ticker?.remove(tick);
      return;
    }
    elapsed += ticker.deltaMS;
    const t = Math.min(1, elapsed / duration);
    const ease = 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2; // 回弹
    node.scale.set(0.15 + (1 - 0.15) * ease);
    if (t >= 1) {
      pixiTable?.ticker?.remove(tick);
      // 指示牌已翻开，赖子身份公开：先把赖子滑到最左（起始理牌）再收尾进对局。
      queueIntroTimer(() => runIntroReSortPhase(state.game, finishRoundIntro), 250);
    }
  };
  pixiTable.ticker.add(tick);
}

// 开局动画结束：清掉动画层，整桌重绘恢复真实状态，机器人与倒计时随之启动。
function finishRoundIntro() {
  clearIntroTimers();
  clearIntroLayer();
  clearIntroFxLayer();
  roundIntro.phase = "done";
  render();
}

// ── 出牌倒计时 ──

function clearDiscardClock() {
  clearInterval(discardClock.timer);
  discardClock.timer = null;
  discardClock.token = null;
  discardClock.deadline = 0;
}

function currentDiscardCountdown() {
  if (!discardClock.token) {
    return null;
  }
  return Math.max(0, Math.ceil((discardClock.deadline - Date.now()) / 1000));
}

// 轮到我出牌（且开局动画已结束）时启动 20s 倒计时；超时自动打出最右侧一张。
// 以 局id:turn 为令牌，同一回合重复 render 不会重置倒计时。
function updateDiscardClock() {
  const game = state.game;
  const active = Boolean(
    game && canHumanDiscard() && !roundIntroActive() && state.view === "table",
  );
  if (!active) {
    clearDiscardClock();
    return;
  }
  const token = `${game.id}:${game.turn}`;
  if (discardClock.token === token) {
    return;
  }
  clearDiscardClock();
  discardClock.token = token;
  discardClock.deadline = Date.now() + DISCARD_TIME_LIMIT * 1000;
  discardClock.timer = setInterval(() => {
    if (!canHumanDiscard() || state.view !== "table") {
      clearDiscardClock();
      return;
    }
    const remain = currentDiscardCountdown();
    if (remain <= 0) {
      clearDiscardClock();
      const hand = state.game.players[0].hand;
      // 附带牌值：联机时服务器按牌值定位数据层索引，避免视图序错位打错牌。
      triggerPixiAction("discard", { handIndex: hand.length - 1, tile: hand[hand.length - 1] });
      return;
    }
    refreshIntroBase();
  }, 500);
}

// 别家打出我可碰/可杠的牌时，我进入反应决策（碰/过）。
function canHumanReact() {
  const game = state.game;
  return Boolean(
    game?.status === "playing" &&
    game.phase === "reaction" &&
    getPengOptions(game, 0).length > 0
  );
}

function clearReactionClock() {
  clearInterval(reactionClock.timer);
  reactionClock.timer = null;
  reactionClock.token = null;
  reactionClock.deadline = 0;
}

function currentReactionCountdown() {
  if (!reactionClock.token) {
    return null;
  }
  return Math.max(0, Math.ceil((reactionClock.deadline - Date.now()) / 1000));
}

// 与出牌倒计时同一套交互：20s 内未点碰/过则自动过；令牌取最后一张弃牌，同一反应不重置。
function updateReactionClock() {
  const game = state.game;
  const active = Boolean(
    game && canHumanReact() && !roundIntroActive() && state.view === "table",
  );
  if (!active) {
    clearReactionClock();
    return;
  }
  const d = game.lastDiscard;
  const token = `${game.id}:R:${d.seat}:${d.tile}:${d.discardIndex}`;
  if (reactionClock.token === token) {
    return;
  }
  clearReactionClock();
  reactionClock.token = token;
  reactionClock.deadline = Date.now() + REACTION_TIME_LIMIT * 1000;
  reactionClock.timer = setInterval(() => {
    if (!canHumanReact() || state.view !== "table") {
      clearReactionClock();
      return;
    }
    const remain = currentReactionCountdown();
    if (remain <= 0) {
      clearReactionClock();
      autoPassReaction();
      return;
    }
    refreshIntroBase();
  }, 500);
}

function autoPassReaction() {
  if (isOnlineMode()) {
    sendOnline("action", { action: "pass" });
    render();
    return;
  }
  try {
    state.game = skipReactions(state.game);
  } catch (error) {
    console.error(error);
  }
  render();
}

// 弃牌区：四家弃牌都围绕中心罗盘摆放（在牌墙圈内侧），各自朝向本方座位，
// 我=罗盘下方横排，对家=上方横排，右家=右侧纵列，左家=左侧纵列，每 6 张换行/列，由中心向外生长。
function drawPixiDiscards(root, tiles, seat, layout) {
  const { cx, cy, laiziTile, scale, discardW, discardH, discardGapX, discardGapY, discardPerLine, discardStart } = layout;
  const rotation = seatRotation(seat);
  tiles.forEach((tile, index) => {
    const line = Math.floor(index / discardPerLine);
    const k = index % discardPerLine;
    const along = (k - (discardPerLine - 1) / 2) * discardGapX;
    let x;
    let y;
    if (seat === 0) {
      x = cx + along;
      y = cy + discardStart + line * discardGapY;
    } else if (seat === 2) {
      x = cx - along;
      y = cy - discardStart - line * discardGapY;
    } else if (seat === 1) {
      x = cx + discardStart + line * discardGapY;
      y = cy - along;
    } else {
      x = cx - discardStart - line * discardGapY;
      y = cy + along;
    }
    drawPixiTile(root, tile, x, y, discardW, discardH, rotation, tile === laiziTile, false, false, scale);
  });
}

// 碰/杠牌区：我在右下角，对家在手牌下方居中，左家/右家在手牌列的上下侧。
// 碰牌按来源方位横放标记牌：上家→首张横（横竖竖），对家→全竖（竖竖竖），下家→末张横（竖竖横）。
function drawPixiMelds(root, melds, seat, layout) {
  if (!melds.length) {
    return;
  }
  const { cx, cy, laneX, width, height, tileW, tileH, smallW, smallH, handCount, laiziTile, scale } = layout;
  const rotation = seatRotation(seat);
  // 碰/杠牌与正常牌同大：我与手牌同尺寸，其余三家与各自手牌同尺寸。
  const meldW = seat === 0 ? tileW : smallW;
  const meldH = seat === 0 ? tileH : smallH;
  const tileGap = meldW * 0.08;
  const groupGap = 10 * scale;
  const handSpan = handCount * smallW * 1.08;

  // 碰牌来源对应的横放位置：横放牌要指向来源方位（上家横在靠上家一端，下家横在靠下家一端）。
  // 注意座位 0/2 的牌组沿水平排（索引 0 分别在右端/左端），座位 1/3 沿竖直排，索引方向不同。
  const markerIndex = (meld) => {
    if (meld.type !== "peng" || meld.fromSeat == null) {
      return -1;
    }
    const rel = (meld.fromSeat - seat + 4) % 4;
    const last = meld.tiles.length - 1;
    if (rel === 3) return seat % 2 === 0 ? last : 0; // 上家
    if (rel === 1) return seat % 2 === 0 ? 0 : last; // 下家
    return -1; // 对家：全竖
  };
  // 每张牌沿排放方向占的宽度：横放的标记牌占 meldH，其余占 meldW。
  const extentsOf = (meld) => meld.tiles.map((_, index) => (index === markerIndex(meld) ? meldH : meldW));
  const groupLen = (meld) => {
    const extents = extentsOf(meld);
    return extents.reduce((sum, extent) => sum + extent, 0) + tileGap * (extents.length - 1);
  };
  const totalLen = melds.reduce((sum, meld) => sum + groupLen(meld), 0) + groupGap * (melds.length - 1);

  let cursor = 0;
  melds.forEach((meld) => {
    const extents = extentsOf(meld);
    const marker = markerIndex(meld);
    let offset = cursor;
    meld.tiles.forEach((tile, index) => {
      const center = offset + extents[index] / 2;
      offset += extents[index] + tileGap;
      const sideways = index === marker;
      let x;
      let y;
      if (seat === 0) {
        // 下家信息牌已移到右边缘居中，右下角空出：碰杠区贴右缘排布。
        // 手牌加大后同排会重叠：上移到手牌上方一行，仍靠右（左侧是我的信息面板）。
        x = width - 44 * scale - center;
        y = height - meldH * 0.62 - tileH * 1.18;
      } else if (seat === 2) {
        x = cx - totalLen / 2 + center;
        y = smallH * 1.72;
      } else if (seat === 1) {
        x = width - laneX;
        y = cy - handSpan / 2 - 12 * scale - center;
      } else {
        x = laneX;
        y = cy + handSpan / 2 + 12 * scale + center;
      }
      drawPixiTile(root, tile, x, y, meldW, meldH, rotation + (sideways ? Math.PI / 2 : 0), tile === laiziTile, false, false, scale);
    });
    cursor += groupLen(meld) + groupGap;
  });
}

function drawPixiTile(root, tile, x, y, width, height, rotation, isLaizi, drawn, back, scale, highlight = false) {
  const node = new Container();
  node.position.set(x, y + (drawn ? -10 * scale : 0));
  node.rotation = rotation;
  const framed = drawn || highlight;
  // 优先用预生成的牌面图片（含牌背）；纹理缺失时回退到文字画法。
  const texture = back || !tile ? tileTextures.get("back") : tileTextures.get(tile);
  if (texture) {
    const sprite = new Sprite(texture);
    sprite.width = width;
    sprite.height = height;
    sprite.position.set(-width / 2, -height / 2);
    node.addChild(sprite);
    if (framed) {
      node.addChild(new Graphics().roundRect(-width / 2, -height / 2, width, height, 5 * scale).stroke({ color: 0xffd85b, width: 2.5 }));
    }
  } else {
    const face = new Graphics().roundRect(-width / 2, -height / 2, width, height, 5 * scale).fill(back ? 0x31706a : highlight ? 0xfdf3d0 : 0xf5edda).stroke({ color: framed ? 0xffd85b : 0xb9b18f, width: framed ? 2.5 : 1.5 });
    node.addChild(face);
    if (tile && !back) {
      const text = addPixiText(node, tileLabel(tile), 0, 0, Math.max(10, width * 0.36), tileClass(tile) === "wan" ? 0xa3322c : tileClass(tile) === "tiao" ? 0x176c4d : tileClass(tile) === "tong" ? 0x28619a : 0x2d3533, true);
      text.anchor.set(0.5);
    }
  }
  if (isLaizi) {
    // 赖子标记：右上角大号红点（描金边），点内写“赖”字，压在牌角上更醒目。
    const markR = Math.max(6.5 * scale, width * 0.26);
    const markX = width / 2 - markR * 0.45;
    const markY = -height / 2 + markR * 0.45;
    const laiziMark = new Graphics()
      .circle(markX, markY, markR)
      .fill(0xd03428)
      .stroke({ color: 0xffd85b, width: Math.max(1, 1.4 * scale) });
    node.addChild(laiziMark);
    addPixiText(node, "赖", markX, markY, markR * 1.12, 0xffffff, true);
  }
  root.addChild(node);
  return node;
}

function addPixiText(parent, value, x, y, size, color, bold = false, rotation = 0) {
  const text = new Text({ text: value, style: { fontFamily: "Arial, sans-serif", fontSize: size, fill: color, fontWeight: bold ? "700" : "400" } });
  text.anchor.set(0.5);
  text.position.set(x, y);
  text.rotation = rotation;
  parent.addChild(text);
  return text;
}

// 点牌但当前不可出牌时的轻提示（1.2 秒淡出），避免"点了没反应"的困惑。
function showTileToast(message) {
  let el = document.getElementById("tile-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "tile-toast";
    el.style.cssText =
      "position:fixed;left:50%;bottom:24%;transform:translateX(-50%);" +
      "background:rgba(20,20,28,.82);color:#fff;padding:8px 18px;border-radius:20px;" +
      "font-size:14px;z-index:60;pointer-events:none;transition:opacity .25s;opacity:0;";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = "1";
  clearTimeout(showTileToast._timer);
  showTileToast._timer = setTimeout(() => {
    el.style.opacity = "0";
  }, 1200);
}

function triggerPixiAction(action, payload = {}) {
  if (action === "discard") {
    if (canHumanDiscard()) {
      if (isOnlineMode()) {
        sendOnline("action", { action, payload });
      } else {
        state.game = discardTile(state.game, 0, payload.handIndex);
      }
      render();
    } else if (state.game?.status === "playing" && state.game.phase === "reaction") {
      // 有人打出牌等我选择时，先处理碰/杠/过。
      showTileToast("请先选择 碰 / 杠 / 过");
    } else if (state.game?.status === "playing") {
      showTileToast("还没轮到你出牌");
    }
  }
}

function renderWall(wallCount) {
  // Keep the visual wall continuous even late in a round; the center counter remains authoritative.
  const visibleStacks = Math.min(72, Math.max(40, Math.ceil(wallCount / 1.5)));
  const sides = distributeCount(visibleStacks, 4);

  return `
    <div class="wall-visual" aria-label="牌墙剩余 ${wallCount} 张">
      <div class="wall-side wall-top">${renderWallBlocks(sides[0])}</div>
      <div class="wall-side wall-right">${renderWallBlocks(sides[1])}</div>
      <div class="wall-side wall-bottom">${renderWallBlocks(sides[2])}</div>
      <div class="wall-side wall-left">${renderWallBlocks(sides[3])}</div>
      <div class="wall-core">
        <strong>牌墙</strong>
        <span>${wallCount}</span>
        <small>剩余</small>
      </div>
    </div>
  `;
}

function renderWallBlocks(count) {
  return Array.from({ length: count }, () => `<span class="wall-block"></span>`).join("");
}

function distributeCount(total, parts) {
  return Array.from({ length: parts }, (_, index) =>
    Math.floor(total / parts) + (index < total % parts ? 1 : 0),
  );
}

function renderHand(hand, laiziTile, interactive = true, highlightTile = null) {
  let highlighted = false;

  return `
    <div class="hand">
      ${hand
        .map((tile, index) => {
          const isDrawn = highlightTile === tile && !highlighted;
          if (isDrawn) {
            highlighted = true;
          }

          return interactive
            ? `
            <button class="tile-button" data-action="discard" data-index="${index}" aria-label="${tileLabel(tile)}">
              ${renderTile(tile, false, tile === laiziTile, isDrawn)}
            </button>
          `
            : renderTile(tile, false, tile === laiziTile, isDrawn);
        })
        .join("")}
    </div>
  `;
}

function renderReadOnlyHand(hand, laiziTile) {
  return `
    <div class="hand">
      ${hand.map((tile) => renderTile(tile, false, tile === laiziTile)).join("")}
    </div>
  `;
}

function renderMelds(melds = [], laiziTile) {
  if (!melds.length) {
    return "";
  }

  return melds
    .map(
      (meld) => `
        <div class="meld-group ${meld.type}">
          ${meld.tiles.map((tile) => renderTile(tile, true, tile === laiziTile)).join("")}
        </div>
      `,
    )
    .join("");
}

function renderBackHand(count) {
  return `
    <div class="hand">
      ${Array.from({ length: Math.min(count, 14) }, () => `<span class="tile back"></span>`).join("")}
    </div>
  `;
}

function renderTile(tile, small = false, isLaizi = false, isDrawn = false) {
  // 与牌桌一致使用预生成的牌面图片（assets/tiles/，文件名 = 牌编码）；
  // 外层 .tile 保留象牙底、圆角、阴影与赖标记，图片铺满内容区。
  return `<span class="tile ${small ? "small" : ""} ${isLaizi ? "laizi" : ""} ${isDrawn ? "drawn" : ""}"><img class="tile-face" src="assets/tiles/${tile}.png" alt="${tileLabel(tile)}" draggable="false"></span>`;
}

function renderControls() {
  const game = state.game;
  if (game.status !== "ended" && roundIntroActive()) {
    return `<span class="badge">开局发牌中…</span>`;
  }
  if (game.status === "ended") {
    return `
      <button class="gold" data-action="next-round">下一局</button>
      <button class="secondary" data-action="back">大厅</button>
    `;
  }
  if (game.phase === "reaction" && getPengOptions(game, 0).length > 0) {
    // 手里有 3 张同牌时可明杠：杠别人打出的第 4 张。
    const canMingGang = getMingGangOptions(game, 0).length > 0;
    return `
      ${canMingGang ? `<button class="gold" data-action="gang">杠</button>` : ""}
      <button class="gold" data-action="peng">碰</button>
      <button class="secondary" data-action="pass">过</button>
    `;
  }
  if (game.currentSeat !== 0) {
    return `<span class="badge">等待 ${game.players[game.currentSeat].name}</span>`;
  }
  if (game.phase === "draw") {
    return `<span class="badge">自动摸牌中</span>`;
  }

  const winButton = game.availableWin?.seat === 0
    ? `<button class="gold" data-action="win">${winTypeLabel(game.availableWin.winType)}</button>`
    : "";
  // 暗杠（手里 4 张）与补杠（碰过后再拿到第 4 张）都以"杠"按钮出现在自己回合。
  const gangButtons = [
    ...getAnGangOptions(game, 0).map((tile) => ({ tile, kind: "an" })),
    ...getBuGangOptions(game, 0).map((tile) => ({ tile, kind: "bu" })),
  ]
    .map(
      ({ tile, kind }) =>
        `<button class="secondary" data-action="gang" data-kind="${kind}" data-tile="${tile}">${kind === "bu" ? "补杠" : "杠"} ${tileLabel(tile)}</button>`,
    )
    .join("");

  return `${winButton}${gangButtons}<span class="badge">选牌打出</span>`;
}

function renderSettlement() {
  const game = state.game;
  const winner = game.players[game.winnerSeat];
  if (!winner) {
    return `
      <div class="settlement">
        <h2>荒庄</h2>
        <div class="ledger-row"><span>下局庄家</span><strong>${game.players[game.nextDealerSeat].name}</strong></div>
        ${renderRevealedHands(game)}
      </div>
    `;
  }

  // 胡牌构成（如"弯杠 · 对对胡 · 风箭×1"）：只展示牌型名称，子数不外显。
  const winBonuses = game.settlement?.winDetail?.bonuses ?? [];
  const bonusLine = winBonuses.length
    ? `<p class="status-text">${winBonuses.map((bonus) => bonus.label).join(" · ")}</p>`
    : "";

  return `
    <div class="settlement">
      <h2>${winner.name} ${winTypeLabel(game.winType)}</h2>
      ${bonusLine}
      ${game.settlement.deltas
        .map(
          (delta, seat) => `
            <div class="ledger-row">
              <span>${game.players[seat].name}</span>
              <strong>${delta > 0 ? "+" : ""}${delta}</strong>
            </div>
          `,
        )
        .join("")}
      ${renderRevealedHands(game)}
    </div>
  `;
}

function renderRevealedHands(game) {
  return `
    <div class="revealed-hands">
      ${game.players
        .map(
          (player) => `
            <div class="revealed-player">
              <strong>${player.name}${player.seat === game.dealerSeat ? " 庄" : ""}</strong>
              <div class="revealed-tiles">
                ${player.melds
                  .map(
                    (meld) => `
                      <div class="revealed-meld">
                        ${meld.tiles.map((tile) => renderTile(tile, true, tile === game.laiziTile)).join("")}
                      </div>
                    `,
                  )
                  .join("")}
                ${player.hand.map((tile) => renderTile(tile, true, tile === game.laiziTile)).join("")}
              </div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function bindLobby() {
  app.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      captureNickname();
      if (action === "toggle-lack") {
        state.mustLackOneSuit = !state.mustLackOneSuit;
      }
      if (action === "show-config") {
        state.lobbyTab = "config";
      }
      if (action === "multiplier") {
        const value = Number(button.dataset.value);
        if (Number.isFinite(value) && value > 0) {
          state.ruleConfig.multiplier = Math.floor(value);
        }
      }
      if (action === "rule-toggle") {
        const key = button.dataset.rule;
        if (key in DEFAULT_RULE_CONFIG.rules) {
          state.ruleConfig.rules[key] = !state.ruleConfig.rules[key];
        }
      }
      if (action === "config-create") {
        // 确认创建：单机直接建房（快照当前规则），联机把规则发给服务器开房。
        if (isOnlineMode()) {
          onlineCreateRoom();
        } else {
          createRoom();
          state.lobbyTab = "game";
        }
      }
      if (action === "create-room") {
        createRoom();
      }
      if (action === "quick-start") {
        // 快速开始：联机走服务端快速加入（优先补位空房间，否则自动建房）；
        // 单机直接创建带电脑的房间并开局。
        if (isOnlineMode()) {
          onlineQuickJoin();
        } else {
          createRoom();
          startGame();
        }
      }
      if (action === "show-join") {
        state.lobbyTab = "join";
      }
      if (action === "tab-game") {
        state.lobbyTab = "game";
      }
      if (action === "tab-records") {
        state.lobbyTab = "records";
      }
      if (action === "tab-settings") {
        state.lobbyTab = "settings";
      }
      if (action === "join-room") {
        const input = app.querySelector("#roomCode");
        createRoom((input.value || randomRoomCode()).toUpperCase());
      }
      if (action === "leave") {
        state.room = null;
      }
      if (action === "start") {
        startGame();
      }
      if (action === "online-create") {
        onlineCreateRoom();
      }
      if (action === "online-join") {
        const input = app.querySelector("#roomCode");
        onlineJoinRoom((input.value || initialParams.get("room") || "").toUpperCase());
      }
      if (action === "show-auth") {
        state.auth.panelOpen = true;
        state.auth.error = "";
      }
      if (action === "auth-close") {
        state.auth.panelOpen = false;
        state.auth.error = "";
      }
      if (action === "auth-switch") {
        // 登录/注册面板切换：清错误提示。
        state.auth.mode = state.auth.mode === "register" ? "login" : "register";
        state.auth.error = "";
      }
      if (action === "auth-submit") {
        submitAuth();
      }
      if (action === "logout") {
        if (isOnlineMode()) {
          sendOnline("logout");
        }
        state.auth.user = null;
        state.auth.token = null;
        state.auth.panelOpen = false;
        saveAuthSession(null);
        // 退回游客：恢复随机昵称，避免沿用账号昵称。
        state.nickname = `玩家${Math.floor(1000 + Math.random() * 9000)}`;
      }
      if (action === "online-start") {
        sendOnline("startGame");
      }
      if (action === "online-leave") {
        sendOnline("leaveRoom");
      }
      if (action === "online-dissolve") {
        if (window.confirm("确定解散房间？所有玩家将返回大厅。")) {
          sendOnline("dissolveRoom");
        }
      }
      if (action === "copy-invite") {
        copyInviteLink();
      }
      render();
    });
  });
}

function bindTable() {
  app.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      try {
        if (action === "back") {
          // 左上角"大厅"按钮 = 离开当前牌局/房间：通知服务器清座
          //（对局中该座位由托管代打，牌局不卡死），本地立即回大厅。
          // 服务器随后不再向本客户端广播，因此不会被 roomState 强行拉回牌桌。
          if (isOnlineMode()) {
            const leavingRoomCode = state.online.room?.code ?? state.room?.code;
            sendOnline("leaveRoom");
            stopOnlineReconnect();
            clearOnlineToken(leavingRoomCode);
            state.online.room = null;
            state.online.lobbyIntent = false;
            state.room = null;
            state.game = null;
            state.lobbyTab = "game";
            state.view = "lobby";
            if (window.location.search.includes("room=")) {
              window.history.replaceState(null, "", "/apps/mobile/?online=1");
            }
            render();
            return;
          }
          state.view = "lobby";
          render();
          return;
        }

        if (isOnlineMode()) {
          if (action === "discard" && canHumanDiscard()) {
            sendOnline("action", {
              action: "discard",
              payload: {
                handIndex: Number(button.dataset.index),
                tile: button.dataset.tile ?? undefined,
              },
            });
          }
          if (action === "peng") {
            sendOnline("action", { action: "peng" });
          }
          if (action === "pass") {
            sendOnline("action", { action: "pass" });
          }
          if (action === "gang") {
            sendOnline("action", {
              action: "gang",
              payload: { tile: button.dataset.tile, kind: button.dataset.kind },
            });
          }
          if (action === "win") {
            sendOnline("action", { action: "win" });
          }
          if (action === "next-round") {
            sendOnline("startGame");
          }
          render();
          return;
        }
        if (action === "draw") {
          state.game = drawForCurrentSeat(state.game);
        }
        if (action === "discard" && canHumanDiscard()) {
          state.game = discardTile(state.game, 0, Number(button.dataset.index));
        }
        if (action === "peng") {
          state.game = pengDiscard(state.game, 0);
        }
        if (action === "pass") {
          // 过：真人放弃后，其余机器人仍按座位顺序决策碰/杠，无人响应才跳过。
          state.game = resolveBotReactions(state.game);
        }
        if (action === "gang" && state.game.phase === "reaction") {
          // 明杠：杠别人打出的第 4 张（牌由引擎取 lastDiscard）。
          state.game = mingGangDiscard(state.game, 0);
        } else if (action === "gang") {
          // 出牌阶段的杠按按钮 kind 分派：补杠升级碰组、暗杠凑四张（此前补杠误走暗杠被拒）。
          state.game = button.dataset.kind === "bu"
            ? buGang(state.game, 0, button.dataset.tile)
            : anGang(state.game, 0, button.dataset.tile);
        }
        if (action === "win") {
          state.game = finishWin(state.game, 0);
          syncHumanBeans("牌局结算");
        }
        if (action === "next-round") {
          nextRound();
        }
      } catch (error) {
        console.error(error);
      }
      render();
    });
  });
}

function createRoom(code = randomRoomCode()) {
  const dealerDice = rollDice();
  state.room = {
    code,
    rounds: 4,
    currentRound: 1,
    mustLackOneSuit: state.mustLackOneSuit,
    ruleConfig: normalizeRuleConfig(state.ruleConfig),
    dealerSeat: (dealerDice.total - 1) % 4,
    dealerDice,
  };
}

function startGame() {
  const names = ["我", ...botNames];
  state.game = startRound({
    dealerSeat: state.room.dealerSeat,
    seed: `${state.room.code}-${state.room.currentRound}-${Date.now()}`,
    playerNames: names,
    beanBalances: [state.beans, 1000, 1000, 1000],
    mustLackOneSuit: state.room.mustLackOneSuit,
    ruleConfig: state.room.ruleConfig,
  });
  state.view = "table";
}

function nextRound() {
  const previousGame = state.game;
  const names = previousGame.players.map((player) => player.name);
  state.room.currentRound += 1;
  state.room.dealerSeat = previousGame.nextDealerSeat;
  state.game = startRound({
    dealerSeat: previousGame.nextDealerSeat,
    seed: `${state.room.code}-${state.room.currentRound}-${Date.now()}`,
    playerNames: names,
    beanBalances: previousGame.players.map((player) => player.beans),
    mustLackOneSuit: state.room.mustLackOneSuit,
    ruleConfig: state.room.ruleConfig,
  });
}

// ---- 联机断线重连 ----
// 座位 token 存 sessionStorage（每个 tab 独立，刷新不丢、互不干扰）。
const onlineReconnect = { attempt: 0, timer: null };
const ONLINE_RECONNECT_MAX_ATTEMPTS = 5;

function readOnlineToken(roomCode) {
  if (!roomCode) {
    return null;
  }
  try {
    return window.sessionStorage.getItem(`qy-online-token-${roomCode}`);
  } catch {
    return null;
  }
}

function saveOnlineToken(roomCode, token) {
  if (!roomCode || !token) {
    return;
  }
  try {
    window.sessionStorage.setItem(`qy-online-token-${roomCode}`, token);
  } catch {
    /* 隐私模式等场景不可用：静默退化（无自动重连） */
  }
}

function clearOnlineToken(roomCode) {
  if (!roomCode) {
    return;
  }
  try {
    window.sessionStorage.removeItem(`qy-online-token-${roomCode}`);
  } catch {
    /* 同上 */
  }
}

function stopOnlineReconnect() {
  if (onlineReconnect.timer) {
    clearTimeout(onlineReconnect.timer);
    onlineReconnect.timer = null;
  }
}

// 指数退避自动重连：1s→2s→4s→8s→16s，最多 5 次；
// 期间服务器保留座位（对局中由电脑托管代打）。
function scheduleOnlineReconnect() {
  const roomCode = state.online.room?.code ?? state.room?.code;
  const token = readOnlineToken(roomCode);
  if (!roomCode || !token || state.online.connected) {
    return;
  }
  if (onlineReconnect.attempt >= ONLINE_RECONNECT_MAX_ATTEMPTS) {
    return;
  }
  stopOnlineReconnect();
  const delay = Math.min(16000, 1000 * 2 ** onlineReconnect.attempt);
  onlineReconnect.timer = setTimeout(() => {
    onlineReconnect.timer = null;
    if (socket?.readyState === WebSocket.OPEN) {
      sendOnline("reconnect", { roomCode, token });
      return;
    }
    connectOnline(() => {
      sendOnline("reconnect", { roomCode, token });
    });
  }, delay);
  onlineReconnect.attempt += 1;
  render();
}

// 断线横幅：房间还在且连接断开时提示（重连中/重连失败座位保留）。
function onlineDisconnectBannerHtml() {
  if (!state.online.room || state.online.connected || state.online.connecting) {
    return "";
  }
  if (onlineReconnect.timer) {
    return `<div class="online-banner">与服务器断开，正在自动重连（第 ${onlineReconnect.attempt} 次尝试）…</div>`;
  }
  if (onlineReconnect.attempt >= ONLINE_RECONNECT_MAX_ATTEMPTS) {
    return `<div class="online-banner warn">自动重连失败。你的座位已保留（对局中由电脑代打），刷新页面可再次尝试。</div>`;
  }
  return `<div class="online-banner warn">与服务器断开。你的座位已保留，即将尝试重连…</div>`;
}

function onlineCreateRoom() {
  connectOnline(() => {
    sendOnline("createRoom", {
      nickname: state.nickname,
      mustLackOneSuit: state.mustLackOneSuit,
      ruleConfig: state.ruleConfig,
    });
  });
}

function onlineQuickJoin() {
  connectOnline(() => {
    sendOnline("quickJoin", {
      nickname: state.nickname,
      mustLackOneSuit: state.mustLackOneSuit,
      ruleConfig: state.ruleConfig,
    });
  });
}

function onlineJoinRoom(roomCode) {
  const code = String(roomCode || "").trim().toUpperCase();
  if (!code) {
    state.online.error = "请输入房号";
    return;
  }

  connectOnline(() => {
    sendOnline("joinRoom", {
      nickname: state.nickname,
      roomCode: code,
    });
  });
}

function connectOnline(onOpen) {
  state.online.error = "";
  if (socket?.readyState === WebSocket.OPEN) {
    onOpen?.();
    return;
  }

  if (socket?.readyState === WebSocket.CONNECTING) {
    socket.addEventListener("open", () => onOpen?.(), { once: true });
    return;
  }

  state.online.connecting = true;
  socket = new WebSocket(getWebSocketUrl());
  socket.addEventListener("open", () => {
    state.online.connected = true;
    state.online.connecting = false;
    // 已有登录会话则自动登录：每次 WS 连接都是新会话，需重新认证后
    // 服务器才会把账号昵称绑定到本连接（建坊/入座以账号昵称为准）。
    if (state.auth?.token) {
      socket.send(JSON.stringify({ type: "authToken", token: state.auth.token }));
    }
    onOpen?.();
    render();
  });
  socket.addEventListener("message", (event) => {
    handleOnlineMessage(JSON.parse(event.data));
  });
  socket.addEventListener("close", () => {
    state.online.connected = false;
    state.online.connecting = false;
    // 断线自动重连（凭 sessionStorage 的座位 token，服务器保留座位）。
    scheduleOnlineReconnect();
    render();
  });
  socket.addEventListener("error", () => {
    state.online.error = "联机服务连接失败";
    state.online.connected = false;
    state.online.connecting = false;
    scheduleOnlineReconnect();
    render();
  });
}

function sendOnline(type, payload = {}) {
  if (socket?.readyState !== WebSocket.OPEN) {
    state.online.error = "联机还没连接上";
    return;
  }
  socket.send(JSON.stringify({ type, ...payload }));
}

// 登录/注册提交：读面板输入 → 联机（必要时先建连）→ 服务器校验后回 authResult。
function submitAuth() {
  const username = app.querySelector("#auth-username")?.value.trim() ?? "";
  const password = app.querySelector("#auth-password")?.value ?? "";
  const nickname = app.querySelector("#auth-nickname")?.value.trim() ?? "";
  const isRegister = state.auth.mode === "register";

  if (!username || !password) {
    state.auth.error = "请填写用户名和密码";
    render();
    return;
  }
  if (isRegister && password.length < 4) {
    state.auth.error = "密码需 4-32 位";
    render();
    return;
  }

  state.auth.busy = true;
  state.auth.error = "";
  connectOnline(() => {
    sendOnline(isRegister ? "register" : "login", isRegister
      ? { username, password, nickname: nickname || username }
      : { username, password });
    render();
  });
  render();
}

function handleOnlineMessage(message) {
  if (message.type === "connected") {
    state.online.clientId = message.clientId;
  }
  if (message.type === "authResult") {
    state.auth.busy = false;
    if (message.ok) {
      if (message.user) {
        // 登录成功：凭据入 localStorage（同浏览器共享登录态、刷新/新 tab 保留），昵称以账号为准。
        state.auth.user = message.user;
        state.auth.token = message.token;
        state.auth.error = "";
        state.auth.panelOpen = false;
        state.nickname = message.user.nickname;
        saveAuthSession({ user: message.user, token: message.token });
      } else {
        // 退出登录：清本地凭据，退回游客身份。
        state.auth.user = null;
        state.auth.token = null;
        saveAuthSession(null);
      }
    } else if (message.reason === "TOKEN_INVALID") {
      // 自动登录失败（token 过期/服务器数据重置）：静默退回游客。
      state.auth.user = null;
      state.auth.token = null;
      saveAuthSession(null);
    } else {
      state.auth.error = message.message ?? "操作失败，请重试";
      state.auth.panelOpen = true;
    }
  }
  if (message.type === "error") {
    state.online.error = message.message;
    // 重连失败：座位已不存在（超时被清/房间解散），清凭据并停止重连。
    if (message.code === "RECONNECT_FAILED") {
      stopOnlineReconnect();
      clearOnlineToken(state.online.room?.code ?? state.room?.code);
      onlineReconnect.attempt = ONLINE_RECONNECT_MAX_ATTEMPTS;
    }
  }
  if (message.type === "roomState") {
    state.online.error = "";
    // 收到带房间的状态：视为连接正常，重置退避计数并保存座位凭据。
    if (message.room) {
      onlineReconnect.attempt = 0;
      stopOnlineReconnect();
      if (message.room.yourToken) {
        saveOnlineToken(message.room.code, message.room.yourToken);
      }
    }
    const hadRoom = Boolean(state.online.room);
    state.online.room = message.room;
    state.game = message.game;
    if (message.room) {
      if (!hadRoom) {
        // 刚加入/重连进房：从“加入房号”等页签切回游戏页签，展示房间面板。
        state.lobbyTab = "game";
      }
      state.room = {
        code: message.room.code,
        rounds: message.room.rounds,
        currentRound: message.room.currentRound,
        mustLackOneSuit: message.room.mustLackOneSuit,
        ruleConfig: message.room.ruleConfig,
        online: true,
      };
      if (message.game?.status === "playing") {
        // 对局进行中强制回牌桌：联机座位由托管代打，不允许躲在大厅旁观。
        state.online.lobbyIntent = false;
        state.view = "table";
      } else if (!state.online.lobbyIntent) {
        // 等待/已结束：尊重用户导航——没主动回大厅就留在牌桌（如结算界面）。
        state.view = message.game ? "table" : "lobby";
      }
      const you = message.room.players.find((player) => player.isYou);
      if (you) {
        state.beans = you.beans;
      }
      if (initialParams.get("room") !== message.room.code) {
        const nextUrl = `/apps/mobile/?online=1&room=${message.room.code}`;
        window.history.replaceState(null, "", nextUrl);
      }
    } else if (isOnlineMode()) {
      // 返回大厅：停止重连循环并清座位凭据（下次加入会拿到新 token）。
      stopOnlineReconnect();
      clearOnlineToken(state.online.room?.code ?? state.room?.code);
      state.room = null;
      state.game = null;
      state.view = "lobby";
      if (window.location.search.includes("room=")) {
        window.history.replaceState(null, "", "/apps/mobile/?online=1");
      }
    }
  }
  render();
}

function queueInitialOnlineJoin() {
  const roomCode = initialParams.get("room");
  const onlineRequested = initialParams.get("online") === "1" || Boolean(roomCode);
  if (!onlineRequested) {
    return;
  }
  setTimeout(() => {
    // 有座位凭据优先重连（刷新页面场景），找回原座位而不是重新入座。
    const token = readOnlineToken(roomCode);
    if (roomCode && token && !state.online.room) {
      connectOnline(() => {
        sendOnline("reconnect", { roomCode, token });
      });
      render();
      return;
    }
    if (roomCode && !state.online.room) {
      onlineJoinRoom(roomCode);
      render();
      return;
    }
    connectOnline(() => {});
    render();
  }, 0);
}

function captureNickname() {
  const input = app.querySelector("#nickname");
  if (input) {
    state.nickname = input.value.trim().slice(0, 8) || state.nickname;
  }
}

async function copyInviteLink() {
  const invitePath = state.online.room?.invitePath;
  if (!invitePath) {
    return;
  }
  const url = `${window.location.origin}${invitePath}`;
  try {
    await navigator.clipboard.writeText(url);
    state.online.error = "邀请链接已复制";
  } catch {
    state.online.error = url;
  }
  render();
}

function getWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function onlineStatusText() {
  if (state.online.connected) {
    return "联机已连接";
  }
  if (state.online.connecting) {
    return "联机连接中";
  }
  return "联机服务未连接";
}

function scheduleBots() {
  const game = state.game;
  if (!game || game.status !== "playing" || roundIntroActive()) {
    return;
  }
  if (game.currentSeat === 0 && game.phase === "draw") {
    botTimer = setTimeout(() => {
      state.game = drawForCurrentSeat(state.game);
      render();
    }, 360);
    return;
  }
  if (game.phase === "reaction" && getPengOptions(game, 0).length > 0) {
    return;
  }
  if (game.currentSeat === 0 && game.phase !== "reaction") {
    return;
  }

  botTimer = setTimeout(() => {
    state.game = playBotStep(state.game);
    if (state.game.status === "ended") {
      syncHumanBeans("牌局结算");
    }
    render();
  }, 520);
}

// 反应阶段按座位顺序询问机器人是否碰/杠；无人响应则跳过，进入下家摸牌。
// 真人（座位 0）的碰/杠在界面上单独决策，不在这里处理。
function resolveBotReactions(game) {
  const discarderSeat = game.lastDiscard.seat;
  for (let offset = 1; offset <= 3; offset += 1) {
    const seat = (discarderSeat + offset) % game.players.length;
    if (seat === 0) {
      continue;
    }
    const reaction = chooseBotReaction(game, seat);
    if (reaction) {
      return reaction.action === "gang"
        ? mingGangDiscard(game, seat)
        : pengDiscard(game, seat);
    }
  }
  return skipReactions(game);
}

function playBotStep(game) {
  let next = game;
  if (next.phase === "reaction") {
    return resolveBotReactions(next);
  }
  if (next.phase === "draw") {
    next = drawForCurrentSeat(next);
    if (next.availableWin?.seat === next.currentSeat) {
      return finishWin(next, next.currentSeat);
    }
    return next;
  }
  if (next.phase === "discard") {
    // 杠后补牌/摸牌若已构成胡牌，机器人直接胡（杠上开花等）。
    if (next.availableWin?.seat === next.currentSeat) {
      return finishWin(next, next.currentSeat);
    }
    const seat = next.currentSeat;
    // 机器人：能暗杠先暗杠（赖子除外，赖子是万能牌不能拿去杠），否则按 AI 出牌。
    const anGangTiles = getAnGangOptions(next, seat).filter((tile) => tile !== next.laiziTile);
    if (anGangTiles.length > 0) {
      return anGang(next, seat, anGangTiles[0]);
    }
    // 碰过的牌又拿到第 4 张：机器人直接补杠（赖子除外）。
    const buGangTiles = getBuGangOptions(next, seat).filter((tile) => tile !== next.laiziTile);
    if (buGangTiles.length > 0) {
      return buGang(next, seat, buGangTiles[0]);
    }
    const player = next.players[seat];
    const discardIndex = chooseBotDiscardIndex(player, next.laiziTile, {
      mustLackOneSuit: next.mustLackOneSuit,
      ruleConfig: next.ruleConfig,
    });
    return discardTile(next, seat, discardIndex);
  }
  return next;
}

function syncHumanBeans(text) {
  const before = state.beans;
  state.beans = state.game.players[0].beans;
  const delta = state.beans - before;
  if (delta !== 0) {
    state.ledger = [{ text, delta }, ...state.ledger].slice(0, 20);
  }
}

function canHumanDiscard() {
  return (
    state.game?.status === "playing" &&
    state.game.currentSeat === 0 &&
    state.game.phase === "discard"
  );
}

function getMessage() {
  const game = state.game;
  if (game.status === "ended") {
    return game.winnerSeat === null ? "荒庄" : `${game.players[game.winnerSeat].name} 胡牌`;
  }
  if (game.availableWin?.seat === 0) {
    return `${winTypeLabel(game.availableWin.winType)} 可胡`;
  }
  if (game.phase === "reaction" && getPengOptions(game, 0).length > 0) {
    return `${game.players[game.lastDiscard.seat].name} 打出 ${tileLabel(game.lastDiscard.tile)}`;
  }
  if (game.currentSeat === 0) {
    return game.phase === "draw" ? "轮到你摸牌" : "轮到你出牌";
  }
  return `${game.players[game.currentSeat].name} 行牌`;
}

function winTypeLabel(winType) {
  return {
    [WIN_TYPES.PING_HU]: "平胡",
    [WIN_TYPES.RUN_FENG]: "跑风",
    [WIN_TYPES.GANG_PING_HU]: "杠上平胡",
    [WIN_TYPES.ZHI_GANG]: "直杠",
    [WIN_TYPES.EN_DOU]: "恩豆",
    [WIN_TYPES.XIAO_KAI]: "小开",
    [WIN_TYPES.PAO_FENG_1]: "跑风",
    [WIN_TYPES.PAO_FENG_2]: "两个跑",
    [WIN_TYPES.QI_XIAO_DUI]: "七小对",
  }[winType] ?? "胡";
}

function tileClass(tile) {
  if (tile.startsWith("wan")) return "wan";
  if (tile.startsWith("tiao")) return "tiao";
  if (tile.startsWith("tong")) return "tong";
  return "honor";
}

function randomRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isOnlineMode() {
  return Boolean(state.room?.online || state.online.room || state.online.mode);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
