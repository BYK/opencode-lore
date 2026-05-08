/**
 * GHCR (GitHub Container Registry) Client
 *
 * Encapsulates the OCI download protocol for fetching nightly CLI binaries
 * from ghcr.io/BYK/loreai. Nightly builds are pushed as OCI artifacts
 * via ORAS with the version baked into the manifest annotation.
 *
 * Key design decisions:
 * - Anonymous access: nightly package is public; no token needed beyond the
 *   standard ghcr.io anonymous token exchange.
 * - Version discovery from manifest annotation: `annotations.version` in the
 *   OCI manifest holds the nightly version.
 * - Redirect quirk: ghcr.io blob downloads return 307 to Azure Blob Storage.
 *   Using `fetch` with `redirect: "follow"` would forward the Authorization
 *   header to Azure, which returns 404. Must follow the redirect manually
 *   without the auth header.
 *
 * Adapted from Sentry CLI's ghcr.ts for Lore.
 */

import { getUserAgent } from "./binary";
import { UpgradeError } from "./errors";

/** Default timeout for GHCR HTTP requests (10 seconds) */
const GHCR_REQUEST_TIMEOUT = 10_000;

/** Maximum number of retry attempts for transient failures */
const GHCR_MAX_RETRIES = 1;

/** Timeout for large blob downloads (30 seconds) */
const GHCR_BLOB_TIMEOUT = 30_000;

function isRetryableError(error: Error): boolean {
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

function buildSignal(
  timeout: number,
  externalSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
}

function isExternalAbort(error: Error, externalSignal?: AbortSignal): boolean {
  return Boolean(externalSignal?.aborted && error.name === "AbortError");
}

type RetryOptions = {
  timeout?: number;
  signal?: AbortSignal;
};

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  context: string,
  options?: RetryOptions,
): Promise<Response> {
  const timeout = options?.timeout ?? GHCR_REQUEST_TIMEOUT;
  const externalSignal = options?.signal;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= GHCR_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: buildSignal(timeout, externalSignal),
      });
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isExternalAbort(lastError, externalSignal)) {
        break;
      }
      if (attempt >= GHCR_MAX_RETRIES || !isRetryableError(lastError)) {
        break;
      }
    }
  }

  throw new UpgradeError(
    "network_error",
    `${context}: ${lastError?.message ?? "unknown error"}`,
  );
}

/** GHCR repository for Lore distribution */
export const GHCR_REPO = "BYK/loreai";

/** OCI tag for nightly builds */
export const GHCR_TAG = "nightly";

/** Base URL for GHCR registry API */
const GHCR_REGISTRY = "https://ghcr.io";

/** OCI manifest media type */
const OCI_MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

/** A single layer entry from an OCI manifest. */
export type OciLayer = {
  digest: string;
  mediaType: string;
  size: number;
  annotations?: Record<string, string>;
};

/** OCI image manifest returned by the registry. */
export type OciManifest = {
  schemaVersion: number;
  mediaType?: string;
  config?: OciLayer;
  layers: OciLayer[];
  annotations?: Record<string, string>;
};

/**
 * Fetch a short-lived anonymous bearer token for read-only access to the
 * public ghcr.io/BYK/loreai package.
 */
export async function getAnonymousToken(
  signal?: AbortSignal,
): Promise<string> {
  const url = `${GHCR_REGISTRY}/token?scope=repository:${GHCR_REPO}:pull`;
  const response = await fetchWithRetry(
    url,
    { headers: { "User-Agent": getUserAgent() } },
    "Failed to connect to GHCR",
    { signal },
  );

  if (!response.ok) {
    throw new UpgradeError(
      "network_error",
      `GHCR token exchange failed: HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new UpgradeError(
      "network_error",
      "GHCR token exchange returned no token",
    );
  }

  return data.token;
}

/**
 * Fetch the OCI manifest for an arbitrary tag from GHCR.
 */
export async function fetchManifest(
  token: string,
  tag: string,
  signal?: AbortSignal,
): Promise<OciManifest> {
  const url = `${GHCR_REGISTRY}/v2/${GHCR_REPO}/manifests/${tag}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: OCI_MANIFEST_TYPE,
        "User-Agent": getUserAgent(),
      },
    },
    `Failed to fetch manifest for tag "${tag}"`,
    { signal },
  );

  if (!response.ok) {
    throw new UpgradeError(
      "network_error",
      `Failed to fetch manifest for tag "${tag}": HTTP ${response.status}`,
    );
  }

  return (await response.json()) as OciManifest;
}

/**
 * Fetch the OCI manifest for the `:nightly` tag.
 */
export async function fetchNightlyManifest(
  token: string,
): Promise<OciManifest> {
  return await fetchManifest(token, GHCR_TAG);
}

/**
 * Extract the nightly version string from a manifest's annotations.
 */
export function getNightlyVersion(manifest: OciManifest): string {
  const version = manifest.annotations?.version;
  if (!version) {
    throw new UpgradeError(
      "network_error",
      "Nightly manifest has no version annotation",
    );
  }
  return version;
}

/**
 * Find the layer matching a given filename in an OCI manifest.
 */
export function findLayerByFilename(
  manifest: OciManifest,
  filename: string,
): OciLayer {
  const layer = manifest.layers.find(
    (l) => l.annotations?.["org.opencontainers.image.title"] === filename,
  );
  if (!layer) {
    throw new UpgradeError(
      "version_not_found",
      `No nightly build found for ${filename}`,
    );
  }
  return layer;
}

/**
 * Download a nightly binary blob from GHCR.
 *
 * The blob endpoint returns a 307 redirect to Azure Blob Storage.
 * Must follow the redirect manually without the Authorization header.
 */
export async function downloadNightlyBlob(
  token: string,
  digest: string,
  signal?: AbortSignal,
): Promise<Response> {
  const blobUrl = `${GHCR_REGISTRY}/v2/${GHCR_REPO}/blobs/${digest}`;

  let blobResponse: Response;
  try {
    blobResponse = await fetch(blobUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": getUserAgent(),
      },
      redirect: "manual",
      signal: buildSignal(GHCR_BLOB_TIMEOUT, signal),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new UpgradeError(
      "network_error",
      `Failed to connect to GHCR: ${msg}`,
    );
  }

  if (blobResponse.status === 200) {
    return blobResponse;
  }

  if (
    blobResponse.status === 301 ||
    blobResponse.status === 302 ||
    blobResponse.status === 307 ||
    blobResponse.status === 308
  ) {
    const redirectUrl = blobResponse.headers.get("location");
    if (!redirectUrl) {
      throw new UpgradeError(
        "network_error",
        `GHCR blob redirect (${blobResponse.status}) had no Location header`,
      );
    }

    let redirectResponse: Response;
    try {
      redirectResponse = await fetch(redirectUrl, {
        headers: { "User-Agent": getUserAgent() },
        signal,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new UpgradeError(
        "network_error",
        `Failed to download from blob storage: ${msg}`,
      );
    }

    if (!redirectResponse.ok) {
      throw new UpgradeError(
        "network_error",
        `Blob storage download failed: HTTP ${redirectResponse.status}`,
      );
    }

    return redirectResponse;
  }

  throw new UpgradeError(
    "network_error",
    `Unexpected GHCR blob response: HTTP ${blobResponse.status}`,
  );
}

/** Page size for tag listing pagination */
const TAGS_PAGE_SIZE = 100;

async function fetchTagPage(
  token: string,
  lastTag?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let url = `${GHCR_REGISTRY}/v2/${GHCR_REPO}/tags/list?n=${TAGS_PAGE_SIZE}`;
  if (lastTag) {
    url += `&last=${encodeURIComponent(lastTag)}`;
  }

  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": getUserAgent(),
      },
    },
    "Failed to list GHCR tags",
    { signal },
  );

  if (!response.ok) {
    throw new UpgradeError(
      "network_error",
      `Failed to list GHCR tags: HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as { tags?: string[] };
  return data.tags ?? [];
}

/**
 * List tags in the GHCR repository, optionally filtered by prefix.
 */
export async function listTags(
  token: string,
  prefix?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const allTags: string[] = [];
  let lastTag: string | undefined;

  for (;;) {
    const tags = await fetchTagPage(token, lastTag, signal);
    if (tags.length === 0) break;

    for (const tag of tags) {
      if (!prefix || tag.startsWith(prefix)) {
        allTags.push(tag);
      }
    }

    if (tags.length < TAGS_PAGE_SIZE) break;
    lastTag = tags.at(-1);
  }

  return allTags;
}

/**
 * Download an OCI layer blob as an ArrayBuffer.
 */
export async function downloadLayerBlob(
  token: string,
  digest: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await downloadNightlyBlob(token, digest, signal);
  return response.arrayBuffer();
}
