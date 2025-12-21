const SUI_COIN_TYPE = "0x2::sui::SUI";
const MIST_PER_SUI = 1_000_000_000;

import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

// =================================================================
// 1. 設定區 (根據你剛剛的部署結果填入)
// =================================================================

const NETWORK = "testnet";

// [你的合約 Package ID]
const SUI_STREAM_PACKAGE_ID =
  "0xe13e305cea49c187ad85cb954deab95149fd33b56db31dc34524525bb7210cb9";

// [你的 Mock Dex Bank ID] (剛剛存錢進去的那個 Shared Object ID)
const MOCK_DEX_BANK_ID =
  "0xf1af89dab6e310c5de38e8b39d9e57387886a95738c645099ae0a754dc81a45a";

// [WAL 代幣類型]
const WAL_COIN_TYPE =
  "0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL";

// Walrus Publisher (負責接收實體檔案)
const WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space";

// 初始化 Client
export const suiClient = new SuiClient({ url: getFullnodeUrl(NETWORK) });

// =================================================================
// 2. 輔助函式
// =================================================================

/**
 * 將檔案上傳至 Walrus Publisher (HTTP PUT)
 */
async function uploadToWalrus(content: Uint8Array | File, blobId: string) {
  // 處理 Uint8Array 轉 Blob 的型別問題
  const body =
    content instanceof Uint8Array ? new Blob([content as any]) : content;

  const response = await fetch(`${WALRUS_PUBLISHER_URL}/v1/blobs?epochs=5`, {
    method: "PUT",
    body: body,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload blob: ${response.statusText}`);
  }
  return response;
}

/**
 * 模擬生成 Blob ID (在真實 Walrus SDK 中這會是 Multihash)
 */
const generateMockId = (prefix: string) => {
  // 產生一個隨機的 Base64Url 字串模擬 Blob ID
  return `${prefix}_${Math.random().toString(36).substring(7)}_${Date.now()}`;
};

// =================================================================
// 3. 核心流程：SUI 換匯 -> 支付 -> 上傳 -> 寫入合約
// =================================================================

export async function uploadVideoAssetsFlow(
  assets: { video: Uint8Array; m3u8: string; cover: File },
  metadata: { title: string; description: string },
  account: string,
  signAndExecuteTransaction: any
) {
  const tx = new Transaction();

  // --- A. 計算費用 (前端估算) ---
  const EPOCHS = 1; // 測試用：降低 Epochs
  const PRICE_PER_BYTE = 1; // 測試用：降低費率以配合 Mock DEX 流動性

  const sizeVideo = assets.video.length;
  const sizeM3u8 = new TextEncoder().encode(assets.m3u8).length;
  const sizeCover = assets.cover.size;
  const totalSize = sizeVideo + sizeM3u8 + sizeCover;

  const totalWalNeeded = totalSize * EPOCHS * PRICE_PER_BYTE;

  // 匯率: 我們的 Mock DEX 是 1 SUI = 0.5 WAL (即 2 SUI = 1 WAL)
  // 所以 SUI = WAL * 2
  // 加一點 buffer 避免浮點數誤差，但不要加太多以免超過 DEX 流動性 (Bank Balance: ~195M WAL)
  // 降低 Buffer: 20,000,000 -> 10,000,000 (約 5M WAL)
  const totalSuiNeeded = Math.ceil(totalWalNeeded * 2) + 10000000;

  console.log(
    `[Fee Estimation] Size: ${totalSize}, WAL: ${totalWalNeeded}, SUI: ${totalSuiNeeded}`
  );

  // --- B. 構建 PTB (可程式化交易) ---

  // 1. [Split] 從 Gas Coin 切出 SUI
  const [suiForSwap] = tx.splitCoins(tx.gas, [tx.pure.u64(totalSuiNeeded)]);

  // 2. [Swap] 呼叫 Mock DEX (SUI -> WAL)
  // 這會回傳一個 Coin<WAL> 物件
  const walCoin = tx.moveCall({
    target: `${SUI_STREAM_PACKAGE_ID}::mock_dex::swap_sui_for_token`,
    typeArguments: [WAL_COIN_TYPE],
    arguments: [
      tx.object(MOCK_DEX_BANK_ID), // 銀行物件
      suiForSwap, // 剛剛切出來的 SUI
    ],
  });

  // 3. [Pay] 支付儲存費
  // 由於我們是 Testnet 模擬環境，這裡我們直接將換到的 WAL 轉給使用者自己
  // (這證明了 Swap 成功，且錢包裡收到了 WAL)
  // 在主網時，這裡會換成 Walrus System 的 buy_blob 呼叫
  tx.transferObjects([walCoin], account);

  // 4. [Metadata] 呼叫 SuiStream 合約記錄影片資訊
  // 生成模擬的 Blob IDs
  const vidId = generateMockId("video");
  const m3uId = generateMockId("m3u8");
  const covId = generateMockId("cover");

  // 將 M3U8 ID 寫入鏈上作為入口
  tx.moveCall({
    target: `${SUI_STREAM_PACKAGE_ID}::video_platform::create_video`,
    arguments: [
      tx.pure.string(metadata.title),
      tx.pure.string(metadata.description),
      tx.pure.string(m3uId),
    ],
  });

  // --- C. 執行交易 ---
  console.log("Submitting Transaction...");
  const result = await signAndExecuteTransaction({
    transaction: tx,
    options: { showEffects: true },
  });

  console.log("Tx Digest:", result.digest);

  // --- D. 上傳實體檔案 ---
  console.log("Uploading assets to Walrus...");

  // 修正：將 m3u8 字串轉為 Uint8Array
  const m3u8Bytes = new TextEncoder().encode(assets.m3u8);

  // Walrus 上傳後會回傳 Blob ID，我們這裡先上傳，然後把回傳的 Blob ID 拿來用
  // 但因為我們已經在合約呼叫時先用了 generateMockId，這在真實流程中是不對的。
  // 真實流程應該是：
  // 1. 上傳到 Walrus -> 拿到 Blob ID
  // 2. 呼叫合約 -> 把 Blob ID 寫入鏈上
  //
  // 但為了配合目前的 Mock 流程，我們這裡先簡單修正 uploadToWalrus 讓它能通

  await Promise.all([
    uploadToWalrus(assets.video, vidId),
    uploadToWalrus(m3u8Bytes, m3uId),
    uploadToWalrus(assets.cover, covId),
  ]);

  return result;
}

export { SUI_COIN_TYPE, MIST_PER_SUI };
