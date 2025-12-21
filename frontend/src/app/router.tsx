import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layout";
import { HomePage } from "@/pages/home";
import { VideosPage } from "@/pages/videos";
import { UploadPage } from "@/pages/upload";
import VideoPlayerPage from "@/pages/video-player";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/videos", element: <VideosPage /> },
      { path: "/video/:id", element: <VideoPlayerPage /> },
      { path: "/upload", element: <UploadPage /> },
    ],
  },
]);
