import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUserStore } from "../src/user-store.js";

function tempStorePath() {
  return join(mkdtempSync(join(tmpdir(), "mj-users-")), "users.json");
}

test("register creates user with token, default nickname and persisted credential", () => {
  const filePath = tempStorePath();
  try {
    const store = createUserStore({ filePath });
    const user = store.register({ username: "张三", password: "1234" });
    assert.equal(user.username, "张三");
    assert.equal(user.nickname, "张三");
    assert.ok(user.token);

    // 自定义昵称生效；同一文件重开 store（服务器重启场景）token 仍可自动登录。
    const alice = store.register({ username: "alice", password: "abcd", nickname: "小明" });
    assert.equal(alice.nickname, "小明");

    const reopened = createUserStore({ filePath });
    assert.equal(reopened.authByToken(user.token)?.username, "张三");
    assert.equal(reopened.authByToken(alice.token)?.nickname, "小明");
  } finally {
    rmSync(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("register rejects duplicate name and bad input", () => {
  const filePath = tempStorePath();
  try {
    const store = createUserStore({ filePath });
    store.register({ username: "李四", password: "1234" });
    assert.throws(() => store.register({ username: "李四", password: "5678" }), /用户名已被注册/);
    assert.throws(() => store.register({ username: "a", password: "1234" }), /用户名/);
    assert.throws(() => store.register({ username: "王五", password: "123" }), /密码/);
  } finally {
    rmSync(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("login refreshes token; wrong password rejected; old token invalidated", () => {
  const filePath = tempStorePath();
  try {
    const store = createUserStore({ filePath });
    const created = store.register({ username: "wang", password: "1234" });

    assert.throws(() => store.login({ username: "wang", password: "xxxx" }), /用户名或密码错误/);
    assert.throws(() => store.login({ username: "nobody", password: "1234" }), /用户名或密码错误/);

    const loggedIn = store.login({ username: "wang", password: "1234" });
    assert.equal(loggedIn.username, "wang");
    assert.notEqual(loggedIn.token, created.token);
    assert.equal(store.authByToken(created.token), null);
    assert.equal(store.authByToken(loggedIn.token)?.username, "wang");
  } finally {
    rmSync(join(filePath, ".."), { recursive: true, force: true });
  }
});

test("authByToken returns null for missing or unknown token", () => {
  const store = createUserStore({ filePath: tempStorePath() });
  assert.equal(store.authByToken(null), null);
  assert.equal(store.authByToken("no-such-token"), null);
});
