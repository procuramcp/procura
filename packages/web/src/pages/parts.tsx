import { CheckIcon, CopyIcon, PencilIcon, ShieldAlertIcon, EyeIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Role, SideEffect } from "@/lib/api";

/** A read-only value with a copy button (endpoint URLs, account ids). */
export function CopyText({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <InputGroup className={className}>
      <InputGroupInput readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

const EFFECT: Record<SideEffect, { label: string; icon: typeof EyeIcon; className: string; hint: string }> = {
  read: { label: "read", icon: EyeIcon, className: "", hint: "Only reads data." },
  write: {
    label: "write",
    icon: PencilIcon,
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    hint: "Changes data. Callable only by people with use_writes access.",
  },
  destructive: {
    label: "destructive",
    icon: ShieldAlertIcon,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
    hint: "Deletes or overwrites data. Callable only by people with use_writes access.",
  },
};

export function SideEffectBadge({ effect, reason }: { effect: SideEffect; reason?: string }) {
  const e = EFFECT[effect];
  const Icon = e.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={e.className}>
          <Icon />
          {e.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {e.hint}
        {reason ? ` Why: ${reason}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-700 dark:text-emerald-400",
  POST: "text-sky-700 dark:text-sky-400",
  PUT: "text-amber-700 dark:text-amber-400",
  PATCH: "text-amber-700 dark:text-amber-400",
  DELETE: "text-destructive",
};

export function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <span className="font-mono text-xs">
      <span className={`font-semibold ${METHOD_COLORS[method] ?? ""}`}>{method}</span> <span className="text-muted-foreground">{path}</span>
    </span>
  );
}

/** A toolset id: lowercase letters and digits joined by single hyphens (the server's SLUG rule). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** Someone in a tenant: their sign-in name if known, the account id, and their role (D-038). */
export function PersonName({ person, you, showRole = true }: { person: { userId: string; label: string | null; role: Role }; you?: boolean; showRole?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5 truncate">
        {person.label ?? <span className="text-muted-foreground">No name yet</span>}
        {showRole && person.role !== "customer" && <Badge variant="outline">{person.role}</Badge>}
        {you && <Badge variant="secondary">you</Badge>}
      </span>
      <span className="truncate font-mono text-muted-foreground text-xs">{person.userId}</span>
    </div>
  );
}
