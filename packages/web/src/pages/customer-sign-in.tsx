import { ArrowLeftIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { act } from "@/lib/act";
import { api, type AccessProfile, type SignInEdit, type SignInView } from "@/lib/api";
import { useLoad, useRole } from "@/lib/hooks";
import { CopyText } from "@/pages/parts";
import { Problem } from "@/pages/shell";

/** How a tenant's customers sign in (D-040). */
export function CustomerSignInPage() {
  const { tenantId = "" } = useParams();
  const view = useLoad(() => api.signIn(tenantId), [tenantId]);
  const access = useLoad(() => api.access(tenantId), [tenantId]);
  if (view.error) return <Problem message={view.error.message} />;
  if (!view.data || !access.data) return <Skeleton className="h-96 w-full" />;
  return <Editor key={JSON.stringify(view.data)} tenantId={tenantId} view={view.data} profiles={access.data.profiles} onChanged={view.set} />;
}

type Draft = {
  kind: "oidc" | "oauth2";
  name: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  subjectField: string;
  labelField: string;
  defaultProfileId: string;
};

const NO_PROFILE = "__none__";

function toDraft(view: SignInView): Draft {
  const s = view.settings;
  return {
    kind: s?.kind ?? "oidc",
    name: s?.name ?? "",
    clientId: s?.clientId ?? "",
    clientSecret: "",
    issuer: s?.kind === "oidc" ? s.issuer : "",
    authorizationUrl: s?.kind === "oauth2" ? s.authorizationUrl : "",
    tokenUrl: s?.kind === "oauth2" ? s.tokenUrl : "",
    userinfoUrl: s?.kind === "oauth2" ? s.userinfoUrl : "",
    scopes: s?.scopes ?? "",
    subjectField: s?.kind === "oauth2" ? (s.subjectField ?? "") : "",
    labelField: s?.kind === "oauth2" ? (s.labelField ?? "") : "",
    defaultProfileId: s?.defaultProfileId ?? NO_PROFILE,
  };
}

function toEdit(d: Draft): SignInEdit {
  const optional = (v: string) => (v.trim() ? v.trim() : undefined);
  const common = {
    name: d.name.trim(),
    clientId: d.clientId.trim(),
    scopes: optional(d.scopes),
    defaultProfileId: d.defaultProfileId === NO_PROFILE ? undefined : d.defaultProfileId,
    clientSecret: optional(d.clientSecret),
  };
  return d.kind === "oidc"
    ? { kind: "oidc", ...common, issuer: d.issuer.trim() }
    : {
        kind: "oauth2",
        ...common,
        authorizationUrl: d.authorizationUrl.trim(),
        tokenUrl: d.tokenUrl.trim(),
        userinfoUrl: d.userinfoUrl.trim(),
        subjectField: optional(d.subjectField),
        labelField: optional(d.labelField),
      };
}

function Editor({ tenantId, view, profiles, onChanged }: { tenantId: string; view: SignInView; profiles: AccessProfile[]; onChanged: (v: SignInView) => void }) {
  const { isAdmin } = useRole(tenantId);
  const [draft, setDraft] = useState<Draft>(() => toDraft(view));
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const readOnly = !isAdmin;

  async function save() {
    const next = await act(() => api.saveSignIn(tenantId, toEdit(draft)), { busy: setBusy, failure: "Not saved" });
    if (!next) return;
    onChanged(next);
    toast.success("Saved", { description: "Customers connecting from now on sign in here." });
  }

  async function remove() {
    const next = await act(() => api.removeSignIn(tenantId), { busy: setBusy });
    if (!next) return;
    onChanged(next);
    toast.success("Removed", { description: "Customers sign in the way your team does again." });
  }

  const text = (key: keyof Draft, label: string, hint: string, placeholder = "") => (
    <Field>
      <FieldLabel htmlFor={`si-${key}`}>{label}</FieldLabel>
      <Input id={`si-${key}`} value={draft[key]} placeholder={placeholder} readOnly={readOnly} onChange={(e) => set({ [key]: e.target.value })} />
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link to={`/t/${tenantId}`} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Back
        </Link>
        <h1 className="flex items-center gap-2 font-heading font-semibold text-2xl">
          Customer sign-in {view.settings ? <Badge variant="secondary">On</Badge> : <Badge variant="outline">Off</Badge>}
        </h1>
        <p className="text-muted-foreground text-sm">
          Let your customers sign in to your MCP server with the accounts they already have with you. They become customers on their first sign-in, and their
          profiles follow the claims your sign-in sends, checked again every few minutes.
        </p>
      </div>

      {readOnly && (
        <Alert>
          <KeyRoundIcon />
          <AlertTitle>Admins and owners set this up</AlertTitle>
          <AlertDescription>You can see the settings, but not change them.</AlertDescription>
        </Alert>
      )}

      <Card className="gap-4 p-4">
        <Field>
          <FieldLabel>Redirect URI</FieldLabel>
          <CopyText value={view.callbackUrl} />
          <FieldDescription>Register this with your provider as an allowed redirect (callback) URL.</FieldDescription>
        </Field>
      </Card>

      <Card className="gap-4 p-4">
        <FieldGroup>
          <Field>
            <FieldLabel>Provider type</FieldLabel>
            <RadioGroup value={draft.kind} onValueChange={(v) => set({ kind: v as Draft["kind"] })} className="flex flex-wrap gap-4" disabled={readOnly}>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="oidc" aria-label="OpenID Connect" /> OpenID Connect
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="oauth2" aria-label="OAuth 2" /> OAuth 2 with a profile URL
              </label>
            </RadioGroup>
            <FieldDescription>
              {draft.kind === "oidc"
                ? "Auth0, Okta, Entra, Google, Cognito, Clerk, Keycloak, and anything else that speaks OpenID Connect."
                : "For an API with OAuth 2 but not OpenID Connect: who signed in, and their claims, come from a URL that describes the signed-in account."}
            </FieldDescription>
          </Field>
          {text("name", "Name", "Shown to customers when they sign in, like your product's name.", "Acme")}
          {draft.kind === "oidc" ? (
            text("issuer", "Issuer URL", "Your provider's issuer; its settings are found from /.well-known/openid-configuration.", "https://login.example.com/")
          ) : (
            <>
              {text("authorizationUrl", "Authorization URL", "Where customers are sent to sign in.", "https://example.com/oauth/authorize")}
              {text("tokenUrl", "Token URL", "Where cairnmcp exchanges the code for tokens.", "https://example.com/oauth/token")}
              {text("userinfoUrl", "Profile URL", "Answers with JSON about the signed-in account.", "https://example.com/api/me")}
              <div className="grid gap-4 sm:grid-cols-2">
                {text("subjectField", "ID field", "The field that identifies the account and never changes.", "id")}
                {text("labelField", "Name field", "The field shown as their name in this console.", "email")}
              </div>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {text("clientId", "Client ID", "From the app you registered with your provider.")}
            <Field>
              <FieldLabel htmlFor="si-secret">Client secret</FieldLabel>
              <Input
                id="si-secret"
                type="password"
                autoComplete="new-password"
                value={draft.clientSecret}
                readOnly={readOnly}
                placeholder={view.secretSet ? "Saved; leave empty to keep" : ""}
                onChange={(e) => set({ clientSecret: e.target.value })}
              />
              <FieldDescription>Encrypted when saved and never shown again.</FieldDescription>
            </Field>
          </div>
          {text(
            "scopes",
            "Scopes",
            draft.kind === "oidc" ? "Leave empty for openid email profile offline_access. offline_access keeps plans up to date." : "Space-separated, as your provider names them.",
          )}
          <Field>
            <FieldLabel>Default profile</FieldLabel>
            <Select value={draft.defaultProfileId} onValueChange={(v) => set({ defaultProfileId: v })} disabled={readOnly}>
              <SelectTrigger className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROFILE}>None</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Everyone who signs in gets it, like a free plan. Other profiles come from claims: set those on each profile.</FieldDescription>
          </Field>
        </FieldGroup>
      </Card>

      {!readOnly && (
        <div className="flex items-center justify-between gap-2">
          {view.settings ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="text-destructive" disabled={busy}>
                  <Trash2Icon /> Turn off
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn off customer sign-in?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Connected customers are signed out at their next refresh. Their accounts, profiles, and access stay here.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void remove()}>Turn off</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <span />
          )}
          <Button onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.clientId.trim() || (!view.secretSet && !draft.clientSecret.trim())}>
            {busy && <Spinner />} Save
          </Button>
        </div>
      )}
    </div>
  );
}
