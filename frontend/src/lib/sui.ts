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

  // Always use the no-uploader flow.
  const walrusBlobOwner = owner;

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

  // NOTE: Upload-relay tips/auth are paid in per-blob transactions later.

  const registerObjectChanges = registerTxBlock.objectChanges ?? [];

  // 6) Upload bytes (off-chain) using the tx digest
  onStatusUpdate?.("Uploading blobs...");
  const certificateByBlobId = new Map<string, unknown>();
  const blobObjectIdByBlobId = new Map<string, string>();
  const tipTxDigestByBlobId = new Map<string, string>();

  for (const blob of encoded) {
    onStatusUpdate?.(`Preparing ${blob.label} for upload relay...`);
    const blobObjectId = await getCreatedWalrusBlobObjectIdByBlobId(
      registerObjectChanges,
      blob.blobId
    );
    blobObjectIdByBlobId.set(blob.blobId, blobObjectId);

    // The upload relay verifies a (nonce hash, blob digest, size) auth payload inside the referenced tx.
    // In practice, the relay expects one blob per txDigest; so we pay a dedicated tip/auth tx per blob.
    onStatusUpdate?.(`Paying upload relay tip for ${blob.label}...`);
    const tipTx = new Transaction();
    tipTx.setSenderIfNotSet(owner);
    tipTx.add(
      suiClient.walrus.sendUploadRelayTip({
        size: blob.bytes.length,
        blobDigest: blob.blobDigest,
        nonce: blob.nonce,
      })
    );
    const tipResult = await signAndExecuteTransaction({
      transaction: tipTx,
      options: { showEffects: true },
    });
    const tipTxDigest: string = tipResult.digest;
    tipTxDigestByBlobId.set(blob.blobId, tipTxDigest);

    onStatusUpdate?.(`Waiting for tip tx (relay auth) for ${blob.label}...`);
    await suiClient.waitForTransaction({
      digest: tipTxDigest,
      options: { showEffects: true },
      timeout: 60_000,
    });

    // Retry on timeout (no extra wallet prompts; this is purely HTTP)
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        onStatusUpdate?.(`Uploading ${blob.label} (upload relay)...`);
        const { certificate } = await suiClient.walrus.writeBlobToUploadRelay({
          blobId: blob.blobId,
          blob: blob.bytes,
          nonce: blob.nonce,
          txDigest: tipTxDigest,
          blobObjectId,
          deletable,
          encodingType: blob.encodingType,
        });
        certificateByBlobId.set(blob.blobId, certificate);

        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        const message = String(
          (e as { message?: unknown } | null)?.message ?? ""
        );
        const shouldRetry =
          isLikelyTimeoutError(e) ||
          message.includes("401") ||
          message.toLowerCase().includes("unauthorized") ||
          message.toLowerCase().includes("nonce hash");

        if (!shouldRetry || attempt === maxAttempts) throw e;
        onStatusUpdate?.(
          `Upload relay error for ${blob.label}; retrying (${attempt}/${maxAttempts})...`
        );
        await sleep(1000 * attempt * attempt);
      }
    }

    if (lastError) throw lastError;
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
    if (!certificate) {
      throw new Error(
        `Missing upload relay certificate for blobId=${blob.blobId}`
      );
    }

    suiClient.walrus.certifyBlobTransaction({
      transaction: certifyTx,
      blobId: blob.blobId,
      blobObjectId,
      deletable,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      certificate: certificate as any,
    });
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
