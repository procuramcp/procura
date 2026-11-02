// Trimmed from AI Elements' code-block: the console only shows JSON (tool.tsx),
// so this keeps the highlighted <CodeBlock> and drops the header, copy button,
// and language picker. Shiki loads on first use with only JSON and two themes,
// on the JavaScript regex engine so the CSP needs no wasm-unsafe-eval (D-033).
import type { CSSProperties, HTMLAttributes } from "react";
import { useEffect, useState } from "react";
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { cn } from "@/lib/utils";

type Tokens = { tokens: ThemedToken[][]; fg: string; bg: string };

const CACHE_SIZE = 50;
const cache = new Map<string, Tokens>();
let highlighter: Promise<HighlighterCore> | undefined;

function highlight(code: string): Promise<Tokens> {
  const hit = cache.get(code);
  if (hit) return Promise.resolve(hit);
  highlighter ??= createHighlighterCore({
    langs: [import("shiki/langs/json.mjs")],
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter.then((h) => {
    const r = h.codeToTokens(code, { lang: "json", themes: { light: "github-light", dark: "github-dark" } });
    const tokens = { tokens: r.tokens, fg: r.fg ?? "inherit", bg: r.bg ?? "transparent" };
    cache.set(code, tokens);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return tokens;
  });
}

/** Unhighlighted lines, shown until Shiki has loaded. */
function plain(code: string): Tokens {
  return { fg: "inherit", bg: "transparent", tokens: code.split("\n").map((line) => (line === "" ? [] : [{ content: line, color: "inherit" } as ThemedToken])) };
}

// Shiki font styles are bit flags: 1 italic, 2 bold, 4 underline.
function tokenStyle(t: ThemedToken): CSSProperties {
  const f = t.fontStyle ?? 0;
  return {
    backgroundColor: t.bgColor,
    color: t.color,
    fontStyle: f & 1 ? "italic" : undefined,
    fontWeight: f & 2 ? "bold" : undefined,
    textDecoration: f & 4 ? "underline" : undefined,
    ...(t.htmlStyle as CSSProperties | undefined),
  };
}

const DARK = "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]";

/** JSON, syntax-highlighted in light and dark. */
export function CodeBlock({ code, language: _json, className, style, ...props }: HTMLAttributes<HTMLDivElement> & { code: string; language?: "json" }) {
  const [tokens, setTokens] = useState<Tokens>(() => cache.get(code) ?? plain(code));
  useEffect(() => {
    let live = true;
    setTokens(cache.get(code) ?? plain(code));
    highlight(code).then(
      (t) => live && setTokens(t),
      (e: unknown) => console.error("Failed to highlight code:", e),
    );
    return () => {
      live = false;
    };
  }, [code]);

  return (
    <div
      className={cn("group relative w-full overflow-hidden rounded-md border bg-background text-foreground", className)}
      data-language="json"
      style={{ containIntrinsicSize: "auto 200px", contentVisibility: "auto", ...style }}
      {...props}
    >
      <div className="relative overflow-auto">
        <pre className={cn(DARK, "m-0 p-4 text-sm")} style={{ backgroundColor: tokens.bg, color: tokens.fg }}>
          <code className="font-mono text-sm">
            {tokens.tokens.map((line, i) => (
              // Lines and tokens never reorder, so their index is a stable key.
              <span className="block" key={i}>
                {line.length === 0
                  ? "\n"
                  : line.map((t, j) => (
                      <span className={DARK} key={j} style={tokenStyle(t)}>
                        {t.content}
                      </span>
                    ))}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
