import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClientQuery,
} from "@mysten/dapp-kit";
import {
  buyVideo,
  VIDEO_PLATFORM_PACKAGE_ID,
  suiClient,
  MIST_PER_SUI,
  WALRUS_AGGREGATOR_URL,
} from "@/lib/sui";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Play, User, Tag, Film } from "lucide-react";

type MoveFields = Record<string, unknown>;

function getMoveFieldsFromObjectResponse(
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

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function getStringProp(
  obj: Record<string, unknown>,
  key: string
): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function getNumberProp(
  obj: Record<string, unknown>,
  key: string
): number | null {
  const value = obj[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

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

  // 查詢使用者擁有的 AccessPass
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

  const [buyingId, setBuyingId] = useState<string | null>(null);

  if (isEventsPending) {
    return (
      <div className="flex h-[50vh] w-full items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading videos...</p>
        </div>
      </div>
    );
  }

  // 整理已購買的 Video ID
  const purchasedVideoIds = new Set(
    (ownedObjects?.data ?? [])
      .map((obj) => {
        const fields = getMoveFieldsFromObjectResponse(obj);
        return fields?.["video_id"];
      })
      .filter((id): id is string => typeof id === "string")
  );

  const videoEvents = (events?.data ?? []).filter(
    (event) =>
      typeof event?.type === "string" && event.type.includes("VideoCreated")
  );

  return (
    <div className="container mx-auto px-4 py-8 md:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Explore Videos</h1>
          <p className="text-muted-foreground mt-1">
            Discover and watch decentralized content
          </p>
        </div>
        <Button onClick={() => navigate("/upload")}>Upload</Button>
      </div>
      {videoEvents && videoEvents.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {videoEvents.map((event) => {
            const parsedJson = getRecord(event.parsedJson);
            if (!parsedJson) return null;

            const videoId = getStringProp(parsedJson, "id");
            const title = getStringProp(parsedJson, "title") ?? "";
            const creator = getStringProp(parsedJson, "creator") ?? "";
            const priceMist = getNumberProp(parsedJson, "price") ?? 0;
            const price = priceMist ? priceMist / MIST_PER_SUI : 0;

            const coverBlobId = getStringProp(parsedJson, "cover_blob_id");
            const coverUrl = coverBlobId
              ? `${WALRUS_AGGREGATOR_URL}${coverBlobId}`
              : null;

            if (!videoId) return null;

            const isCreator = currentAccount?.address === creator;
            const isPurchased = purchasedVideoIds.has(videoId);
            const isFree = price === 0;
            const hasAccess = isCreator || isPurchased || isFree;

            return (
              <Card
                key={videoId}
                className="group flex flex-col overflow-hidden transition-all hover:shadow-lg"
              >
                <CardHeader className="p-0">
                  <div className="relative aspect-video w-full overflow-hidden bg-muted">
                    {coverUrl ? (
                      <img
                        src={coverUrl}
                        alt={title}
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-secondary/50">
                        <Film className="h-12 w-12 text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="absolute right-2 top-2">
                      <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 bg-background">
                        {isFree ? "Free" : `${price} SUI`}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3 p-4">
                  <div className="space-y-1">
                    <h3
                      className="line-clamp-1 text-lg font-semibold leading-none tracking-tight"
                      title={title}
                    >
                      {title}
                    </h3>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span className="truncate">
                        {creator.slice(0, 6)}...{creator.slice(-4)}
                        {isCreator && (
                          <span className="ml-1 font-medium text-primary">
                            (You)
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="grid grid-cols-2 gap-3 p-4 pt-0">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() =>
                      navigate(`/watch?v=${encodeURIComponent(videoId)}`)
                    }
                  >
                    <Play className="mr-2 h-4 w-4" />
                    Details
                  </Button>
                  {hasAccess ? (
                    <Button
                      variant="secondary"
                      className="w-full cursor-default opacity-80"
                      disabled
                    >
                      {isCreator ? "Owner" : isFree ? "Free" : "Owned"}
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={async () => {
                        if (!currentAccount) return;
                        setBuyingId(videoId);
                        try {
                          const result = await buyVideo(
                            { id: videoId, price: priceMist },
                            currentAccount.address,
                            signAndExecuteTransaction
                          );
                          await suiClient.waitForTransaction({
                            digest: result.digest,
                          });
                          toast.success("Purchase Successful!");
                          await refetchOwnedObjects();
                        } catch (e) {
                          console.error(e);
                          toast.error("Purchase Failed");
                        } finally {
                          setBuyingId(null);
                        }
                      }}
                      disabled={buyingId === videoId || !currentAccount}
                    >
                      {buyingId === videoId ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Buying
                        </>
                      ) : (
                        <>
                          <Tag className="mr-2 h-4 w-4" />
                          Buy
                        </>
                      )}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="rounded-full bg-muted p-4">
            <Film className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="mt-4 text-lg font-semibold">No videos found</h3>
          <p className="text-muted-foreground">
            Be the first to upload a video to the platform!
          </p>
        </div>
      )}
    </div>
  );
}

export { VideosPage };
