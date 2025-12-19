import { createBrowserRouter } from "react-router-dom";
import { AppLayout } from "./layout";
import Home from "@/pages/home";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [{ path: "/", element: <Home /> }],
  },
]);
