import { ArrowLeftIcon, ArrowRightIcon, CheckCircle2Icon, ChevronDownIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { act } from "@/lib/act";
import { api, type DocumentInput, type OperationCounts, type SideEffect, type SourceUpdatePreview } from "@/lib/api";
import { useLoad, useRole } from "@/lib/hooks";
import { DocumentFinder } from "@/pages/document-finder";
import { Endpoint, SideEffectBadge } from "@/pages/parts";
import { Problem } from "@/pages/shell";

type Found = { input: DocumentInput | { version: number } | Record<string, never>; baseUrl: "current" | "document"; preview: SourceUpdatePreview };

/**
 * Update an API to a new version of its description (D-048): fetch it again (or give it),
 * see what changes for the API, its toolsets, and its plans, then apply exactly that.
 */
export function UpdateSourcePage() {
  const { tenantId = "", sourceId = "" } = useParams();
  const navigate = useNavigate();
  const source = useLoad(() => api.source(tenantId, sourceId), [tenantId, sourceId]);
  const { canEdit } = useRole(tenantId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [found, setFound] = useState<Found | undefined>();
  // Restoring a kept version (D-049): previewed as soon as the page opens.
  const [params] = useSearchParams();
  const restoring = Number(params.get("version")) || undefined;
  useEffect(() => {
    if (restoring) void preview({ version: restoring }, "current");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per version
  }, [restoring]);

  async function preview(input: Found["input"], baseUrl: Found["baseUrl"]) {
    setBusy(true);
    setProblem(undefined);
    try {
      setFound({ input, baseUrl, preview: await api.previewSourceUpdate(tenantId, sourceId, { ...input, baseUrl }) });
    } catch (e) {
      setFound(undefined);
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (source.error) return <Problem message={source.error.message} />;
  if (!source.data) return <Skeleton className="h-96 w-full" />;
  if (!canEdit) return <Problem message="Editors, admins, and owners update APIs." />;
  const back = `/t/${tenantId}/sources/${sourceId}`;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link to={back} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> {source.data.name}
        </Link>
        <h1 className="font-heading font-semibold text-2xl">{restoring ? `Restore version ${restoring} of ${source.data.name}` : `Update ${source.data.name}`}</h1>
        <p className="text-muted-foreground text-sm">
          {restoring
            ? "See what going back to this version changes, for the API and for the toolsets and plans built on it. Your current classifications stay. Nothing changes until you apply."
            : "Get the API's new description and see what changes, for the API and for the toolsets and plans built on it. Nothing changes until you apply."}
        </p>
      </div>

      {restoring && busy && !found && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner /> Comparing version {restoring} with what's in use…
        </p>
      )}
      {!restoring && source.data.documentUrl && (
        <Card className="flex-row flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0 text-sm">
            <p className="font-medium">From the same place</p>
            <p className="truncate font-mono text-muted-foreground text-xs">{source.data.documentUrl}</p>
          </div>
          <Button onClick={() => void preview({}, found?.baseUrl ?? "current")} disabled={busy}>
            {busy ? <Spinner /> : null} Check for changes
          </Button>
        </Card>
      )}
      {!restoring && <Collapsible defaultOpen={!source.data.documentUrl}>
        {source.data.documentUrl && (
          <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
            <ChevronDownIcon className="size-4" /> Or from another URL, pasted text, or a file
          </CollapsibleTrigger>
        )}
        <CollapsibleContent className="pt-2">
          <DocumentFinder initialUrl={source.data.documentUrl ?? ""} busy={busy} submitLabel="Check for changes" onSubmit={(doc) => void preview(doc, found?.baseUrl ?? "current")} />
        </CollapsibleContent>
      </Collapsible>}
      {problem && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't use that</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{problem}</AlertDescription>
        </Alert>
      )}

      {found && (
        <Review
          found={found}
          busy={busy}
          onBaseUrl={(baseUrl) => void preview(found.input, baseUrl)}
          onApply={async () => {
            const done = await act(() => api.applySourceUpdate(tenantId, sourceId, { ...found.input, baseUrl: found.baseUrl, digest: found.preview.digest }), {
              busy: setBusy,
              failure: "Not updated",
            });
            if (!done) return;
            const adjusted = [done.toolsets && `${done.toolsets} toolset${done.toolsets === 1 ? "" : "s"}`, done.profiles && `${done.profiles} plan${done.profiles === 1 ? "" : "s"}`].filter(Boolean);
            const kept = `The version it replaced is kept as version ${done.keptVersion}.`;
            toast.success(restoring ? `Version ${restoring} restored` : `${source.data!.name} updated`, { description: [adjusted.length ? `Adjusted ${adjusted.join(" and ")}.` : "", kept].filter(Boolean).join(" ") });
            navigate(back);
          }}
        />
      )}
    </div>
  );
}

function Review({ found, busy, onBaseUrl, onApply }: { found: Found; busy: boolean; onBaseUrl: (b: Found["baseUrl"]) => void; onApply: () => Promise<void> }) {
  const { preview } = found;
  const { diff, effects } = preview;
  const attention = attentionItems(preview);
  const nothing =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.name &&
    !(diff.baseUrl && diff.baseUrl.used === "document") &&
    diff.authSchemes.added.length + diff.authSchemes.removed.length + diff.authSchemes.changed.length === 0;
  const tidy = effects.toolsets.flatMap((t) => [
    ...t.renamedTools.map((r) => `${t.name}: ${r.name} now uses ${r.to} (renamed from ${r.from})`),
    ...(t.refreshedTexts ? [`${t.name}: ${t.refreshedTexts} tool description${t.refreshedTexts === 1 ? "" : "s"} you hadn't edited will follow the API's new text`] : []),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">+{diff.added.length} new</Badge>
          <Badge variant="secondary">−{diff.removed.length} removed</Badge>
          <Badge variant="secondary">{diff.changed.length} changed</Badge>
          <Badge variant="outline">{diff.unchanged} unchanged</Badge>
        </div>
        <Counts before={preview.operations.before} after={preview.operations.after} />
        {diff.name && (
          <p className="text-sm">
            Name: {diff.name.from} <ArrowRightIcon className="inline size-3.5" /> {diff.name.to}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          {preview.documentUrl ? <>From <span className="font-mono">{preview.documentUrl}</span></> : "From pasted or uploaded text"}
          {preview.warningCount ? ` · ${preview.warningCount} mapping warning${preview.warningCount === 1 ? "" : "s"}` : ""}
        </p>
      </Card>

      {diff.baseUrl && (
        <Card className="gap-3 p-4">
          <div>
            <p className="font-medium text-sm">The document names a different base URL</p>
            <p className="text-muted-foreground text-sm">This is where every tool sends its requests. Keep the current one unless the API really moved.</p>
          </div>
          <RadioGroup value={found.baseUrl} onValueChange={(v) => onBaseUrl(v as Found["baseUrl"])} disabled={busy}>
            {(["current", "document"] as const).map((choice) => (
              <div key={choice} className="flex items-center gap-2">
                <RadioGroupItem id={`base-${choice}`} value={choice} />
                <Label htmlFor={`base-${choice}`} className="font-normal">
                  {choice === "current" ? "Keep" : "Use the document's"} <span className="font-mono text-xs">{choice === "current" ? diff.baseUrl!.current : diff.baseUrl!.document}</span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        </Card>
      )}

      {attention.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Check these before applying</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {attention.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {tidy.length > 0 && (
        <Alert>
          <InfoIcon />
          <AlertTitle>Carried over for you</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {tidy.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
              {diff.classifications.kept.length > 0 && (
                <li>
                  Your classification of {diff.classifications.kept.length} operation{diff.classifications.kept.length === 1 ? "" : "s"} stays (
                  {diff.classifications.kept.map((c) => `${c.id} as ${c.class}`).join(", ")}).
                </li>
              )}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <OperationList title="New" items={diff.added.map((op) => ({ key: op.id, op, note: "Off in existing toolsets until you turn it on." }))} open />
      <OperationList title="Removed" items={diff.removed.map((op) => ({ key: op.id, op }))} open />
      <OperationList
        title="Changed"
        items={diff.changed.map((op) => ({ key: op.id, op, note: [op.renamedFrom ? `renamed from ${op.renamedFrom}` : "", ...op.details].filter(Boolean).join(" · ") }))}
      />

      <div className="flex flex-wrap items-center gap-3">
        {nothing ? (
          <p className="flex items-center gap-1.5 text-sm">
            <CheckCircle2Icon className="size-4 text-emerald-600" /> Already up to date: no operations, sign-in schemes, or settings changed.
          </p>
        ) : (
          <>
            <Button onClick={() => void onApply()} disabled={busy}>
              {busy ? <Spinner /> : null} Apply update
            </Button>
            <p className="text-muted-foreground text-xs">MCP clients get the new tools on their next request.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** What a person should know before applying: anything that changes who can call what. */
function attentionItems(preview: SourceUpdatePreview): ReactNode[] {
  const items: ReactNode[] = [];
  const { diff, effects } = preview;
  for (const t of effects.toolsets) {
    for (const r of t.removedTools.filter((r) => r.enabled)) items.push(<>{t.name}: <b>{r.name}</b> is on and will be removed (its operation is gone).</>);
    for (const d of t.disabledTools) {
      items.push(<>{t.name}: <b>{d.name}</b> will be turned off. Its pinned input{d.pins.length === 1 ? "" : "s"} {d.pins.join(", ")} no longer exist{d.pins.length === 1 ? "s" : ""}; re-check the pins and turn it back on.</>);
    }
    for (const s of t.sideEffectChanged) items.push(<>{t.name}: <b>{s.name}</b> becomes {s.to === "read" ? "a read: anyone with use access can call it" : `${s.to === "write" ? "a write" : "destructive"}: only people with use_writes can call it`}.</>);
    for (const i of t.issues) items.push(<>{t.name}: {i.message}</>);
  }
  for (const p of effects.profiles) {
    if (p.removedOperations.length) items.push(<>Plan <b>{p.name}</b> lists {p.removedOperations.map((r) => r.operationId).join(", ")}, which {p.removedOperations.length === 1 ? "is" : "are"} gone and will be dropped from it.</>);
    for (const r of p.removedRules) items.push(<>Plan <b>{p.name}</b> loses its rule for {r}: nothing it allowed there still exists.</>);
  }
  for (const id of effects.unusedCredentials) items.push(<>The API no longer uses the sign-in scheme <b>{id}</b>. Its stored key is kept but won't be used.</>);
  for (const id of diff.authSchemes.added) items.push(<>New sign-in scheme <b>{id}</b>: add its key on the API's page after updating, if tools need it.</>);
  for (const c of diff.classifications.dropped) items.push(<>Your classification of {c.id} (as {c.class}) goes with it: the operation is gone.</>);
  for (const c of diff.classifications.automaticChanged.filter((c) => c.curated)) {
    items.push(<>{c.id}: the API's own classification changed from {c.from} to {c.to}; your {c.curated} {c.curated === c.to ? "now matches it, so it's no longer needed" : "still applies"}.</>);
  }
  return items;
}

function Counts({ before, after }: { before: OperationCounts; after: OperationCounts }) {
  const row = (label: string, a: number, b: number) => (
    <span className="tabular-nums">
      {label} {a === b ? a : <>{a} <ArrowRightIcon className="inline size-3" /> <b>{b}</b></>}
    </span>
  );
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm">
      {row("Operations", before.total, after.total)}
      {row("reads", before.read, after.read)}
      {row("writes", before.write, after.write)}
      {row("destructive", before.destructive, after.destructive)}
    </p>
  );
}

function OperationList({ title, items, open = false }: { title: string; items: Array<{ key: string; op: { id: string; method: string; path: string; class: SideEffect }; note?: string }>; open?: boolean }) {
  if (items.length === 0) return null;
  return (
    <Collapsible defaultOpen={open || items.length <= 10}>
      <CollapsibleTrigger className="flex items-center gap-1 font-medium text-sm">
        <ChevronDownIcon className="size-4" /> {title} ({items.length})
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mt-2 gap-0 divide-y p-0">
          {items.map(({ key, op, note }) => (
            <div key={key} className="flex flex-col gap-1 px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{op.id}</span>
                <SideEffectBadge effect={op.class} />
              </div>
              <Endpoint method={op.method} path={op.path} />
              {note && <p className="text-muted-foreground text-xs">{note}</p>}
            </div>
          ))}
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}
