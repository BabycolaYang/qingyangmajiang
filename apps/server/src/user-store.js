import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { dirname } from "node:path";

// 统一错误构造：error.code 供服务器按码回给客户端。
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 简易用户存储：JSON 文件持久化（注册 / 登录 / 会话 token 自动登录）。
// - 密码用 scrypt + 随机盐哈希存储，不存明文；
// - 会话 token 随用户记录持久化，服务器重启后客户端仍可凭 token 自动登录；
// - 每次登录刷新 token（旧 token 立即失效，单设备会话）。
export function createUserStore({ filePath } = {}) {
  let users = new Map();
  let loaded = false;

  function load() {
    if (loaded) {
      return;
    }
    loaded = true;
    if (!existsSync(filePath)) {
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8"));
      for (const user of Array.isArray(raw) ? raw : []) {
        if (user?.username) {
          users.set(user.username, user);
        }
      }
    } catch {
      // 文件损坏时从空库开始，避免服务器起不来。
      users = new Map();
    }
  }

  function save() {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...users.values()], null, 2), "utf8");
  }

  function hashPassword(password, salt) {
    return scryptSync(String(password), salt, 32).toString("hex");
  }

  function publicUser(user) {
    return { username: user.username, nickname: user.nickname };
  }

  function validateUsername(username) {
    const name = String(username ?? "").trim();
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,16}$/.test(name)) {
      throw fail("BAD_USERNAME", "用户名需 2-16 位（中文、字母、数字或下划线）");
    }
    return name;
  }

  function validatePassword(password) {
    const pass = String(password ?? "");
    if (pass.length < 4 || pass.length > 32) {
      throw fail("BAD_PASSWORD", "密码需 4-32 位");
    }
    return pass;
  }

  load();

  return {
    register({ username, password, nickname } = {}) {
      const name = validateUsername(username);
      const pass = validatePassword(password);
      if (users.has(name)) {
        throw fail("USER_EXISTS", "用户名已被注册");
      }
      const cleanNickname = String(nickname ?? "").trim().slice(0, 8) || name;
      const salt = randomBytes(16).toString("hex");
      const user = {
        username: name,
        nickname: cleanNickname,
        salt,
        hash: hashPassword(pass, salt),
        token: randomUUID(),
        createdAt: Date.now(),
      };
      users.set(name, user);
      save();
      // 返回浅拷贝：调用方持有的引用不随后续登录刷新 token 而变化。
      return { ...user };
    },

    login({ username, password } = {}) {
      const name = validateUsername(username);
      const user = users.get(name);
      if (!user || user.hash !== hashPassword(password, user.salt)) {
        throw fail("BAD_CREDENTIALS", "用户名或密码错误");
      }
      // 登录刷新会话 token（旧 token 失效）。
      user.token = randomUUID();
      save();
      return { ...user };
    },

    // 凭会话 token 自动登录（服务器重启后仍有效）；无效返回 null。
    authByToken(token) {
      if (!token) {
        return null;
      }
      const user = [...users.values()].find((candidate) => candidate.token === token);
      return user ? { ...user } : null;
    },
  };
}
