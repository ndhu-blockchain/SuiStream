import { useParams } from "react-router-dom";
import {
  useSuiClientQuery,
  useCurrentAccount,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useRef } from "react";
import { SealClient, SessionKey } from "@mysten/seal";
import { suiClient, VIDEO_PLATFORM_PACKAGE_ID } from "@/lib/sui";
import { Transaction } from "@mysten/sui/transactions";
import { PublicKey } from "@mysten/sui/cryptography";
import { toBase64, toHex } from "@mysten/sui/utils";
import { bcs } from "@mysten/sui/bcs";
import Hls from "hls.js";

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
    // 這裡我們不需要真的實作驗證，因為 Seal SDK 只是要拿 Public Key
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
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);

  // 1. 獲取影片 Metadata (從鏈上物件)
  const { data: videoObject, isPending } = useSuiClientQuery("getObject", {
    id: id!,
    options: { showContent: true },
  });

  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  useEffect(() => {
    if (!decryptedKey || !videoObject || !videoRef.current) return;

    const content = videoObject.data?.content as any;
    const fields = content.fields;
    // Use ipfs_hash as m3u8_blob_id
    const m3u8BlobId = fields.ipfs_hash;

    const initPlayer = async () => {
      if (Hls.isSupported()) {
        // 1. Fetch M3U8
        const m3u8Url = `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${m3u8BlobId}`;
        try {
          const response = await fetch(m3u8Url);
          if (!response.ok) throw new Error("Failed to fetch m3u8");
          let m3u8Text = await response.text();

          // 2. Modify M3U8: Remove Encryption Tag
          m3u8Text = m3u8Text.replace(
            /#EXT-X-KEY:METHOD=AES-128,URI="video.key"\n/g,
            ""
          );

          // 3. Find the video URL from the M3U8 content
          // The M3U8 should contain the full Walrus URL now (since we embedded it during upload)
          const videoUrlMatch = m3u8Text.match(
            /(https:\/\/aggregator\.walrus-testnet\.walrus\.space\/v1\/blobs\/[a-zA-Z0-9_-]+)/
          );
          const videoUrl = videoUrlMatch ? videoUrlMatch[0] : "";

          if (!videoUrl) {
            console.error("Could not find video URL in M3U8");
            // Fallback or error handling
          }

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
                  if (context.url === videoUrl) {
                    try {
                      const fetchConfig = {
                        headers: {} as any,
                      };
                      if (context.rangeStart !== undefined) {
                        fetchConfig.headers[
                          "Range"
                        ] = `bytes=${context.rangeStart}-${context.rangeEnd}`;
                      }

                      const res = await fetch(context.url, fetchConfig);
                      if (!res.ok) throw new Error("Failed to fetch segment");
                      const buffer = await res.arrayBuffer();
                      const encryptedChunk = new Uint8Array(buffer);

                      console.log(
                        `[CustomLoader] Fetched chunk: ${encryptedChunk.length} bytes. Range: ${context.rangeStart}-${context.rangeEnd}`
                      );

                      if (encryptedChunk.length < 17) {
                        throw new Error(
                          `Chunk too small: ${encryptedChunk.length}`
                        );
                      }

                      // Decrypt: [IV (16 bytes)] [Encrypted Data]
                      const iv = encryptedChunk.slice(0, 16);
                      const data = encryptedChunk.slice(16);

                      console.log(`[CustomLoader] IV: ${toHex(iv)}`);
                      console.log(`[CustomLoader] Data size: ${data.length}`);

                      let dataToDecrypt = data;
                      if (data.length % 16 !== 0) {
                        console.warn(
                          `[CustomLoader] Warning: Data length (${data.length}) is not a multiple of 16! Decryption might fail.`
                        );
                        const newLength = data.length - (data.length % 16);
                        console.warn(
                          `[CustomLoader] Truncating to ${newLength} bytes.`
                        );
                        dataToDecrypt = data.slice(0, newLength);
                      }

                      const key = await window.crypto.subtle.importKey(
                        "raw",
                        decryptedKey as any,
                        "AES-CBC",
                        false,
                        ["decrypt"]
                      );

                      const decryptedChunk = await window.crypto.subtle.decrypt(
                        { name: "AES-CBC", iv: iv },
                        key,
                        dataToDecrypt
                      );

                      console.log(
                        `[CustomLoader] Decryption successful! Decrypted size: ${decryptedChunk.byteLength}`
                      );

                      callbacks.onSuccess(
                        { data: decryptedChunk, url: context.url },
                        { url: context.url },
                        context
                      );
                    } catch (err) {
                      console.error("Segment load error:", err);
                      callbacks.onError(err, context, context);
                    }
                  } else {
                    load(context, config, callbacks);
                  }
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

  const handlePlay = async () => {
    if (!videoObject || !currentAccount) return;
    setIsDecrypting(true);
    setError("");

    try {
      const content = videoObject.data?.content as any;
      const fields = content.fields;
      const keyBlobId = fields.key_blob_id;
      const sealId = new Uint8Array(fields.seal_id);
      console.log("Seal ID:", sealId);
      console.log("Seal ID (Hex):", toHex(sealId));

      // 1. Check for AccessPass
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

      // If creator, they can also play (using seal_approve)
      const isCreator = fields.creator === currentAccount.address;

      if (!pass && !isCreator) {
        throw new Error("You don't have an Access Pass for this video.");
      }

      // 2. Build Transaction for Authorization
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

      // 移除手動 Gas Payment，讓 SDK 自動處理
      // 但保留 sender 設定

      // 檢查 Transaction Data 結構
      const txData = await tx.getData();
      console.log("Transaction Data JSON:", JSON.stringify(txData, null, 2));

      // 重要：Seal SDK 需要的是 BCS 序列化後的 TransactionData
      // tx.build() 回傳的就是這個 Uint8Array
      // 根據文件，必須設定 onlyTransactionKind: true
      const txBytes = await tx.build({
        client: suiClient,
        onlyTransactionKind: true,
      });
      console.log("TxBytes Hex:", toHex(txBytes));

      console.log("Fetching Encrypted Key from Walrus...", keyBlobId);
      // 3. Fetch Encrypted Key
      const response = await fetch(
        `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${keyBlobId}`
      );
      if (!response.ok) throw new Error("Failed to fetch key from Walrus");
      const encryptedKey = new Uint8Array(await response.arrayBuffer());

      console.log("Creating Session Key...");
      const signerAdapter = {
        signPersonalMessage: async (message: Uint8Array) => {
          // Seal SDK 傳入的是 Uint8Array (bytes)，而不是物件
          const res = await signPersonalMessage({ message });

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

      console.log("Decrypting with Seal...");
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
        // 增加 timeout 避免網路問題
        timeout: 30000,
      });

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
    }
  };

  if (isPending) return <div>Loading video...</div>;
  if (!videoObject?.data) return <div>Video not found</div>;

  const content = videoObject.data.content as any;
  const fields = content.fields;

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">{fields.title}</h1>
      <p className="text-gray-600 mb-8">{fields.description}</p>

      <div className="aspect-video bg-black rounded-lg flex items-center justify-center relative overflow-hidden">
        {!decryptedKey ? (
          <div className="text-center">
            <p className="text-white mb-4">Content is Encrypted</p>
            <Button onClick={handlePlay} disabled={isDecrypting}>
              {isDecrypting ? "Decrypting..." : "Unlock & Play"}
            </Button>
            {error && <p className="text-red-500 mt-2">{error}</p>}
          </div>
        ) : (
          <video
            ref={videoRef}
            controls
            className="w-full h-full"
            poster={
              fields.cover_blob_id
                ? `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${fields.cover_blob_id}`
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
