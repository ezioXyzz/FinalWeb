import { getActiveDriveToken, getLocalSessionUser } from "../routers";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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

export async function handleCloudflareDriveUpload(request: Request): Promise<Response> {
  const user = getLocalSessionUser(request.headers.get("cookie") ?? undefined);
  if (!user) return jsonError(401, "Please sign in to upload files.");

  const rawName = request.headers.get("x-file-name");
  const rawLength = request.headers.get("x-file-size");
  const transportLength = request.headers.get("content-length");
  const mimeType = request.headers.get("x-file-type") || "application/octet-stream";
  if (!rawName || !rawLength || !request.body) {
    return jsonError(400, "File name, size, and file content are required.");
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(rawName)
      .replaceAll("/", "_")
      .replaceAll(String.fromCharCode(92), "_")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 255);
  } catch {
    return jsonError(400, "The file name is invalid.");
  }

  const contentLength = Number(rawLength);
  if (
    !fileName ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    (transportLength !== null && Number(transportLength) !== contentLength)
  ) {
    return jsonError(400, "The file name or size is invalid.");
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    return jsonError(413, "Uploads are limited to 20 MB per file.");
  }
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) || mimeType.length > 180) {
    return jsonError(400, "The file type is invalid.");
  }

  try {
    const accessToken = await getActiveDriveToken();
    const sessionResponse = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(contentLength),
        },
        body: JSON.stringify({ name: fileName, mimeType }),
      },
    );

    if (!sessionResponse.ok) {
      return jsonError(
        sessionResponse.status === 401 || sessionResponse.status === 403 ? sessionResponse.status : 502,
        await googleErrorMessage(sessionResponse),
      );
    }

    const uploadUrl = sessionResponse.headers.get("location");
    if (!uploadUrl) return jsonError(502, "Google Drive did not start the file upload.");

    const uploadBody = new FixedLengthStream(contentLength);
    const [uploadResponse] = await Promise.all([
      fetch(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": mimeType,
        },
        // Workers derives the required Content-Length from FixedLengthStream.
        body: uploadBody.readable,
      }),
      request.body.pipeTo(uploadBody.writable),
    ]);

    if (!uploadResponse.ok) {
      return jsonError(
        uploadResponse.status === 401 || uploadResponse.status === 403 ? uploadResponse.status : 502,
        await googleErrorMessage(uploadResponse),
      );
    }

    const uploadedFile = await uploadResponse.json();
    return Response.json(uploadedFile, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The upload failed.";
    console.error("[Cloudflare Drive Upload]", message);
    return jsonError(502, message);
  }
}
