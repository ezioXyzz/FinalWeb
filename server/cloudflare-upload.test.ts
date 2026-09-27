import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCloudflareDriveUpload } from "./cloudflare/drive-upload";
import { runWithWorkerBindings, type D1DatabaseBinding, type D1Statement } from "./cloudflare-runtime";

function createFakeD1(connection: Record<string, unknown>): D1DatabaseBinding {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          return connection as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
      };
      return statement as D1Statement;
    },
    async batch() {
      return [];
    },
  };
}

class TestFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expectedLength: number) {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let written = 0;
    this.readable = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write(chunk) {
        written += chunk.byteLength;
        if (written > expectedLength) throw new Error("Fixed-length stream overflow");
        controller.enqueue(chunk);
      },
      close() {
        if (written !== expectedLength) {
          controller.error(new Error("Fixed-length stream ended early"));
          return;
        }
        controller.close();
      },
      abort(reason) {
        controller.error(reason);
      },
    });
  }
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare Drive streaming upload", () => {
  it("uses a fixed-length stream and forwards the exact file bytes to a resumable session", async () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    const now = Date.now();
    const database = createFakeD1({
      id: 1,
      connectionKey: "imira",
      accountEmail: "admin@example.com",
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      scope: "drive.file",
      expiresAt: now + 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    });
    const secret = "test-worker-secret";
    const token = createHmac("sha256", secret).update("local-session:imira").digest("hex");
    const sessionCookie = `imira_cloud_session=imira.${token}`;
    const lengths: number[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    vi.stubGlobal("FixedLengthStream", class extends TestFixedLengthStream {
      constructor(length: number) {
        lengths.push(length);
        super(length);
      }
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-upload-content-length")).toBe(String(payload.byteLength));
        return new Response(null, {
          status: 200,
          headers: { location: "https://upload.example/session/1" },
        });
      }
      if (url === "https://upload.example/session/1") {
        const chunks = await readStream(init?.body as ReadableStream<Uint8Array>);
        expect(chunks).toHaveLength(1);
        expect(Array.from(chunks[0]!)).toEqual(Array.from(payload));
        return Response.json({ id: "file-1", name: "test file.bin", mimeType: "application/octet-stream" });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const request = new Request("https://eziocloud.example/api/drive/upload", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "x-file-name": "test%20file.bin",
        "x-file-type": "application/octet-stream",
        "x-file-size": String(payload.byteLength),
      },
      body: payload,
    });

    const response = await runWithWorkerBindings(
      {
        DB: database,
        JWT_SECRET: secret,
        LOCAL_AUTH_USERS_JSON: JSON.stringify({ imira: "unused-test-password" }),
      },
      () => handleCloudflareDriveUpload(request),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "file-1", name: "test file.bin" });
    expect(lengths).toEqual([payload.byteLength]);
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[1]?.init?.headers).has("content-length")).toBe(false);
  });
});
