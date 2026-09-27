import { fetchRequestHandler, type FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { runWithWorkerBindings, type EzioCloudWorkerBindings } from "./cloudflare-runtime";
import { handleCloudflareDriveDownload } from "./cloudflare/drive-download";
import { handleCloudflareDriveUpload } from "./cloudflare/drive-upload";

interface WorkerEnvironment extends EzioCloudWorkerBindings {
  DB: NonNullable<EzioCloudWorkerBindings["DB"]>;
  ASSETS: NonNullable<EzioCloudWorkerBindings["ASSETS"]>;
}

function serializeCookie(name: string, value: string, options: Record<string, unknown> = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (typeof options.maxAge === "number") {
    // Express accepts milliseconds while Set-Cookie Max-Age is expressed in seconds.
    parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  }
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (typeof options.domain === "string" && options.domain) parts.push(`Domain=${options.domain}`);
  if (typeof options.path === "string" && options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    const sameSite = options.sameSite === true ? "Strict" : String(options.sameSite);
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1).toLowerCase()}`);
  }
  return parts.join("; ");
}

function createCloudflareTrpcContext({ req, resHeaders }: FetchCreateContextFnOptions): TrpcContext {
  const expressRequest = {
    protocol: new URL(req.url).protocol.replace(":", ""),
    headers: Object.fromEntries(req.headers.entries()),
  };
  const expressResponse = {
    cookie(name: string, value: string, options?: Record<string, unknown>) {
      resHeaders.append("Set-Cookie", serializeCookie(name, value, options));
    },
    clearCookie(name: string, options?: Record<string, unknown>) {
      resHeaders.append(
        "Set-Cookie",
        serializeCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) }),
      );
    },
  };

  // Existing tRPC procedures use only Express-compatible headers/protocol and cookie methods.
  return { req: expressRequest, res: expressResponse, user: null } as unknown as TrpcContext;
}

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/api/health") {
      return Response.json({ ok: true, service: "eziocloud" });
    }

    if (pathname === "/api/drive/upload" && request.method === "POST") {
      return runWithWorkerBindings(env, () => handleCloudflareDriveUpload(request));
    }

    if (pathname === "/api/drive/download" && request.method === "GET") {
      return runWithWorkerBindings(env, () => handleCloudflareDriveDownload(request));
    }

    if (pathname === "/api/trpc" || pathname.startsWith("/api/trpc/")) {
      return runWithWorkerBindings(env, () =>
        fetchRequestHandler({
          endpoint: "/api/trpc",
          req: request,
          router: appRouter,
          createContext: createCloudflareTrpcContext,
        }),
      );
    }

    if (pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (pathname.startsWith("/manus-storage/")) {
      return new Response("This asset path is no longer used by EzioCloud.", { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
