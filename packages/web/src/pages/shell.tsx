import { Building2Icon, LogOutIcon, MountainIcon } from "lucide-react";
import { NavLink, Outlet, useLocation, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, type Provider } from "@/lib/api";
import { MeContext, useLoad } from "@/lib/hooks";

export function Shell() {
  const me = useLoad(() => api.me(), []);
  const { tenantId } = useParams();
  const { pathname } = useLocation();

  if (me.loading && !me.data) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Skeleton className="h-40 w-80" />
      </div>
    );
  }
  if (me.error) {
    const providers = me.error instanceof ApiError ? me.error.body.providers : undefined;
    return providers ? <SignIn providers={providers} /> : <Problem message={me.error.message} />;
  }
  const data = me.data!;

  async function logout() {
    await api.logout().catch(() => undefined);
    window.location.assign("/app/");
  }

  return (
    <MeContext.Provider value={data}>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <NavLink to="/" className="flex items-center gap-2 px-2 py-1.5 font-heading font-semibold">
              <MountainIcon className="size-5" />
              cairnmcp
            </NavLink>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Tenants</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {data.tenants.map((t) => (
                    <SidebarMenuItem key={t.id}>
                      <SidebarMenuButton asChild isActive={t.id === tenantId}>
                        <NavLink to={`/t/${t.id}`}>
                          <Building2Icon />
                          <span>{t.name}</span>
                        </NavLink>
                      </SidebarMenuButton>
                      {t.id === tenantId && (
                        <SidebarMenuSub>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={!pathname.endsWith("/access") && !pathname.endsWith("/sign-in")}>
                              <NavLink to={`/t/${t.id}`} end>
                                Toolsets
                              </NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={pathname.endsWith("/access")}>
                              <NavLink to={`/t/${t.id}/access`}>People and profiles</NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={pathname.endsWith("/sign-in")}>
                              <NavLink to={`/t/${t.id}/sign-in`}>Customer sign-in</NavLink>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  ))}
                  {data.tenants.length === 0 && <p className="px-2 text-muted-foreground text-sm">None yet</p>}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <div className="flex items-center justify-between gap-2 px-2">
              <span className="truncate text-muted-foreground text-sm" title={data.user.label}>
                {data.user.label}
              </span>
              <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out">
                <LogOutIcon />
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="flex h-12 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4" />
            <span className="text-muted-foreground text-sm">Curation console</span>
          </header>
          <main className="min-w-0 flex-1 p-4 md:p-6">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </MeContext.Provider>
  );
}

function SignIn({ providers }: { providers: Provider[] }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MountainIcon className="size-5" />
            cairnmcp
          </CardTitle>
          <CardDescription>Sign in to curate your MCP toolsets.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {providers.map((p) => (
            <Button key={p.id} asChild>
              {/* A full page load: sign-in is a redirect flow, not an API call. */}
              <a href={p.href}>Continue with {p.name}</a>
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function Problem({ message }: { message: string }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription className="whitespace-pre-wrap">{message}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
