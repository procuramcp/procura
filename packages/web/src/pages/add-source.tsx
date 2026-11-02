import { ArrowLeftIcon, CircleAlertIcon, FileUpIcon, LinkIcon, SearchIcon, TextIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, type DocumentInput, type SourcePreview } from "@/lib/api";
import { slugify } from "@/pages/parts";

/** Bring in an API from its OpenAPI document (D-035): find it, preview it, add it. */
export function AddSourcePage() {
  const { tenantId = "" } = useParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"url" | "paste" | "file">("url");
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<{ name: string; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [found, setFound] = useState<{ input: DocumentInput; result: SourcePreview } | undefined>();

  const input = (): DocumentInput | undefined =>
    mode === "url" ? (url.trim() ? { url: url.trim() } : undefined) : mode === "paste" ? (pasted.trim() ? { document: pasted } : undefined) : file ? { document: file.text } : undefined;

  async function preview() {
    const doc = input();
    if (!doc) return;
    setBusy(true);
    setProblem(undefined);
    setFound(undefined);
    try {
      setFound({ input: doc, result: await api.previewSource(tenantId, doc) });
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link to={`/t/${tenantId}`} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Back
        </Link>
        <h1 className="font-heading font-semibold text-2xl">Add an API</h1>
        <p className="text-muted-foreground text-sm">From its OpenAPI (Swagger) description. Nothing is saved until you add it.</p>
      </div>

      <Card className="gap-4 p-4">
        <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <TabsList>
            <TabsTrigger value="url">
              <LinkIcon /> URL
            </TabsTrigger>
            <TabsTrigger value="paste">
              <TextIcon /> Paste
            </TabsTrigger>
            <TabsTrigger value="file">
              <FileUpIcon /> Upload
            </TabsTrigger>
          </TabsList>
          <TabsContent value="url">
            <Field>
              <FieldLabel htmlFor="doc-url">Document, docs page, or API address</FieldLabel>
              <Input
                id="doc-url"
                type="url"
                placeholder="https://intervals.icu/api/v1/docs/swagger-ui/index.html"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void preview()}
              />
              <FieldDescription>
                The OpenAPI document itself, a Swagger UI page (we follow it to the document), or the API's address (we try the usual places, like
                /openapi.json). Public https addresses only.
              </FieldDescription>
            </Field>
          </TabsContent>
          <TabsContent value="paste">
            <Field>
              <FieldLabel htmlFor="doc-text">OpenAPI document (JSON or YAML)</FieldLabel>
              <Textarea id="doc-text" rows={8} className="font-mono text-xs" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"openapi": "3.1.0", ...}' />
            </Field>
          </TabsContent>
          <TabsContent value="file">
            <Field>
              <FieldLabel htmlFor="doc-file">OpenAPI file (.json, .yaml)</FieldLabel>
              <Input
                id="doc-file"
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  setFile(f ? { name: f.name, text: await f.text() } : undefined);
                }}
              />
            </Field>
          </TabsContent>
        </Tabs>
        <Button className="self-start" onClick={preview} disabled={busy || !input()}>
          {busy ? <Spinner /> : <SearchIcon />} {busy ? "Reading the document…" : "Preview"}
        </Button>
        {problem && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Couldn't use that</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{problem}</AlertDescription>
          </Alert>
        )}
      </Card>

      {found && (
        <Review
          key={JSON.stringify(found.result.preview.suggestedId) + found.result.preview.operations.total}
          tenantId={tenantId}
          found={found}
          onAdded={(sourceId) => navigate(`/t/${tenantId}/sources/${sourceId}`)}
        />
      )}
    </div>
  );
}

function Review({ tenantId, found, onAdded }: { tenantId: string; found: { input: DocumentInput; result: SourcePreview }; onAdded: (sourceId: string) => void }) {
  const { preview, takenIds, documentUrl, via } = found.result;
  const firstFree = (base: string) => {
    if (!takenIds.includes(base)) return base;
    for (let i = 2; ; i++) if (!takenIds.includes(`${base}-${i}`)) return `${base}-${i}`;
  };
  const [id, setId] = useState(() => firstFree(preview.suggestedId));
  // APIs often say "username is X" in the scheme's description (Intervals.icu: "Username is API_KEY").
  const suggested = Object.fromEntries(
    preview.authSchemes.flatMap((sc) => {
      const m = sc.type === "http_basic" ? /username\s*(?:is|=|:)\s*[`'"]?([A-Za-z0-9_.-]{1,64})/i.exec(sc.description ?? "") : null;
      return m ? [[sc.id, m[1]!]] : [];
    }),
  );
  const [usernames, setUsernames] = useState<Record<string, string>>(suggested);
  const [withToolset, setWithToolset] = useState(true);
  const [toolsetName, setToolsetName] = useState(preview.name);
  const [busy, setBusy] = useState(false);
  const taken = takenIds.includes(id);
  const basic = preview.authSchemes.filter((s) => s.type === "http_basic");

  async function add() {
    setBusy(true);
    try {
      const fixed = Object.fromEntries(Object.entries(usernames).filter(([, v]) => v.trim()));
      await api.createSource(tenantId, {
        ...found.input,
        id,
        fixedUsernames: fixed,
        ...(withToolset && toolsetName.trim() ? { toolset: { id: slugify(toolsetName) || id, name: toolsetName.trim() } } : {}),
      });
      toast.success(`Added ${preview.name}`, { description: "Next: add its API key so calls can be made." });
      onAdded(id);
    } catch (e) {
      toast.error("Not added", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-heading font-semibold text-xl">{preview.name}</h2>
          <p className="truncate font-mono text-muted-foreground text-xs">{preview.baseUrl}</p>
          {documentUrl && (
            <p className="mt-1 text-muted-foreground text-xs">
              Found <span className="font-mono">{documentUrl}</span> through {via}.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{preview.operations.total} operations</Badge>
          <Badge variant="outline">{preview.operations.read} read</Badge>
          <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
            {preview.operations.write} write
          </Badge>
          <Badge variant="outline" className="border-destructive/40 text-destructive">
            {preview.operations.destructive} destructive
          </Badge>
        </div>
      </div>
      {preview.description && <p className="line-clamp-3 text-muted-foreground text-sm">{preview.description}</p>}

      {preview.warningCount > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="self-start">
              <TriangleAlertIcon /> {preview.warningCount} ingest warning{preview.warningCount === 1 ? "" : "s"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 max-h-48 list-disc overflow-y-auto pl-5 text-muted-foreground text-xs">
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  <span className="font-mono">{w.code}</span>: {w.message}
                </li>
              ))}
              {preview.warningCount > preview.warnings.length && <li>…and {preview.warningCount - preview.warnings.length} more</li>}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      <FieldGroup>
        <Field data-invalid={taken || undefined}>
          <FieldLabel htmlFor="source-id">Source id</FieldLabel>
          <Input id="source-id" className="font-mono" value={id} onChange={(e) => setId(slugify(e.target.value))} aria-invalid={taken} />
          <FieldDescription>{taken ? "Already used in this tenant. Updating an existing source comes later." : "A short name for this API in cairnmcp."}</FieldDescription>
        </Field>

        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-sm">How it signs in</h3>
          {preview.authSchemes.length === 0 && <p className="text-muted-foreground text-sm">No authentication described: calls go out without a key.</p>}
          {preview.authSchemes.map((s) => (
            <div key={s.id} className="flex flex-col gap-1 rounded-md border p-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{s.id}</span>
                <Badge variant="outline">{schemeLabel(s.type)}</Badge>
                {s.in && (
                  <span className="text-muted-foreground text-xs">
                    {s.in} <span className="font-mono">{s.name}</span>
                  </span>
                )}
              </div>
              {s.description && <p className="line-clamp-2 text-muted-foreground text-xs">{s.description}</p>}
            </div>
          ))}
          {basic.map((s) => (
            <Field key={s.id}>
              <FieldLabel htmlFor={`fixed-${s.id}`}>Fixed username for {s.id} (optional)</FieldLabel>
              <Input
                id={`fixed-${s.id}`}
                className="font-mono"
                placeholder="e.g. API_KEY"
                value={usernames[s.id] ?? ""}
                onChange={(e) => setUsernames({ ...usernames, [s.id]: e.target.value })}
              />
              <FieldDescription>
                {suggested[s.id] && usernames[s.id] === suggested[s.id]
                  ? "Filled in from the API's description. "
                  : ""}
                Some APIs use the same username for everyone and the key as the password; Intervals.icu uses API_KEY.
              </FieldDescription>
            </Field>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={withToolset} onCheckedChange={(v) => setWithToolset(v === true)} aria-label="Create a toolset now" />
            Create a toolset now, with the {preview.operations.read} read tools turned on
          </label>
          {withToolset && <Input value={toolsetName} onChange={(e) => setToolsetName(e.target.value)} placeholder="Toolset name" className="max-w-sm" />}
        </div>
      </FieldGroup>

      <Button className="self-start" onClick={add} disabled={busy || !id || taken}>
        {busy && <Spinner />} Add {preview.name}
      </Button>
    </Card>
  );
}

export function schemeLabel(type: string): string {
  return { http_basic: "username + password", http_bearer: "bearer token", api_key: "API key", oauth2: "OAuth 2", oidc: "OpenID Connect" }[type] ?? type;
}
