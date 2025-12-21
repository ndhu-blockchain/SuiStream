import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClientQuery,
} from "@mysten/dapp-kit";
import { buyVideo, VIDEO_PLATFORM_PACKAGE_ID } from "@/lib/sui";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function VideosPage() {
  const currentAccount = useCurrentAccount();
  const { mutateAsync: signAndExecuteTransaction } =
    useSignAndExecuteTransaction();
  const navigate = useNavigate();

  // 查詢 Events
  const { data: events, isPending: isEventsPending } = useSuiClientQuery(
    "queryEvents",
    {
      query: {
        MoveModule: {
          package: VIDEO_PLATFORM_PACKAGE_ID,
          module: "video_platform",
        },
      },
      limit: 50,
      order: "descending",
    }
  );

  const [buyingId, setBuyingId] = useState<string | null>(null);

  if (isEventsPending) return <div className="p-8">Loading videos...</div>;

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-8">Explore Videos</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {events?.data.map((event: any) => {
          // 只顯示 VideoCreated 事件
          if (!event.type.includes("VideoCreated")) return null;

          const parsedJson = event.parsedJson;
          const videoId = parsedJson.id;
          const title = parsedJson.title;
          const price = parsedJson.price
            ? Number(parsedJson.price) / 1_000_000_000
            : 0; // MIST to SUI

          return (
            <Card key={videoId}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>
                  Creator: {parsedJson.creator.slice(0, 6)}...
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="aspect-video bg-gray-100 rounded-md flex items-center justify-center mb-4">
                  <span className="text-gray-400">Thumbnail Placeholder</span>
                </div>
                <p className="font-bold text-lg">
                  {price > 0 ? `${price} SUI` : "Free"}
                </p>
              </CardContent>
              <CardFooter className="flex justify-between">
                <Button
                  variant="outline"
                  onClick={() => navigate(`/video/${videoId}`)}
                >
                  View Details
                </Button>
                {price > 0 && (
                  <Button
                    onClick={async () => {
                      if (!currentAccount) return;
                      setBuyingId(videoId);
                      try {
                        await buyVideo(
                          { id: videoId, price: Number(parsedJson.price) },
                          currentAccount.address,
                          signAndExecuteTransaction
                        );
                        alert("Purchase Successful!");
                      } catch (e) {
                        console.error(e);
                        alert("Purchase Failed");
                      } finally {
                        setBuyingId(null);
                      }
                    }}
                    disabled={buyingId === videoId}
                  >
                    {buyingId === videoId ? "Buying..." : "Buy Access"}
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
export { VideosPage };
