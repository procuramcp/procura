import { DatabaseIcon, PlusIcon, UsersIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { act } from "@/lib/act";
import { api, type TenantView } from "@/lib/api";
import { useLoad, useRole } from "@/lib/hooks";
import { CopyText, slugify } from "@/pages/parts";
import { Problem } from "@/pages/shell";

export function TenantPage() {
  const { tenantId = "" } = useParams();
  const view = useLoad(() => api.tenant(tenantId), [tenantId]);
  const { canEdit } = useRole(tenantId);

  if (view.error) return <Problem message={view.error.message} />;
  if (!view.data) return <Skeleton className="h-64 w-full" />;
  const { tenant, toolsets, sources, people } = view.data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading font-semibold text-2xl">{tenant.name}</h1>
          <p className="text-muted-foreground text-sm">
            {plural(toolsets.length, "toolset")} · {plural(sources.length, "source")} · {plural(people.team, "on the team", "on the team")} ·{" "}
            {plural(people.customers, "customer")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to={`/t/${tenant.id}/access`}>
              <UsersIcon /> People and profiles
            </Link>
          </Button>
          {canEdit && <NewToolset view={view.data} />}
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Toolsets</h2>
        {toolsets.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WrenchIcon />
              </EmptyMedia>
              <EmptyTitle>No toolsets yet</EmptyTitle>
              <EmptyDescription>A toolset is one MCP endpoint: the tools you choose from a source.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {toolsets.map((t) => (
              <Card key={t.id}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <Link to={`/t/${tenant.id}/toolsets/${t.id}`} className="hover:underline">
                      {t.name}
                    </Link>
                    <Badge variant="secondary">{t.enabledTools} tools</Badge>
                  </CardTitle>
                  <CardDescription>from {sources.find((s) => s.id === t.sourceId)?.name ?? t.sourceId}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <CopyText value={t.endpoint} />
                  <Button asChild variant="outline" size="sm" className="self-start">
                    <Link to={`/t/${tenant.id}/toolsets/${t.id}`}>{canEdit ? "Edit tools" : "View tools"}</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Sources</h2>
          {canEdit && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/t/${tenant.id}/sources/new`}>
                <PlusIcon /> Add an API
              </Link>
            </Button>
          )}
        </div>
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Operations</TableHead>
                <TableHead className="text-right">Reads</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <DatabaseIcon className="size-4 text-muted-foreground" />
                      <Link to={`/t/${tenant.id}/sources/${s.id}`} className="hover:underline">
                        {s.name}
                      </Link>{" "}
                      <span className="font-mono text-muted-foreground text-xs">{s.id}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.operations}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.reads}</TableCell>
                </TableRow>
              ))}
              {sources.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No APIs yet.{" "}
                    {canEdit && (
                      <>
                        <Link to={`/t/${tenant.id}/sources/new`} className="underline">
                          Add one
                        </Link>{" "}
                        from its OpenAPI description.
                      </>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </section>
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function NewToolset({ view }: { view: TenantView }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [sourceId, setSourceId] = useState(view.sources[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const taken = view.toolsets.some((t) => t.id === id);

  async function create() {
    const created = await act(() => api.createToolset(view.tenant.id, { id, name, sourceId }), { busy: setBusy });
    if (!created) return;
    toast.success(`Created ${name}`, { description: "Read tools are on; writes start off." });
    navigate(`/t/${view.tenant.id}/toolsets/${id}`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={view.sources.length === 0}>
          <PlusIcon />
          New toolset
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New toolset</DialogTitle>
          <DialogDescription>Starts with every read operation of the source as a tool. You can trim it down next.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ts-name">Name</FieldLabel>
            <Input
              id="ts-name"
              value={name}
              placeholder="My training"
              onChange={(e) => {
                setName(e.target.value);
                if (!idEdited) setId(slugify(e.target.value));
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="ts-id">Id</FieldLabel>
            <Input
              id="ts-id"
              value={id}
              className="font-mono"
              onChange={(e) => {
                setIdEdited(true);
                setId(slugify(e.target.value));
              }}
            />
            <FieldDescription>
              Part of the MCP URL: <span className="font-mono">/mcp/{view.tenant.id}/{id || "…"}</span>
              {taken && <span className="text-destructive"> · already taken</span>}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Source</FieldLabel>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {view.sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button onClick={create} disabled={busy || !name || !id || !sourceId || taken}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
