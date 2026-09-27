// server/_core/index.ts
import "dotenv/config";
import express2 from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";

// shared/const.ts
var COOKIE_NAME = "app_session_id";
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
var AXIOS_TIMEOUT_MS = 3e4;
var UNAUTHED_ERR_MSG = "Please login (10001)";
var NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
var OAUTH_STATE_COOKIE = "__Host-oauth_state";
var decodeOAuthState = (state) => {
  let decoded;
  try {
    decoded = atob(state);
  } catch {
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
  }
  return { redirectUri: decoded };
};

// server/_core/oauth.ts
import { parse as parseCookieHeader2 } from "cookie";

// server/db.ts
import { asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var googleDriveConnections = mysqlTable("google_drive_connections", {
  id: int("id").autoincrement().primaryKey(),
  connectionKey: varchar("connectionKey", { length: 64 }).notNull().unique(),
  accountEmail: varchar("accountEmail", { length: 320 }),
  accessToken: text("accessToken").notNull(),
  refreshToken: text("refreshToken"),
  scope: text("scope"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});
var sharedLinks = mysqlTable("shared_links", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 160 }).notNull(),
  url: varchar("url", { length: 2048 }).notNull(),
  category: varchar("category", { length: 48 }).default("General").notNull(),
  notes: text("notes"),
  createdBy: varchar("createdBy", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull()
});

// server/cloudflare-runtime.ts
import { AsyncLocalStorage } from "node:async_hooks";
var requestBindings = new AsyncLocalStorage();
function getWorkerBindings() {
  return requestBindings.getStore();
}
function getRuntimeEnv(name) {
  const bindingValue = requestBindings.getStore()?.[name];
  if (typeof bindingValue === "string") return bindingValue;
  return process.env[name];
}

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
var _db = null;
function d1Database() {
  return getWorkerBindings()?.DB;
}
function fromD1Date(value) {
  return value instanceof Date ? value : new Date(Number(value));
}
function mapD1Connection(row) {
  return {
    ...row,
    expiresAt: fromD1Date(row.expiresAt),
    createdAt: fromD1Date(row.createdAt),
    updatedAt: fromD1Date(row.updatedAt)
  };
}
function mapD1SharedLink(row) {
  return {
    ...row,
    createdAt: fromD1Date(row.createdAt),
    updatedAt: fromD1Date(row.updatedAt)
  };
}
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function upsertUser(user) {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  const values = { openId: user.openId };
  const updateSet = {};
  const textFields = ["name", "email", "loginMethod"];
  textFields.forEach((field) => {
    const value = user[field];
    if (value === void 0) return;
    values[field] = value ?? null;
    updateSet[field] = value ?? null;
  });
  values.lastSignedIn = user.lastSignedIn ?? /* @__PURE__ */ new Date();
  updateSet.lastSignedIn = values.lastSignedIn;
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}
async function getUserByOpenId(openId) {
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}
async function getGoogleDriveConnection(connectionKey = "imira") {
  const d1 = d1Database();
  if (d1) {
    const row = await d1.prepare("SELECT id, connectionKey, accountEmail, accessToken, refreshToken, scope, expiresAt, createdAt, updatedAt FROM google_drive_connections WHERE connectionKey = ? LIMIT 1").bind(connectionKey).first();
    return row ? mapD1Connection(row) : void 0;
  }
  const db = await getDb();
  if (!db) return void 0;
  const result = await db.select().from(googleDriveConnections).where(eq(googleDriveConnections.connectionKey, connectionKey)).limit(1);
  return result[0];
}
async function saveGoogleDriveConnection(connection) {
  const d1 = d1Database();
  if (d1) {
    const now = Date.now();
    await d1.prepare(`INSERT INTO google_drive_connections
        (connectionKey, accountEmail, accessToken, refreshToken, scope, expiresAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connectionKey) DO UPDATE SET
          accountEmail = excluded.accountEmail,
          accessToken = excluded.accessToken,
          refreshToken = excluded.refreshToken,
          scope = excluded.scope,
          expiresAt = excluded.expiresAt,
          updatedAt = excluded.updatedAt`).bind(
      connection.connectionKey,
      connection.accountEmail ?? null,
      connection.accessToken,
      connection.refreshToken ?? null,
      connection.scope ?? null,
      connection.expiresAt.getTime(),
      connection.createdAt?.getTime() ?? now,
      now
    ).run();
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  await db.insert(googleDriveConnections).values(connection).onDuplicateKeyUpdate({
    set: {
      accountEmail: connection.accountEmail,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      scope: connection.scope,
      expiresAt: connection.expiresAt,
      updatedAt: /* @__PURE__ */ new Date()
    }
  });
}
async function listSharedLinks() {
  const d1 = d1Database();
  if (d1) {
    const result = await d1.prepare("SELECT id, title, url, category, notes, createdBy, createdAt, updatedAt FROM shared_links ORDER BY category ASC, updatedAt DESC").all();
    return result.results.map(mapD1SharedLink);
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  return db.select().from(sharedLinks).orderBy(asc(sharedLinks.category), desc(sharedLinks.updatedAt));
}
async function getSharedLink(id) {
  const d1 = d1Database();
  if (d1) {
    const row = await d1.prepare("SELECT id, title, url, category, notes, createdBy, createdAt, updatedAt FROM shared_links WHERE id = ? LIMIT 1").bind(id).first();
    return row ? mapD1SharedLink(row) : void 0;
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  const result = await db.select().from(sharedLinks).where(eq(sharedLinks.id, id)).limit(1);
  return result[0];
}
async function createSharedLink(link) {
  const d1 = d1Database();
  if (d1) {
    const now = Date.now();
    await d1.prepare("INSERT INTO shared_links (title, url, category, notes, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(link.title, link.url, link.category, link.notes ?? null, link.createdBy, now, now).run();
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  await db.insert(sharedLinks).values(link);
}
async function createSharedLinks(links) {
  if (links.length === 0) return;
  const d1 = d1Database();
  if (d1) {
    const now = Date.now();
    const statements = links.map(
      (link) => d1.prepare("INSERT INTO shared_links (title, url, category, notes, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(link.title, link.url, link.category, link.notes ?? null, link.createdBy, now, now)
    );
    await d1.batch(statements);
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  await db.insert(sharedLinks).values(links);
}
async function updateSharedLink(id, link) {
  const d1 = d1Database();
  if (d1) {
    await d1.prepare("UPDATE shared_links SET title = ?, url = ?, category = ?, notes = ?, updatedAt = ? WHERE id = ?").bind(link.title, link.url, link.category, link.notes ?? null, Date.now(), id).run();
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  await db.update(sharedLinks).set({ ...link, updatedAt: /* @__PURE__ */ new Date() }).where(eq(sharedLinks.id, id));
}
async function deleteSharedLink(id) {
  const d1 = d1Database();
  if (d1) {
    await d1.prepare("DELETE FROM shared_links WHERE id = ?").bind(id).run();
    return;
  }
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  await db.delete(sharedLinks).where(eq(sharedLinks.id, id));
}

// server/_core/cookies.ts
function isSecureRequest(req) {
  if (req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;
  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");
  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}
function getSessionCookieOptions(req) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req)
  };
}

// shared/_core/errors.ts
var HttpError = class extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
};
var ForbiddenError = (msg) => new HttpError(403, msg);

// server/_core/sdk.ts
import axios from "axios";
import { parse as parseCookieHeader } from "cookie";
import { SignJWT, jwtVerify } from "jose";
var isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
var EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
var GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
var GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;
var OAuthService = class {
  constructor(client) {
    this.client = client;
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }
  decodeState(state) {
    return decodeOAuthState(state).redirectUri;
  }
  async getTokenByCode(code, state) {
    const payload = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state)
    };
    const { data } = await this.client.post(
      EXCHANGE_TOKEN_PATH,
      payload
    );
    return data;
  }
  async getUserInfoByToken(token) {
    const { data } = await this.client.post(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken
      }
    );
    return data;
  }
};
var createOAuthHttpClient = () => axios.create({
  baseURL: ENV.oAuthServerUrl,
  timeout: AXIOS_TIMEOUT_MS
});
var SDKServer = class {
  client;
  oauthService;
  constructor(client = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }
  deriveLoginMethod(platforms, fallback) {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set(
      platforms.filter((p) => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (set.has("REGISTERED_PLATFORM_MICROSOFT") || set.has("REGISTERED_PLATFORM_AZURE"))
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }
  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(code, state) {
    return this.oauthService.getTokenByCode(code, state);
  }
  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken) {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken
    });
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  parseCookies(cookieHeader) {
    if (!cookieHeader) {
      return /* @__PURE__ */ new Map();
    }
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }
  getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }
  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(openId, options = {}) {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || ""
      },
      options
    );
  }
  async signSession(payload, options = {}) {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1e3);
    const secretKey = this.getSessionSecret();
    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name
    }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setExpirationTime(expirationSeconds).sign(secretKey);
  }
  async verifySession(cookieValue) {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }
    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"]
      });
      const { openId, appId, name } = payload;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }
      return {
        openId,
        appId,
        name
      };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }
  async getUserInfoWithJwt(jwtToken) {
    const payload = {
      jwtToken,
      projectId: ENV.appId
    };
    const { data } = await this.client.post(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );
    const loginMethod = this.deriveLoginMethod(
      data?.platforms,
      data?.platform ?? data.platform ?? null
    );
    return {
      ...data,
      platform: loginMethod,
      loginMethod
    };
  }
  async authenticateRequest(req) {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }
    const session = await this.verifySession(sessionToken);
    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }
    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }
    const sessionUserId = session.openId;
    const signedInAt = /* @__PURE__ */ new Date();
    let user = await getUserByOpenId(sessionUserId);
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionToken ?? "");
        await upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt
        });
        user = await getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }
    await upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt
    });
    return user;
  }
};
var CRON_OPEN_ID_PREFIX = "cron_";
function buildCronUser(userInfo) {
  const now = /* @__PURE__ */ new Date();
  return {
    id: -1,
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? void 0,
    isCron: true
  };
}
var sdk = new SDKServer();

// server/_core/oauth.ts
function getQueryParam(req, key) {
  const value = req.query[key];
  return typeof value === "string" ? value : void 0;
}
function registerOAuthRoutes(app) {
  app.get("/api/oauth/callback", async (req, res) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }
    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader2(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "none" });
    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }
      await upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: /* @__PURE__ */ new Date()
      });
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}

// server/_core/storageProxy.ts
function registerStorageProxy(app) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }
    try {
      const forgeUrl = new URL(
        "v1/storage/presign/get",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/"
      );
      forgeUrl.searchParams.set("path", key);
      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` }
      });
      if (!forgeResp.ok) {
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }
      const { url } = await forgeResp.json();
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}

// server/routers.ts
import { TRPCError as TRPCError4 } from "@trpc/server";
import axios2 from "axios";
import { parse as parseCookie } from "cookie";
import crypto from "node:crypto";
import { z as z3 } from "zod";

// server/_core/systemRouter.ts
import { z } from "zod";

// server/_core/notification.ts
import { TRPCError } from "@trpc/server";
var TITLE_MAX_LENGTH = 1200;
var CONTENT_MAX_LENGTH = 2e4;
var trimValue = (value) => value.trim();
var isNonEmptyString2 = (value) => typeof value === "string" && value.trim().length > 0;
var buildEndpointUrl = (baseUrl) => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};
var validatePayload = (input) => {
  if (!isNonEmptyString2(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required."
    });
  }
  if (!isNonEmptyString2(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required."
    });
  }
  const title = trimValue(input.title);
  const content = trimValue(input.content);
  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`
    });
  }
  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`
    });
  }
  return { title, content };
};
async function notifyOwner(payload) {
  const { title, content } = validatePayload(payload);
  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured."
    });
  }
  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured."
    });
  }
  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1"
      },
      body: JSON.stringify({ title, content })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}

// server/_core/trpc.ts
import { initTRPC, TRPCError as TRPCError2 } from "@trpc/server";
import superjson from "superjson";
var t = initTRPC.context().create({
  transformer: superjson
});
var router = t.router;
var publicProcedure = t.procedure;
var requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;
  if (!ctx.user) {
    throw new TRPCError2({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user
    }
  });
});
var protectedProcedure = t.procedure.use(requireUser);
var adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError2({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({
      ctx: {
        ...ctx,
        user: ctx.user
      }
    });
  })
);

// server/_core/systemRouter.ts
var systemRouter = router({
  health: publicProcedure.input(
    z.object({
      timestamp: z.number().min(0, "timestamp cannot be negative")
    })
  ).query(() => ({
    ok: true
  })),
  notifyOwner: adminProcedure.input(
    z.object({
      title: z.string().min(1, "title is required"),
      content: z.string().min(1, "content is required")
    })
  ).mutation(async ({ input }) => {
    const delivered = await notifyOwner(input);
    return {
      success: delivered
    };
  })
});

// server/routers/shared-links.ts
import { TRPCError as TRPCError3 } from "@trpc/server";
import { z as z2 } from "zod";
var sharedLinkFields = z2.object({
  title: z2.string().trim().min(1).max(160),
  url: z2.string().trim().url().max(2048).refine((value) => /^https?:\/\//i.test(value), "Only HTTP and HTTPS links are allowed."),
  category: z2.string().trim().min(1).max(48),
  notes: z2.string().trim().max(4e3).optional().default("")
});
async function ensureLinkExists(id) {
  const link = await getSharedLink(id);
  if (!link) throw new TRPCError3({ code: "NOT_FOUND", message: "That shared link no longer exists." });
}
function createSharedLinksRouter(guards) {
  return router({
    list: publicProcedure.query(({ ctx }) => {
      guards.requireLocalSession(ctx);
      return listSharedLinks();
    }),
    create: publicProcedure.input(sharedLinkFields).mutation(async ({ ctx, input }) => {
      const user = guards.requireLocalAdmin(ctx);
      await createSharedLink({ ...input, notes: input.notes || null, createdBy: user.username });
      return { success: true };
    }),
    createMany: publicProcedure.input(z2.object({ links: z2.array(sharedLinkFields).min(1).max(100) })).mutation(async ({ ctx, input }) => {
      const user = guards.requireLocalAdmin(ctx);
      await createSharedLinks(input.links.map((link) => ({ ...link, notes: link.notes || null, createdBy: user.username })));
      return { success: true, count: input.links.length };
    }),
    update: publicProcedure.input(sharedLinkFields.extend({ id: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      guards.requireLocalAdmin(ctx);
      await ensureLinkExists(input.id);
      const { id, ...fields } = input;
      await updateSharedLink(id, { ...fields, notes: fields.notes || null });
      return { success: true };
    }),
    delete: publicProcedure.input(z2.object({ id: z2.number().int().positive() })).mutation(async ({ ctx, input }) => {
      guards.requireLocalAdmin(ctx);
      await ensureLinkExists(input.id);
      await deleteSharedLink(input.id);
      return { success: true };
    })
  });
}

// server/routers.ts
var LOCAL_SESSION_COOKIE = "imira_cloud_session";
var LOCAL_USERS_ENV = "LOCAL_AUTH_USERS_JSON";
var DRIVE_CONNECTION_KEY = "imira";
var ADMIN_USERNAME = "imira";
var MAX_DRIVE_UPLOAD_BYTES = 20 * 1024 * 1024;
var MAX_BASE64_UPLOAD_CHARS = Math.ceil(MAX_DRIVE_UPLOAD_BYTES / 3) * 4;
var MULTIPART_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
var MAX_DRIVE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
var GOOGLE_WORKSPACE_EXPORTS = {
  "application/vnd.google-apps.document": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx"
  },
  "application/vnd.google-apps.presentation": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.drawing": { mimeType: "image/svg+xml", extension: ".svg" }
};
var DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");
var workerGoogleHttp = axios2.create({ adapter: "fetch" });
function googleHttp() {
  return getWorkerBindings() ? workerGoogleHttp : axios2;
}
function signingSecret() {
  const secret = getRuntimeEnv("JWT_SECRET");
  if (secret) return secret;
  if (getWorkerBindings()) throw new Error("JWT_SECRET must be configured for Cloudflare deployment.");
  return "imira-cloud-development-signing-secret";
}
function sign(value) {
  return crypto.createHmac("sha256", signingSecret()).update(value).digest("hex");
}
function safelyMatches(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
function getLocalAccounts() {
  const source = getRuntimeEnv(LOCAL_USERS_ENV);
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter(([username, password]) => /^[a-zA-Z0-9._-]{1,64}$/.test(username) && typeof password === "string" && password.length > 0 && password.length <= 256).map(([username, password]) => ({
      username,
      password,
      displayName: username.charAt(0).toUpperCase() + username.slice(1)
    }));
  } catch {
    return [];
  }
}
function localSessionToken(username) {
  return `${username}.${sign(`local-session:${username}`)}`;
}
function getLocalSessionUser(cookieHeader) {
  const token = parseCookie(cookieHeader || "")[LOCAL_SESSION_COOKIE];
  if (!token) return void 0;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return void 0;
  const username = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safelyMatches(signature, sign(`local-session:${username}`))) return void 0;
  return getLocalAccounts().find((account) => account.username === username);
}
function localRole(user) {
  return user.username === ADMIN_USERNAME ? "admin" : "member";
}
function hasLocalSession(cookieHeader) {
  return Boolean(getLocalSessionUser(cookieHeader));
}
function isSecureRequest2(request) {
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.protocol === "https" || forwardedValue?.split(",")[0] === "https";
}
function localCookieOptions(request) {
  return {
    httpOnly: true,
    secure: Boolean(getWorkerBindings()) || isSecureRequest2(request),
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1e3
  };
}
function requireLocalSession(ctx) {
  const header = ctx.req.headers.cookie;
  const cookieHeader = Array.isArray(header) ? header.join(";") : header;
  const user = getLocalSessionUser(cookieHeader);
  if (!user) {
    throw new TRPCError4({ code: "UNAUTHORIZED", message: "Please sign in to access your storage." });
  }
  return user;
}
function requireLocalAdmin(ctx) {
  const user = requireLocalSession(ctx);
  if (localRole(user) !== "admin") {
    throw new TRPCError4({ code: "FORBIDDEN", message: "Only Imira can manage this shared workspace." });
  }
  return user;
}
function googleDriveConfigured() {
  return Boolean(
    getRuntimeEnv("GOOGLE_CLIENT_ID") && getRuntimeEnv("GOOGLE_CLIENT_SECRET") && getRuntimeEnv("GOOGLE_REDIRECT_URI")
  );
}
function signedState() {
  const payload = Buffer.from(
    JSON.stringify({ account: DRIVE_CONNECTION_KEY, expiresAt: Date.now() + 10 * 60 * 1e3 })
  ).toString("base64url");
  return `${payload}.${sign(`drive-state:${payload}`)}`;
}
function validateState(state) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !safelyMatches(signature, sign(`drive-state:${payload}`))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.account === DRIVE_CONNECTION_KEY && Boolean(parsed.expiresAt && parsed.expiresAt > Date.now());
  } catch {
    return false;
  }
}
function buildGoogleAuthorizationUrl() {
  if (!googleDriveConfigured()) return null;
  const clientId = getRuntimeEnv("GOOGLE_CLIENT_ID");
  const redirectUri = getRuntimeEnv("GOOGLE_REDIRECT_URI");
  if (!clientId || !redirectUri) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: DRIVE_SCOPES,
    state: signedState()
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
async function refreshAccessToken(connection) {
  const clientId = getRuntimeEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getRuntimeEnv("GOOGLE_CLIENT_SECRET");
  if (!connection.refreshToken || !clientId || !clientSecret) {
    throw new TRPCError4({
      code: "PRECONDITION_FAILED",
      message: "Reconnect Google Drive to renew its secure access."
    });
  }
  const response = await googleHttp().post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token"
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const expiresAt = new Date(Date.now() + response.data.expires_in * 1e3);
  await saveGoogleDriveConnection({
    connectionKey: DRIVE_CONNECTION_KEY,
    accountEmail: connection.accountEmail,
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token || connection.refreshToken,
    scope: response.data.scope || connection.scope,
    expiresAt
  });
  return response.data.access_token;
}
async function getActiveDriveToken() {
  const connection = await getGoogleDriveConnection(DRIVE_CONNECTION_KEY);
  if (!connection) {
    throw new TRPCError4({ code: "PRECONDITION_FAILED", message: "Connect Google Drive before managing files." });
  }
  if (connection.expiresAt.getTime() > Date.now() + 6e4) return connection.accessToken;
  return refreshAccessToken(connection);
}
async function withDriveApiErrors(request) {
  try {
    const response = await request();
    return response.data;
  } catch (error) {
    if (!axios2.isAxiosError(error)) throw error;
    if (error.message.includes("maxContentLength")) {
      throw new TRPCError4({ code: "PAYLOAD_TOO_LARGE", message: "Downloads are limited to 20 MB per file." });
    }
    const status = error.response?.status;
    const apiError = error.response?.data?.error;
    const message = typeof apiError === "string" ? apiError : apiError?.message;
    console.error(`[Drive] API request failed (${status ?? "network"}): ${message || error.message}`);
    throw new TRPCError4({
      code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "BAD_GATEWAY",
      message: message || `Google Drive returned an HTTP ${status ?? "network"} error.`
    });
  }
}
var appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true };
    })
  }),
  localAuth: router({
    status: publicProcedure.query(({ ctx }) => {
      const header = ctx.req.headers.cookie;
      const cookieHeader = Array.isArray(header) ? header.join(";") : header;
      const user = getLocalSessionUser(cookieHeader);
      return {
        authenticated: Boolean(user),
        user: user ? { username: user.username, displayName: user.displayName, role: localRole(user) } : null
      };
    }),
    login: publicProcedure.input(z3.object({ username: z3.string().min(1).max(64), password: z3.string().min(1).max(256) })).mutation(({ ctx, input }) => {
      const user = getLocalAccounts().find(
        (account) => safelyMatches(input.username, account.username) && safelyMatches(input.password, account.password)
      );
      if (!user) {
        throw new TRPCError4({ code: "UNAUTHORIZED", message: "That username or password is not correct." });
      }
      ctx.res.cookie(LOCAL_SESSION_COOKIE, localSessionToken(user.username), localCookieOptions(ctx.req));
      return { success: true, user: { username: user.username, displayName: user.displayName, role: localRole(user) } };
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(LOCAL_SESSION_COOKIE, { ...localCookieOptions(ctx.req), maxAge: -1 });
      return { success: true };
    })
  }),
  drive: router({
    status: publicProcedure.query(async ({ ctx }) => {
      const header = ctx.req.headers.cookie;
      const cookieHeader = Array.isArray(header) ? header.join(";") : header;
      if (!hasLocalSession(cookieHeader)) {
        return { configured: googleDriveConfigured(), connected: false, accountEmail: null };
      }
      const connection = await getGoogleDriveConnection(DRIVE_CONNECTION_KEY);
      return {
        configured: googleDriveConfigured(),
        connected: Boolean(connection),
        accountEmail: connection?.accountEmail || null
      };
    }),
    getAuthorizationUrl: publicProcedure.mutation(({ ctx }) => {
      requireLocalAdmin(ctx);
      const url = buildGoogleAuthorizationUrl();
      if (!url) {
        return {
          configured: false,
          url: null,
          message: "Google OAuth needs a client ID, client secret, and approved redirect URL before it can connect."
        };
      }
      return { configured: true, url, message: "Opening secure Google authorization\u2026" };
    }),
    completeConnection: publicProcedure.input(z3.object({ code: z3.string().min(1), state: z3.string().min(1) })).mutation(async ({ ctx, input }) => {
      requireLocalAdmin(ctx);
      const clientId = getRuntimeEnv("GOOGLE_CLIENT_ID");
      const clientSecret = getRuntimeEnv("GOOGLE_CLIENT_SECRET");
      const redirectUri = getRuntimeEnv("GOOGLE_REDIRECT_URI");
      if (!googleDriveConfigured()) {
        throw new TRPCError4({ code: "PRECONDITION_FAILED", message: "Google Drive credentials are not configured yet." });
      }
      if (!validateState(input.state)) {
        throw new TRPCError4({ code: "BAD_REQUEST", message: "This Google Drive connection request expired. Please try again." });
      }
      const tokenResponse = await googleHttp().post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
          code: input.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      const profile = await googleHttp().get("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
      });
      await saveGoogleDriveConnection({
        connectionKey: DRIVE_CONNECTION_KEY,
        accountEmail: profile.data.email || null,
        accessToken: tokenResponse.data.access_token,
        refreshToken: tokenResponse.data.refresh_token || null,
        scope: tokenResponse.data.scope || DRIVE_SCOPES,
        expiresAt: new Date(Date.now() + tokenResponse.data.expires_in * 1e3)
      });
      return { success: true, accountEmail: profile.data.email || null };
    }),
    listFiles: publicProcedure.query(async ({ ctx }) => {
      requireLocalSession(ctx);
      const accessToken = await getActiveDriveToken();
      const response = await withDriveApiErrors(() => googleHttp().get("https://www.googleapis.com/drive/v3/files", {
        params: {
          pageSize: 100,
          q: "trashed = false",
          orderBy: "folder,name",
          fields: "files(id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),sharedWithMeTime)"
        },
        headers: { Authorization: `Bearer ${accessToken}` }
      }));
      return response.files || [];
    }),
    listSharedFiles: publicProcedure.query(async ({ ctx }) => {
      requireLocalSession(ctx);
      const accessToken = await getActiveDriveToken();
      const response = await withDriveApiErrors(() => googleHttp().get("https://www.googleapis.com/drive/v3/files", {
        params: {
          pageSize: 100,
          q: "sharedWithMe and trashed = false",
          orderBy: "sharedWithMeTime desc",
          fields: "files(id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),sharedWithMeTime)"
        },
        headers: { Authorization: `Bearer ${accessToken}` }
      }));
      return response.files || [];
    }),
    download: publicProcedure.input(z3.object({ fileId: z3.string().min(1).max(1024) })).mutation(async ({ ctx, input }) => {
      requireLocalSession(ctx);
      const accessToken = await getActiveDriveToken();
      const headers = { Authorization: `Bearer ${accessToken}` };
      const fileId = encodeURIComponent(input.fileId);
      const metadata = await withDriveApiErrors(
        () => googleHttp().get(
          `https://www.googleapis.com/drive/v3/files/${fileId}`,
          { params: { fields: "id,name,mimeType,size" }, headers }
        )
      );
      if (metadata.mimeType === "application/vnd.google-apps.folder") {
        throw new TRPCError4({ code: "BAD_REQUEST", message: "Folders cannot be downloaded as individual files." });
      }
      const googleExport = GOOGLE_WORKSPACE_EXPORTS[metadata.mimeType];
      if (metadata.mimeType.startsWith("application/vnd.google-apps.") && !googleExport) {
        throw new TRPCError4({ code: "BAD_REQUEST", message: "This Google Workspace file type cannot be downloaded here." });
      }
      const size = Number(metadata.size);
      if (Number.isFinite(size) && size > MAX_DRIVE_DOWNLOAD_BYTES) {
        throw new TRPCError4({ code: "PAYLOAD_TOO_LARGE", message: "Downloads are limited to 20 MB per file." });
      }
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}${googleExport ? "/export" : ""}`;
      const content = await withDriveApiErrors(
        () => googleHttp().get(downloadUrl, {
          params: googleExport ? { mimeType: googleExport.mimeType } : { alt: "media" },
          headers,
          responseType: "arraybuffer",
          maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES
        })
      );
      const bytes = Buffer.from(content);
      if (bytes.byteLength > MAX_DRIVE_DOWNLOAD_BYTES) {
        throw new TRPCError4({ code: "PAYLOAD_TOO_LARGE", message: "Downloads are limited to 20 MB per file." });
      }
      const filename = metadata.name.replaceAll("/", "_").replaceAll(String.fromCharCode(92), "_").slice(0, 255) || "download";
      const extensionIndex = filename.lastIndexOf(".");
      const baseName = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
      return {
        fileName: googleExport ? `${baseName}${googleExport.extension}` : filename,
        mimeType: googleExport?.mimeType || metadata.mimeType,
        contentBase64: bytes.toString("base64")
      };
    }),
    upload: publicProcedure.input(
      z3.object({
        fileName: z3.string().min(1).max(255),
        mimeType: z3.string().min(1).max(180),
        contentBase64: z3.string().min(1).max(MAX_BASE64_UPLOAD_CHARS)
      })
    ).mutation(async ({ ctx, input }) => {
      requireLocalSession(ctx);
      const accessToken = await getActiveDriveToken();
      const content = Buffer.from(input.contentBase64, "base64");
      if (content.byteLength > MAX_DRIVE_UPLOAD_BYTES) {
        throw new TRPCError4({ code: "PAYLOAD_TOO_LARGE", message: "Uploads are limited to 20 MB per file." });
      }
      if (content.byteLength > MULTIPART_UPLOAD_MAX_BYTES) {
        const session = await withDriveApiErrors(async () => {
          const response = await googleHttp().post(
            "https://www.googleapis.com/upload/drive/v3/files",
            { name: input.fileName, mimeType: input.mimeType },
            {
              params: { uploadType: "resumable", fields: "id,name,mimeType,modifiedTime,size" },
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": input.mimeType,
                "X-Upload-Content-Length": String(content.byteLength)
              }
            }
          );
          return { data: { uploadUrl: response.headers.location } };
        });
        if (!session.uploadUrl) {
          throw new TRPCError4({ code: "BAD_GATEWAY", message: "Google Drive did not start the large-file upload." });
        }
        return withDriveApiErrors(
          () => googleHttp().put(session.uploadUrl, content, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": input.mimeType,
              "Content-Length": String(content.byteLength)
            },
            maxBodyLength: MAX_DRIVE_UPLOAD_BYTES,
            maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES
          })
        );
      }
      const boundary = `ezio_${crypto.randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify({ name: input.fileName })}\r
--${boundary}\r
Content-Type: ${input.mimeType}\r
\r
`
        ),
        content,
        Buffer.from(`\r
--${boundary}--`)
      ]);
      return withDriveApiErrors(() => googleHttp().post(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size",
        body,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "Content-Length": body.length
          },
          maxBodyLength: MAX_DRIVE_UPLOAD_BYTES,
          maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES
        }
      ));
    })
  }),
  links: createSharedLinksRouter({ requireLocalSession, requireLocalAdmin })
});

// server/_core/context.ts
async function createContext(opts) {
  let user = null;
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    user = null;
  }
  return {
    req: opts.req,
    res: opts.res,
    user
  };
}

// server/_core/vite.ts
import express from "express";
import fs2 from "fs";
import { nanoid } from "nanoid";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// vite.config.ts
import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";
var PROJECT_ROOT = import.meta.dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
function vitePluginCloudflareArtAssets() {
  const assetRoot = path.resolve(import.meta.dirname, "cloudflare-assets");
  return {
    name: "eziocloud-cloudflare-art-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname;
        try {
          pathname = new URL(req.url || "/", "http://vite.local").pathname;
        } catch {
          return next();
        }
        const prefix = "/assets/";
        if (!pathname.startsWith(prefix)) return next();
        let relativePath;
        try {
          relativePath = decodeURIComponent(pathname.slice(prefix.length));
        } catch {
          return next();
        }
        const filePath = path.resolve(assetRoot, relativePath);
        if (!filePath.startsWith(`${assetRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return next();
        }
        const contentType = path.extname(filePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.end(fs.readFileSync(filePath));
      });
    }
  };
}
var isCloudflareBuild = process.env.CLOUDFLARE_BUILD === "1";
var plugins = [
  react(),
  tailwindcss(),
  vitePluginCloudflareArtAssets(),
  ...isCloudflareBuild ? [] : [jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()]
];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets")
    }
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: isCloudflareBuild ? false : path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});

// server/_core/vite.ts
async function setupVite(app, server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true
  };
  const vite = await createViteServer({
    ...vite_config_default,
    configFile: false,
    server: serverOptions,
    appType: "custom"
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path2.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );
      let template = await fs2.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e);
      next(e);
    }
  });
}
function serveStatic(app) {
  const distPath = process.env.NODE_ENV === "development" ? path2.resolve(import.meta.dirname, "../..", "dist", "public") : path2.resolve(import.meta.dirname, "public");
  if (!fs2.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }
  app.use(express.static(distPath));
  app.use("*", (_req, res) => {
    res.sendFile(path2.resolve(distPath, "index.html"));
  });
}

// server/_core/index.ts
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
async function findAvailablePort(startPort = 3e3) {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}
async function startServer() {
  const app = express2();
  const server = createServer(app);
  app.use(express2.json({ limit: "50mb" }));
  app.use(express2.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext
    })
  );
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
startServer().catch(console.error);
