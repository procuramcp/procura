import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/pages/shell";
import { AccessPage } from "@/pages/access";
import { Home } from "@/pages/home";
import { TenantPage } from "@/pages/tenant";
import { ToolsetPage } from "@/pages/toolset";
import "./index.css";

// Follow the system's light or dark setting.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <Shell />,
      children: [
        { index: true, element: <Home /> },
        { path: "t/:tenantId", element: <TenantPage /> },
        { path: "t/:tenantId/toolsets/:toolsetId", element: <ToolsetPage /> },
        { path: "t/:tenantId/access", element: <AccessPage /> },
      ],
    },
  ],
  { basename: "/app" },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
  </StrictMode>,
);
