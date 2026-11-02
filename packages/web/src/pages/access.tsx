import { ArrowLeftIcon, EllipsisIcon, PauseIcon, PlayIcon, PlusIcon, SearchIcon, ShieldCheckIcon, StickyNoteIcon, Trash2Icon, UndoIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { act } from "@/lib/act";
import { api, type AccessProfile, type AccessView, type Level, type MemberStatus, type Person, type PlanLimits, type ProfileRule, type Role } from "@/lib/api";
import { useLoad, useRole } from "@/lib/hooks";
import { PersonName, SideEffectBadge, slugify } from "@/pages/parts";
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
          A profile is a set of permissions you assign to people. Change a profile and everyone who has it changes on their next request. Your team
          works in this console; customers only call tools.
        </p>
      </div>
      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="team">Team ({view.data.team.length})</TabsTrigger>
          <TabsTrigger value="customers">Customers ({view.data.customers})</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles">
          <ProfilesTab tenantId={tenantId} view={view.data} onChanged={view.set} />
        </TabsContent>
        <TabsContent value="team">
          <TeamTab tenantId={tenantId} view={view.data} onChanged={view.set} />
        </TabsContent>
        <TabsContent value="customers">
          <CustomersTab tenantId={tenantId} view={view.data} onCount={view.reload} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Profiles ---------------------------------------------------------------------------

function ProfilesTab({ tenantId, view, onChanged }: { tenantId: string; view: AccessView; onChanged: (v: AccessView) => void }) {
  const { canEdit } = useRole(tenantId);
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
        {canEdit && (
        <NewProfile
          taken={view.profiles.map((p) => p.id)}
          onCreate={async (id, name) => {
            onChanged(await api.saveProfile(tenantId, id, { name, rules: [] }));
            setSelected(id);
          }}
        />
        )}
      </div>
      {current ? (
        <ProfileEditor key={current.id} tenantId={tenantId} view={view} profile={current} onChanged={onChanged} onDeleted={() => setSelected(undefined)} readOnly={!canEdit} />
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
  const rules = p.rules.map((r) => `${view.toolsets.find((t) => t.id === r.toolsetId)?.name ?? r.toolsetId}: ${r.level}${r.operations ? ` (${r.operations.length} tools)` : ""}`);
  const { perDay, perMonth } = p.limits;
  const limits = [
    perDay && `${perDay.toLocaleString()}/day`,
    perMonth && `${perMonth.toLocaleString()}/month`,
  ].filter(Boolean);
  return [...rules, ...(limits.length > 0 ? [limits.join(", ")] : [])].join(" · ");
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

/** Limits as typed: blank means no limit. */
type LimitFields = { perDay: string; perMonth: string; upgradeUrl: string };
type Draft = { name: string; description: string; rules: ProfileRule[]; limits: LimitFields };

const limitFields = (l: PlanLimits): LimitFields => ({
  perDay: l.perDay?.toString() ?? "",
  perMonth: l.perMonth?.toString() ?? "",
  upgradeUrl: l.upgradeUrl ?? "",
});
function planLimits(f: LimitFields): PlanLimits {
  const count = (v: string) => (v.trim() ? Number(v) : undefined);
  const limits: PlanLimits = {};
  const day = count(f.perDay);
  const month = count(f.perMonth);
  if (day !== undefined) limits.perDay = day;
  if (month !== undefined) limits.perMonth = month;
  if (f.upgradeUrl.trim()) limits.upgradeUrl = f.upgradeUrl.trim();
  return limits;
}

function ProfileEditor(props: { tenantId: string; view: AccessView; profile: AccessProfile; onChanged: (v: AccessView) => void; onDeleted: () => void; readOnly: boolean }) {
  const { view, profile } = props;
  const initial: Draft = { name: profile.name, description: profile.description ?? "", rules: profile.rules, limits: limitFields(profile.limits) };
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  function setRule(toolsetId: string, rule: Omit<ProfileRule, "toolsetId"> | undefined) {
    const others = draft.rules.filter((r) => r.toolsetId !== toolsetId);
    setDraft({ ...draft, rules: rule ? [...others, { toolsetId, ...rule }] : others });
  }

  async function save() {
    const edit = { name: draft.name, ...(draft.description.trim() ? { description: draft.description } : {}), rules: draft.rules, limits: planLimits(draft.limits) };
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
    // A disabled fieldset turns every control inside read-only for viewers.
    <fieldset disabled={props.readOnly} className="flex min-w-0 flex-col gap-4">
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
            ? "Nobody has this profile yet. Assign it under Team or Customers."
            : `${profile.members.length} ${profile.members.length === 1 ? "person has" : "people have"} this profile.`}
        </div>
      </Card>

      <LimitsCard limits={draft.limits} onChange={(limits) => setDraft({ ...draft, limits })} />

      {view.toolsets.map((toolset) => (
        <RuleCard key={toolset.id} toolset={toolset} rule={draft.rules.find((r) => r.toolsetId === toolset.id)} onChange={(r) => setRule(toolset.id, r)} />
      ))}
      {view.toolsets.length === 0 && <p className="text-muted-foreground text-sm">This tenant has no toolsets yet.</p>}

      {!props.readOnly && (
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
      )}
    </fieldset>
  );
}

/** What the plan allows each customer who holds it (D-039). */
function LimitsCard({ limits, onChange }: { limits: LimitFields; onChange: (l: LimitFields) => void }) {
  const field = (key: keyof LimitFields, label: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={`limit-${key}`}>{label}</FieldLabel>
      <Input
        id={`limit-${key}`}
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        placeholder="No limit"
        value={limits[key]}
        onChange={(e) => onChange({ ...limits, [key]: e.target.value })}
      />
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );
  return (
    <Card className="gap-3 p-4">
      <div>
        <h3 className="font-medium">Limits</h3>
        <p className="text-muted-foreground text-xs">
          Per customer, across every toolset. Leave a box empty for no limit. Someone with more than one plan gets the most generous; a direct grant has none.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {field("perDay", "Calls per day", "Starts over at midnight UTC")}
        {field("perMonth", "Calls per month", "Starts over on the 1st, UTC")}
      </div>
      <Field>
        <FieldLabel htmlFor="limit-upgradeUrl">Upgrade link</FieldLabel>
        <Input
          id="limit-upgradeUrl"
          type="url"
          placeholder="https://example.com/pricing"
          value={limits.upgradeUrl}
          onChange={(e) => onChange({ ...limits, upgradeUrl: e.target.value })}
        />
        <FieldDescription>Shown to the customer's agent when they hit a limit. https only.</FieldDescription>
      </Field>
    </Card>
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

// --- People (D-038) -----------------------------------------------------------------------

const ROLE_HELP: Record<Exclude<Role, "customer">, string> = {
  owner: "Everything, including other owners",
  admin: "Everything but owners: keys and the team too",
  editor: "Tools, profiles, and customers",
  viewer: "Looks at everything, changes nothing",
};

/** Profiles someone holds, with a menu to add or remove them. */
function ProfilePicker(props: { profiles: AccessProfile[]; held: string[]; busy: boolean; readOnly: boolean; onChange: (next: string[]) => void }) {
  const { profiles, held, busy, readOnly, onChange } = props;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {held.map((id) => (
        <Badge key={id}>{profiles.find((p) => p.id === id)?.name ?? id}</Badge>
      ))}
      {held.length === 0 && readOnly && <span className="text-muted-foreground text-xs">None</span>}
      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="outline" disabled={busy || profiles.length === 0}>
              {busy ? <Spinner /> : <PlusIcon />} Profiles
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Profiles</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {profiles.map((p) => (
              <DropdownMenuCheckboxItem
                key={p.id}
                checked={held.includes(p.id)}
                onCheckedChange={(on) => onChange(on ? [...held, p.id] : held.filter((x) => x !== p.id))}
                onSelect={(e) => e.preventDefault()}
              >
                {p.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function TeamTab({ tenantId, view, onChanged }: { tenantId: string; view: AccessView; onChanged: (v: AccessView) => void }) {
  const { canEdit, isAdmin, isOwner } = useRole(tenantId);
  const [busy, setBusy] = useState<string | undefined>();
  const busyFor = (userId: string) => (b: boolean) => setBusy(b ? userId : undefined);

  async function setProfiles(userId: string, profiles: string[]) {
    const next = await act(() => api.setMemberProfiles(tenantId, userId, profiles), { busy: busyFor(userId) });
    if (next) onChanged(next);
  }
  async function setRole(m: Person, role: Role) {
    const next = await act(() => api.setRole(tenantId, m.userId, role), { busy: busyFor(m.userId) });
    if (!next) return;
    onChanged(next);
    toast.success(role === "customer" ? `${m.label ?? m.userId} is now a customer` : `${m.label ?? m.userId} is now ${role === "admin" || role === "editor" ? "an" : "a"} ${role}`);
  }
  async function remove(m: Person) {
    if (!(await act(() => api.removeMember(tenantId, m.userId), { busy: busyFor(m.userId) }))) return;
    const next = await act(() => api.access(tenantId));
    if (next) onChanged(next);
    toast.success(`Removed ${m.label ?? m.userId}`);
  }
  // Owners manage owners; admins manage everyone else; nobody changes themselves.
  const manageable = (m: Person) => isAdmin && !m.you && (isOwner || m.role !== "owner");

  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead className="w-40">Role</TableHead>
            <TableHead>Profiles</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.team.map((m) => (
            <TableRow key={m.userId}>
              <TableCell className="max-w-0">
                <PersonName person={m} you={m.you} showRole={false} />
              </TableCell>
              <TableCell>
                {manageable(m) ? (
                  <Select value={m.role} onValueChange={(v) => void setRole(m, v as Role)} disabled={busy === m.userId}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["owner", "admin", "editor", "viewer"] as const)
                        .filter((r) => isOwner || r !== "owner")
                        .map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      <SelectSeparator />
                      <SelectItem value="customer">Make a customer</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">{m.role}</Badge>
                )}
              </TableCell>
              <TableCell>
                <ProfilePicker profiles={view.profiles} held={m.profiles} busy={busy === m.userId} readOnly={!canEdit} onChange={(p) => void setProfiles(m.userId, p)} />
              </TableCell>
              <TableCell>{manageable(m) && <RemoveButton who={m} onConfirm={() => void remove(m)} />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isAdmin && <AddTeammate tenantId={tenantId} isOwner={isOwner} onChanged={onChanged} />}
      <dl className="grid gap-x-4 gap-y-1 border-t px-4 py-3 text-muted-foreground text-xs sm:grid-cols-[auto_1fr]">
        {Object.entries(ROLE_HELP).map(([role, help]) => (
          <div key={role} className="contents">
            <dt className="font-medium">{role}</dt>
            <dd>{help}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function AddTeammate({ tenantId, isOwner, onChanged }: { tenantId: string; isOwner: boolean; onChanged: (v: AccessView) => void }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t p-4">
      <div>
        <h3 className="font-medium text-sm">Add a teammate</h3>
        <p className="text-muted-foreground text-xs">They sign in to this console once; the page they land on shows their account id.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-64 flex-1 font-mono" placeholder="Account id" value={userId} onChange={(e) => setUserId(e.target.value.trim())} />
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["owner", "admin", "editor", "viewer"] as const)
              .filter((r) => isOwner || r !== "owner")
              .map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Button
          disabled={busy || !userId}
          onClick={async () => {
            const next = await act(() => api.setRole(tenantId, userId, role), { busy: setBusy });
            if (!next) return;
            onChanged(next);
            setUserId("");
            toast.success("Added to the team");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function RemoveButton({ who, onConfirm }: { who: Person; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${who.label ?? who.userId}`}>
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {who.label ?? who.userId}?</AlertDialogTitle>
          <AlertDialogDescription>
            They lose their access and profiles here. Suspending keeps both, if they may come back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CustomersTab({ tenantId, view, onCount }: { tenantId: string; view: AccessView; onCount: () => void }) {
  const { canEdit } = useRole(tenantId);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const busyFor = (userId: string) => (b: boolean) => setBusy(b ? userId : undefined);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.customers(tenantId, search).then(
      (page) => {
        if (!live) return;
        setRows(page.customers);
        setTotal(page.total);
        setNext(page.next);
        setLoading(false);
      },
      (e: Error) => {
        if (!live) return;
        toast.error("Couldn't load customers", { description: e.message });
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [tenantId, search]);

  async function more() {
    const page = await act(() => api.customers(tenantId, search, next), { busy: (b) => setLoading(b) });
    if (!page) return;
    setRows((r) => [...r, ...page.customers]);
    setNext(page.next);
  }
  const replace = (p: Person) => setRows((r) => r.map((x) => (x.userId === p.userId ? p : x)));

  async function setProfiles(c: Person, profiles: string[]) {
    if (await act(() => api.setMemberProfiles(tenantId, c.userId, profiles), { busy: busyFor(c.userId) })) replace({ ...c, profiles });
  }
  async function setStatus(c: Person, status: MemberStatus) {
    const updated = await act(() => api.updateMember(tenantId, c.userId, { status }), { busy: busyFor(c.userId) });
    if (!updated) return;
    replace(updated);
    toast.success(status === "suspended" ? `Suspended ${c.label ?? c.userId}` : `Resumed ${c.label ?? c.userId}`, {
      description: status === "suspended" ? "Their next request is refused; their access and profiles are kept." : "They have their access back.",
    });
  }
  async function setNote(c: Person, note: string) {
    const updated = await act(() => api.updateMember(tenantId, c.userId, { note: note.trim() || null }), { busy: busyFor(c.userId) });
    if (updated) replace(updated);
  }
  async function remove(c: Person) {
    if (!(await act(() => api.removeMember(tenantId, c.userId), { busy: busyFor(c.userId) }))) return;
    setRows((r) => r.filter((x) => x.userId !== c.userId));
    setTotal((t) => t - 1);
    onCount();
    toast.success(`Removed ${c.label ?? c.userId}`);
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <InputGroup className="min-w-48 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search by name, email, account id, or note" value={query} onChange={(e) => setQuery(e.target.value)} />
        </InputGroup>
        <span className="text-muted-foreground text-sm tabular-nums">
          {search ? `${total} of ${view.customers}` : `${total}`} {total === 1 ? "customer" : "customers"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="w-28">Status</TableHead>
            <TableHead>Profiles</TableHead>
            <TableHead className="w-36 text-right">Calls today / month</TableHead>
            <TableHead className="hidden lg:table-cell">Note</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => (
            <TableRow key={c.userId} className={c.status === "suspended" ? "bg-muted/40" : undefined}>
              <TableCell className="max-w-0">
                <PersonName person={c} />
              </TableCell>
              <TableCell>
                {c.status === "suspended" ? <Badge variant="destructive">Suspended</Badge> : <Badge variant="secondary">Active</Badge>}
              </TableCell>
              <TableCell>
                <ProfilePicker profiles={view.profiles} held={c.profiles} busy={busy === c.userId} readOnly={!canEdit} onChange={(p) => void setProfiles(c, p)} />
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {c.usage ? `${c.usage.today.toLocaleString()} / ${c.usage.month.toLocaleString()}` : "–"}
              </TableCell>
              <TableCell className="hidden max-w-0 truncate text-muted-foreground text-sm lg:table-cell" title={c.note ?? undefined}>
                {c.note}
              </TableCell>
              <TableCell>
                {canEdit && (
                  <CustomerMenu
                    customer={c}
                    busy={busy === c.userId}
                    onStatus={(s) => void setStatus(c, s)}
                    onNote={(n) => void setNote(c, n)}
                    onRemove={() => void remove(c)}
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
          {!loading && rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                {search ? "No customer matches." : "No customers yet. Anyone you grant access to joins as a customer."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {(next || loading) && (
        <div className="flex justify-center border-t p-3">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void more()}>
            {loading && <Spinner />} {loading ? "Loading" : `Show more (${rows.length} of ${total})`}
          </Button>
        </div>
      )}
      {canEdit && (
        <AddCustomer
          tenantId={tenantId}
          view={view}
          onAdded={() => {
            setSearch("");
            setQuery("");
            setRows([]);
            onCount();
            // Reload the first page so the new customer shows at the top.
            void api.customers(tenantId).then((page) => {
              setRows(page.customers);
              setTotal(page.total);
              setNext(page.next);
            });
          }}
        />
      )}
    </Card>
  );
}

function CustomerMenu(props: { customer: Person; busy: boolean; onStatus: (s: MemberStatus) => void; onNote: (note: string) => void; onRemove: () => void }) {
  const { customer, busy } = props;
  const [noteOpen, setNoteOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [note, setNote] = useState(customer.note ?? "");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" disabled={busy} aria-label={`Actions for ${customer.label ?? customer.userId}`}>
            {busy ? <Spinner /> : <EllipsisIcon />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {customer.status === "active" ? (
            <DropdownMenuItem onSelect={() => props.onStatus("suspended")}>
              <PauseIcon /> Suspend
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => props.onStatus("active")}>
              <PlayIcon /> Resume
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              setNote(customer.note ?? "");
              setNoteOpen(true);
            }}
          >
            <StickyNoteIcon /> {customer.note ? "Edit note" : "Add note"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setRemoveOpen(true)}>
            <Trash2Icon /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Note on {customer.label ?? customer.userId}</DialogTitle>
            <DialogDescription>Only your team sees it.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} maxLength={2000} value={note} placeholder="Trial until March, support ticket link…" onChange={(e) => setNote(e.target.value)} />
          <DialogFooter>
            <Button
              onClick={() => {
                props.onNote(note);
                setNoteOpen(false);
              }}
            >
              Save note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {customer.label ?? customer.userId}?</AlertDialogTitle>
            <AlertDialogDescription>They lose their access and profiles here. Suspending keeps both, if they may come back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={props.onRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AddCustomer({ tenantId, view, onAdded }: { tenantId: string; view: AccessView; onAdded: () => void }) {
  const [userId, setUserId] = useState("");
  const [profileId, setProfileId] = useState(view.profiles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  if (view.profiles.length === 0) {
    return <p className="border-t px-4 py-3 text-muted-foreground text-xs">Create a profile first to add customers with it, or grant access on a toolset's Access tab.</p>;
  }
  return (
    <div className="flex flex-col gap-2 border-t p-4">
      <div>
        <h3 className="font-medium text-sm">Add a customer</h3>
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
            // Keep any profiles they already hold.
            const added = await act(
              async () => {
                const existing = (await api.customers(tenantId, userId)).customers.find((c) => c.userId === userId)?.profiles ?? [];
                return api.setMemberProfiles(tenantId, userId, [...new Set([...existing, profileId])]);
              },
              { busy: setBusy },
            );
            if (!added) return;
            setUserId("");
            onAdded();
            toast.success("Added");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
