import {
  getFullnodeUrl,
  SuiClient,
  type SuiObjectResponse,
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

// dapp-kit 的 `useSignAndExecuteTransaction().mutateAsync` 回傳型別
// 與 `@mysten/sui` 的 `SuiTransactionBlockResponse` 不完全相同（effects 型別不同）。
// 但在本專案中，我們只需要它回傳 `digest` 來做 waitForTransaction。
type SignAndExecuteTransactionFn = (input: {
  transaction: Transaction;
  options?: SuiTransactionBlockResponseOptions;
}) => Promise<{ digest: string }>;

function getMoveObjectFieldsFromSuiObject(
  obj: SuiObjectResponse
): Record<string, unknown> | null {
  const content = obj.data?.content;
  if (!content || typeof content !== "object") return null;
  const fields = (content as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object") return null;
  return fields as Record<string, unknown>;
}

// ============================================================================
// Walrus/Sui 上傳流程
//
// - 用 PTB 把 Walrus register + 合約 create_video 包起來
// - 鏈上 metadata 指到的 blobId 一定已被 register（但 bytes 仍需後續 upload-relay 上傳）

// - register 需要 WAL，因此在同一筆交易內先用 mock_dex 把 SUI swap 成 WAL
// - register 完成後，再對每個 blob 走 upload-relay
//   1 付 tip（產生 relay 需要的 auth payload / txDigest）
//   2 HTTP 上傳 bytes（writeBlobToUploadRelay）
// - 所有 blob 上傳完成後，再用 certifyTx 把 certificates 上鏈
//
// - blobId：Walrus 內容位址 / base64url 字串（SDK 回傳）
// - blobObjectId：register 後在 Sui 上建立的 Blob 物件 id
// - certificate：upload-relay 回傳的憑證，certify 時需要
// ============================================================================

function getCreatedObjectsByTypeFromObjectChanges(
  objectChanges: NonNullable<SuiTransactionBlockResponse["objectChanges"]>,
  objectType: string
): string[] {
  type ObjectChange = NonNullable<
    SuiTransactionBlockResponse["objectChanges"]
  >[number];
  type CreatedChange = Extract<ObjectChange, { type: "created" }>;

  const isTypeMatch = (actualType: string, expectedType: string) => {
    if (actualType === expectedType) return true;
    // Sui 的 objectType 可能帶泛型後綴：`${expected}<...>`
    // 例如 `0x...::module::Struct<0x2::sui::SUI>`
    return (
      actualType.startsWith(expectedType) &&
      actualType.length > expectedType.length &&
      actualType[expectedType.length] === "<"
    );
  };

  return objectChanges
    .filter((c): c is CreatedChange => c.type === "created")
    .filter((c) => isTypeMatch(c.objectType, objectType))
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

  // 找出哪個 created Blob 對應到指定 blobId
  for (const objectId of createdBlobObjectIds) {
    const obj = await suiClient.getObject({
      id: objectId,
      options: { showContent: true },
    });

    const fields = getMoveObjectFieldsFromSuiObject(obj);
    if (!fields) continue;

    // Walrus 在鏈上把 blob_id 存成 u256
    // 但 SDK 產生的 blobId 是 base64url 字串
    const onChainBlobId = fields["blob_id"] ?? fields["blobId"];
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
    // 確保 Walrus WASM 從正確 URL 取得
    // 避免 SPA fallback 回傳 HTML 造成 wasm load 失敗
    wasmUrl: walrusWasmUrl,

    // 使用官方 testnet upload relay 做代理上傳
    // 瀏覽器直接對 Walrus node 請求會爆炸多
    // 實測僅直接傳小檔 m3u8, cover, key 請求 12000+
    // 且失敗率高
    uploadRelay: {
      host: WALRUS_UPLOAD_RELAY_HOST,
      // 開啟 tipping
      // 上傳時會帶上 txDigest, nonce 作為授權驗證
      sendTip: { max: 2_000 },
      timeout: WALRUS_UPLOAD_RELAY_TIMEOUT_MS,
    },
  })
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 偵測是否可能是 timeout 錯誤
function isLikelyTimeoutError(err: unknown) {
  // AbortSignal.timeout 可能會產生 name TimeoutError 的 DOMException
  // Walrus SDK 目前只處理 name AbortError 的錯誤，因此這裡兩種都判斷
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { name?: unknown; message?: unknown };
  const name = typeof anyErr.name === "string" ? anyErr.name : "";
  const message = typeof anyErr.message === "string" ? anyErr.message : "";
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

// 上傳影片資產 PTB register + create_video 交易後再上傳 bytes
export async function uploadVideoAssetsFlow(
  assets: {
    video: Uint8Array;
    m3u8: string;
    cover: File;
    aesKey: Uint8Array;
  },
  metadata: { title: string; description: string; price: number },
  account: string,
  signAndExecuteTransaction: SignAndExecuteTransactionFn,
  onStatusUpdate?: (status: string) => void
) {
  // =============================================================
  // PTB
  // - 先在本機計算每個 blob 的 metadata（blobId/rootHash/nonce/digest）
  // - 建一筆交易把以下步驟綁在一起：
  //   1 取得 WAL（mock_dex swap SUI->WAL）
  //   2 register Walrus blobs（on-chain）
  //   3 呼叫合約 create_video 把 metadata 寫鏈上 store app metadata
  // - register 成功後透過 upload relay 上傳 bytes
  // - 最後做 certify，讓 blob 可被安全引用/讀取

  const epochs = WALRUS_DEFAULT_EPOCHS; // TODO: 可做成可調參數（u64）
  const deletable = true; // TODO: 依政策決定是否可刪
  const owner = account;
  const walrusBlobOwner = owner;

  // 用 Seal 加密 AES key
  // sealId 是 32 bytes 隨機 id，會一起寫入 app metadata 供播放端解密 key
  onStatusUpdate?.("Encrypting AES Key with Seal...");
  const sealId = new Uint8Array(32);
  crypto.getRandomValues(sealId);
  const encryptedKey = await encryptKeyWithSeal(assets.aesKey, sealId);

  // 準備要上傳的 bytes
  // - video：加密後的合併檔（video.bin）
  // - m3u8：BYTERANGE 播放清單
  // - cover：封面圖
  // - key：Seal 加密後的 AES key（播放端拿到後再解密）
  onStatusUpdate?.("Preparing files...");
  const m3u8Bytes = new TextEncoder().encode(assets.m3u8);
  const coverBytes = new Uint8Array(await assets.cover.arrayBuffer());

  // 計算每個 blob 的 metadata（blobId/rootHash/nonce/digest）
  // 只是產生後續 register/relay 需要的資料
  onStatusUpdate?.("Preparing Walrus metadata...");
  const encoded: EncodedWalrusBlob[] = [];

  // 固定 shard 數以確保 metadata 計算一致
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
    // Walrus WASM 可能回傳共享記憶體上的 Uint8Array view？
    // 為避免後續 WASM 呼叫覆寫同一段 buffer 導致 relay 授權失敗
    // 這裡把需要用到的 bytes 都立刻 copy/materialize。
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

  // 估算 register 需要的 WAL，並準備在同一筆 tx 內 swap SUI->WAL
  onStatusUpdate?.("Estimating WAL costs...");
  let totalWalNeeded = 0n;
  for (const blob of encoded) {
    const { totalCost } = await suiClient.walrus.storageCost(
      blob.bytes.length,
      epochs
    );
    totalWalNeeded += totalCost;
  }

  // mock_dex 匯率：WAL = SUI / 2（兩者都是 9 decimals）
  // 加 buffer 避免四捨五入/價格漂移導致 WAL 不足。
  // TODO: DEX Pool -> 改成從 mock_dex 查詢實際匯率
  const totalSuiToSwap =
    (totalWalNeeded * 2n * (10_000n + WAL_SWAP_BUFFER_BPS)) / 10_000n + 1n;

  onStatusUpdate?.(
    `Estimated WAL needed: ${totalWalNeeded.toString()} (mist). Swapping SUI: ${totalSuiToSwap.toString()} (mist).`
  );

  // 建一筆交易：swap → register blobs → create_video
  onStatusUpdate?.("Building atomic transaction (PTB)...");
  const registerTx = new Transaction();
  registerTx.setSenderIfNotSet(owner);

  // 取得 WAL 在同一筆 tx 用 mock_dex swap SUI->WAL
  // 產生的 Coin<WAL> 會當作 walCoin 傳進每一次 register
  // TODO: DEX Pool -> 改成實際 dex pool
  onStatusUpdate?.("Swapping SUI -> WAL (mock_dex)...");
  const [suiForWal] = registerTx.splitCoins(registerTx.gas, [
    registerTx.pure.u64(totalSuiToSwap),
  ]);
  const walCoin = registerTx.moveCall({
    target: `${MOCK_DEX_PACKAGE_ID}::mock_dex::swap_sui_for_token`,
    typeArguments: [WAL_COIN_TYPE],
    arguments: [registerTx.object(MOCK_DEX_BANK_ID), suiForWal],
  });

  // 對每個 blob 做 on-chain register
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

  // Walrus 內部會對 walCoin 做 splitCoins 付費 會剩餘一些 WAL
  // 必須把剩餘的 WAL 轉回 owner 否則 dry-run 會因 UnusedValueWithoutDrop 失敗
  registerTx.transferObjects([walCoin], owner);

  // 寫入 app metadata（create_video on-chain）
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

  // 執行 registerTx 需跳錢包簽名
  onStatusUpdate?.("Signing & executing register transaction...");
  const registerResult = await signAndExecuteTransaction({
    transaction: registerTx,
    options: { showEffects: true, showObjectChanges: true },
  });

  const registerDigest: string = registerResult.digest;

  // 錢包送出的節點與我們設定的 fullnode 可能不同
  // 等到這個 RPC 也能查到交易避免後續查 objectChanges 404
  onStatusUpdate?.("Waiting for transaction to be available on RPC...");
  const registerTxBlock = await suiClient.waitForTransaction({
    digest: registerDigest,
    options: {
      showObjectChanges: true,
      showEffects: true,
    },
    timeout: 60_000,
  });

  // upload-relay 的 tip/auth 會在後面每個 blob 一筆交易支付

  const registerObjectChanges = registerTxBlock.objectChanges ?? [];

  // 上傳 bytes（透過 upload relay）
  // - 會對每個 blob：先付 tip（產生 auth txDigest）→ 再呼叫 writeBlobToUploadRelay（HTTP）
  onStatusUpdate?.("Uploading blobs...");
  type UploadRelayCertificate = Awaited<
    ReturnType<typeof suiClient.walrus.writeBlobToUploadRelay>
  >["certificate"];
  const certificateByBlobId = new Map<string, UploadRelayCertificate>();
  const blobObjectIdByBlobId = new Map<string, string>();
  const tipTxDigestByBlobId = new Map<string, string>();

  for (const blob of encoded) {
    onStatusUpdate?.(`Preparing ${blob.label} for upload relay...`);
    const blobObjectId = await getCreatedWalrusBlobObjectIdByBlobId(
      registerObjectChanges,
      blob.blobId
    );
    blobObjectIdByBlobId.set(blob.blobId, blobObjectId);

    // upload-relay 會用 txDigest 內的（nonce hash, blob digest, size）作為授權驗證
    // relay 一個 txDigest 對應一個 blob，因此我們每個 blob 都付一筆 tipTx
    // TODO: 找方法把 4 個 blob 的 tip 包進 ptb
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

    // 遇到 timeout/授權問題重試
    // 不跳錢包簽名 純 HTTP upload
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

  // certify
  // 會跳錢包簽名
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
      certificate,
    });
  }

  await signAndExecuteTransaction({
    transaction: certifyTx,
    options: { showEffects: true },
  });

  // 嘗試從 registerTx 的 objectChanges 找出 create_video 創的物件 id
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
  signAndExecuteTransaction: SignAndExecuteTransactionFn
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
