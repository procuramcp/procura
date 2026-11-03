import { CircleAlertIcon, FileUpIcon, LinkIcon, SearchIcon, TextIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { DocumentInput } from "@/lib/api";

/**
 * Where an OpenAPI document comes from: a URL (the document, a Swagger UI page, or the API's
 * address), pasted text, or a file. Used to add an API (D-035) and to update one (D-048).
 */
export function DocumentFinder({
  initialUrl = "",
  busy,
  problem,
  submitLabel = "Preview",
  onSubmit,
}: {
  initialUrl?: string;
  busy: boolean;
  /** Shown under the button when the last attempt failed. */
  problem?: string | undefined;
  submitLabel?: string;
  onSubmit: (doc: DocumentInput) => void;
}) {
  const [mode, setMode] = useState<"url" | "paste" | "file">("url");
  const [url, setUrl] = useState(initialUrl);
  const [pasted, setPasted] = useState("");
  const [file, setFile] = useState<{ name: string; text: string } | undefined>();

  const input = (): DocumentInput | undefined =>
    mode === "url" ? (url.trim() ? { url: url.trim() } : undefined) : mode === "paste" ? (pasted.trim() ? { document: pasted } : undefined) : file ? { document: file.text } : undefined;
  const submit = () => {
    const doc = input();
    if (doc && !busy) onSubmit(doc);
  };

  return (
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
              onKeyDown={(e) => e.key === "Enter" && submit()}
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
      <Button className="self-start" onClick={submit} disabled={busy || !input()}>
        {busy ? <Spinner /> : <SearchIcon />} {busy ? "Reading the document…" : submitLabel}
      </Button>
      {problem && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Couldn't use that</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{problem}</AlertDescription>
        </Alert>
      )}
    </Card>
  );
}
