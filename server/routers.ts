import { TRPCError } from "@trpc/server";
import axios from "axios";
import { parse as parseCookie } from "cookie";
import crypto from "node:crypto";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import * as db from "./db";
import { getRuntimeEnv, getWorkerBindings } from "./cloudflare-runtime";
import { createSharedLinksRouter } from "./routers/shared-links";
import { publicProcedure, router } from "./_core/trpc";

const LOCAL_SESSION_COOKIE = "imira_cloud_session";
// Local logins are configured as a server-side project secret; all accounts share this Drive workspace.
const LOCAL_USERS_ENV = "LOCAL_AUTH_USERS_JSON";
const DRIVE_CONNECTION_KEY = "imira";
const ADMIN_USERNAME = "imira";
const MAX_DRIVE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_UPLOAD_CHARS = Math.ceil(MAX_DRIVE_UPLOAD_BYTES / 3) * 4;
const MULTIPART_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DRIVE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const GOOGLE_WORKSPACE_EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  },
  "application/vnd.google-apps.presentation": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.drawing": { mimeType: "image/svg+xml", extension: ".svg" },
};
const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const workerGoogleHttp = axios.create({ adapter: "fetch" });
function googleHttp() {
  return getWorkerBindings() ? workerGoogleHttp : axios;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

type GoogleFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  sharedWithMeTime?: string;
};

function signingSecret() {
  const secret = getRuntimeEnv("JWT_SECRET");
  if (secret) return secret;
  if (getWorkerBindings()) throw new Error("JWT_SECRET must be configured for Cloudflare deployment.");
  return "imira-cloud-development-signing-secret";
}

function sign(value: string) {
  return crypto.createHmac("sha256", signingSecret()).update(value).digest("hex");
}

function safelyMatches(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

type LocalAccount = { username: string; password: string; displayName: string };

function getLocalAccounts(): LocalAccount[] {
  const source = getRuntimeEnv(LOCAL_USERS_ENV);
  if (!source) return [];

  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

    return Object.entries(parsed as Record<string, unknown>)
      .filter(([username, password]) => /^[a-zA-Z0-9._-]{1,64}$/.test(username) && typeof password === "string" && password.length > 0 && password.length <= 256)
      .map(([username, password]) => ({
        username,
        password: password as string,
        displayName: username.charAt(0).toUpperCase() + username.slice(1),
      }));
  } catch {
    return [];
  }
}

function localSessionToken(username: string) {
  return `${username}.${sign(`local-session:${username}`)}`;
}

export function getLocalSessionUser(cookieHeader?: string): LocalAccount | undefined {
  const token = parseCookie(cookieHeader || "")[LOCAL_SESSION_COOKIE];
  if (!token) return undefined;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return undefined;
  const username = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safelyMatches(signature, sign(`local-session:${username}`))) return undefined;
  return getLocalAccounts().find(account => account.username === username);
}

function localRole(user: LocalAccount): "admin" | "member" {
  return user.username === ADMIN_USERNAME ? "admin" : "member";
}

function hasLocalSession(cookieHeader?: string) {
  return Boolean(getLocalSessionUser(cookieHeader));
}

function isSecureRequest(request: { protocol?: string; headers: Record<string, string | string[] | undefined> }) {
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.protocol === "https" || forwardedValue?.split(",")[0] === "https";
}

function localCookieOptions(request: { protocol?: string; headers: Record<string, string | string[] | undefined> }) {
  return {
    httpOnly: true,
    secure: Boolean(getWorkerBindings()) || isSecureRequest(request),
    sameSite: "lax" as const,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function requireLocalSession(ctx: { req: { headers: Record<string, string | string[] | undefined> } }) {
  const header = ctx.req.headers.cookie;
  const cookieHeader = Array.isArray(header) ? header.join(";") : header;
  const user = getLocalSessionUser(cookieHeader);
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in to access your storage." });
  }
  return user;
}

function requireLocalAdmin(ctx: { req: { headers: Record<string, string | string[] | undefined> } }) {
  const user = requireLocalSession(ctx);
  if (localRole(user) !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only Imira can manage this shared workspace." });
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
    JSON.stringify({ account: DRIVE_CONNECTION_KEY, expiresAt: Date.now() + 10 * 60 * 1000 })
  ).toString("base64url");
  return `${payload}.${sign(`drive-state:${payload}`)}`;
}

function validateState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !safelyMatches(signature, sign(`drive-state:${payload}`))) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      account?: string;
      expiresAt?: number;
    };
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
    state: signedState(),
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function refreshAccessToken(connection: NonNullable<Awaited<ReturnType<typeof db.getGoogleDriveConnection>>>) {
  const clientId = getRuntimeEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getRuntimeEnv("GOOGLE_CLIENT_SECRET");
  if (!connection.refreshToken || !clientId || !clientSecret) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Reconnect Google Drive to renew its secure access.",
    });
  }

  const response = await googleHttp().post<TokenResponse>(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const expiresAt = new Date(Date.now() + response.data.expires_in * 1000);
  await db.saveGoogleDriveConnection({
    connectionKey: DRIVE_CONNECTION_KEY,
    accountEmail: connection.accountEmail,
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token || connection.refreshToken,
    scope: response.data.scope || connection.scope,
    expiresAt,
  });

  return response.data.access_token;
}

export async function getActiveDriveToken() {
  const connection = await db.getGoogleDriveConnection(DRIVE_CONNECTION_KEY);
  if (!connection) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect Google Drive before managing files." });
  }

  if (connection.expiresAt.getTime() > Date.now() + 60_000) return connection.accessToken;
  return refreshAccessToken(connection);
}

async function withDriveApiErrors<T>(request: () => Promise<{ data: T }>): Promise<T> {
  try {
    const response = await request();
    return response.data;
  } catch (error) {
    if (!axios.isAxiosError(error)) throw error;
    if (error.message.includes("maxContentLength")) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Downloads are limited to 20 MB per file." });
    }

    const status = error.response?.status;
    const apiError = (error.response?.data as { error?: string | { message?: string } } | undefined)?.error;
    const message = typeof apiError === "string" ? apiError : apiError?.message;
    console.error(`[Drive] API request failed (${status ?? "network"}): ${message || error.message}`);
    throw new TRPCError({
      code: status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "BAD_GATEWAY",
      message: message || `Google Drive returned an HTTP ${status ?? "network"} error.`,
    });
  }
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  localAuth: router({
    status: publicProcedure.query(({ ctx }) => {
      const header = ctx.req.headers.cookie;
      const cookieHeader = Array.isArray(header) ? header.join(";") : header;
      const user = getLocalSessionUser(cookieHeader);
      return {
        authenticated: Boolean(user),
        user: user ? { username: user.username, displayName: user.displayName, role: localRole(user) } : null,
      };
    }),
    login: publicProcedure
      .input(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }))
      .mutation(({ ctx, input }) => {
        const user = getLocalAccounts().find(
          account => safelyMatches(input.username, account.username) && safelyMatches(input.password, account.password)
        );
        if (!user) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "That username or password is not correct." });
        }

        ctx.res.cookie(LOCAL_SESSION_COOKIE, localSessionToken(user.username), localCookieOptions(ctx.req));
        return { success: true, user: { username: user.username, displayName: user.displayName, role: localRole(user) } };
      }),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(LOCAL_SESSION_COOKIE, { ...localCookieOptions(ctx.req), maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  drive: router({
    status: publicProcedure.query(async ({ ctx }) => {
      const header = ctx.req.headers.cookie;
      const cookieHeader = Array.isArray(header) ? header.join(";") : header;
      if (!hasLocalSession(cookieHeader)) {
        return { configured: googleDriveConfigured(), connected: false, accountEmail: null };
      }

      const connection = await db.getGoogleDriveConnection(DRIVE_CONNECTION_KEY);
      return {
        configured: googleDriveConfigured(),
        connected: Boolean(connection),
        accountEmail: connection?.accountEmail || null,
      };
    }),
    getAuthorizationUrl: publicProcedure.mutation(({ ctx }) => {
      requireLocalAdmin(ctx);
      const url = buildGoogleAuthorizationUrl();
      if (!url) {
        return {
          configured: false,
          url: null,
          message: "Google OAuth needs a client ID, client secret, and approved redirect URL before it can connect.",
        };
      }

      return { configured: true, url, message: "Opening secure Google authorization…" };
    }),
    completeConnection: publicProcedure
      .input(z.object({ code: z.string().min(1), state: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        requireLocalAdmin(ctx);
        const clientId = getRuntimeEnv("GOOGLE_CLIENT_ID");
        const clientSecret = getRuntimeEnv("GOOGLE_CLIENT_SECRET");
        const redirectUri = getRuntimeEnv("GOOGLE_REDIRECT_URI");
        if (!googleDriveConfigured()) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Google Drive credentials are not configured yet." });
        }
        if (!validateState(input.state)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This Google Drive connection request expired. Please try again." });
        }

        const tokenResponse = await googleHttp().post<TokenResponse>(
          "https://oauth2.googleapis.com/token",
          new URLSearchParams({
            code: input.code,
            client_id: clientId!,
            client_secret: clientSecret!,
            redirect_uri: redirectUri!,
            grant_type: "authorization_code",
          }),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );

        const profile = await googleHttp().get<{ email?: string }>("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
        });

        await db.saveGoogleDriveConnection({
          connectionKey: DRIVE_CONNECTION_KEY,
          accountEmail: profile.data.email || null,
          accessToken: tokenResponse.data.access_token,
          refreshToken: tokenResponse.data.refresh_token || null,
          scope: tokenResponse.data.scope || DRIVE_SCOPES,
          expiresAt: new Date(Date.now() + tokenResponse.data.expires_in * 1000),
        });

        return { success: true, accountEmail: profile.data.email || null };
      }),
    listFiles: publicProcedure.query(async ({ ctx }) => {
      requireLocalSession(ctx);
      const accessToken = await getActiveDriveToken();
      const response = await withDriveApiErrors(() => googleHttp().get<{ files?: GoogleFile[] }>("https://www.googleapis.com/drive/v3/files", {
        params: {
          pageSize: 100,
          q: "trashed = false",
          orderBy: "folder,name",
          fields: "files(id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),sharedWithMeTime)",
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      }));

      return response.files || [];
    }),
    listSharedFiles: publicProcedure.query(async ({ ctx }) => {
      requireLocalSession(ctx);
      const accessToken = await getActiveDriveToken();
      const response = await withDriveApiErrors(() => googleHttp().get<{ files?: GoogleFile[] }>("https://www.googleapis.com/drive/v3/files", {
        params: {
          pageSize: 100,
          q: "sharedWithMe and trashed = false",
          orderBy: "sharedWithMeTime desc",
          fields: "files(id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),sharedWithMeTime)",
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      }));

      return response.files || [];
    }),
    download: publicProcedure
      .input(z.object({ fileId: z.string().min(1).max(1024) }))
      .mutation(async ({ ctx, input }) => {
        requireLocalSession(ctx);
        const accessToken = await getActiveDriveToken();
        const headers = { Authorization: `Bearer ${accessToken}` };
        const fileId = encodeURIComponent(input.fileId);
        const metadata = await withDriveApiErrors(() =>
          googleHttp().get<{ id: string; name: string; mimeType: string; size?: string }>(
            `https://www.googleapis.com/drive/v3/files/${fileId}`,
            { params: { fields: "id,name,mimeType,size" }, headers }
          )
        );

        if (metadata.mimeType === "application/vnd.google-apps.folder") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Folders cannot be downloaded as individual files." });
        }
        const googleExport = GOOGLE_WORKSPACE_EXPORTS[metadata.mimeType];
        if (metadata.mimeType.startsWith("application/vnd.google-apps.") && !googleExport) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This Google Workspace file type cannot be downloaded here." });
        }
        const size = Number(metadata.size);
        if (Number.isFinite(size) && size > MAX_DRIVE_DOWNLOAD_BYTES) {
          throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Downloads are limited to 20 MB per file." });
        }

        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}${googleExport ? "/export" : ""}`;
        const content = await withDriveApiErrors(() =>
          googleHttp().get<ArrayBuffer>(downloadUrl, {
            params: googleExport ? { mimeType: googleExport.mimeType } : { alt: "media" },
            headers,
            responseType: "arraybuffer",
            maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES,
          })
        );
        const bytes = Buffer.from(content);
        if (bytes.byteLength > MAX_DRIVE_DOWNLOAD_BYTES) {
          throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Downloads are limited to 20 MB per file." });
        }

        const filename = metadata.name.replaceAll("/", "_").replaceAll(String.fromCharCode(92), "_").slice(0, 255) || "download";
        const extensionIndex = filename.lastIndexOf(".");
        const baseName = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
        return {
          fileName: googleExport ? `${baseName}${googleExport.extension}` : filename,
          mimeType: googleExport?.mimeType || metadata.mimeType,
          contentBase64: bytes.toString("base64"),
        };
      }),
    upload: publicProcedure
      .input(
        z.object({
          fileName: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(180),
          contentBase64: z.string().min(1).max(MAX_BASE64_UPLOAD_CHARS),
        })
      )
      .mutation(async ({ ctx, input }) => {
        requireLocalSession(ctx);
        const accessToken = await getActiveDriveToken();
        const content = Buffer.from(input.contentBase64, "base64");
        if (content.byteLength > MAX_DRIVE_UPLOAD_BYTES) {
          throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Uploads are limited to 20 MB per file." });
        }

        if (content.byteLength > MULTIPART_UPLOAD_MAX_BYTES) {
          const session = await withDriveApiErrors(async () => {
            const response = await googleHttp().post<{ id?: string }>(
              "https://www.googleapis.com/upload/drive/v3/files",
              { name: input.fileName, mimeType: input.mimeType },
              {
                params: { uploadType: "resumable", fields: "id,name,mimeType,modifiedTime,size" },
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json; charset=UTF-8",
                  "X-Upload-Content-Type": input.mimeType,
                  "X-Upload-Content-Length": String(content.byteLength),
                },
              }
            );
            return { data: { uploadUrl: response.headers.location as string | undefined } };
          });

          if (!session.uploadUrl) {
            throw new TRPCError({ code: "BAD_GATEWAY", message: "Google Drive did not start the large-file upload." });
          }

          return withDriveApiErrors(() =>
            googleHttp().put<GoogleFile>(session.uploadUrl!, content, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": input.mimeType,
                "Content-Length": String(content.byteLength),
              },
              maxBodyLength: MAX_DRIVE_UPLOAD_BYTES,
              maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES,
            })
          );
        }

        const boundary = `ezio_${crypto.randomUUID()}`;
        const body = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: input.fileName })}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`
          ),
          content,
          Buffer.from(`\r\n--${boundary}--`),
        ]);

        return withDriveApiErrors(() => googleHttp().post<GoogleFile>(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size",
          body,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": `multipart/related; boundary=${boundary}`,
              "Content-Length": body.length,
            },
            maxBodyLength: MAX_DRIVE_UPLOAD_BYTES,
            maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES,
          }
        ));
      }),
  }),
  links: createSharedLinksRouter({ requireLocalSession, requireLocalAdmin }),
});

export type AppRouter = typeof appRouter;
