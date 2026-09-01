import {
  WIN_TYPES,
  anGang,
  chooseBotDiscardIndex,
  discardTile,
  drawForCurrentSeat,
  finishWin,
  getAnGangOptions,
  getPengOptions,
  pengDiscard,
  rollDice,
  skipReactions,
  startRound,
  tileLabel,
} from "../../packages/mahjong-core/src/index.js";
import { Application, Container, Graphics, Text } from "/node_modules/pixi.js/dist/pixi.mjs";


const app = document.querySelector("#app");
const storageKey = "qingyang-pinghu-mobile";
const botNames = ["下家", "对家", "上家"];

const state = loadState();
let botTimer = null;
let socket = null;
let pixiTable = null;
let pixiRoot = null;
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
    ledger: nextState.ledger ?? [],
    nickname: nextState.nickname || `玩家${Math.floor(1000 + Math.random() * 9000)}`,
    online: {
      connected: false,
      connecting: false,
      clientId: nextState.online?.clientId ?? null,
      room: null,
      error: "",
    },
  };
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify({
    ...state,
    game: state.game,
  }));
}

function render() {
  clearTimeout(botTimer);
  saveState();

  if (state.view === "table" && state.game) {
    if (state.game.status !== "ended" && pixiTable && pixiRoot && app.querySelector("#table-canvas")) {
      updateExistingPixiTable(state.game);
      if (state.room) {
        const title = app.querySelector(".table-head h1");
        const badges = app.querySelector(".badge-row");
        if (title) title.textContent = `房号 ${state.room.code}`;
        if (badges) {
          badges.innerHTML = `<span class="badge">墙 ${state.game.wall.length}</span><span class="badge">翻 ${tileLabel(state.game.indicatorTile)}</span><span class="badge">赖 ${tileLabel(state.game.laiziTile)}</span>`;
        }
      }
      const controls = app.querySelector(".controls");
      if (controls) {
        controls.innerHTML = renderControls();
        bindTable();
      }
      if (!isOnlineMode()) {
        scheduleBots();
      }
      return;
    }
    pixiTable?.destroy(true, { children: true, texture: true, baseTexture: true });
    pixiTable = null;
    pixiRoot = null;
    app.innerHTML = renderTable();
    bindTable();
    void mountPixiTable(state.game);
    if (!isOnlineMode()) {
      scheduleBots();
    }
    return;
  }

  pixiTable?.destroy(true, { children: true, texture: true, baseTexture: true });
  pixiTable = null;
  pixiRoot = null;
  app.innerHTML = renderLobby();
  bindLobby();
}

function renderLobby() {
  const room = state.room;
  const onlineRoom = state.online.room;
  const isOnline = isOnlineMode();
  return `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <h1>青阳平胡</h1>
          <span>${isOnline ? "联机好友房" : "好友房"}</span>
        </div>
        <div class="beans">
          <small>欢乐豆</small>
          <strong>${state.beans}</strong>
        </div>
      </header>
      <section class="screen lobby-grid">
        <div class="panel">
          <h2>${onlineRoom ? "联机房间" : "房间"}</h2>
          ${
            onlineRoom
              ? renderOnlineRoomPanel(onlineRoom)
              : room
              ? `
                <p class="room-meta">房号</p>
                <p><span class="room-code">${room.code}</span></p>
                <div class="setting-row"><span>局数</span><strong>${room.rounds}</strong></div>
                <div class="setting-row"><span>缺一门</span><strong>${room.mustLackOneSuit ? "开" : "关"}</strong></div>
                <div class="actions">
                  <button class="gold" data-action="start">开局</button>
                  <button class="secondary" data-action="leave">离开</button>
                </div>
              `
              : `
                <input id="nickname" maxlength="8" placeholder="昵称" value="${escapeHtml(state.nickname)}" />
                <div style="height: 10px"></div>
                <div class="setting-row">
                  <span>缺一门</span>
                  <button class="toggle ${state.mustLackOneSuit ? "on" : ""}" data-action="toggle-lack" aria-label="缺一门"><span></span></button>
                </div>
                <div class="actions">
                  <button class="gold" data-action="create-room">创建好友房</button>
                  <button data-action="online-create">联机创建</button>
                </div>
                <div style="height: 12px"></div>
                <input id="roomCode" maxlength="6" inputmode="latin" placeholder="房号" />
                <div style="height: 8px"></div>
                <div class="actions">
                  <button class="secondary" data-action="join-room">本地加入</button>
                  <button class="secondary" data-action="online-join">联机加入</button>
                </div>
                ${state.online.error ? `<p class="status-text error">${escapeHtml(state.online.error)}</p>` : ""}
                <p class="status-text">${onlineStatusText()}</p>
              `
          }
        </div>
        <div class="panel">
          <h3>流水</h3>
          ${renderLedger()}
        </div>
      </section>
    </div>
  `;
}

function renderOnlineRoomPanel(room) {
  const inviteUrl = `${window.location.origin}${room.invitePath}`;
  return `
    <p class="room-meta">房号</p>
    <p><span class="room-code">${room.code}</span></p>
    <div class="invite-box">${escapeHtml(inviteUrl)}</div>
    <div class="actions">
      <button class="secondary" data-action="copy-invite">复制邀请</button>
      ${room.isOwner ? `<button class="gold" data-action="online-start">开局</button>` : ""}
      <button class="secondary" data-action="online-leave">离开</button>
    </div>
    <div class="seat-list">
      ${room.players
        .map(
          (player) => `
            <div class="seat-row ${player.isYou ? "you" : ""}">
              <span>${player.seat + 1} 座</span>
              <strong>${player.name || "空位"}${player.isOwner ? " 房主" : ""}${player.isYou ? " 我" : ""}</strong>
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

function renderTable() {
  const game = state.game;
  const positions = ["bottom", "right", "top", "left"];
  const message = getMessage();

  return `
    <div class="table ${game.status === "ended" ? "ended" : ""}">
      <header class="table-head">
        <button class="secondary" data-action="back">大厅</button>
        <h1>房号 ${state.room.code}</h1>
        <div class="badge-row">
          <span class="badge">墙 ${game.wall.length}</span>
          <span class="badge">翻 ${tileLabel(game.indicatorTile)}</span>
          <span class="badge">赖 ${tileLabel(game.laiziTile)}</span>
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

  pixiTable?.destroy(true, { children: true, texture: true, baseTexture: true });
  pixiTable = new Application();
  await pixiTable.init({
    canvas,
    resizeTo: board,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    backgroundAlpha: 0,
  });

  const width = board.clientWidth;
  const height = board.clientHeight;
  const root = new Container();
  pixiRoot = root;
  pixiTable.stage.addChild(root);
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

function drawPixiTable(root, game, width, height) {
  const scale = Math.max(0.68, Math.min(width / 1180, height / 680));
  const cx = width / 2;
  const cy = height * 0.48;
  const poolW = Math.min(width * 0.58, 710 * scale);
  const poolH = Math.min(height * 0.5, 360 * scale);
  const tileW = Math.max(24, 38 * scale);
  const tileH = Math.max(34, 54 * scale);
  const smallW = Math.max(17, 27 * scale);
  const smallH = Math.max(24, 38 * scale);
  const positions = [
    { x: cx, y: height - tileH * 0.64, rotation: 0 },
    { x: width - tileH * 0.64, y: cy, rotation: -Math.PI / 2 },
    { x: cx, y: tileH * 0.72, rotation: Math.PI },
    { x: tileH * 0.64, y: cy, rotation: Math.PI / 2 },
  ];

  const pool = new Graphics()
    .ellipse(cx, cy, poolW / 2, poolH / 2)
    .fill({ color: 0x063d38, alpha: 0.2 })
    .stroke({ color: 0x7de7c7, alpha: 0.22, width: 2 });
  root.addChild(pool);

  const wallCount = Math.min(72, Math.max(40, Math.ceil(game.wall.length / 1.5)));
  const wallSides = distributeCount(wallCount, 4);
  drawPixiWall(root, wallSides, cx, cy, poolW, poolH, scale);

  const dial = new Graphics()
    .roundRect(cx - 48 * scale, cy - 38 * scale, 96 * scale, 76 * scale, 14 * scale)
    .fill({ color: 0x101b22, alpha: 0.95 })
    .stroke({ color: 0x45b8dd, alpha: 0.55, width: 3 });
  root.addChild(dial);
  addPixiText(root, "牌墙", cx, cy - 20 * scale, 14 * scale, 0xffffff, true);
  addPixiText(root, String(game.wall.length), cx, cy + 3 * scale, 27 * scale, 0x66ddff, true);
  addPixiText(root, "剩余", cx, cy + 25 * scale, 11 * scale, 0xb8d7d3, false);

  game.players.forEach((player, seat) => {
    const pos = positions[seat];
    const current = game.currentSeat === seat;
    addPixiText(root, `${player.name}${seat === game.dealerSeat ? " 庄" : ""}`, pos.x, pos.y - (seat === 0 ? tileH * 1.48 : 0), 15 * scale, current ? 0xffe18a : 0xffffff, true, pos.rotation);
    addPixiText(root, `${player.beans} 豆`, pos.x, pos.y - (seat === 0 ? tileH * 1.1 : -18 * scale), 11 * scale, 0xb7cfca, false, pos.rotation);

    drawPixiDiscards(root, player.discards, seat, cx, cy, poolW, poolH, smallW, smallH, game.laiziTile, scale);
    drawPixiMelds(root, player.melds, seat, cx, cy, poolW, poolH, smallW, smallH, game.laiziTile, scale);

    const hand = seat === 0 || game.status === "ended" ? player.hand : player.hand.map(() => null);
    const gap = tileW * 0.92;
    const start = -((hand.length - 1) * gap) / 2;
    hand.forEach((tile, index) => {
      const offset = start + index * gap;
      const drawn = game.lastDraw?.seat === seat && index === hand.length - 1;
      const x = pos.x + (pos.rotation === 0 || pos.rotation === Math.PI ? offset : 0);
      const y = pos.y + (pos.rotation === 0 || pos.rotation === Math.PI ? 0 : offset);
      const tileNode = drawPixiTile(root, tile, x, y, tileW, tileH, pos.rotation, tile === game.laiziTile, drawn, tile === null, scale);
      if (seat === 0 && tile && game.status === "playing") {
        tileNode.eventMode = "static";
        tileNode.cursor = "pointer";
        tileNode.on("pointertap", () => triggerPixiAction("discard", { handIndex: index }));
      }
    });
  });

  addPixiText(root, getMessage(), 18 * scale, 24 * scale, 15 * scale, 0xf5fff8, true);
}

function drawPixiWall(root, sides, cx, cy, poolW, poolH, scale) {
  const gap = 12 * scale;
  const blockW = 16 * scale;
  const blockH = 8 * scale;
  const drawBlock = (x, y, rotation = 0) => {
    const block = new Graphics().roundRect(-blockW / 2, -blockH / 2, blockW, blockH, 2 * scale).fill(0x319b72).stroke({ color: 0x063f35, width: 1 });
    block.position.set(x, y);
    block.rotation = rotation;
    root.addChild(block);
  };
  sides[0] && Array.from({ length: sides[0] }, (_, i) => drawBlock(cx - ((sides[0] - 1) * gap) / 2 + i * gap, cy - poolH / 2 - 24 * scale));
  sides[2] && Array.from({ length: sides[2] }, (_, i) => drawBlock(cx - ((sides[2] - 1) * gap) / 2 + i * gap, cy + poolH / 2 + 24 * scale));
  sides[1] && Array.from({ length: sides[1] }, (_, i) => drawBlock(cx + poolW / 2 + 24 * scale, cy - ((sides[1] - 1) * gap) / 2 + i * gap, Math.PI / 2));
  sides[3] && Array.from({ length: sides[3] }, (_, i) => drawBlock(cx - poolW / 2 - 24 * scale, cy - ((sides[3] - 1) * gap) / 2 + i * gap, Math.PI / 2));
}

function drawPixiDiscards(root, tiles, seat, cx, cy, poolW, poolH, tileW, tileH, laiziTile, scale) {
  const gap = tileW * 0.86;
  const rotation = seat === 1 ? -Math.PI / 2 : seat === 3 ? Math.PI / 2 : seat === 2 ? Math.PI : 0;
  const row = seat === 0 ? { x: cx, y: cy + poolH * 0.39 } : seat === 2 ? { x: cx, y: cy - poolH * 0.39 } : { x: cx + (seat === 1 ? poolW * 0.39 : -poolW * 0.39), y: cy };
  const start = -((tiles.length - 1) * gap) / 2;
  tiles.forEach((tile, index) => {
    const offset = start + index * gap;
    const x = seat < 2 ? row.x + offset : row.x;
    const y = seat < 2 ? row.y : row.y + offset;
    drawPixiTile(root, tile, x, y, tileW, tileH, rotation, tile === laiziTile, false, false, scale);
  });
}

function drawPixiMelds(root, melds, seat, cx, cy, poolW, poolH, tileW, tileH, laiziTile, scale) {
  melds.forEach((meld, meldIndex) => {
    const rotation = seat === 1 ? -Math.PI / 2 : seat === 3 ? Math.PI / 2 : seat === 2 ? Math.PI : 0;
    const baseX = seat < 2 ? cx + (meldIndex - melds.length / 2) * tileW * 1.2 : cx + (seat === 1 ? poolW * 0.3 : -poolW * 0.3);
    const baseY = seat === 0 ? cy + poolH * 0.27 : seat === 2 ? cy - poolH * 0.27 : cy + (meldIndex - melds.length / 2) * tileW * 1.2;
    meld.tiles.forEach((tile, index) => drawPixiTile(root, tile, baseX + (seat < 2 ? index * tileW * 0.7 : 0), baseY + (seat < 2 ? 0 : index * tileW * 0.7), tileW * 0.72, tileH * 0.72, rotation, tile === laiziTile, false, false, scale));
  });
}

function drawPixiTile(root, tile, x, y, width, height, rotation, isLaizi, drawn, back, scale) {
  const node = new Container();
  node.position.set(x, y + (drawn ? -10 * scale : 0));
  node.rotation = rotation;
  const face = new Graphics().roundRect(-width / 2, -height / 2, width, height, 5 * scale).fill(back ? 0x31706a : 0xf5edda).stroke({ color: drawn ? 0xffd85b : 0xb9b18f, width: drawn ? 2.5 : 1.5 });
  node.addChild(face);
  if (tile) {
    const text = addPixiText(node, tileLabel(tile), 0, 0, Math.max(10, width * 0.36), tileClass(tile) === "wan" ? 0xa3322c : tileClass(tile) === "tiao" ? 0x176c4d : tileClass(tile) === "tong" ? 0x28619a : 0x2d3533, true);
    text.anchor.set(0.5);
  }
  if (isLaizi) {
    const laiziMark = new Graphics().circle(width * 0.35, -height * 0.4, 7 * scale).fill(0xc93b32);
    node.addChild(laiziMark);
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

function triggerPixiAction(action, payload = {}) {
  if (action === "discard" && canHumanDiscard()) {
    if (isOnlineMode()) {
      sendOnline("action", { action, payload });
    } else {
      state.game = discardTile(state.game, 0, payload.handIndex);
    }
    render();
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
  return `<span class="tile ${small ? "small" : ""} ${tileClass(tile)} ${isLaizi ? "laizi" : ""} ${isDrawn ? "drawn" : ""}">${tileLabel(tile)}</span>`;
}

function renderControls() {
  const game = state.game;
  if (game.status === "ended") {
    return `
      <button class="gold" data-action="next-round">下一局</button>
      <button class="secondary" data-action="back">大厅</button>
    `;
  }
  if (game.phase === "reaction" && getPengOptions(game, 0).length > 0) {
    return `
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
  const gangs = getAnGangOptions(game, 0)
    .map((tile) => `<button class="secondary" data-action="gang" data-tile="${tile}">杠 ${tileLabel(tile)}</button>`)
    .join("");

  return `${winButton}${gangs}<span class="badge">选牌打出</span>`;
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

  return `
    <div class="settlement">
      <h2>${winner.name} ${winTypeLabel(game.winType)}</h2>
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
      if (action === "create-room") {
        createRoom();
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
      if (action === "online-start") {
        sendOnline("startGame");
      }
      if (action === "online-leave") {
        sendOnline("leaveRoom");
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
          state.view = "lobby";
          render();
          return;
        }

        if (isOnlineMode()) {
          if (action === "discard" && canHumanDiscard()) {
            sendOnline("action", {
              action: "discard",
              payload: { handIndex: Number(button.dataset.index) },
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
              payload: { tile: button.dataset.tile },
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
          state.game = skipReactions(state.game);
        }
        if (action === "gang") {
          state.game = anGang(state.game, 0, button.dataset.tile);
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
  });
}

function onlineCreateRoom() {
  connectOnline(() => {
    sendOnline("createRoom", {
      nickname: state.nickname,
      mustLackOneSuit: state.mustLackOneSuit,
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
    onOpen?.();
    render();
  });
  socket.addEventListener("message", (event) => {
    handleOnlineMessage(JSON.parse(event.data));
  });
  socket.addEventListener("close", () => {
    state.online.connected = false;
    state.online.connecting = false;
    render();
  });
  socket.addEventListener("error", () => {
    state.online.error = "联机服务连接失败";
    state.online.connected = false;
    state.online.connecting = false;
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

function handleOnlineMessage(message) {
  if (message.type === "connected") {
    state.online.clientId = message.clientId;
  }
  if (message.type === "error") {
    state.online.error = message.message;
  }
  if (message.type === "roomState") {
    state.online.error = "";
    state.online.room = message.room;
    state.game = message.game;
    if (message.room) {
      state.room = {
        code: message.room.code,
        rounds: message.room.rounds,
        currentRound: message.room.currentRound,
        mustLackOneSuit: message.room.mustLackOneSuit,
        online: true,
      };
      state.view = message.game ? "table" : "lobby";
      const you = message.room.players.find((player) => player.isYou);
      if (you) {
        state.beans = you.beans;
      }
      if (initialParams.get("room") !== message.room.code) {
        const nextUrl = `/apps/mobile/?online=1&room=${message.room.code}`;
        window.history.replaceState(null, "", nextUrl);
      }
    } else if (isOnlineMode()) {
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
  if (!game || game.status !== "playing") {
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

function playBotStep(game) {
  let next = game;
  if (next.phase === "reaction") {
    return skipReactions(next);
  }
  if (next.phase === "draw") {
    next = drawForCurrentSeat(next);
    if (next.availableWin?.seat === next.currentSeat) {
      return finishWin(next, next.currentSeat);
    }
    return next;
  }
  if (next.phase === "discard") {
    const player = next.players[next.currentSeat];
    const discardIndex = chooseBotDiscardIndex(player, next.laiziTile, {
      mustLackOneSuit: next.mustLackOneSuit,
    });
    return discardTile(next, next.currentSeat, discardIndex);
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
  return Boolean(state.room?.online || state.online.room);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
