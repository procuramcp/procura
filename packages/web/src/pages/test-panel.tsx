import { FlaskConicalIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, type JsonValue, type OperationView, type TestResult, type ToolBinding } from "@/lib/api";
import { parseValue } from "@/lib/values";

/**
 * Run the tool as edited (saved or not) through the real runtime, with its
 * pins and the stored credential, and show what an agent would get (D-033).
 */
export function TestPanel({ tenantId, toolsetId, op, binding }: { tenantId: string; toolsetId: string; op: OperationView; binding: ToolBinding }) {
  const open = op.inputs.filter((i) => !(i.name in binding.pinnedInputs));
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<{ args: Record<string, JsonValue>; result?: TestResult; error?: string } | undefined>();

  const args = (): Record<string, JsonValue> => {
    const out: Record<string, JsonValue> = {};
    for (const input of open) {
      const text = values[input.name];
      if (text !== undefined && text !== "") out[input.name] = parseValue(text, input.type);
    }
    return out;
  };

  async function go(confirm: boolean) {
    const a = args();
    setRunning(true);
    setRun({ args: a });
    try {
      const result = await api.testTool(tenantId, toolsetId, { ...binding, enabled: true }, a, confirm);
      setRun({ args: a, result });
    } catch (e) {
      if (e instanceof ApiError && e.body.error === "confirm_required") {
        setRun(undefined);
        setConfirming(true);
      } else {
        setRun({ args: a, error: (e as Error).message });
        if (!(e instanceof ApiError)) toast.error((e as Error).message);
      }
    } finally {
      setRunning(false);
    }
  }

  const changesData = op.sideEffect.class !== "read";
  const result = run?.result?.result;
  const state = running ? "input-available" : run?.error || (result && !result.ok) ? "output-error" : result ? "output-available" : "input-streaming";
  const errorText = run?.error ?? (result && !result.ok ? `${result.error.kind}: ${result.error.message}` : undefined);

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-medium">
            <FlaskConicalIcon className="size-4" /> Try it
          </h3>
          <p className="text-muted-foreground text-sm">A real call to {op.method === "GET" ? "the API" : "the API, which changes data"}, with the pins and your stored key.</p>
        </div>
        <Button size="sm" onClick={() => go(false)} disabled={running} variant={changesData ? "outline" : "default"}>
          {running ? <Spinner /> : <PlayIcon />} Run
        </Button>
      </div>

      {open.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {open.map((input) => (
            <label key={input.name} className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 font-mono text-xs">
                {input.name}
                {input.required && <span className="text-destructive">*</span>}
                <span className="text-muted-foreground">{input.type}</span>
              </span>
              <Input
                className="font-mono"
                value={values[input.name] ?? ""}
                placeholder={input.description.slice(0, 60)}
                onChange={(e) => setValues({ ...values, [input.name]: e.target.value })}
              />
            </label>
          ))}
        </div>
      )}
      {Object.keys(binding.pinnedInputs).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          Pinned:
          {Object.entries(binding.pinnedInputs).map(([k, v]) => (
            <Badge key={k} variant="outline" className="font-mono">
              {k}={typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}
            </Badge>
          ))}
        </div>
      )}

      {run && (
        <Tool defaultOpen>
          <ToolHeader type="dynamic-tool" toolName={binding.name} state={state} />
          <ToolContent>
            <ToolInput input={run.args} />
            <ToolOutput output={result?.ok ? (result.data as never) : undefined} errorText={errorText} />
          </ToolContent>
        </Tool>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run a {op.sideEffect.class} tool?</AlertDialogTitle>
            <AlertDialogDescription>
              {binding.name} calls <span className="font-mono">{op.method} {op.path}</span> for real and changes data. The call is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void go(true)}>Run it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
