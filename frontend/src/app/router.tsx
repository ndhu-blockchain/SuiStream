import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layout";
import { Home } from "@/pages/home";
import { Videos } from "@/pages/videos";
import { Upload } from "@/pages/upload";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/videos", element: <Videos /> },
      { path: "/upload", element: <Upload /> },
    ],
  },
]);
