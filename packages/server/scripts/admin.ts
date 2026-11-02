// Operator CLI for setting up tenants until the curation UI exists.
// Runs where the app runs (it needs CAIRNMCP_DATABASE_URL and, for credentials,
// CAIRNMCP_MASTER_KEY). On the Oracle VM, use deploy/oracle/admin.sh from your
// machine, which runs this inside the app container.
//
//   tenant create  --name <name> --owner <account id> [--id <slug>]
//   tenant show    --tenant <id>
//   source add     --tenant <id> --id <slug> [--fixed-username <scheme>=<value>]...   < openapi.json|yaml
//   toolset put    --tenant <id> --source <id> --id <slug> [--name <name>] [--definition]  [< toolset.json]
//   access grant   --tenant <id> --toolset <id> --user <account id> --level use|use_writes|none
//   credential set --tenant <id> --source <id> --scheme <scheme id> --kind basic|bearer|api_key [--username <u>]   < secret
import { parseArgs } from "node:util";
import { Database, PgVaultStore } from "@cairnmcp/db";
import { LocalKeyWrapper, parseMasterKey, Vault, type CredentialInput } from "@cairnmcp/vault";
import { AdminError, addSource, createTenant, grantAccess, putToolsetFor, setCredential, showTenant } from "../src/admin.ts";

const USAGE = `usage: admin <command> [options]
  tenant create  --name <name> --owner <account id> [--id <slug>]
  tenant show    --tenant <id>
  source add     --tenant <id> --id <slug> [--fixed-username <scheme>=<value>]...   (OpenAPI document on stdin)
  toolset put    --tenant <id> --source <id> --id <slug> [--name <name>] [--definition]   (JSON on stdin with --definition)
  access grant   --tenant <id> --toolset <id> --user <account id> --level use|use_writes|none
  credential set --tenant <id> --source <id> --scheme <scheme id> --kind basic|bearer|api_key [--username <u>]   (secret on stdin)`;

const [group, action, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  strict: true,
  options: {
    name: { type: "string" },
    owner: { type: "string" },
    id: { type: "string" },
    tenant: { type: "string" },
    source: { type: "string" },
    toolset: { type: "string" },
    user: { type: "string" },
    level: { type: "string" },
    scheme: { type: "string" },
    kind: { type: "string" },
    username: { type: "string" },
    definition: { type: "boolean" },
    "fixed-username": { type: "string", multiple: true },
  },
});

function need(name: keyof typeof values): string {
  const v = values[name];
  if (typeof v !== "string" || v === "") throw new AdminError(`missing --${name}\n\n${USAGE}`);
  return v;
}

async function stdin(what: string): Promise<string> {
  if (process.stdin.isTTY) throw new AdminError(`expected ${what} on stdin (pipe it in: ... < file)`);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new AdminError(`${what} on stdin was empty`);
  return text;
}

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new AdminError(`${name} is not set`);
  return v;
};

async function main(): Promise<void> {
  const command = `${group ?? ""} ${action ?? ""}`.trim();
  if (!["tenant create", "tenant show", "source add", "toolset put", "access grant", "credential set"].includes(command)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const db = await Database.connect({ url: env("CAIRNMCP_DATABASE_URL"), max: 2 });
  const vault = () => new Vault({ store: new PgVaultStore(db), keyWrapper: new LocalKeyWrapper(parseMasterKey(process.env["CAIRNMCP_MASTER_KEY"])) });
  const publicUrl = process.env["CAIRNMCP_PUBLIC_URL"]?.replace(/\/+$/, "");
  try {
    switch (command) {
      case "tenant create": {
        const id = await createTenant(db, { name: need("name"), ownerUserId: need("owner"), ...(values.id ? { id: values.id } : {}) });
        console.log(`Created tenant ${id}, owned by ${values.owner}.`);
        break;
      }
      case "tenant show":
        console.log(JSON.stringify(await showTenant(db, vault(), need("tenant")), null, 2));
        break;
      case "source add": {
        const fixedUsernames: Record<string, string> = {};
        for (const pair of values["fixed-username"] ?? []) {
          const [scheme, ...v] = pair.split("=");
          if (!scheme || v.length === 0) throw new AdminError(`--fixed-username must be <scheme>=<value>, got ${pair}`);
          fixedUsernames[scheme] = v.join("=");
        }
        const s = await addSource(db, { tenantId: need("tenant"), sourceId: need("id"), openapi: await stdin("an OpenAPI document"), fixedUsernames });
        console.log(`Stored source ${s.id} (${s.name}): ${s.operations} operations, ${s.reads} reads; auth schemes: ${s.authSchemes.join(", ") || "none"}${s.warnings ? `; ${s.warnings} mapping warnings` : ""}.`);
        break;
      }
      case "toolset put": {
        const definition = values.definition ? (JSON.parse(await stdin("a toolset definition (JSON)")) as unknown) : undefined;
        const tenantId = need("tenant");
        const t = await putToolsetFor(db, { tenantId, sourceId: need("source"), toolsetId: need("id"), ...(values.name ? { name: values.name } : {}), ...(definition !== undefined ? { definition } : {}) });
        console.log(`Stored toolset ${t.id}: ${t.enabled.length} enabled tools${t.disabled ? `, ${t.disabled} disabled` : ""}.`);
        console.log(`  ${t.enabled.join(", ")}`);
        if (publicUrl) console.log(`MCP endpoint: ${publicUrl}/mcp/${tenantId}/${t.id}`);
        break;
      }
      case "access grant": {
        const level = need("level");
        if (!["use", "use_writes", "none"].includes(level)) throw new AdminError("--level must be use, use_writes, or none");
        const r = await grantAccess(db, { tenantId: need("tenant"), toolsetId: need("toolset"), userId: need("user"), level: level as "use" | "use_writes" | "none" });
        console.log(`${level === "none" ? "Revoked" : `Granted ${level} on`} ${values.toolset} for ${values.user}${r.addedMember ? " (added as a customer)" : ""}.`);
        break;
      }
      case "credential set": {
        const kind = need("kind");
        const secret = (await stdin("the secret")).replace(/\r?\n$/, "");
        const credential: CredentialInput =
          kind === "basic"
            ? { kind, password: secret, ...(values.username ? { username: values.username } : {}) }
            : kind === "bearer"
              ? { kind, token: secret }
              : kind === "api_key"
                ? { kind, value: secret }
                : (() => {
                    throw new AdminError("--kind must be basic, bearer, or api_key");
                  })();
        const r = await setCredential(vault(), { tenantId: need("tenant"), sourceId: need("source"), schemeId: need("scheme"), credential });
        console.log(`Stored a ${kind} credential for ${values.source} (${values.scheme})${r.replaced ? `, replacing ${r.replaced} older one(s)` : ""}. The secret was not printed.`);
        break;
      }
    }
  } finally {
    await db.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof AdminError ? e.message : `unexpected error: ${(e as Error).message}`);
  process.exitCode = 1;
});
