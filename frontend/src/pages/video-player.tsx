/* eslint-disable @typescript-eslint/no-explicit-any */
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _data: Uint8Array,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signature: Uint8Array | string
  ): Promise<boolean> {
    // 不實作驗證 Seal SDK 只是要拿 Public Key
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

    const content = videoObject.data?.content as any;
    const fields = content.fields;
    // Use ipfs_hash as m3u8_blob_id
    const m3u8BlobId = fields.ipfs_hash;

    const initPlayer = async () => {
      if (Hls.isSupported()) {
        // 取 M3U8
        const m3u8Url = `${WALRUS_AGGREGATOR_URL}${m3u8BlobId}`;
        try {
          const response = await fetch(m3u8Url);
          if (!response.ok) throw new Error("Failed to fetch m3u8");
          let m3u8Text = await response.text();

          const hls = new Hls({
            enableWorker: false,
            loader: class CustomLoader extends Hls.DefaultConfig.loader {
              constructor(config: any) {
                super(config);
                const load = this.load.bind(this);
                this.load = async (
                  context: any,
                  config: any,
                  callbacks: any
                ) => {
                  // 攔截 Key 請求並回傳已解密的 Key
                  if (context.url.includes("video.key")) {
                    console.log("[CustomLoader] Intercepting key request");
                    if (decryptedKey) {
                      callbacks.onSuccess(
                        {
                          data: decryptedKey.buffer,
                          url: context.url,
                        },
                        { url: context.url },
                        context
                      );
                    } else {
                      callbacks.onError(
                        new Error("Key not available"),
                        context,
                        context
                      );
                    }
                    return;
                  }
                  // 其他請求 (m3u8, segments) 走預設載入邏輯
                  load(context, config, callbacks);
                };
              }
            } as any,
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
    const content = videoObject.data?.content as any;
    const fields = content.fields;
    const price = Number(fields.price);

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
    } catch (e: any) {
      console.error(e);
      toast.error("Purchase Failed: " + e.message);
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
      const content = videoObject.data?.content as any;
      const fields = content.fields;
      const keyBlobId = fields.key_blob_id;
      const sealId = new Uint8Array(fields.seal_id);
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
        const content = p.data?.content as any;
        return content.fields.video_id === id;
      });

      // 如是創作者本人也算有權限
      const isCreator = fields.creator === currentAccount.address;

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

      const sessionKey = await SessionKey.create({
        suiClient,
        packageId: VIDEO_PLATFORM_PACKAGE_ID,
        address: currentAccount.address,
        ttlMin: 10,
        signer: signerAdapter as any,
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
    } catch (err: any) {
      console.error("Decryption failed:", err);
      setError(err.message || "Decryption failed");
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

  const content = videoObject.data.content as any;
  const fields = content.fields;

  // Check access
  const pass = ownedObjects?.data.find((p) => {
    const content = p.data?.content as any;
    return content.fields.video_id === id;
  });
  const isCreator = fields.creator === currentAccount?.address;
  const isFree = Number(fields.price) === 0;
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
                  fields.cover_blob_id
                    ? `${WALRUS_AGGREGATOR_URL}${fields.cover_blob_id}`
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
                {fields.title}
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
                    {fields.creator.slice(0, 6)}...{fields.creator.slice(-4)}
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
                  {fields.description || "No description provided."}
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
