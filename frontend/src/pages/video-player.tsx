import { useParams } from "react-router-dom";
import {
  useSuiClientQuery,
  useCurrentAccount,
  useSignPersonalMessage,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect, useRef } from "react";
import { SessionKey } from "@mysten/seal";
import {
  suiClient,
  VIDEO_PLATFORM_PACKAGE_ID,
  buyVideo,
  MIST_PER_SUI,
  WALRUS_AGGREGATOR_URL,
  sealClient,
} from "@/lib/sui";
import { Transaction } from "@mysten/sui/transactions";
import { PublicKey } from "@mysten/sui/cryptography";
import { toBase64, toHex } from "@mysten/sui/utils";
import Hls from "hls.js";
import { toast } from "sonner";
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
  const { id } = useParams();
  const currentAccount = useCurrentAccount();
  const [decryptedKey, setDecryptedKey] = useState<Uint8Array | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [isBuying, setIsBuying] = useState(false);
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  const { mutateAsync: signAndExecuteTransaction } =
    useSignAndExecuteTransaction();

  // 取影片 Metadata 鏈上
  const { data: videoObject, isPending } = useSuiClientQuery("getObject", {
    id: id!,
    options: { showContent: true },
  });

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
    if (!decryptedKey || !videoObject || !videoRef.current) return;

    const fields = getMoveFieldsFromObjectResponse(videoObject);
    if (!fields) return;
    const m3u8BlobId = getStringField(fields, "m3u8_blob_id");
    const videoBlobId = getStringField(fields, "video_blob_id");

    const initPlayer = async () => {
      if (Hls.isSupported()) {
        // 取 M3U8
        const m3u8Url = `${WALRUS_AGGREGATOR_URL}${m3u8BlobId}`;
        try {
          const response = await fetch(m3u8Url);
          if (!response.ok) throw new Error("Failed to fetch m3u8");
          const m3u8Text = await response.text();
          console.log("Fetched M3U8:", m3u8Text);

          const hls = new Hls({
            enableWorker: false,
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
                    ctx.url = `${WALRUS_AGGREGATOR_URL}${videoBlobId}`;
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
          const manifestUrl = URL.createObjectURL(blob);

          hls.loadSource(manifestUrl);
          hls.attachMedia(videoRef.current!);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
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
  }, [decryptedKey, videoObject]);

  const handleBuy = async () => {
    if (!videoObject || !currentAccount) return;
    const fields = getMoveFieldsFromObjectResponse(videoObject);
    if (!fields) return;
    const price = getNumberField(fields, "price");

    setIsBuying(true);
    try {
      await buyVideo(
        { id: id!, price },
        currentAccount.address,
        signAndExecuteTransaction
      ).then(async (result) => {
        await suiClient.waitForTransaction({ digest: result.digest });
      });
      toast.success("Purchase Successful!");
      await refetchOwnedObjects();
    } catch (e: unknown) {
      console.error(e);
      toast.error("Purchase Failed: " + getErrorMessage(e));
    } finally {
      setIsBuying(false);
    }
  };

  const handlePlay = async () => {
    if (!videoObject || !currentAccount) return;
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
          target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::seal_approve`,
          arguments: [sealIdArg, tx.object(id!)],
        });
      } else {
        tx.moveCall({
          target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::seal_approve_with_pass`,
          arguments: [
            sealIdArg,
            tx.object(id!),
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
      const response = await fetch(`${WALRUS_AGGREGATOR_URL}${keyBlobId}`);
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
                        disabled={isBuying}
                        className="w-full gap-2 text-lg font-semibold"
                        variant={isFree ? "default" : "secondary"}
                      >
                        {isBuying ? (
                          <>
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Processing...
                          </>
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
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
