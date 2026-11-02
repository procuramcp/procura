import { ArrowLeftIcon, PlusIcon, ShieldCheckIcon, Trash2Icon, UndoIcon, UsersIcon } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { act } from "@/lib/act";
import { api, type AccessProfile, type AccessView, type Level, type ProfileRule } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { SideEffectBadge, slugify } from "@/pages/parts";
import { Problem } from "@/pages/shell";

/** Profiles and who holds them (D-034). */
export function AccessPage() {
  const { tenantId = "" } = useParams();
  const view = useLoad(() => api.access(tenantId), [tenantId]);
  if (view.error) return <Problem message={view.error.message} />;
  if (!view.data) return <Skeleton className="h-96 w-full" />;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Link to={`/t/${tenantId}`} className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" /> Back
        </Link>
        <h1 className="font-heading font-semibold text-2xl">People and profiles</h1>
        <p className="text-muted-foreground text-sm">
          A profile is a set of permissions you assign to people. Change a profile and everyone who has it changes on their next request.
        </p>
      </div>
      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles">
          <ProfilesTab tenantId={tenantId} view={view.data} onChanged={view.set} />
        </TabsContent>
        <TabsContent value="members">
          <MembersTab tenantId={tenantId} view={view.data} onChanged={view.set} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Profiles ---------------------------------------------------------------------------

function ProfilesTab({ tenantId, view, onChanged }: { tenantId: string; view: AccessView; onChanged: (v: AccessView) => void }) {
  const [selected, setSelected] = useState<string | undefined>(view.profiles[0]?.id);
  const current = view.profiles.find((p) => p.id === selected);

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        {view.profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p.id)}
            className={`rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 ${p.id === selected ? "border-primary bg-muted/50" : ""}`}
          >
            <div className="flex items-center justify-between gap-2 font-medium">
              {p.name}
              <Badge variant="secondary">
                <UsersIcon /> {p.members.length}
              </Badge>
            </div>
            <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">{p.description || summary(p, view)}</p>
          </button>
        ))}
        <NewProfile
          taken={view.profiles.map((p) => p.id)}
          onCreate={async (id, name) => {
            onChanged(await api.saveProfile(tenantId, id, { name, rules: [] }));
            setSelected(id);
          }}
        />
      </div>
      {current ? (
        <ProfileEditor key={current.id} tenantId={tenantId} view={view} profile={current} onChanged={onChanged} onDeleted={() => setSelected(undefined)} />
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon />
            </EmptyMedia>
            <EmptyTitle>{view.profiles.length === 0 ? "No profiles yet" : "Pick a profile"}</EmptyTitle>
            <EmptyDescription>For example, "Athlete" uses the read tools, "Coach" can also add workouts to the calendar.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function summary(p: AccessProfile, view: AccessView): string {
  if (p.rules.length === 0) return "No access yet";
  return p.rules.map((r) => `${view.toolsets.find((t) => t.id === r.toolsetId)?.name ?? r.toolsetId}: ${r.level}${r.operations ? ` (${r.operations.length} tools)` : ""}`).join(" · ");
}

function NewProfile({ taken, onCreate }: { taken: string[]; onCreate: (id: string, name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const id = slugify(name);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <PlusIcon /> New profile
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New profile</DialogTitle>
          <DialogDescription>Name it after a role, like Athlete or Coach. You choose its permissions next.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="profile-name">Name</FieldLabel>
          <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Coach" />
          {taken.includes(id) && <FieldDescription className="text-destructive">A profile with this name already exists.</FieldDescription>}
        </Field>
        <DialogFooter>
          <Button
            disabled={busy || !id || taken.includes(id)}
            onClick={async () => {
              const created = await act(
                async () => {
                  await onCreate(id, name.trim());
                  return true;
                },
                { busy: setBusy },
              );
              if (!created) return;
              setOpen(false);
              setName("");
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Draft = { name: string; description: string; rules: ProfileRule[] };

function ProfileEditor(props: { tenantId: string; view: AccessView; profile: AccessProfile; onChanged: (v: AccessView) => void; onDeleted: () => void }) {
  const { view, profile } = props;
  const initial: Draft = { name: profile.name, description: profile.description ?? "", rules: profile.rules };
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  function setRule(toolsetId: string, rule: Omit<ProfileRule, "toolsetId"> | undefined) {
    const others = draft.rules.filter((r) => r.toolsetId !== toolsetId);
    setDraft({ ...draft, rules: rule ? [...others, { toolsetId, ...rule }] : others });
  }

  async function save() {
    const edit = { name: draft.name, ...(draft.description.trim() ? { description: draft.description } : {}), rules: draft.rules };
    const next = await act(() => api.saveProfile(props.tenantId, profile.id, edit), { busy: setBusy, failure: "Not saved" });
    if (!next) return;
    props.onChanged(next);
    toast.success(`Saved ${draft.name}`, { description: `Applies to ${profile.members.length} ${profile.members.length === 1 ? "person" : "people"} on their next request.` });
  }

  async function remove() {
    const next = await act(() => api.deleteProfile(props.tenantId, profile.id));
    if (!next) return;
    props.onChanged(next);
    props.onDeleted();
    toast.success(`Deleted ${profile.name}`);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="gap-4 p-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="p-name">Name</FieldLabel>
            <Input id="p-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="p-description">Description</FieldLabel>
            <Textarea id="p-description" rows={2} value={draft.description} placeholder="Who this is for" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
        </FieldGroup>
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-sm">
          <UsersIcon className="size-4" />
          {profile.members.length === 0
            ? "Nobody has this profile yet. Assign it under Members."
            : `${profile.members.length} ${profile.members.length === 1 ? "person has" : "people have"} this profile.`}
        </div>
      </Card>

      {view.toolsets.map((toolset) => (
        <RuleCard key={toolset.id} toolset={toolset} rule={draft.rules.find((r) => r.toolsetId === toolset.id)} onChange={(r) => setRule(toolset.id, r)} />
      ))}
      {view.toolsets.length === 0 && <p className="text-muted-foreground text-sm">This tenant has no toolsets yet.</p>}

      <div className="flex items-center justify-between gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" className="text-destructive">
              <Trash2Icon /> Delete profile
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {profile.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {profile.members.length > 0
                  ? `${profile.members.length} ${profile.members.length === 1 ? "person loses" : "people lose"} the access it gives, unless they have it another way.`
                  : "Nobody has it, so no one loses access."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="flex gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(initial)} disabled={busy}>
              <UndoIcon /> Discard
            </Button>
          )}
          <Button onClick={save} disabled={busy || !dirty || !draft.name.trim()}>
            {busy && <Spinner />} Save profile
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuleCard(props: {
  toolset: AccessView["toolsets"][number];
  rule: ProfileRule | undefined;
  onChange: (rule: Omit<ProfileRule, "toolsetId"> | undefined) => void;
}) {
  const { toolset, rule, onChange } = props;
  const enabled = toolset.tools.filter((t) => t.enabled);
  const level = rule?.level;
  // A `use` rule never allows writes, so they can't be picked (D-034: lists only narrow).
  const callable = (t: (typeof enabled)[number]) => level === "use_writes" || t.sideEffect === "read";

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">{toolset.name}</h3>
          <p className="text-muted-foreground text-xs">{enabled.length} tools enabled</p>
        </div>
        <Select
          value={level ?? "none"}
          onValueChange={(v) => onChange(v === "none" ? undefined : { level: v as Level, operations: rule?.operations ?? null })}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No access</SelectItem>
            <SelectItem value="use">use: read tools</SelectItem>
            <SelectItem value="use_writes">use_writes: reads and writes</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {level && (
        <>
          <RadioGroup
            value={rule?.operations ? "some" : "all"}
            onValueChange={(v) =>
              // Start "only these" with everything ticked, so nothing changes until a tool is unticked.
              onChange({ level, operations: v === "all" ? null : enabled.filter(callable).map((t) => t.operationId) })
            }
            className="flex flex-wrap gap-4"
          >
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="all" aria-label="Every tool the level allows" /> Every tool the level allows
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="some" aria-label="Only these tools" /> Only these tools
            </label>
          </RadioGroup>
          {rule?.operations && (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {enabled.map((t) => {
                const ok = callable(t);
                const checked = ok && rule.operations!.includes(t.operationId);
                return (
                  <label key={t.operationId} className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm ${ok ? "" : "opacity-50"}`}>
                    <span className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={t.name}
                        checked={checked}
                        disabled={!ok}
                        onCheckedChange={(on) => {
                          const next = on ? [...rule.operations!, t.operationId] : rule.operations!.filter((o) => o !== t.operationId);
                          // An empty list would grant nothing; keep at least one, or switch to "every tool".
                          onChange({ level, operations: next.length > 0 ? next : null });
                        }}
                      />
                      <span className="truncate font-mono text-xs">{t.name}</span>
                    </span>
                    <SideEffectBadge effect={t.sideEffect} />
                  </label>
                );
              })}
            </div>
          )}
          {level === "use" && enabled.some((t) => t.sideEffect !== "read") && (
            <p className="text-muted-foreground text-xs">Write tools need use_writes.</p>
          )}
        </>
      )}
    </Card>
  );
}

// --- Members ----------------------------------------------------------------------------

function MembersTab({ tenantId, view, onChanged }: { tenantId: string; view: AccessView; onChanged: (v: AccessView) => void }) {
  const [busy, setBusy] = useState<string | undefined>();

  async function toggle(userId: string, current: string[], profileId: string, on: boolean) {
    const profiles = on ? [...current, profileId] : current.filter((p) => p !== profileId);
    const next = await act(() => api.setMemberProfiles(tenantId, userId, profiles), { busy: (b) => setBusy(b ? userId : undefined) });
    if (next) onChanged(next);
  }

  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="w-28">Role</TableHead>
            <TableHead>Profiles</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.members.map((m) => (
            <TableRow key={m.userId}>
              <TableCell className="font-mono text-xs">
                {m.userId} {m.you && <Badge variant="secondary">you</Badge>}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{m.role}</Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  {m.profiles.map((id) => (
                    <Badge key={id}>{view.profiles.find((p) => p.id === id)?.name ?? id}</Badge>
                  ))}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="xs" variant="outline" disabled={busy === m.userId || view.profiles.length === 0}>
                        {busy === m.userId ? <Spinner /> : <PlusIcon />} Profiles
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>Profiles</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {view.profiles.map((p) => (
                        <DropdownMenuCheckboxItem
                          key={p.id}
                          checked={m.profiles.includes(p.id)}
                          onCheckedChange={(on) => void toggle(m.userId, m.profiles, p.id, on)}
                          onSelect={(e) => e.preventDefault()}
                        >
                          {p.name}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <AddMember tenantId={tenantId} view={view} onChanged={onChanged} />
      <p className="border-t px-4 py-3 text-muted-foreground text-xs">
        Owners and admins edit this tenant; profiles only decide which tools someone can call.
      </p>
    </Card>
  );
}

function AddMember({ tenantId, view, onChanged }: { tenantId: string; view: AccessView; onChanged: (v: AccessView) => void }) {
  const [userId, setUserId] = useState("");
  const [profileId, setProfileId] = useState(view.profiles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  if (view.profiles.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t p-4">
      <div>
        <h3 className="font-medium text-sm">Add someone</h3>
        <p className="text-muted-foreground text-xs">They sign in once by connecting to an MCP URL; the No access page shows their account id.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-64 flex-1 font-mono" placeholder="Account id" value={userId} onChange={(e) => setUserId(e.target.value.trim())} />
        <Select value={profileId} onValueChange={setProfileId}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {view.profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={busy || !userId || !profileId}
          onClick={async () => {
            const current = view.members.find((m) => m.userId === userId)?.profiles ?? [];
            const next = await act(() => api.setMemberProfiles(tenantId, userId, [...new Set([...current, profileId])]), { busy: setBusy });
            if (!next) return;
            onChanged(next);
            setUserId("");
            toast.success("Added");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
