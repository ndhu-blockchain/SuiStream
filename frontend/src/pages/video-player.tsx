import { useParams } from "react-router-dom";
import {
  useSuiClientQuery,
  useCurrentAccount,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { SealClient, SessionKey } from "@mysten/seal";
import { suiClient, VIDEO_PLATFORM_PACKAGE_ID } from "@/lib/sui";
import { Transaction } from "@mysten/sui/transactions";

export default function VideoPlayerPage() {
  const { id } = useParams();
  const currentAccount = useCurrentAccount();
  const [decryptedKey, setDecryptedKey] = useState<Uint8Array | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState("");

  // 1. 獲取影片 Metadata (從鏈上物件)
  const { data: videoObject, isPending } = useSuiClientQuery("getObject", {
    id: id!,
    options: { showContent: true },
  });

  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const handlePlay = async () => {
    if (!videoObject || !currentAccount) return;
    setIsDecrypting(true);
    setError("");

    try {
      const content = videoObject.data?.content as any;
      const fields = content.fields;
      const keyBlobId = fields.key_blob_id;
      const sealId = new Uint8Array(fields.seal_id);

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
      if (isCreator) {
        tx.moveCall({
          target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::seal_approve`,
          arguments: [tx.pure.vector("u8", sealId), tx.object(id!)],
        });
      } else {
        tx.moveCall({
          target: `${VIDEO_PLATFORM_PACKAGE_ID}::video_platform::seal_approve_with_pass`,
          arguments: [
            tx.pure.vector("u8", sealId),
            tx.object(id!),
            tx.object(pass!.data!.objectId),
          ],
        });
      }
      tx.setSender(currentAccount.address);
      const txBytes = await tx.build({ client: suiClient });

      console.log("Fetching Encrypted Key from Walrus...", keyBlobId);
      // 3. Fetch Encrypted Key
      const response = await fetch(
        `https://aggregator.walrus-testnet.walrus.space/v1/blobs/${keyBlobId}`
      );
      if (!response.ok) throw new Error("Failed to fetch key from Walrus");
      const encryptedKey = new Uint8Array(await response.arrayBuffer());

      console.log("Creating Session Key...");
      const signerAdapter = {
        signPersonalMessage: async (input: { message: Uint8Array }) => {
          const res = await signPersonalMessage({ message: input.message });
          return { bytes: res.bytes, signature: res.signature };
        },
        getAddress: async () => currentAccount.address,
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
      });

      const decrypted = await client.decrypt({
        data: encryptedKey,
        sessionKey,
        txBytes,
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
          <div className="w-full h-full flex items-center justify-center">
            <p className="text-green-500 text-xl">
              Key Decrypted! Ready to Play. <br />
              (Player integration pending...)
            </p>
            {/* 這裡未來會整合 Hls.js 並注入 decryptedKey */}
          </div>
        )}
      </div>
    </div>
  );
}
