import { getActiveDriveToken, getLocalSessionUser } from "../routers";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const GOOGLE_WORKSPACE_EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  },
  "application/vnd.google-apps.presentation": { mimeType: "application/pdf", extension: ".pdf" },
  "application/vnd.google-apps.drawing": { mimeType: "image/svg+xml", extension: ".svg" },
};

function jsonError(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

async function googleErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string | { message?: string } };
    if (typeof payload.error === "string") return payload.error;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // The upstream may return a non-JSON error body.
  }
  return `Google Drive returned HTTP ${response.status}.`;
}

function safeFileName(name: string, extension = "") {
  const sanitized = name
    .replaceAll("/", "_")
    .replaceAll(String.fromCharCode(92), "_")
    .replace(/[\u0000-\u001f\u007f";]/g, "_")
    .slice(0, 255) || "download";
  const finalName = extension && !sanitized.toLowerCase().endsWith(extension) ? `${sanitized}${extension}` : sanitized;
  const asciiFallback = finalName.replace(/[^\x20-\x7e]/g, "_");
  return { finalName, asciiFallback };
}

export async function handleCloudflareDriveDownload(request: Request): Promise<Response> {
  const user = getLocalSessionUser(request.headers.get("cookie") ?? undefined);
  if (!user) return jsonError(401, "Please sign in to download files.");

  const url = new URL(request.url);
  const fileId = url.searchParams.get("fileId");
  if (!fileId || fileId.length > 1024) return jsonError(400, "A valid Google Drive file ID is required.");

  try {
    const accessToken = await getActiveDriveToken();
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    metadataUrl.searchParams.set("fields", "id,name,mimeType,size");
    const metadataResponse = await fetch(metadataUrl, { headers: authHeaders });
    if (!metadataResponse.ok) {
      return jsonError(
        metadataResponse.status === 401 || metadataResponse.status === 403 ? metadataResponse.status : 502,
        await googleErrorMessage(metadataResponse),
      );
    }

    const metadata = (await metadataResponse.json()) as { name: string; mimeType: string; size?: string };
    if (metadata.mimeType === "application/vnd.google-apps.folder") {
      return jsonError(400, "Folders cannot be downloaded as individual files.");
    }
    const exportInfo = GOOGLE_WORKSPACE_EXPORTS[metadata.mimeType];
    if (metadata.mimeType.startsWith("application/vnd.google-apps.") && !exportInfo) {
      return jsonError(400, "This Google Workspace file type cannot be downloaded here.");
    }
    const reportedSize = Number(metadata.size);
    if (Number.isFinite(reportedSize) && reportedSize > MAX_DOWNLOAD_BYTES) {
      return jsonError(413, "Downloads are limited to 20 MB per file.");
    }

    const contentUrl = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}${exportInfo ? "/export" : ""}`,
    );
    if (exportInfo) contentUrl.searchParams.set("mimeType", exportInfo.mimeType);
    else contentUrl.searchParams.set("alt", "media");

    const contentResponse = await fetch(contentUrl, { headers: authHeaders });
    if (!contentResponse.ok || !contentResponse.body) {
      return jsonError(
        contentResponse.status === 401 || contentResponse.status === 403 ? contentResponse.status : 502,
        contentResponse.ok ? "Google Drive returned an empty file." : await googleErrorMessage(contentResponse),
      );
    }

    const upstreamLength = Number(contentResponse.headers.get("content-length"));
    if (Number.isFinite(upstreamLength) && upstreamLength > MAX_DOWNLOAD_BYTES) {
      return jsonError(413, "Downloads are limited to 20 MB per file.");
    }

    const { finalName, asciiFallback } = safeFileName(metadata.name, exportInfo?.extension);
    const headers = new Headers({
      "Content-Type": exportInfo?.mimeType || metadata.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(finalName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (Number.isFinite(upstreamLength) && upstreamLength > 0) headers.set("Content-Length", String(upstreamLength));

    let totalBytes = 0;
    const limitedBody = contentResponse.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_DOWNLOAD_BYTES) {
            controller.error(new Error("Downloads are limited to 20 MB per file."));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limitedBody, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The download failed.";
    console.error("[Cloudflare Drive Download]", message);
    return jsonError(502, message);
  }
}
