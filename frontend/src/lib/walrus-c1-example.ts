import type { SuiTransactionBlockResponseOptions } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { WalrusFile } from "@mysten/walrus";

import { suiClient } from "./sui";

/**
 * `writeFilesFlow` 的標準用法（示意）。
 *
 * 注意：它會在 `register()` 內部 new 一個 Transaction，所以無法做到 C.1「注入既有 tx」。
 */
export function createWriteFilesFlowExample(
  files: {
    contents: Uint8Array | Blob;
    identifier: string;
    tags?: Record<string, string>;
  }[]
) {
  return suiClient.walrus.writeFilesFlow({
    files: files.map((f) =>
      WalrusFile.from({
        contents: f.contents,
        identifier: f.identifier,
        tags: f.tags ?? {},
      })
    ),
  });
}

/**
 * C.1（同一筆 Transaction / PTB 原子化）參考範例（Browser）。
 *
 * 重點：
 * - `writeFilesFlow()` 很好用，但 `flow.register()` 會自己 new 一個 Transaction，
 *   你無法「把你的 Move PTB 插在 register 之前」並同時把 register 變成同一筆交易的一部分。
 * - 此外 `writeFilesFlow()` 目前會把多檔打包成 quilt；若你要求「不要 quilt」，
 *   就必須改成：每個檔案各自 `encodeBlob()` + `registerBlobTransaction()`。
 *
 * 這個函式是「可複製到 Next.js / Vite」的完整流程骨架。
 * 所有需替換值都用 TODO 標記。
 */
export async function walrusC1AtomicWriteFiles(
  input: {
    files: {
      contents: Uint8Array | Blob;
      identifier: string;
      tags?: Record<string, string>;
    }[];
    owner: string;
    epochs: number;
    deletable: boolean;

    /**
     * 讓呼叫端把「你的 Move PTB」加進同一筆交易。
     * 必須確保它在 Walrus register 之前被加入。
     */
    addMovePtbBeforeRegister: (tx: Transaction) => void;

    signAndExecuteTransaction: (args: {
      transaction: Transaction;
      options?: SuiTransactionBlockResponseOptions;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => Promise<any>;
  },
  onStatusUpdate?: (status: string) => void
) {
  // --------------------------------------------------------------
  // (B) C.1 實作：等效低階 API（可注入既有 tx，達成原子化）
  // --------------------------------------------------------------
  onStatusUpdate?.("Encoding blobs (no quilt)...");

  const blobs = await Promise.all(
    input.files.map(async (f) => {
      const bytes =
        f.contents instanceof Blob
          ? new Uint8Array(await f.contents.arrayBuffer())
          : f.contents;
      const encoded = await suiClient.walrus.encodeBlob(bytes);
      return {
        identifier: f.identifier,
        bytes,
        encoded,
      };
    })
  );

  onStatusUpdate?.("Building atomic transaction (PTB)...");
  const tx = new Transaction();
  tx.setSenderIfNotSet(input.owner);

  // 1) 先跑你的 Move PTB（WAL 來源控制 / escrow / approve / swap...）
  input.addMovePtbBeforeRegister(tx);

  // 2) 再做 Walrus register（同一筆交易）
  for (const blob of blobs) {
    suiClient.walrus.registerBlobTransaction({
      transaction: tx,
      owner: input.owner,
      size: blob.bytes.length,
      epochs: input.epochs,
      deletable: input.deletable,
      blobId: blob.encoded.blobId,
      rootHash: blob.encoded.rootHash,

      // walCoin: TODO（可選）如果你的 Move PTB 會產出 Coin<WAL>，可在這裡傳入
      // attributes: TODO（可選）寫入 metadata
    });
  }

  onStatusUpdate?.("Signing & executing transaction...");
  const { digest } = await input.signAndExecuteTransaction({
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });

  // 3) tx 成功後用 digest 做 upload
  onStatusUpdate?.("Uploading to storage nodes...");

  const blobType = await suiClient.walrus.getBlobType();
  const txb = await suiClient.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });

  const createdBlobObjectIds = (txb.objectChanges ?? [])
    .filter((c) => c.type === "created")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((c: any) => c.objectType === blobType)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => c.objectId);

  if (input.deletable && createdBlobObjectIds.length < blobs.length) {
    throw new Error("Missing created Walrus Blob objectIds");
  }

  // NOTE: 這裡用最簡單方式：逐一把 created objectId 跟 blobs 對齊。
  // 更嚴謹的作法是把 objectId getObject 後用 fields.blob_id 對應 blobId。
  const confirmationsByBlobId = new Map<string, unknown[]>();
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const objectId = createdBlobObjectIds[i];
    const confirmations = await suiClient.walrus.writeEncodedBlobToNodes({
      blobId: blob.encoded.blobId,
      metadata: blob.encoded.metadata,
      sliversByNode: blob.encoded.sliversByNode,
      deletable: input.deletable,
      objectId,
    });
    confirmationsByBlobId.set(blob.encoded.blobId, confirmations);
  }

  // 4)（可選但建議）certify
  onStatusUpdate?.("Certifying on-chain...");
  const certifyTx = new Transaction();
  certifyTx.setSenderIfNotSet(input.owner);

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];
    const objectId = createdBlobObjectIds[i];
    const confirmations = confirmationsByBlobId.get(blob.encoded.blobId);
    if (!confirmations) throw new Error("Missing confirmations");

    suiClient.walrus.certifyBlobTransaction({
      transaction: certifyTx,
      blobId: blob.encoded.blobId,
      blobObjectId: objectId,
      deletable: input.deletable,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      confirmations: confirmations as any,
    });
  }

  await input.signAndExecuteTransaction({
    transaction: certifyTx,
    options: { showEffects: true },
  });

  return {
    digest,
    blobs: blobs.map((b) => ({
      identifier: b.identifier,
      blobId: b.encoded.blobId,
    })),
  };
}
