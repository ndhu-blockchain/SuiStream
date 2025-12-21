import {
  getFullnodeUrl,
  SuiClient,
  type SuiTransactionBlockResponseOptions,
} from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { SealClient } from "@mysten/seal";
import { toHex } from "@mysten/sui/utils";

// =================================================================
// 設定

const NETWORK = "testnet";
const MIST_PER_SUI = 1_000_000_000;
const SUI_COIN_TYPE = "0x2::sui::SUI";
const WAL_COIN_TYPE =
  "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";

// Platform Package ID
export const VIDEO_PLATFORM_PACKAGE_ID =
  "0xe0361d9cce250c5d56d06fe4f00c8055b66354280b05dff01307aff3b00ea81a";

// Mock DEX
const MOCK_DEX_PACKAGE_ID =
  "0x048124ed3fe7405b210ea4f28f2d20590749fe65af58dc1e3779f0c6ebd6d091";
const MOCK_DEX_BANK_ID =
  "0x77ce005108e30bde1385cbd2c416bd45cfff59c372ad4da16dae026471fbd0dd";

// Walrus Aggregator
export const WALRUS_AGGREGATOR_URL =
  "https://aggregator.walrus-testnet.walrus.space/v1/blobs/";
export const WALRUS_AGGREGATOR_FORMAT =
  /(https:\/\/aggregator\.walrus-testnet\.walrus\.space\/v1\/blobs\/[a-zA-Z0-9_-]+)/;

// Walrus Publisher
const WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space";

export const WALRUS_EPOCHS_MAX = 53;

const WALRUS_DEFAULT_EPOCHS = 2;

// init Client
export const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });
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

// =================================================================
// func

// 檔案上傳 Walrus publisher
async function uploadToWalrus(content: Uint8Array | File, blobId: string) {
  // 處理 Uint8Array 轉 Blob 的型別問題
  const body =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content instanceof Uint8Array ? new Blob([content as any]) : content;

  const response = await fetch(
    `${WALRUS_PUBLISHER_URL}/v1/blobs?epochs=${WALRUS_DEFAULT_EPOCHS}`,
    {
      method: "PUT",
      body: body,
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to upload blob: ${response.statusText}`);
  }
  // 解回傳 json 取得真實 Blob ID
  const data = await response.json();
  let realBlobId = "";
  if (
    data.newlyCreated &&
    data.newlyCreated.blobObject &&
    data.newlyCreated.blobObject.blobId
  ) {
    realBlobId = data.newlyCreated.blobObject.blobId;
  } else if (data.alreadyCertified && data.alreadyCertified.blobId) {
    realBlobId = data.alreadyCertified.blobId;
  }

  return realBlobId || blobId; // 如果失敗回傳原本的
}

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

// 模擬生成 Blob ID
const generateMockId = (prefix: string) => {
  // 產生一個隨機的 Base64Url 字串模擬 Blob ID
  return `${prefix}_${Math.random().toString(36).substring(7)}_${Date.now()}`;
};

// =================================================================
// 流程 SUI 換匯 > 支付 > 上傳 > 寫合約

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
  const tx = new Transaction();

  // Seal 加密
  onStatusUpdate?.("Encrypting AES Key with Seal...");
  console.log("Encrypting AES Key with Seal...");
  const sealId = new Uint8Array(32);
  crypto.getRandomValues(sealId);
  const encryptedKey = await encryptKeyWithSeal(assets.aesKey, sealId);
  console.log("Key Encrypted. Size:", encryptedKey.length);

  // 上傳所有檔案到 Walrus
  onStatusUpdate?.("Uploading Video to Walrus...");
  console.log("Uploading Assets to Walrus...");

  // 先上傳影片取 Blob ID
  const tempVidName = generateMockId("video");
  const realVideoBlobId = await uploadToWalrus(assets.video, tempVidName);
  console.log("Video Uploaded:", realVideoBlobId);

  // 改 M3U8 指向真實 Blob
  const videoUrl = `${WALRUS_AGGREGATOR_URL}${realVideoBlobId}`;
  const modifiedM3u8 = assets.m3u8.replace(/video\.bin/g, videoUrl);
  const m3u8Bytes = new TextEncoder().encode(modifiedM3u8);

  // 上傳其他檔案
  onStatusUpdate?.("Uploading Metadata to Walrus...");
  const tempKeyName = generateMockId("key");
  const tempM3uName = generateMockId("m3u8");
  const tempCovName = generateMockId("cover");

  const [realKeyBlobId, realM3u8BlobId, realCoverBlobId] = await Promise.all([
    uploadToWalrus(encryptedKey, tempKeyName),
    uploadToWalrus(m3u8Bytes, tempM3uName),
    uploadToWalrus(assets.cover, tempCovName),
  ]);

  console.log("Real Blob IDs:", {
    key: realKeyBlobId,
    video: realVideoBlobId,
    m3u8: realM3u8BlobId,
    cover: realCoverBlobId,
  });

  // 費用估算
  onStatusUpdate?.("Calculating Fees...");
  const EPOCHS = 1; // 測試 降低 Epochs
  const PRICE_PER_BYTE = 1; // 測試 降低費率

  const sizeVideo = assets.video.length;
  const sizeM3u8 = m3u8Bytes.length;
  const sizeCover = assets.cover.size;
  const sizeKey = encryptedKey.length;
  const totalSize = sizeVideo + sizeM3u8 + sizeCover + sizeKey;

  const totalWalNeeded = totalSize * EPOCHS * PRICE_PER_BYTE;

  // 匯率: 我們的 Mock DEX 是 1 SUI = 0.5 WAL (即 2 SUI = 1 WAL)
  // 所以 SUI = WAL * 2
  // 加一點 buffer 避免浮點數誤差 但不要太多
  // 降低 Buffer: 20,000,000 > 10,000,000 (約 5M WAL)
  // TODO: 如果要上 mainnet 這裡需要處理
  const totalSuiNeeded = Math.ceil(totalWalNeeded * 2) + 10000000;

  console.log(
    `[Fee Estimation] Size: ${totalSize}, WAL: ${totalWalNeeded}, SUI: ${totalSuiNeeded}`
  );

  // PTB
  onStatusUpdate?.("Preparing Transaction...");

  // 從 Gas Coin 切出 SUI
  const [suiForSwap] = tx.splitCoins(tx.gas, [tx.pure.u64(totalSuiNeeded)]);

  // 呼叫 Mock DEX (SUI > WAL)
  const walCoin = tx.moveCall({
    target: `${MOCK_DEX_PACKAGE_ID}::mock_dex::swap_sui_for_token`,
    typeArguments: [WAL_COIN_TYPE],
    arguments: [
      tx.object(MOCK_DEX_BANK_ID), // bank obj
      suiForSwap, // 剛剛切出來的 SUI
    ],
  });

  // 付儲存費
  tx.transferObjects([walCoin], account);

  // call SuiStream 合約記錄影片資訊
  tx.moveCall({
    target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::create_video`,
    arguments: [
      tx.pure.string(metadata.title),
      tx.pure.string(metadata.description),
      tx.pure.string(realM3u8BlobId), // 真實 M3U8 ID
      tx.pure.string(realCoverBlobId), // 真實 Cover ID
      tx.pure.vector("u8", sealId), // 傳入 Seal ID
      tx.pure.string(realKeyBlobId), // 傳入真實的 Key Blob ID
      tx.pure.u64(metadata.price), // 傳入價格
    ],
  });

  // 執行交易
  onStatusUpdate?.("Please approve the transaction in your wallet...");
  const result = await signAndExecuteTransaction({
    transaction: tx,
    options: { showEffects: true },
  });

  console.log("Tx Digest:", result.digest);

  return result;
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
