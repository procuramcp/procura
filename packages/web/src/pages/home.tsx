import { Building2Icon } from "lucide-react";
import { Link, Navigate } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useMe } from "@/lib/hooks";
import { CopyText } from "@/pages/parts";

export function Home() {
  const me = useMe();
  if (me.tenants.length === 1) return <Navigate to={`/t/${me.tenants[0]!.id}`} replace />;

  if (me.tenants.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Building2Icon />
          </EmptyMedia>
          <EmptyTitle>No tenants yet</EmptyTitle>
          <EmptyDescription>
            Ask an owner to add you, or create a tenant with the admin CLI. Your account id:
          </EmptyDescription>
        </EmptyHeader>
        <CopyText value={me.user.id} />
      </Empty>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="font-heading font-semibold text-2xl">Your tenants</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {me.tenants.map((t) => (
          <Link key={t.id} to={`/t/${t.id}`}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  {t.name}
                  <Badge variant="secondary">{t.role}</Badge>
                </CardTitle>
                <CardDescription>{t.id}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
