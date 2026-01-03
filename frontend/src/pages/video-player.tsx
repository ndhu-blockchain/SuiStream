import { useSearchParams } from "react-router-dom";
import {
  useSuiClientQuery,
  useCurrentAccount,
  useCurrentWallet,
  useSignPersonalMessage,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useState, useEffect, useRef } from "react";
import { SessionKey } from "@mysten/seal";
import {
  suiClient,
  VIDEO_PLATFORM_PACKAGE_ID,
  buyVideo,
  MIST_PER_SUI,
  WALRUS_AGGREGATOR_URL,
  sealClient,
  waitForTransactionSuccess,
  WALRUS_EPOCHS_MAX,
} from "@/lib/sui";
import { Transaction } from "@mysten/sui/transactions";
import { PublicKey } from "@mysten/sui/cryptography";
import { toBase64, toHex } from "@mysten/sui/utils";
import Hls from "hls.js";
import { toast } from "sonner";
import { blobIdToInt } from "@mysten/walrus";
import {
  Loader2,
  Lock,
  Play,
  AlertCircle,
  CheckCircle2,
  User,
  Coins,
  Film,
} from "lucide-react";

type MoveFields = Record<string, unknown>;

function getMoveFieldsFromObjectResponse(
  // dapp-kit / SuiClient 可能回傳 `data: null` 的 SuiObjectResponse
  // 這裡用更寬鬆的 shape 來做 unknown-safe 解析。
  obj: { data?: unknown } | null | undefined
): MoveFields | null {
  const data = obj?.data;
  if (!data || typeof data !== "object") return null;
  const content = (data as { content?: unknown }).content;
  if (!content || typeof content !== "object") return null;
  const fields = (content as { fields?: unknown }).fields;
  if (!fields || typeof fields !== "object") return null;
  return fields as MoveFields;
}

function getErrorMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const maybe = err as { message?: unknown };
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(err);
}

function getStringField(fields: MoveFields, key: string): string {
  const value = fields[key];
  if (typeof value === "string") return value;
  throw new Error(`Missing/invalid field: ${key}`);
}

function getNumberField(fields: MoveFields, key: string): number {
  const value = fields[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Missing/invalid number field: ${key}`);
}

function getU8VectorField(fields: MoveFields, key: string): Uint8Array {
  const value = fields[key];
  if (value instanceof Uint8Array) return value;
  if (
    Array.isArray(value) &&
    value.every((n) => typeof n === "number" && Number.isInteger(n))
  ) {
    return new Uint8Array(value);
  }
  throw new Error(`Missing/invalid vector<u8> field: ${key}`);
}

// 實作一個簡單的 PublicKey Adapter
class SimplePublicKey extends PublicKey {
  private rawBytes: Uint8Array;
  private _flag: number;
  private _address: string;

  constructor(rawBytes: Uint8Array, flag: number, address: string) {
    super();
    this.rawBytes = rawBytes;
    this._flag = flag;
    this._address = address;
  }

  toRawBytes(): Uint8Array<ArrayBuffer> {
    return this.rawBytes as Uint8Array<ArrayBuffer>;
  }

  flag(): number {
    return this._flag;
  }

  async verify(
    _data: Uint8Array,
    _signature: Uint8Array | string
  ): Promise<boolean> {
    // 不實作驗證 Seal SDK 只是要拿 Public Key
    void _data;
    void _signature;
    return true;
  }

  toSuiAddress(): string {
    return this._address;
  }
}

export default function VideoPlayerPage() {
  const [searchParams] = useSearchParams();
  const id = searchParams.get("v") ?? "";
  const hasId = id.length > 0;
  const currentAccount = useCurrentAccount();
  const { isConnected: isWalletConnected } = useCurrentWallet();
  const [decryptedKey, setDecryptedKey] = useState<Uint8Array | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [isBuying, setIsBuying] = useState(false);
  const [isWaitingOnChain, setIsWaitingOnChain] = useState(false);
  const [error, setError] = useState("");

  type WalrusBlobEpochInfo = {
    label: "video" | "m3u8" | "key" | "cover";
    blobId: string;
    startEpoch: number | null;
    endEpoch: number | null;
    remainingEpochs: number[] | null;
    remainingCount: number | null;
    totalCount: number | null;
    percentRemaining: number | null; // 0..100 (used as progress %)
    error: string | null;
  };

  const [walrusEpochInfoLoading, setWalrusEpochInfoLoading] = useState(false);
  const [walrusEpochInfoError, setWalrusEpochInfoError] = useState<string>("");
  const [walrusCurrentEpoch, setWalrusCurrentEpoch] = useState<number | null>(
    null
  );
  const [walrusEpochInfo, setWalrusEpochInfo] = useState<
    WalrusBlobEpochInfo[] | null
  >(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const { mutateAsync: signAndExecuteTransaction } =
    useSignAndExecuteTransaction();

  // 取影片 Metadata 鏈上
  const { data: videoObject, isPending } = useSuiClientQuery(
    "getObject",
    {
      id,
      options: { showContent: true },
    },
    {
      enabled: hasId,
    }
  );

  // 查使用者有的 AccessPass
  const { data: ownedObjects, refetch: refetchOwnedObjects } =
    useSuiClientQuery(
      "getOwnedObjects",
      {
        owner: currentAccount?.address || "",
        filter: {
          StructType: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::AccessPass`,
        },
        options: { showContent: true },
      },
      {
        enabled: !!currentAccount,
      }
    );

  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  useEffect(() => {
    if (!videoObject) return;

    const fields = getMoveFieldsFromObjectResponse(videoObject);
    if (!fields) return;

    const creator =
      typeof fields["creator"] === "string" ? fields["creator"] : "";
    const videoBlobId =
      typeof fields["video_blob_id"] === "string"
        ? fields["video_blob_id"]
        : "";
    const m3u8BlobId =
      typeof fields["m3u8_blob_id"] === "string" ? fields["m3u8_blob_id"] : "";
    const keyBlobId =
      typeof fields["key_blob_id"] === "string" ? fields["key_blob_id"] : "";
    const coverBlobId =
      typeof fields["cover_blob_id"] === "string"
        ? fields["cover_blob_id"]
        : "";

    if (!creator || !videoBlobId || !m3u8BlobId || !keyBlobId || !coverBlobId) {
      return;
    }

    let didCancel = false;

    const toInfo = (
      base: Pick<WalrusBlobEpochInfo, "label" | "blobId">
    ): WalrusBlobEpochInfo => ({
      label: base.label,
      blobId: base.blobId,
      startEpoch: null,
      endEpoch: null,
      remainingEpochs: null,
      remainingCount: null,
      totalCount: null,
      percentRemaining: null,
      error: null,
    });

    const run = async () => {
      setWalrusEpochInfoLoading(true);
      setWalrusEpochInfoError("");
      setWalrusEpochInfo(null);
      setWalrusCurrentEpoch(null);

      try {
        const stakingState = await suiClient.walrus.stakingState();
        const currentEpoch = Number(
          (stakingState as { epoch?: unknown }).epoch
        );
        if (!Number.isFinite(currentEpoch)) {
          throw new Error("Failed to read Walrus current epoch");
        }

        const blobs: Array<Pick<WalrusBlobEpochInfo, "label" | "blobId">> = [
          { label: "video", blobId: videoBlobId },
          { label: "m3u8", blobId: m3u8BlobId },
          { label: "key", blobId: keyBlobId },
          { label: "cover", blobId: coverBlobId },
        ];

        const results = blobs.map(toInfo);

        // 1) Fast path: verified status may expose endEpoch for permanent blobs.
        await Promise.all(
          results.map(async (r) => {
            try {
              const status = await suiClient.walrus.getVerifiedBlobStatus({
                blobId: r.blobId,
              });
              if (status && typeof status === "object") {
                const s = status as { type?: unknown; endEpoch?: unknown };
                if (s.type === "permanent" && typeof s.endEpoch === "number") {
                  r.endEpoch = s.endEpoch;
                }
              }
            } catch {
              // Ignore and fallback to event lookup.
            }
          })
        );

        // 2) Event fallback: BlobRegistered contains epoch + end_epoch.
        const needEventLookup = results.some(
          (r) => r.endEpoch === null || r.startEpoch === null
        );

        if (needEventLookup) {
          const blobType = await suiClient.walrus.getBlobType();
          const walrusPackageId = String(blobType).split("::")[0] ?? "";
          const blobRegisteredType = walrusPackageId
            ? `${walrusPackageId}::events::BlobRegistered`
            : "";

          if (!blobRegisteredType) {
            throw new Error("Failed to determine Walrus package id");
          }

          const targetByInt = new Map<string, WalrusBlobEpochInfo>();
          for (const r of results) {
            targetByInt.set(String(blobIdToInt(r.blobId)), r);
          }

          let cursor: { txDigest: string; eventSeq: string } | null = null;
          const limit = 50;
          const maxPages = 12;

          for (let page = 0; page < maxPages; page += 1) {
            const res = await suiClient.queryEvents({
              query: { Sender: creator },
              cursor,
              limit,
              order: "descending",
            });

            for (const evt of res.data) {
              if (evt.type !== blobRegisteredType) continue;
              const parsed = evt.parsedJson as
                | {
                    blob_id?: unknown;
                    end_epoch?: unknown;
                    epoch?: unknown;
                  }
                | undefined;
              if (!parsed) continue;

              const blobIdValue = parsed.blob_id;
              const endEpochValue = parsed.end_epoch;
              const startEpochValue = parsed.epoch;

              let onChainBlobId: bigint | null = null;
              if (typeof blobIdValue === "string") {
                try {
                  onChainBlobId = BigInt(blobIdValue);
                } catch {
                  onChainBlobId = null;
                }
              } else if (typeof blobIdValue === "bigint") {
                onChainBlobId = blobIdValue;
              } else if (typeof blobIdValue === "number") {
                onChainBlobId = BigInt(blobIdValue);
              }
              if (onChainBlobId === null) continue;

              const target = targetByInt.get(String(onChainBlobId));
              if (!target) continue;

              if (target.startEpoch === null) {
                if (typeof startEpochValue === "number") {
                  target.startEpoch = startEpochValue;
                } else if (typeof startEpochValue === "string") {
                  const maybe = Number(startEpochValue);
                  if (Number.isFinite(maybe)) target.startEpoch = maybe;
                }
              }

              if (target.endEpoch === null) {
                if (typeof endEpochValue === "number") {
                  target.endEpoch = endEpochValue;
                } else if (typeof endEpochValue === "string") {
                  const maybe = Number(endEpochValue);
                  if (Number.isFinite(maybe)) target.endEpoch = maybe;
                }
              }
            }

            const allResolved = results.every((r) => r.endEpoch !== null);
            if (allResolved) break;
            if (!res.hasNextPage || !res.nextCursor) break;
            cursor = res.nextCursor;
          }
        }

        // 3) Compute remaining epoch list + progress percent.
        for (const r of results) {
          if (r.endEpoch === null) {
            r.error = "Unable to resolve Walrus end epoch";
            continue;
          }

          const endEpochNumber = Number(r.endEpoch);
          if (!Number.isFinite(endEpochNumber)) {
            r.error = "Invalid Walrus end epoch";
            continue;
          }

          const startEpochNumber =
            r.startEpoch !== null && Number.isFinite(Number(r.startEpoch))
              ? Number(r.startEpoch)
              : null;

          const remaining: number[] = [];
          if (endEpochNumber > currentEpoch) {
            for (let e = currentEpoch; e < endEpochNumber; e += 1) {
              remaining.push(e);
            }
          }

          r.remainingEpochs = remaining;
          r.remainingCount = Math.max(endEpochNumber - currentEpoch, 0);

          if (startEpochNumber !== null && endEpochNumber > startEpochNumber) {
            r.totalCount = endEpochNumber - startEpochNumber;
            // Progress semantics:
            // - start = startEpoch
            // - current = currentEpoch
            // - max = endEpoch (exclusive)
            const elapsed = currentEpoch - startEpochNumber;
            const ratio = r.totalCount === 0 ? 0 : elapsed / r.totalCount;
            r.percentRemaining = Math.max(0, Math.min(100, ratio * 100));
            r.startEpoch = startEpochNumber;
          } else {
            r.totalCount = null;
            r.percentRemaining = null;
            r.startEpoch = startEpochNumber;
          }
        }

        if (didCancel) return;
        setWalrusCurrentEpoch(currentEpoch);
        setWalrusEpochInfo(results);
      } catch (e) {
        if (didCancel) return;
        setWalrusEpochInfoError(getErrorMessage(e));
      } finally {
        if (didCancel) return;
        setWalrusEpochInfoLoading(false);
      }
    };

    void run();
    return () => {
      didCancel = true;
    };
  }, [videoObject]);

  useEffect(() => {
    if (!decryptedKey || !videoObject || !videoRef.current) return;

    const fields = getMoveFieldsFromObjectResponse(videoObject);
    if (!fields) return;
    const m3u8BlobId = getStringField(fields, "m3u8_blob_id");
    const videoBlobId = getStringField(fields, "video_blob_id");

    let hls: Hls | null = null;
    let manifestUrl: string | null = null;
    let didCancel = false;

    const initPlayer = async () => {
      if (Hls.isSupported()) {
        // 取 M3U8
        const m3u8Url = `${WALRUS_AGGREGATOR_URL}${m3u8BlobId}`;
        try {
          const response = await fetch(m3u8Url, {
            cache: "no-store",
            headers: {
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
            },
          });
          if (!response.ok) throw new Error("Failed to fetch m3u8");
          const m3u8Text = await response.text();
          console.log("Fetched M3U8:", m3u8Text);

          hls = new Hls({
            enableWorker: false,
            xhrSetup: (xhr) => {
              // 讓瀏覽器可以快取，但每次都必須 revalidate，避免錯誤重用 206 partial。
              // （Walrus aggregator 不接受 query-based cache busting）
              try {
                xhr.setRequestHeader(
                  "Cache-Control",
                  "no-cache, must-revalidate, max-age=0"
                );
                xhr.setRequestHeader("Pragma", "no-cache");
              } catch {
                // 某些情況下可能已送出 request 或 header 被鎖定，忽略即可
              }
            },
            loader: class CustomLoader extends (Hls.DefaultConfig
              .loader as unknown as {
              new (config: unknown): { load: (...args: unknown[]) => void };
            }) {
              constructor(config: unknown) {
                super(config);
                const load = this.load.bind(this) as (
                  context: unknown,
                  config: unknown,
                  callbacks: unknown
                ) => void;

                // hls.js 內部在處理 AES-128 key 時，會從 `context.decryptdata` 讀寫資料。
                // 因此我們攔截 key request 時，必須把「原本的 context」原封不動傳回去。
                type LoaderContext = Record<string, unknown> & {
                  url?: unknown;
                  decryptdata?: unknown;
                  rangeStart?: unknown;
                  rangeEnd?: unknown;
                  headers?: unknown;
                };
                type LoaderStats = Record<string, unknown> & { url: string };
                type LoaderCallbacks = {
                  onSuccess: (
                    response: { data: ArrayBuffer; url: string },
                    stats: LoaderStats,
                    context: LoaderContext,
                    networkDetails?: unknown
                  ) => void;
                  onError: (
                    error: Error,
                    context: LoaderContext,
                    networkDetails: unknown,
                    stats?: LoaderStats
                  ) => void;
                };

                this.load = async (
                  context: unknown,
                  config: unknown,
                  callbacks: unknown
                ) => {
                  const isObjectContext =
                    !!context && typeof context === "object";
                  const ctx: LoaderContext = isObjectContext
                    ? (context as LoaderContext)
                    : {};

                  const url = typeof ctx.url === "string" ? ctx.url : "";
                  const cb = callbacks as Partial<LoaderCallbacks>;

                  // 攔截 Key 請求並回傳已解密的 Key
                  if (url.includes("video.key")) {
                    console.log("[CustomLoader] Intercepting key request");
                    if (decryptedKey) {
                      // `Uint8Array.buffer` 在 TS 型別上可能是 ArrayBufferLike。
                      // hls.js loader callback 期待的是 ArrayBuffer，因此這裡明確 copy 成 ArrayBuffer。
                      const keyBytes = Uint8Array.from(decryptedKey);
                      const data = keyBytes.buffer.slice(
                        keyBytes.byteOffset,
                        keyBytes.byteOffset + keyBytes.byteLength
                      );
                      const now = performance.now();
                      const stats: LoaderStats = {
                        url,
                        trequest: now,
                        tfirst: now,
                        tload: now,
                        loaded: keyBytes.byteLength,
                        total: keyBytes.byteLength,
                      };

                      // 關鍵：第三個參數必須是「原本的 context」，讓 hls.js 能讀到 decryptdata。
                      cb.onSuccess?.({ data, url }, stats, ctx);
                    } else {
                      cb.onError?.(new Error("Key not available"), ctx, null);
                    }
                    return;
                  }

                  // 攔截 video.bin 請求並重導向到 Walrus
                  if (
                    url.includes("video.bin") &&
                    typeof ctx.url === "string"
                  ) {
                    // console.log("[CustomLoader] Intercepting video.bin request");
                    const baseUrl = `${WALRUS_AGGREGATOR_URL}${videoBlobId}`;

                    // 注意：Walrus aggregator 可能會拒絕未知 query params（例如 ?range=...），
                    // 因此這裡只改 host+path，不做 query-based cache busting。
                    ctx.url = baseUrl;

                    const prevHeaders =
                      ctx.headers && typeof ctx.headers === "object"
                        ? (ctx.headers as Record<string, string>)
                        : {};
                    ctx.headers = {
                      ...prevHeaders,
                      "Cache-Control": "no-cache, must-revalidate, max-age=0",
                      Pragma: "no-cache",
                    };
                  }

                  // 其他請求 (m3u8, segments) 走預設載入邏輯
                  // 這裡把原本的 context 傳回去（我們只在 object context 上原地改 url）。
                  load(isObjectContext ? context : ctx, config, callbacks);
                };
              }
            } as unknown as typeof Hls.DefaultConfig.loader,
          });

          const blob = new Blob([m3u8Text], {
            type: "application/vnd.apple.mpegurl",
          });
          manifestUrl = URL.createObjectURL(blob);

          if (didCancel) return;
          hls.loadSource(manifestUrl);
          hls.attachMedia(videoRef.current!);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (didCancel) return;
            videoRef.current
              ?.play()
              .catch((e) => console.error("Auto-play failed", e));
          });
        } catch (e) {
          console.error("Player init failed:", e);
        }
      }
    };

    initPlayer();

    return () => {
      didCancel = true;
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (manifestUrl) {
        URL.revokeObjectURL(manifestUrl);
        manifestUrl = null;
      }
    };
  }, [decryptedKey, videoObject]);

  if (!hasId) {
    return (
      <div className="flex h-[50vh] w-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-semibold">Missing video id</p>
          <p className="text-muted-foreground">Use /watch?v=&lt;id&gt;</p>
        </div>
      </div>
    );
  }

  const handleBuy = async () => {
    if (!id || !videoObject || !currentAccount) return;
    const fields = getMoveFieldsFromObjectResponse(videoObject);
    if (!fields) return;
    const price = getNumberField(fields, "price");

    setIsBuying(true);
    setIsWaitingOnChain(false);
    let startedPromise = false;
    try {
      const result = await buyVideo(
        { id, price },
        currentAccount.address,
        signAndExecuteTransaction
      );

      // 簽名送出後（拿到 digest）才開始 loading spinner / toast
      setIsWaitingOnChain(true);

      const p = (async () => {
        await waitForTransactionSuccess(result.digest);
        await refetchOwnedObjects();
      })();

      startedPromise = true;
      toast.promise(p, {
        loading: "Processing purchase...",
        success: "Purchase Successful!",
        error: (e) => ({
          message: `Purchase Failed: ${getErrorMessage(e)}`,
          duration: Infinity,
          closeButton: true,
        }),
      });

      await p;
    } catch (e: unknown) {
      console.error(e);
      // 如果已經進入 toast.promise 的等待階段，錯誤會由 promise toast 顯示
      if (!startedPromise) {
        toast.error(`Purchase Failed: ${getErrorMessage(e)}`, {
          duration: Infinity,
          closeButton: true,
        });
      }
    } finally {
      setIsBuying(false);
      setIsWaitingOnChain(false);
    }
  };

  const handlePlay = async () => {
    if (!id || !videoObject || !currentAccount) return;
    setIsDecrypting(true);
    setStatusText("Preparing...");
    setError("");

    try {
      const fields = getMoveFieldsFromObjectResponse(videoObject);
      if (!fields) throw new Error("Missing video fields");
      const keyBlobId = getStringField(fields, "key_blob_id");
      const sealId = getU8VectorField(fields, "seal_id");
      console.log("Seal ID:", sealId);
      console.log("Seal ID (Hex):", toHex(sealId));

      setStatusText("Checking access...");
      // 查使用者有的 AccessPass
      const accessPasses = await suiClient.getOwnedObjects({
        owner: currentAccount.address,
        filter: {
          StructType: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::AccessPass`,
        },
        options: { showContent: true },
      });

      const pass = accessPasses.data.find((p) => {
        const pFields = getMoveFieldsFromObjectResponse(p);
        return pFields?.["video_id"] === id;
      });

      // 如是創作者本人也算有權限
      const isCreator = fields["creator"] === currentAccount.address;

      if (!pass && !isCreator) {
        throw new Error("You don't have an Access Pass for this video.");
      }

      setStatusText("Building transaction...");
      // 建立授權交易
      const tx = new Transaction();

      // 使用標準方式傳遞 vector<u8>
      const sealIdArg = tx.pure.vector("u8", Array.from(sealId));

      if (isCreator) {
        tx.moveCall({
          target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::seal_approve_creator`,
          arguments: [sealIdArg, tx.object(id)],
        });
      } else {
        tx.moveCall({
          target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::seal_approve_pass`,
          arguments: [
            sealIdArg,
            tx.object(id),
            tx.object(pass!.data!.objectId),
          ],
        });
      }

      tx.setSender(currentAccount.address);
      tx.setGasBudget(20000000);

      // 移除手動 Gas Payment 讓 SDK 自己處理
      // 但保留 sender 設定

      // 檢查 Transaction Data 結構
      const txData = await tx.getData();
      console.log("Transaction Data JSON:", JSON.stringify(txData, null, 2));

      // Seal SDK 需要的是 BCS 序列化後的 TransactionData?
      // tx.build() 回傳的就是這個 Uint8Array
      // 文件說要設定 onlyTransactionKind: true
      const txBytes = await tx.build({
        client: suiClient,
        onlyTransactionKind: true,
      });
      console.log("TxBytes Hex:", toHex(txBytes));

      setStatusText("Fetching Encrypted Key from Walrus...");
      console.log("Fetching Encrypted Key from Walrus...", keyBlobId);
      // 取加密的 Key
      const response = await fetch(`${WALRUS_AGGREGATOR_URL}${keyBlobId}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      if (!response.ok) throw new Error("Failed to fetch key from Walrus");
      const encryptedKey = new Uint8Array(await response.arrayBuffer());

      setStatusText("Creating Session Key...");
      console.log("Creating Session Key...");
      const signerAdapter = {
        signPersonalMessage: async (message: Uint8Array) => {
          setStatusText("Please sign the request in your wallet");
          // Seal SDK 傳入的是 Uint8Array (bytes) 而不是物件
          const res = await signPersonalMessage({ message });
          setStatusText("Verifying signature...");

          // 確保回傳的 bytes 是 base64 字串
          return {
            bytes: res.bytes || toBase64(message),
            signature: res.signature,
          };
        },
        getAddress: async () => currentAccount.address,
        getPublicKey: () => {
          return new SimplePublicKey(
            new Uint8Array(currentAccount.publicKey),
            0x00,
            currentAccount.address
          );
        },
        signTransactionBlock: async () => {
          throw new Error("Not implemented");
        },
        signTransaction: async () => {
          throw new Error("Not implemented");
        },
      };

      type SessionKeyCreateArgs = Parameters<typeof SessionKey.create>[0];
      type SessionKeySigner = SessionKeyCreateArgs["signer"];

      const sessionKey = await SessionKey.create({
        suiClient,
        packageId: VIDEO_PLATFORM_PACKAGE_ID,
        address: currentAccount.address,
        ttlMin: 10,
        signer: signerAdapter as unknown as SessionKeySigner,
      });

      setStatusText("Decrypting with Seal...");
      console.log("Decrypting with Seal...");
      const client = sealClient;

      const decrypted = await client.decrypt({
        data: encryptedKey,
        sessionKey,
        txBytes: txBytes,
      });

      setDecryptedKey(decrypted);
      console.log("Decrypted Key Success!", decrypted);
    } catch (err: unknown) {
      console.error("Decryption failed:", err);
      setError(getErrorMessage(err) || "Decryption failed");
    } finally {
      setIsDecrypting(false);
      setStatusText("");
    }
  };

  if (isPending) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <div className="space-y-6">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <div className="space-y-4">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-5 w-1/3" />
            <Separator className="my-4" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!videoObject?.data) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
        <AlertCircle className="h-16 w-16 text-destructive/50" />
        <h2 className="text-2xl font-bold">Video not found</h2>
        <p className="text-muted-foreground">
          The video you are looking for does not exist or has been removed.
        </p>
        <Button variant="outline" onClick={() => window.history.back()}>
          Go Back
        </Button>
      </div>
    );
  }

  const fields = getMoveFieldsFromObjectResponse(videoObject);
  if (!fields) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
        <AlertCircle className="h-16 w-16 text-destructive/50" />
        <h2 className="text-2xl font-bold">Video not found</h2>
        <p className="text-muted-foreground">
          The video you are looking for does not exist or has been removed.
        </p>
        <Button variant="outline" onClick={() => window.history.back()}>
          Go Back
        </Button>
      </div>
    );
  }

  const title = typeof fields["title"] === "string" ? fields["title"] : "";
  const description =
    typeof fields["description"] === "string" ? fields["description"] : "";
  const creator =
    typeof fields["creator"] === "string" ? fields["creator"] : "";
  const coverBlobId =
    typeof fields["cover_blob_id"] === "string" ? fields["cover_blob_id"] : "";

  // Check access
  const pass = ownedObjects?.data.find((p) => {
    const pFields = getMoveFieldsFromObjectResponse(p);
    return pFields?.["video_id"] === id;
  });
  const isCreator = fields["creator"] === currentAccount?.address;
  const isFree = getNumberField(fields, "price") === 0;
  const hasAccess = !!pass || isCreator;

  return (
    <div className="min-h-screen w-full bg-background pb-20">
      <div className="container mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {/* 影片播放器區 */}
        <div className="mx-auto w-full max-w-5xl">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10">
            {!decryptedKey ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/90 p-6 text-center text-white backdrop-blur-sm">
                <div className="flex w-full max-w-sm flex-col items-center gap-6 justify-space-between">
                  {hasAccess ? (
                    <>
                      <div className="space-y-2">
                        <h3 className="text-2xl font-bold">Content Locked</h3>
                        <p className="text-zinc-400">
                          You have access to this video.
                        </p>
                      </div>
                      {/* 狀態文字區 */}
                      {isDecrypting && statusText && (
                        <div className="w-full">
                          <p className="animate-pulse text-sm font-medium text-primary-foreground">
                            {statusText}
                          </p>
                        </div>
                      )}
                      {error && (
                        <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">
                          <AlertCircle className="h-4 w-4" />
                          {error}
                        </div>
                      )}
                      <div className="flex w-full flex-col gap-4">
                        <Button
                          size="lg"
                          onClick={handlePlay}
                          disabled={isDecrypting}
                          className="w-full gap-2 text-lg font-semibold"
                        >
                          {isDecrypting ? (
                            <>
                              <Loader2 className="h-5 w-5 animate-spin" />
                              Decrypting...
                            </>
                          ) : (
                            <>
                              <Play className="h-5 w-5" />
                              Unlock & Play
                            </>
                          )}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <h3 className="text-2xl font-bold">Premium Content</h3>
                        <p className="text-zinc-400">
                          {isFree
                            ? "This video is free, but requires an access pass."
                            : "Purchase an access pass to watch this video."}
                        </p>
                      </div>
                      {error && (
                        <div className="mt-4 flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">
                          <AlertCircle className="h-4 w-4" />
                          {error}
                        </div>
                      )}
                      <Button
                        size="lg"
                        onClick={handleBuy}
                        disabled={isBuying || !isWalletConnected}
                        className="w-full gap-2 text-lg font-semibold"
                        variant={isFree ? "default" : "secondary"}
                      >
                        {isBuying && isWaitingOnChain ? (
                          <>
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Processing...
                          </>
                        ) : isBuying ? (
                          <>Confirm in wallet</>
                        ) : isFree ? (
                          "Get Free Access"
                        ) : (
                          <>
                            <Coins className="h-5 w-5" />
                            Buy for {Number(fields.price) / MIST_PER_SUI} SUI
                          </>
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <video
                ref={videoRef}
                controls
                className="h-full w-full"
                poster={
                  coverBlobId
                    ? `${WALRUS_AGGREGATOR_URL}${coverBlobId}`
                    : undefined
                }
              />
            )}
          </div>
        </div>
        {/* Info Area */}
        <div className="mx-auto mt-8 grid max-w-5xl gap-8">
          {/* 資訊區 */}
          <div className="space-y-6 lg:col-span-2">
            <div>
              <h1 className="wrap-break-word text-3xl font-bold leading-tight tracking-tighter md:text-4xl">
                {title}
              </h1>
              <div className="mt-4 flex items-center gap-3 text-muted-foreground">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <User className="h-5 w-5" />
                </div>
                <div className="flex flex-col overflow-hidden">
                  <span className="text-sm font-medium text-foreground">
                    Creator
                  </span>
                  <span className="text-sm font-mono">
                    {creator
                      ? `${creator.slice(0, 6)}...${creator.slice(-4)}`
                      : ""}
                    {isCreator && " (You)"}
                  </span>
                </div>
              </div>
            </div>
            <Separator />
            <div className="space-y-4">
              <h3 className="text-xl font-semibold">Description</h3>
              <div className="prose prose-zinc max-w-none dark:prose-invert">
                <p className="whitespace-pre-wrap wrap-break-word leading-relaxed text-muted-foreground">
                  {description || "No description provided."}
                </p>
              </div>
            </div>
          </div>
          {/* Right: Meta Card */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Film className="h-5 w-5" />
                  Video Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Price</span>
                  <span className="text-xl font-bold">
                    {isFree
                      ? "Free"
                      : `${Number(fields.price) / MIST_PER_SUI} SUI`}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Status</span>
                  {hasAccess ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-300">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Owned
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">
                      <Lock className="mr-1 h-3 w-3" />
                      Locked
                    </span>
                  )}
                </div>
                <Separator />
                <div className="space-y-2">
                  <span className="text-sm font-medium">Video ID</span>
                  <code className="block w-full break-all rounded bg-muted p-2 text-xs text-muted-foreground">
                    {id}
                  </code>
                </div>
                <Separator />
                <div className="space-y-2">
                  <span className="text-sm font-medium">Epochs</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Current</span>
                  <span className="text-sm font-mono">
                    {walrusCurrentEpoch !== null
                      ? walrusCurrentEpoch
                      : walrusEpochInfoLoading
                      ? "Loading..."
                      : "unavailable"}
                  </span>
                </div>
                <div className="space-y-2">
                  {walrusEpochInfoLoading ? (
                    <Skeleton className="h-28 w-full" />
                  ) : walrusEpochInfoError ? (
                    <p className="text-xs text-muted-foreground">
                      {walrusEpochInfoError}
                    </p>
                  ) : walrusEpochInfo && walrusCurrentEpoch !== null ? (
                    <div className="space-y-4">
                      {walrusEpochInfo.map((info) => (
                        <div key={info.label} className="space-y-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {info.label}
                          </p>
                          {info.percentRemaining !== null ? (
                            <Progress value={info.percentRemaining} />
                          ) : (
                            <Progress value={0} className="opacity-40" />
                          )}
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              {walrusCurrentEpoch}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {info.error ? "unavailable" : `${info.endEpoch}`}
                              {info.remainingCount === WALRUS_EPOCHS_MAX
                                ? "(Max)"
                                : info.remainingCount !== null
                                ? `(${info.remainingCount} epochs left)`
                                : ""}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      (unavailable)
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
