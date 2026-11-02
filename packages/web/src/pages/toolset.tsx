import { ArrowLeftIcon, CircleAlertIcon, PinIcon, SearchIcon, UndoIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useBlocker, useParams } from "react-router";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, type Issue, type JsonValue, type Level, type OperationView, type ToolBinding, type ToolsetView } from "@/lib/api";
import { useLoad, useMe } from "@/lib/hooks";
import { display, parseValue } from "@/lib/values";
import { CopyText, Endpoint, SideEffectBadge } from "@/pages/parts";
import { Problem } from "@/pages/shell";
import { TestPanel } from "@/pages/test-panel";

type Draft = { name: string; description: string; tools: ToolBinding[] };

const toDraft = (v: ToolsetView): Draft => ({ name: v.toolset.name, description: v.toolset.description ?? "", tools: v.toolset.tools });
const toEdit = (d: Draft) => ({ name: d.name, ...(d.description.trim() ? { description: d.description } : {}), tools: d.tools });

export function ToolsetPage() {
  const { tenantId = "", toolsetId = "" } = useParams();
  const view = useLoad(() => api.toolset(tenantId, toolsetId), [tenantId, toolsetId]);
  if (view.error) return <Problem message={view.error.message} />;
  if (!view.data) return <Skeleton className="h-96 w-full" />;
  return <Editor key={`${tenantId}/${toolsetId}`} tenantId={tenantId} view={view.data} onSaved={view.set} />;
}

function Editor({ tenantId, view, onSaved }: { tenantId: string; view: ToolsetView; onSaved: (v: ToolsetView) => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(view));
  const [saved, setSaved] = useState<Draft>(() => toDraft(view));
  const [issues, setIssues] = useState<Issue[]>(view.issues);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(toEdit(draft)) !== JSON.stringify(toEdit(saved));
  const ops = useMemo(() => new Map(view.operations.map((o) => [o.id, o])), [view.operations]);

  // Don't lose edits to a navigation or a closed tab.
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    try {
      const next = await api.saveToolset(tenantId, view.toolset.id, toEdit(draft));
      onSaved(next);
      setSaved(toDraft(next));
      setDraft(toDraft(next));
      setIssues(next.issues);
      toast.success("Saved", { description: "MCP clients see the change on their next request." });
    } catch (e) {
      if (e instanceof ApiError && e.body.issues) setIssues(e.body.issues);
      toast.error("Not saved", { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const enabled = draft.tools.filter((t) => t.enabled);
  const writes = enabled.filter((t) => ops.get(t.operationId)?.sideEffect.class !== "read").length;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link to={`/t/${tenantId}`} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
            <ArrowLeftIcon className="size-3.5" /> Back
          </Link>
          <h1 className="font-heading font-semibold text-2xl">{draft.name || view.toolset.id}</h1>
          <p className="text-muted-foreground text-sm">
            {enabled.length} of {view.operations.length} operations enabled{writes > 0 ? ` · ${writes} write` : ""} · from {view.source.name}
          </p>
        </div>
        <CopyText value={view.endpoint} className="w-full max-w-md" />
      </div>

      {issues.length > 0 && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>This toolset has problems</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {issues.map((i, n) => (
                <li key={n}>
                  <span className="font-mono">{i.toolName}</span>: {i.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="tools">
        <TabsList>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="tools">
          <ToolsTab tenantId={tenantId} view={view} draft={draft} setDraft={setDraft} ops={ops} />
        </TabsContent>
        <TabsContent value="access">
          <AccessTab tenantId={tenantId} view={view} onChanged={onSaved} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab view={view} draft={draft} setDraft={setDraft} />
        </TabsContent>
      </Tabs>

      {dirty && (
        <div className="sticky bottom-4 z-10 mx-auto flex items-center gap-3 rounded-lg border bg-popover px-4 py-2 shadow-lg">
          <span className="text-sm">Unsaved changes</span>
          <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={saving}>
            <UndoIcon /> Discard
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Spinner />} Save
          </Button>
        </div>
      )}

      <AlertDialog open={blocker.state === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to this toolset will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- Tools ------------------------------------------------------------------------------

type Filter = "all" | "enabled" | "read" | "write";

function ToolsTab(props: { tenantId: string; view: ToolsetView; draft: Draft; setDraft: (d: Draft) => void; ops: Map<string, OperationView> }) {
  const { view, draft, setDraft, ops } = props;
  const [query, setQuery] = useState("");
  // Open on the tools already in use; "All" shows the rest of the source.
  const [filter, setFilter] = useState<Filter>(() => (draft.tools.some((t) => t.enabled) ? "enabled" : "all"));
  const [selected, setSelected] = useState<string | undefined>(() => draft.tools.find((t) => t.enabled)?.operationId ?? view.operations[0]?.id);
  const bindings = useMemo(() => new Map(draft.tools.map((t) => [t.operationId, t])), [draft.tools]);

  const rows = view.operations.filter((op) => {
    const b = bindings.get(op.id);
    if (filter === "enabled" && !b?.enabled) return false;
    if (filter === "read" && op.sideEffect.class !== "read") return false;
    if (filter === "write" && op.sideEffect.class === "read") return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [op.id, op.title, op.path, b?.name ?? "", ...op.tags].some((s) => s.toLowerCase().includes(q));
  });

  /** Replace (or add) the binding for one operation. */
  function update(op: OperationView, change: Partial<ToolBinding>) {
    const existing = bindings.get(op.id) ?? newBinding(op);
    const next = { ...existing, ...change };
    const tools = bindings.has(op.id) ? draft.tools.map((t) => (t.operationId === op.id ? next : t)) : [...draft.tools, next];
    setDraft({ ...draft, tools });
  }

  const current = selected ? ops.get(selected) : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <InputGroup className="min-w-48 flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search operations" value={query} onChange={(e) => setQuery(e.target.value)} />
          </InputGroup>
          <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="read">Reads</SelectItem>
              <SelectItem value="write">Writes</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">On</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead className="w-28">Effect</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((op) => {
                const b = bindings.get(op.id);
                return (
                  <TableRow key={op.id} data-state={op.id === selected ? "selected" : undefined} className="cursor-pointer" onClick={() => setSelected(op.id)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Switch checked={b?.enabled ?? false} onCheckedChange={(on) => update(op, { enabled: on })} aria-label={`Enable ${op.id}`} />
                    </TableCell>
                    <TableCell className="max-w-0">
                      <div className="flex items-center gap-1.5 truncate font-medium">
                        {b?.name ?? op.id}
                        {b && Object.keys(b.pinnedInputs).length > 0 && <PinIcon className="size-3 shrink-0 text-muted-foreground" />}
                      </div>
                      <div className="truncate">
                        <Endpoint method={op.method} path={op.path} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <SideEffectBadge effect={op.sideEffect.class} reason={op.sideEffect.reason} />
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    No operations match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* The list scrolls with the page; the editor stays in view beside it, with its own scroll. */}
      <div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100svh-2rem)] lg:self-start lg:overflow-y-auto">
      {current ? (
        <ToolEditor
          key={current.id}
          tenantId={props.tenantId}
          toolsetId={view.toolset.id}
          op={current}
          binding={bindings.get(current.id) ?? { ...newBinding(current), enabled: false }}
          names={draft.tools.filter((t) => t.operationId !== current.id).map((t) => t.name)}
          onChange={(change) => update(current, change)}
        />
      ) : (
        <Card className="items-center justify-center p-8 text-muted-foreground">Pick an operation to edit it.</Card>
      )}
      </div>
    </div>
  );
}

function newBinding(op: OperationView): ToolBinding {
  return { operationId: op.id, name: op.id, description: op.description.slice(0, 4000), enabled: true, pinnedInputs: {} };
}

function ToolEditor(props: {
  tenantId: string;
  toolsetId: string;
  op: OperationView;
  binding: ToolBinding;
  names: string[];
  onChange: (change: Partial<ToolBinding>) => void;
}) {
  const { op, binding, onChange } = props;
  const nameProblem = !/^[a-z][a-z0-9_]{0,63}$/.test(binding.name)
    ? "Lowercase letters, digits and _, starting with a letter"
    : props.names.includes(binding.name)
      ? "Another tool already has this name"
      : undefined;

  function setPin(name: string, value: JsonValue | undefined) {
    const pins = { ...binding.pinnedInputs };
    if (value === undefined) delete pins[name];
    else pins[name] = value;
    onChange({ pinnedInputs: pins });
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Endpoint method={op.method} path={op.path} />
          <div className="flex items-center gap-2">
            <SideEffectBadge effect={op.sideEffect.class} reason={op.sideEffect.reason} />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={binding.enabled} onCheckedChange={(on) => onChange({ enabled: on })} />
              {binding.enabled ? "Enabled" : "Off"}
            </label>
          </div>
        </div>
        {op.sideEffect.class !== "read" && binding.enabled && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>This tool changes data</AlertTitle>
            <AlertDescription>Only people with use_writes access can call it. Clients mark it as {op.sideEffect.class}.</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field data-invalid={nameProblem ? true : undefined}>
            <FieldLabel htmlFor="tool-name">Tool name</FieldLabel>
            <Input id="tool-name" className="font-mono" value={binding.name} onChange={(e) => onChange({ name: e.target.value })} aria-invalid={!!nameProblem} />
            <FieldDescription>{nameProblem ?? "What agents call. Short and specific, like list_activities."}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="tool-description">Description for agents</FieldLabel>
            <Textarea id="tool-description" rows={5} value={binding.description} onChange={(e) => onChange({ description: e.target.value })} />
            <FieldDescription className="flex justify-between gap-2">
              <span>Say what it returns and when to use it; mention inputs that keep responses small.</span>
              <span className="tabular-nums">{binding.description.length}/4000</span>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </Card>

      <Card className="gap-3 p-4">
        <div>
          <h3 className="font-medium">Inputs</h3>
          <p className="text-muted-foreground text-sm">Pin an input to fix its value. Agents don't see pinned inputs and can't change them.</p>
        </div>
        {op.inputs.length === 0 ? (
          <p className="text-muted-foreground text-sm">No inputs.</p>
        ) : (
          <div className="flex flex-col divide-y">
            {op.inputs.map((input) => (
              <PinRow key={input.name} input={input} value={binding.pinnedInputs[input.name]} onChange={(v) => setPin(input.name, v)} />
            ))}
          </div>
        )}
      </Card>

      <TestPanel tenantId={props.tenantId} toolsetId={props.toolsetId} op={op} binding={binding} />
    </div>
  );
}

function PinRow({ input, value, onChange }: { input: OperationView["inputs"][number]; value: JsonValue | undefined; onChange: (v: JsonValue | undefined) => void }) {
  const pinned = value !== undefined;
  const [text, setText] = useState(pinned ? display(value) : "");
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-sm">{input.name}</span>
          <Badge variant="outline" className="font-mono">
            {input.type}
          </Badge>
          {input.required && <Badge variant="secondary">required</Badge>}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          <Switch checked={pinned} onCheckedChange={(on) => onChange(on ? parseValue(text, input.type) : undefined)} />
          Pin
        </label>
      </div>
      {input.description && <p className="line-clamp-2 text-muted-foreground text-xs">{input.description}</p>}
      {pinned && (
        <Input
          className="font-mono"
          value={text}
          placeholder="value"
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseValue(e.target.value, input.type));
          }}
        />
      )}
    </div>
  );
}

// --- Access -----------------------------------------------------------------------------

function AccessTab({ tenantId, view, onChanged }: { tenantId: string; view: ToolsetView; onChanged: (v: ToolsetView) => void }) {
  const me = useMe();
  const [userId, setUserId] = useState("");
  const [level, setLevel] = useState<Level>("use");
  const [busy, setBusy] = useState(false);
  const withoutAccess = view.members.filter((m) => !view.access.some((a) => a.userId === m.userId));

  async function set(target: string, next: Level | "none") {
    setBusy(true);
    try {
      onChanged(await api.setAccess(tenantId, view.toolset.id, target, next));
      toast.success(next === "none" ? "Access removed" : `Access set to ${next}`);
      setUserId("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead className="w-48">Access</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.access.map((a) => (
              <TableRow key={a.userId}>
                <TableCell className="font-mono text-xs">
                  {a.userId} {a.userId === me.user.id && <Badge variant="secondary">you</Badge>}
                </TableCell>
                <TableCell>
                  <LevelSelect value={a.level} disabled={busy} onChange={(v) => set(a.userId, v)} allowNone />
                </TableCell>
              </TableRow>
            ))}
            {withoutAccess.map((m) => (
              <TableRow key={m.userId} className="text-muted-foreground">
                <TableCell className="font-mono text-xs">
                  {m.userId} <Badge variant="outline">{m.role}, no access</Badge>
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => set(m.userId, "use")}>
                    Grant use
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-3 p-4">
        <div>
          <h3 className="font-medium">Add someone</h3>
          <p className="text-muted-foreground text-sm">
            They sign in once by connecting to the MCP URL; the No access page shows their account id.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-64 flex-1 font-mono" placeholder="Account id" value={userId} onChange={(e) => setUserId(e.target.value.trim())} />
          <LevelSelect value={level} onChange={(v) => v !== "none" && setLevel(v)} />
          <Button disabled={busy || !userId} onClick={() => set(userId, level)}>
            Grant
          </Button>
        </div>
      </Card>
      <p className="text-muted-foreground text-xs">use calls read tools; use_writes also calls the write and destructive tools this toolset enables.</p>
    </div>
  );
}

function LevelSelect({ value, onChange, disabled, allowNone }: { value: Level; onChange: (v: Level | "none") => void; disabled?: boolean; allowNone?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Level | "none")} disabled={disabled ?? false}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="use">use</SelectItem>
        <SelectItem value="use_writes">use_writes</SelectItem>
        {allowNone && <SelectItem value="none">Remove access</SelectItem>}
      </SelectContent>
    </Select>
  );
}

// --- Settings ---------------------------------------------------------------------------

function SettingsTab({ view, draft, setDraft }: { view: ToolsetView; draft: Draft; setDraft: (d: Draft) => void }) {
  return (
    <Card className="max-w-3xl gap-4 p-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="ts-name">Name</FieldLabel>
          <Input id="ts-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <FieldDescription>Shown to MCP clients as the server's title.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="ts-description">Instructions for agents</FieldLabel>
          <Textarea id="ts-description" rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <FieldDescription>Sent as the server's instructions: what this toolset is for, units, date formats.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>MCP endpoint</FieldLabel>
          <CopyText value={view.endpoint} />
        </Field>
        <Field>
          <FieldLabel>Source</FieldLabel>
          <p className="text-sm">
            {view.source.name} <span className="font-mono text-muted-foreground text-xs">{view.source.baseUrl}</span>
          </p>
        </Field>
      </FieldGroup>
    </Card>
  );
}
