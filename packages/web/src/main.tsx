import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/pages/shell";
import "./index.css";

// Follow the system's light or dark setting.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

// Each page is its own chunk, fetched when its route is first opened, so the
// first load carries only the shell.
const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <Shell />,
      children: [
        { index: true, lazy: async () => ({ Component: (await import("@/pages/home")).Home }) },
        {
          path: "t/:tenantId",
          lazy: async () => ({ Component: (await import("@/pages/tenant")).TenantPage }),
        },
        {
          path: "t/:tenantId/toolsets/:toolsetId",
          lazy: async () => ({ Component: (await import("@/pages/toolset")).ToolsetPage }),
        },
        {
          path: "t/:tenantId/access",
          lazy: async () => ({ Component: (await import("@/pages/access")).AccessPage }),
        },
        {
          path: "t/:tenantId/sources/new",
          lazy: async () => ({ Component: (await import("@/pages/add-source")).AddSourcePage }),
        },
        {
          path: "t/:tenantId/sources/:sourceId",
          lazy: async () => ({ Component: (await import("@/pages/source")).SourcePage }),
        },
        {
          path: "t/:tenantId/sources/:sourceId/update",
          lazy: async () => ({ Component: (await import("@/pages/update-source")).UpdateSourcePage }),
        },
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
