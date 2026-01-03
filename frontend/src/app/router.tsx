import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layout";
import { VideosPage } from "@/pages/videos";
import { UploadPage } from "@/pages/upload";
import VideoPlayerPage from "@/pages/video-player";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <VideosPage /> },
      { path: "/watch", element: <VideoPlayerPage /> },
      { path: "/upload", element: <UploadPage /> },
    ],
  },
]);
