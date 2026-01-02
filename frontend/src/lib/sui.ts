import {
  getFullnodeUrl,
  SuiClient,
  type SuiTransactionBlockResponse,
  type SuiTransactionBlockResponseOptions,
} from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { SealClient } from "@mysten/seal";
import { toHex } from "@mysten/sui/utils";
import { blobIdToInt, walrus, type EncodingType } from "@mysten/walrus";
import walrusWasmUrl from "@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url";

// =================================================================
// 設定

const NETWORK = "testnet";
const MIST_PER_SUI = 1_000_000_000;
const SUI_COIN_TYPE = "0x2::sui::SUI";

// Mock DEX (＄WAL)
const MOCK_DEX_PACKAGE_ID =
  "0x048124ed3fe7405b210ea4f28f2d20590749fe65af58dc1e3779f0c6ebd6d091";
const MOCK_DEX_BANK_ID =
  "0x77ce005108e30bde1385cbd2c416bd45cfff59c372ad4da16dae026471fbd0dd";
const WAL_COIN_TYPE =
  "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";

// 部屬合約 pkg id
export const VIDEO_PLATFORM_PACKAGE_ID =
  "0x178f6055d47fd6ffb826c4542887a807b69662c4d3ec1ea5531a6cd1e6efc9db";

// Walrus Aggregator
export const WALRUS_AGGREGATOR_URL =
  "https://aggregator.walrus-testnet.walrus.space/v1/blobs/";
export const WALRUS_AGGREGATOR_FORMAT =
  /(https:\/\/aggregator\.walrus-testnet\.walrus\.space\/v1\/blobs\/[a-zA-Z0-9_-]+)/;

// Walrus Upload Relay
const WALRUS_UPLOAD_RELAY_HOST = "https://upload-relay.testnet.walrus.space";
// Upload relay timeout
const WALRUS_UPLOAD_RELAY_TIMEOUT_MS = 10 * 60_000;

// Optional uploader server (recommended for browsers). When enabled, we will:
// - register blobs owned by the uploader address
// - let the uploader pay relay tips, upload, certify, and transfer blobs back to the user
// Configure via Vite env: VITE_UPLOADER_SERVER_URL (e.g. "/uploader" when using Vite dev proxy)
const UPLOADER_SERVER_URL = import.meta.env.VITE_UPLOADER_SERVER_URL as
  | string
  | undefined;

export const WALRUS_EPOCHS_MAX = 53;

const WALRUS_DEFAULT_EPOCHS = 2;

// Swap buffer to avoid rounding / price drift (in basis points).
// 500 bps = +5%
const WAL_SWAP_BUFFER_BPS = 500n;

type EncodedWalrusBlob = {
  label: string;
  bytes: Uint8Array;
  blobId: string;
  rootHash: Uint8Array;
  nonce: Uint8Array;
  blobDigest: Uint8Array;
  encodingType: EncodingType;
  contentType?: string;
};

function getCreatedObjectsByTypeFromObjectChanges(
  objectChanges: NonNullable<SuiTransactionBlockResponse["objectChanges"]>,
  objectType: string
): string[] {
  type ObjectChange = NonNullable<
    SuiTransactionBlockResponse["objectChanges"]
  >[number];
  type CreatedChange = Extract<ObjectChange, { type: "created" }>;

  return objectChanges
    .filter((c): c is CreatedChange => c.type === "created")
    .filter((c) => c.objectType === objectType)
    .map((c) => c.objectId);
}

async function getCreatedWalrusBlobObjectIdByBlobId(
  txObjectChanges: NonNullable<SuiTransactionBlockResponse["objectChanges"]>,
  blobId: string
): Promise<string> {
  const blobType = await suiClient.walrus.getBlobType();
  const createdBlobObjectIds = getCreatedObjectsByTypeFromObjectChanges(
    txObjectChanges,
    await Promise.resolve(blobType)
  );

  if (createdBlobObjectIds.length === 0) {
    throw new Error("Walrus register succeeded but no Blob objects found");
  }

  const expectedBlobIdU256 = blobIdToInt(blobId);

  // Resolve which created Blob matches the expected blobId
  for (const objectId of createdBlobObjectIds) {
    const obj = await suiClient.getObject({
      id: objectId,
      options: { showContent: true },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = obj.data?.content as any;
    const fields = content?.fields;

    // Walrus stores `blob_id` on-chain as `u256` (stringified in Sui JSON),
    // while `encodeBlob()` returns a base64url string blobId.
    const onChainBlobId = fields?.blob_id ?? fields?.blobId;
    if (typeof onChainBlobId === "string") {
      try {
        if (BigInt(onChainBlobId) === expectedBlobIdU256) return objectId;
      } catch {
        // ignore parse errors and keep searching
      }
    } else if (typeof onChainBlobId === "bigint") {
      if (onChainBlobId === expectedBlobIdU256) return objectId;
    } else if (typeof onChainBlobId === "number") {
      if (BigInt(onChainBlobId) === expectedBlobIdU256) return objectId;
    }
  }

  throw new Error(`Walrus Blob objectId not found for blobId=${blobId}`);
}

// init Client
export const suiClient = new SuiClient({
  url: getFullnodeUrl(NETWORK),
  network: NETWORK,
}).$extend(
  walrus({
    // Ensure the Walrus WASM binary is fetched from a valid URL served by Vite
    // (avoids SPA fallback returning HTML for the wasm request).
    wasmUrl: walrusWasmUrl,

    // Use the official testnet upload relay for off-chain uploads.
    // This is required because direct-to-node uploads often fail in browsers due to TLS/cert issues.
    uploadRelay: {
      host: WALRUS_UPLOAD_RELAY_HOST,
      // Enable tipping so the SDK includes (tx_id, nonce) when uploading.
      // We'll pay the tip in the SAME C.1 registerTx (single prompt for registerTx).
      sendTip: { max: 2_000 },
      timeout: WALRUS_UPLOAD_RELAY_TIMEOUT_MS,
    },
  })
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let uploaderAddressPromise: Promise<string> | null = null;

async function getUploaderAddressOrThrow(): Promise<string> {
  if (!UPLOADER_SERVER_URL) {
    throw new Error("Uploader server is not configured");
  }

  if (!uploaderAddressPromise) {
    uploaderAddressPromise = (async () => {
      const resp = await fetch(`${UPLOADER_SERVER_URL}/healthz`);
      if (!resp.ok) {
        throw new Error(
          `Uploader server health check failed: HTTP ${resp.status}`
        );
      }
      const json = (await resp.json()) as { address?: string };
      if (!json?.address) {
        throw new Error("Uploader server healthz missing address");
      }
      return json.address;
    })();
  }

  return uploaderAddressPromise;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function uploadBlobViaUploaderServer(input: {
  blobId: string;
  blobObjectId: string;
  encodingType: EncodingType;
  nonce: Uint8Array;
  deletable: boolean;
  userAddress: string;
  bytes: Uint8Array;
}): Promise<{ tipTxDigest: string; certifyDigest: string }> {
  if (!UPLOADER_SERVER_URL) {
    throw new Error("Uploader server is not configured");
  }

  const params = new URLSearchParams();
  params.set("blob_id", input.blobId);
  params.set("blob_object_id", input.blobObjectId);
  params.set("encoding_type", String(input.encodingType));
  params.set("nonce", base64UrlEncode(input.nonce));
  params.set("user", input.userAddress);
  params.set("deletable", String(input.deletable));

  const url = `${UPLOADER_SERVER_URL}/v1/upload?${params.toString()}`;

  // Ensure the Blob is backed by an ArrayBuffer (avoids TS/DOM typing issues with ArrayBufferLike).
  const bodyBytes = new Uint8Array(input.bytes.byteLength);
  bodyBytes.set(input.bytes);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Blob([bodyBytes]),
  });

  const text = await resp.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!resp.ok) {
    throw new Error(
      `Uploader server upload failed: HTTP ${resp.status} ${
        text || resp.statusText
      }`
    );
  }

  const parsed = json as
    | { ok?: unknown; tipTxDigest?: unknown; certifyDigest?: unknown }
    | null
    | undefined;

  if (
    !parsed ||
    parsed.ok !== true ||
    typeof parsed.tipTxDigest !== "string" ||
    typeof parsed.certifyDigest !== "string"
  ) {
    throw new Error(`Uploader server unexpected response: ${text}`);
  }

  return {
    tipTxDigest: parsed.tipTxDigest,
    certifyDigest: parsed.certifyDigest,
  };
}

async function buildUploadRelayAuthPayload(input: {
  blobDigest: Uint8Array;
  nonce: Uint8Array;
  size: number;
}): Promise<Uint8Array> {
  const nonceBytes = new Uint8Array(input.nonce);
  const nonceDigest = await crypto.subtle.digest(
    "SHA-256",
    nonceBytes as unknown as BufferSource
  );
  // u64 little-endian
  const lengthBytes = new Uint8Array(8);
  new DataView(lengthBytes.buffer).setBigUint64(0, BigInt(input.size), true);
  const authPayload = new Uint8Array(
    input.blobDigest.byteLength +
      nonceDigest.byteLength +
      lengthBytes.byteLength
  );
  authPayload.set(input.blobDigest, 0);
  authPayload.set(new Uint8Array(nonceDigest), input.blobDigest.byteLength);
  authPayload.set(
    lengthBytes,
    input.blobDigest.byteLength + nonceDigest.byteLength
  );
  return authPayload;
}

// (debug helper removed)

function isDebugWalrusRelayEnabled() {
  try {
    // Toggle via DevTools: localStorage.setItem('DEBUG_WALRUS_RELAY','1')
    return (
      typeof window !== "undefined" &&
      window.localStorage.getItem("DEBUG_WALRUS_RELAY") === "1"
    );
  } catch {
    return false;
  }
}

function isLikelyTimeoutError(err: unknown) {
  // In browsers, AbortSignal.timeout may yield DOMException with name "TimeoutError".
  // Walrus SDK currently only maps AbortError; so we handle both.
  if (!err || typeof err !== "object") return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  const name = String(anyErr.name ?? "");
  const message = String(anyErr.message ?? "");
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    message.toLowerCase().includes("timed out") ||
    message.toLowerCase().includes("timeout")
  );
}
export const sealClient = new SealClient({
  suiClient,
  serverConfigs: [
    {
      objectId:
        "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
      weight: 1,
    },
    {
      objectId:
        "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
      weight: 1,
    },
  ],
  verifyKeyServers: false,
  timeout: 30000,
});

// 使用 Seal 加密 AES Key
async function encryptKeyWithSeal(aesKey: Uint8Array, sealId: Uint8Array) {
  const client = new SealClient({
    suiClient,
    serverConfigs: [
      {
        objectId:
          "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
        weight: 1,
      },
      {
        objectId:
          "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
        weight: 1,
      },
    ],
    verifyKeyServers: false,
  });

  const { encryptedObject } = await client.encrypt({
    threshold: 1,
    packageId: VIDEO_PLATFORM_PACKAGE_ID,
    id: toHex(sealId),
    data: aesKey,
  });

  return encryptedObject;
}

// 上傳影片資產（C.1: 單筆 PTB 原子化 register + create_video，交易後再上傳 bytes）
export async function uploadVideoAssetsFlow(
  assets: {
    video: Uint8Array;
    m3u8: string;
    cover: File;
    aesKey: Uint8Array;
  },
  metadata: { title: string; description: string; price: number },
  account: string,
  signAndExecuteTransaction: (input: {
    transaction: Transaction;
    options?: SuiTransactionBlockResponseOptions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => Promise<any>,
  onStatusUpdate?: (status: string) => void
) {
  // =============================================================
  // C.1 (Same PTB / Atomic register)
  // - Encode blobs locally
  // - Build ONE transaction:
  //   1) (TODO) your Move PTB for WAL source / escrow / approve
  //   2) register Walrus blobs (on-chain)
  //   3) call your app contract to store metadata (create_video)
  // - After digest: upload bytes to nodes
  // - Then certify (optional but recommended)

  const epochs = WALRUS_DEFAULT_EPOCHS; // TODO: make configurable (u64)
  const deletable = true; // TODO: set based on your policy
  const owner = account;

  const useUploaderServer = Boolean(UPLOADER_SERVER_URL);
  const uploaderAddress = useUploaderServer
    ? await getUploaderAddressOrThrow()
    : null;
  const walrusBlobOwner = uploaderAddress ?? owner;

  // 1) Seal encrypt key
  onStatusUpdate?.("Encrypting AES Key with Seal...");
  const sealId = new Uint8Array(32);
  crypto.getRandomValues(sealId);
  const encryptedKey = await encryptKeyWithSeal(assets.aesKey, sealId);

  // 2) Prepare bytes for each blob
  onStatusUpdate?.("Preparing files...");
  const m3u8Bytes = new TextEncoder().encode(assets.m3u8);
  const coverBytes = new Uint8Array(await assets.cover.arrayBuffer());

  // 3) Encode each blob (generates blobId + rootHash + slivers)
  onStatusUpdate?.("Preparing Walrus metadata...");
  const encoded: EncodedWalrusBlob[] = [];

  // Pin blob-metadata computation to a single shard count for consistency.
  const walrusSystemState = await suiClient.walrus.systemState();
  const numShards = walrusSystemState.committee.n_shards;

  const encodeOne = async (
    label: string,
    bytes: Uint8Array,
    contentType?: string
  ) => {
    const result = await suiClient.walrus.computeBlobMetadata({
      bytes,
      numShards,
    });
    // NOTE: The Walrus WASM layer may return Uint8Array views backed by shared WASM memory.
    // To avoid subtle mutations across subsequent WASM calls (which can break upload-relay auth),
    // eagerly materialize/copy all buffers we rely on later.
    const blobDigestBytes = await result.blobDigest();
    encoded.push({
      label,
      bytes,
      blobId: result.blobId,
      rootHash: new Uint8Array(result.rootHash),
      nonce: new Uint8Array(result.nonce),
      blobDigest: new Uint8Array(blobDigestBytes),
      encodingType: result.metadata.encodingType as EncodingType,
      contentType,
    });
  };

  await encodeOne("video", assets.video, "application/octet-stream");
  await encodeOne("m3u8", m3u8Bytes, "application/vnd.apple.mpegurl");
  await encodeOne("cover", coverBytes, assets.cover.type || "image/png");
  await encodeOne("key", encryptedKey, "application/octet-stream");

  const videoBlobId = encoded.find((b) => b.label === "video")!.blobId;
  const m3u8BlobId = encoded.find((b) => b.label === "m3u8")!.blobId;
  const coverBlobId = encoded.find((b) => b.label === "cover")!.blobId;
  const keyBlobId = encoded.find((b) => b.label === "key")!.blobId;

  // NOTE: The upload-relay flow is effectively 1 blob per txDigest.
  // For multi-blob uploads in browsers, prefer enabling the uploader-server.
  const RELAY_BLOB_LABEL: EncodedWalrusBlob["label"] = "video";

  // 3.5) Estimate WAL required for all register operations, then swap SUI->WAL via mock_dex
  // NOTE: Walrus register consumes WAL for BOTH storage reservation and write fee.
  onStatusUpdate?.("Estimating WAL costs...");
  let totalWalNeeded = 0n;
  for (const blob of encoded) {
    const { totalCost } = await suiClient.walrus.storageCost(
      blob.bytes.length,
      epochs
    );
    totalWalNeeded += totalCost;
  }

  // mock_dex rate: WAL = SUI / 2  (both are 9 decimals)
  // Add a small buffer to avoid rounding / price drift.
  const totalSuiToSwap =
    (totalWalNeeded * 2n * (10_000n + WAL_SWAP_BUFFER_BPS)) / 10_000n + 1n;

  onStatusUpdate?.(
    `Estimated WAL needed: ${totalWalNeeded.toString()} (mist). Swapping SUI: ${totalSuiToSwap.toString()} (mist).`
  );

  // 4) Build ONE transaction: (Move PTB) -> (register blobs) -> (create_video)
  onStatusUpdate?.("Building atomic transaction (PTB)...");
  const registerTx = new Transaction();
  registerTx.setSenderIfNotSet(owner);

  // 4.0 Upload-relay auth + tip (SUI)
  // - If using uploader-server, tips are paid server-side per blob.
  // - Otherwise, we only include a relay tip for the largest blob.
  if (!useUploaderServer) {
    const relayBlob = encoded.find((b) => b.label === RELAY_BLOB_LABEL);
    if (!relayBlob) {
      throw new Error(`Missing relay blob label=${RELAY_BLOB_LABEL}`);
    }
    registerTx.add(
      suiClient.walrus.sendUploadRelayTip({
        size: relayBlob.bytes.length,
        blobDigest: relayBlob.blobDigest,
        nonce: relayBlob.nonce,
      })
    );
  }

  // 4.1 WAL source: Swap SUI -> WAL via mock_dex in the SAME tx (C.1)
  // This produces a Coin<WAL> that we pass into Walrus register as `walCoin`.
  // If you later move WAL sourcing into your own Move module, replace this block.
  onStatusUpdate?.("Swapping SUI -> WAL (mock_dex)...");
  const [suiForWal] = registerTx.splitCoins(registerTx.gas, [
    registerTx.pure.u64(totalSuiToSwap),
  ]);
  const walCoin = registerTx.moveCall({
    target: `${MOCK_DEX_PACKAGE_ID}::mock_dex::swap_sui_for_token`,
    typeArguments: [WAL_COIN_TYPE],
    arguments: [registerTx.object(MOCK_DEX_BANK_ID), suiForWal],
  });

  // 4.2 Walrus register (on-chain) for each blob
  for (const blob of encoded) {
    suiClient.walrus.registerBlobTransaction({
      transaction: registerTx,
      owner: walrusBlobOwner,
      size: blob.bytes.length,
      epochs,
      deletable,
      blobId: blob.blobId,
      rootHash: blob.rootHash,
      attributes: blob.contentType
        ? { "content-type": blob.contentType }
        : undefined,
      walCoin,
    });
  }

  // Walrus internally `splitCoins(walCoin, [amount])` for fees, leaving a remainder.
  // Ensure the remainder is transferred, otherwise dry-run fails with UnusedValueWithoutDrop.
  registerTx.transferObjects([walCoin], owner);

  // 4.3 App contract call: create video metadata on-chain
  registerTx.moveCall({
    target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::create_video`,
    arguments: [
      registerTx.pure.string(metadata.title),
      registerTx.pure.string(metadata.description),
      registerTx.pure.string(m3u8BlobId),
      registerTx.pure.string(videoBlobId),
      registerTx.pure.string(coverBlobId),
      registerTx.pure.vector("u8", Array.from(sealId)),
      registerTx.pure.string(keyBlobId),
      registerTx.pure.u64(metadata.price),
    ],
  });

  // 5) Execute register tx
  onStatusUpdate?.("Signing & executing register transaction...");
  const registerResult = await signAndExecuteTransaction({
    transaction: registerTx,
    options: { showEffects: true, showObjectChanges: true },
  });

  const registerDigest: string = registerResult.digest;

  // Important: wallet execution and our configured fullnode may differ.
  // Wait until THIS fullnode can see the transaction, otherwise follow-up queries may 404.
  onStatusUpdate?.("Waiting for transaction to be available on RPC...");
  const registerTxBlock = await suiClient.waitForTransaction({
    digest: registerDigest,
    options: {
      showObjectChanges: true,
      showEffects: true,
    },
    timeout: 60_000,
  });

  if (isDebugWalrusRelayEnabled()) {
    if (useUploaderServer) {
      console.log(
        "[walrus-relay-debug] uploader server enabled; skipping relay auth checks"
      );
    } else {
      try {
        const txWithInput = await suiClient.getTransactionBlock({
          digest: registerDigest,
          options: { showInput: true },
        });
        // Sui RPC showInput returns structured inputs (arrays of numbers), not base64.
        // Compare against the actual bytes instead of string-searching JSON.
        const inputs = (
          txWithInput as unknown as {
            transaction?: {
              data?: { transaction?: { inputs?: unknown } };
            };
          }
        )?.transaction?.data?.transaction?.inputs;

        const pureByteArrays: Uint8Array[] = [];
        if (Array.isArray(inputs)) {
          for (const inp of inputs) {
            const candidate = inp as { type?: unknown; value?: unknown };
            if (candidate?.type === "pure" && Array.isArray(candidate?.value)) {
              pureByteArrays.push(new Uint8Array(candidate.value));
            }
          }
        }

        for (const blob of encoded) {
          const authPayload = await buildUploadRelayAuthPayload({
            blobDigest: blob.blobDigest,
            nonce: blob.nonce,
            size: blob.bytes.length,
          });

          // Some builders store raw payload bytes (72). Others may store BCS(vector<u8>) bytes.
          // Accept both to avoid false negatives in debug.
          const bcsVectorU8 = new Uint8Array(authPayload.length + 1);
          // ULEB128 for 72 fits in one byte.
          bcsVectorU8[0] = authPayload.length;
          bcsVectorU8.set(authPayload, 1);

          const authInTx = pureByteArrays.some((candidate) => {
            const equals = (a: Uint8Array, b: Uint8Array) => {
              if (a.length !== b.length) return false;
              for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false;
              }
              return true;
            };
            return (
              equals(candidate, authPayload) || equals(candidate, bcsVectorU8)
            );
          });

          const expected = blob.label === RELAY_BLOB_LABEL;
          console.log(
            `[walrus-relay-debug] ${blob.label} blobId=${blob.blobId} authInTx=${authInTx} expected=${expected}`
          );
        }
      } catch (e) {
        console.warn("[walrus-relay-debug] failed to fetch tx input", e);
      }
    }
  }

  const registerObjectChanges = registerTxBlock.objectChanges ?? [];

  // 6) Upload bytes (off-chain) using the tx digest
  onStatusUpdate?.("Uploading blobs...");
  const certificateByBlobId = new Map<string, unknown>();
  const confirmationsByBlobId = new Map<string, unknown>();
  const blobObjectIdByBlobId = new Map<string, string>();

  for (const blob of encoded) {
    const usesRelay = !useUploaderServer && blob.label === RELAY_BLOB_LABEL;
    onStatusUpdate?.(
      `Uploading ${blob.label} (${
        useUploaderServer
          ? "uploader server"
          : usesRelay
          ? "upload relay"
          : "storage nodes"
      })...`
    );
    const blobObjectId = await getCreatedWalrusBlobObjectIdByBlobId(
      registerObjectChanges,
      blob.blobId
    );
    blobObjectIdByBlobId.set(blob.blobId, blobObjectId);

    // Retry on timeout (no extra wallet prompts; this is purely HTTP)
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (useUploaderServer) {
          await uploadBlobViaUploaderServer({
            blobId: blob.blobId,
            blobObjectId,
            encodingType: blob.encodingType,
            nonce: blob.nonce,
            deletable,
            userAddress: owner,
            bytes: blob.bytes,
          });
        } else if (usesRelay) {
          const { certificate } = await suiClient.walrus.writeBlobToUploadRelay(
            {
              blobId: blob.blobId,
              blob: blob.bytes,
              nonce: blob.nonce,
              txDigest: registerDigest,
              blobObjectId,
              deletable,
              encodingType: blob.encodingType,
            }
          );
          certificateByBlobId.set(blob.blobId, certificate);
        } else {
          const encodedForNodes = await suiClient.walrus.encodeBlob(blob.bytes);
          if (encodedForNodes.blobId !== blob.blobId) {
            throw new Error(
              `encodeBlob blobId mismatch for ${blob.label}: expected=${blob.blobId} got=${encodedForNodes.blobId}`
            );
          }
          const confirmations = await suiClient.walrus.writeEncodedBlobToNodes({
            blobId: blob.blobId,
            metadata: encodedForNodes.metadata,
            sliversByNode: encodedForNodes.sliversByNode,
            deletable,
            objectId: blobObjectId,
          });
          confirmationsByBlobId.set(blob.blobId, confirmations);
        }

        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        if (!isLikelyTimeoutError(e) || attempt === maxAttempts) throw e;
        onStatusUpdate?.(
          `Upload timeout for ${blob.label}; retrying (${attempt}/${maxAttempts})...`
        );
        await sleep(1000 * attempt * attempt);
      }
    }

    if (lastError) throw lastError;
  }

  if (useUploaderServer) {
    // Uploader server already certifies each blob (and transfers ownership back).
    // Best-effort: return created video object id from the register tx.
    try {
      const videoType = `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::Video`;
      const createdVideos = getCreatedObjectsByTypeFromObjectChanges(
        registerObjectChanges,
        videoType
      );
      return {
        digest: registerDigest,
        videoObjectId: createdVideos[0] ?? null,
        blobs: {
          m3u8BlobId,
          videoBlobId,
          coverBlobId,
          keyBlobId,
        },
        sealId,
      };
    } catch {
      return {
        digest: registerDigest,
        videoObjectId: null,
        blobs: {
          m3u8BlobId,
          videoBlobId,
          coverBlobId,
          keyBlobId,
        },
        sealId,
      };
    }
  }

  // 7) Certify (on-chain)
  // NOTE: This is one additional wallet signature prompt after uploads finish.
  onStatusUpdate?.("Certifying blobs on-chain...");
  const certifyTx = new Transaction();
  certifyTx.setSenderIfNotSet(owner);

  for (const blob of encoded) {
    const blobObjectId = blobObjectIdByBlobId.get(blob.blobId);
    if (!blobObjectId) {
      throw new Error(`Missing blobObjectId for blobId=${blob.blobId}`);
    }

    const certificate = certificateByBlobId.get(blob.blobId);
    const confirmations = confirmationsByBlobId.get(blob.blobId);
    if (!certificate && !confirmations) {
      throw new Error(
        `Missing upload proof (certificate/confirmations) for blobId=${blob.blobId}`
      );
    }

    if (certificate) {
      suiClient.walrus.certifyBlobTransaction({
        transaction: certifyTx,
        blobId: blob.blobId,
        blobObjectId,
        deletable,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        certificate: certificate as any,
      });
    } else {
      suiClient.walrus.certifyBlobTransaction({
        transaction: certifyTx,
        blobId: blob.blobId,
        blobObjectId,
        deletable,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        confirmations: confirmations as any,
      });
    }
  }

  await signAndExecuteTransaction({
    transaction: certifyTx,
    options: { showEffects: true },
  });

  // Optional: return created video object id (best-effort)
  try {
    const videoType = `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::Video`;
    const createdVideos = getCreatedObjectsByTypeFromObjectChanges(
      registerObjectChanges,
      videoType
    );
    return {
      digest: registerDigest,
      videoObjectId: createdVideos[0] ?? null,
      blobs: {
        m3u8BlobId,
        videoBlobId,
        coverBlobId,
        keyBlobId,
      },
      sealId,
    };
  } catch {
    return {
      digest: registerDigest,
      videoObjectId: null,
      blobs: {
        m3u8BlobId,
        videoBlobId,
        coverBlobId,
        keyBlobId,
      },
      sealId,
    };
  }
}

// 購買影片
export async function buyVideo(
  video: { id: string; price: number },
  _account: string,
  signAndExecuteTransaction: (input: {
    transaction: Transaction;
    options?: SuiTransactionBlockResponseOptions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => Promise<any>
) {
  const tx = new Transaction();

  // 切割支付金額
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(video.price)]);

  // call buy_video
  tx.moveCall({
    target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::buy_video`,
    arguments: [tx.object(video.id), payment],
  });

  // 執行
  const result = await signAndExecuteTransaction({
    transaction: tx,
    options: { showEffects: true },
  });

  return result;
}

export { SUI_COIN_TYPE, MIST_PER_SUI };
