import { ArrowLeftIcon, CheckCircle2Icon, KeyRoundIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { act } from "@/lib/act";
import { api, type CredentialInput, type SourceView } from "@/lib/api";
import { useLoad, useRole } from "@/lib/hooks";
import { schemeLabel } from "@/pages/add-source";
import { Problem } from "@/pages/shell";

/** One API: what it is, and its keys (D-035). Keys go in, never come back out. */
export function SourcePage() {
  const { tenantId = "", sourceId = "" } = useParams();
  const view = useLoad(() => api.source(tenantId, sourceId), [tenantId, sourceId]);
  const { isAdmin, canEdit } = useRole(tenantId);
  if (view.error) return <Problem message={view.error.message} />;
  if (!view.data) return <Skeleton className="h-96 w-full" />;
  const source = view.data;
  const missing = source.authSchemes.length > 0 && source.authSchemes.every((s) => s.stored.length === 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link to={`/t/${tenantId}`} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Back
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-heading font-semibold text-2xl">{source.name}</h1>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/t/${tenantId}/sources/${sourceId}/update`}>
                <RefreshCwIcon /> Update from a new version
              </Link>
            </Button>
          )}
        </div>
        <p className="font-mono text-muted-foreground text-xs">{source.baseUrl}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge variant="secondary">{source.operations.total} operations</Badge>
          <Badge variant="outline">{source.operations.read} read</Badge>
          <Badge variant="outline">{source.operations.write} write</Badge>
          <Badge variant="outline">{source.operations.destructive} destructive</Badge>
        </div>
        {source.documentUrl && (
          <p className="text-muted-foreground text-xs">
            From <span className="font-mono">{source.documentUrl}</span>
          </p>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Keys</h2>
          <p className="text-muted-foreground text-sm">
            {isAdmin
              ? `${missing ? "Add a key so tools can call this API. " : ""}A key is encrypted when saved and never shown again; you can replace or remove it.`
              : "Admins and owners manage keys. A key is encrypted when saved and never shown again."}
          </p>
        </div>
        {source.authSchemes.map((scheme) => (
          <KeyCard key={scheme.id} tenantId={tenantId} source={source} scheme={scheme} onChanged={view.set} canManage={isAdmin} />
        ))}
        {source.authSchemes.length === 0 && <p className="text-muted-foreground text-sm">This API describes no authentication.</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Toolsets using it</h2>
        {source.toolsets.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            None yet. Create one from the <Link to={`/t/${tenantId}`} className="underline">tenant page</Link>.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {source.toolsets.map((t) => (
              <Button key={t.id} asChild variant="outline" size="sm">
                <Link to={`/t/${tenantId}/toolsets/${t.id}`}>{t.name}</Link>
              </Button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function KeyCard(props: { tenantId: string; source: SourceView; scheme: SourceView["authSchemes"][number]; onChanged: (v: SourceView) => void; canManage: boolean }) {
  const { tenantId, source, scheme, onChanged, canManage } = props;
  const stored = scheme.stored.length > 0;
  const [editing, setEditing] = useState(!stored && canManage);
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const kind = scheme.accepts[0];

  const credential = (): CredentialInput | undefined => {
    if (!secret) return undefined;
    switch (kind) {
      case "basic":
        return { kind: "basic", password: secret, ...(scheme.fixedUsername ? {} : username ? { username } : {}) };
      case "bearer":
        return { kind: "bearer", token: secret };
      case "api_key":
        return { kind: "api_key", value: secret };
      case "oauth2":
        return { kind: "oauth2", accessToken: secret };
      default:
        return undefined;
    }
  };

  async function save() {
    const c = credential();
    if (!c) return;
    const next = await act(() => api.setCredential(tenantId, source.id, scheme.id, c), { busy: setBusy });
    if (!next) return;
    onChanged(next);
    setSecret("");
    setUsername("");
    setEditing(false);
    toast.success(`Saved the key for ${scheme.id}`, { description: "Encrypted; it won't be shown again." });
  }

  async function remove() {
    const next = await act(() => api.removeCredential(tenantId, source.id, scheme.id));
    if (!next) return;
    onChanged(next);
    setEditing(true);
    toast.success(`Removed the key for ${scheme.id}`);
  }

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
          <span className="font-mono text-sm">{scheme.id}</span>
          <Badge variant="outline">{schemeLabel(scheme.type)}</Badge>
        </div>
        {stored ? (
          <Badge className="bg-emerald-600/15 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2Icon /> Key set
          </Badge>
        ) : (
          <Badge variant="secondary">No key</Badge>
        )}
      </div>
      {scheme.description && <p className="line-clamp-3 text-muted-foreground text-xs">{scheme.description}</p>}
      {!kind && <p className="text-muted-foreground text-sm">procura can't store keys for this kind of sign-in yet.</p>}

      {kind && editing && (
        <FieldGroup>
          {kind === "basic" && !scheme.fixedUsername && (
            <Field>
              <FieldLabel htmlFor={`user-${scheme.id}`}>Username</FieldLabel>
              <Input id={`user-${scheme.id}`} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={`secret-${scheme.id}`}>{secretLabel(kind)}</FieldLabel>
            <Input
              id={`secret-${scheme.id}`}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
            {kind === "basic" && scheme.fixedUsername && (
              <FieldDescription>
                The username is always <span className="font-mono">{scheme.fixedUsername}</span>; enter the key as the password.
              </FieldDescription>
            )}
            {scheme.in && (
              <FieldDescription>
                Sent in the {scheme.in} <span className="font-mono">{scheme.name}</span>.
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>
      )}

      {kind && canManage && (
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button size="sm" onClick={save} disabled={busy || !credential()}>
                {busy && <Spinner />} {stored ? "Replace key" : "Save key"}
              </Button>
              {stored && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Replace key
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="ghost" className="text-destructive">
                    <Trash2Icon /> Remove
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove the key for {scheme.id}?</AlertDialogTitle>
                    <AlertDialogDescription>Tools that need it fail until a new key is added.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function secretLabel(kind: string): string {
  return { basic: "Password or API key", bearer: "Token", api_key: "API key", oauth2: "Access token" }[kind] ?? "Secret";
}
