/**
 * Plan-mode enforcement policy (pure).
 *
 * grok's `x.ai/exit_plan_mode` treats *any* client response as approval, so we
 * cannot reject a plan at the protocol layer. Instead we enforce plan/act on
 * *our* side, at the two mandatory server→client choke points the agent cannot
 * avoid:
 *
 *   - `fs/write_text_file` — every file write
 *   - `terminal/create`    — every shell command
 *
 * Empirically (grok 0.2.3, ACP), a plan-mode turn only *reads* the workspace
 * (`fs/read_text_file` + internal search tools) and writes its plan to
 * `~/.grok/sessions/<cwd>/<id>/plan.md` — i.e. *outside* the workspace. So the
 * gate is not "block all writes"; it is "block writes that land inside the
 * workspace", which protects the user's project while letting grok persist its
 * own plan file.
 *
 * These functions are pure so the policy can be unit-tested without spawning a
 * CLI; `acp.ts` / `sidebar.ts` call them with the live path/command strings.
 */

import * as nodePath from "node:path";

/** JSON-RPC error code we use when refusing a mutating call during plan mode. */
export const PLAN_BLOCKED_CODE = -32010;
export const PLAN_BLOCKED_WRITE_MSG =
  "Blocked by Plan mode: approve the plan before writing files in the workspace.";
export const PLAN_BLOCKED_TERMINAL_MSG =
  "Blocked by Plan mode: approve the plan before running commands that may change the workspace.";

/**
 * Strip the Windows extended-length prefix (`\\?\` or `//?/`), normalize all
 * separators to `/`, collapse `.`/`..` segments, and drop a trailing slash.
 * Drive-letter / backslash paths are treated as Windows and lower-cased for a
 * case-insensitive compare; POSIX paths stay case-sensitive.
 */
function canonical(p: string): { norm: string; windows: boolean } {
  let s = String(p || "").trim();
  const windows = /^[\\/]{2}\?[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.includes("\\");
  s = s.replace(/^[\\/]{2}\?[\\/]/, ""); // \\?\C:\... → C:\...
  s = s.replace(/\\/g, "/");
  s = nodePath.posix.normalize(s);
  s = s.replace(/\/+$/, ""); // drop trailing slash (but keep "/" root)
  if (s === "") s = "/";
  return { norm: windows ? s.toLowerCase() : s, windows };
}

function isAbsolutePath(p: string): boolean {
  const s = String(p || "").trim();
  return /^[\\/]{2}\?[\\/]/.test(s) || /^[a-zA-Z]:[\\/]/.test(s) ||
    s.startsWith("/") || s.startsWith("\\");
}

function canonicalTarget(target: string, root: string): { norm: string; windows: boolean } {
  if (isAbsolutePath(target)) return canonical(target);
  const r = canonical(root);
  const t = canonical(target);
  const norm = nodePath.posix.normalize(`${r.norm}/${t.norm}`);
  return { norm: r.windows ? norm.toLowerCase() : norm, windows: r.windows };
}

/**
 * True if `target` resolves to `root` itself or somewhere beneath it. Used to
 * decide whether a write lands in the user's workspace (block) or outside it
 * (allow). Grok's own `~/.grok/.../plan.md` is handled separately because a
 * user may open their home directory as the workspace root.
 */
export function isInsideWorkspace(target: string, root: string): boolean {
  if (!target || !root) return false;
  const t = canonicalTarget(target, root).norm;
  const r = canonical(root).norm;
  if (r === "/" ) return t === "/" || t.startsWith("/");
  return t === r || t.startsWith(r + "/");
}

/** Tool-call `kind`s that mutate state and must be rejected while planning. */
const MUTATING_KINDS = new Set(["edit", "execute", "delete", "move", "write"]);

/** Read-only `kind`s the agent may use freely while planning. */
export function isMutatingKind(kind: string | undefined): boolean {
  return MUTATING_KINDS.has(String(kind || "").toLowerCase());
}

// Shell metacharacters that can redirect, background, or smuggle code — any of
// these means we can't trust a head-token allowlist, so we block. The pure
// SEQUENCING operators — `&&`, `||`, `;`, `|` — are deliberately NOT here:
// they split the command into segments and every segment must be read-only on
// its own (#36 — plan mode used to block the harmless `cd repo && git status`,
// which crashed grok-4.5's planning phase). A lone `&` (POSIX backgrounding)
// is still blocked, checked separately in isReadOnlyCommand since `&` is a
// substring of `&&`. Script-block braces `{ }` are blocked because an
// otherwise-safe cmdlet can host arbitrary code in one (e.g.
// `Select-Object @{e={ Remove-Item x }}`). An operator hidden inside quotes
// mis-splits into segments that fail the allowlist — mis-parses err toward
// blocking.
const UNSAFE_SHELL = /[>`{}\r\n]|\$\(|<\(/;

const READONLY_HEADS = new Set([
  // POSIX
  "ls", "dir", "pwd", "cd", "echo", "cat", "type", "head", "tail", "less", "more",
  "grep", "rg", "ag", "ack", "find", "fd", "tree", "wc", "stat", "file", "which",
  "where", "whereis", "basename", "dirname", "realpath", "readlink", "du", "df",
  "printenv", "date", "whoami", "hostname", "uname", "sort", "uniq", "cut",
  // PowerShell read-only cmdlets + aliases. Inspection/formatting only — anything
  // that writes (out-file, set-content, tee-object, export-*) or executes
  // (foreach-object, where-object, invoke-expression/iex, invoke-command, start-process)
  // is deliberately excluded, so a pipeline containing one is blocked.
  "get-childitem", "gci", "get-content", "gc", "get-item", "gi",
  "get-itemproperty", "gp", "test-path", "resolve-path", "rvpa", "get-location", "gl",
  "select-object", "select", "format-table", "ft", "format-list", "fl", "format-wide", "fw",
  "sort-object", "measure-object", "measure", "select-string", "sls", "out-string",
  "get-command", "gcm", "get-help", "get-member", "gm", "compare-object",
]);

const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "ls-tree",
  "rev-parse", "blame", "describe", "shortlog", "cat-file", "name-rev",
  "whatchanged",
]);

const PKG_READONLY = new Set(["ls", "list", "view", "info", "outdated", "why", "show", "audit"]);

const GIT_BRANCH_READONLY_FLAGS = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list",
  "--show-current", "--merged", "--no-merged", "--contains", "--no-contains",
  "--points-at", "--color", "--no-color", "--column", "--no-column",
]);
const GIT_BRANCH_READONLY_PREFIXES = ["--format=", "--sort=", "--color=", "--column="];

const GIT_TAG_READONLY_FLAGS = new Set([
  "-l", "--list", "-n", "--contains", "--no-contains", "--points-at",
  "--merged", "--no-merged", "--color", "--no-color", "--column", "--no-column",
]);
const GIT_TAG_READONLY_PREFIXES = ["-n", "--format=", "--sort=", "--color=", "--column="];

const GIT_WRITE_OUTPUT_OPTIONS = [
  "--output=", "--output-directory=",
];

function hasToken(tokens: string[], ...blocked: string[]): boolean {
  return tokens.some((t) => blocked.includes(t));
}

function hasTokenPrefix(tokens: string[], ...prefixes: string[]): boolean {
  return tokens.some((t) => prefixes.some((p) => t.startsWith(p)));
}

function hasGitWriteOption(tokens: string[]): boolean {
  return hasToken(tokens, "--output", "--output-directory", "--ext-diff") ||
    hasTokenPrefix(tokens, ...GIT_WRITE_OUTPUT_OPTIONS);
}

function allReadOnlyOptionTokens(tokens: string[], exact: Set<string>, prefixes: string[]): boolean {
  return tokens.every((t) => exact.has(t) || prefixes.some((p) => t.startsWith(p)));
}

function hasSedInPlace(tokens: string[]): boolean {
  return tokens.some((t) => /^-[a-z]*i([a-z]|\b)/i.test(t) || t.startsWith("--in-place"));
}

function hasOutputOption(tokens: string[]): boolean {
  return hasToken(tokens, "-o", "--output") || hasTokenPrefix(tokens, "--output=");
}

function isReadOnlyGit(tokens: string[]): boolean {
  const sub = (tokens[1] || "").toLowerCase();
  const args = tokens.slice(2).map((t) => t.toLowerCase());
  if (hasGitWriteOption(args)) return false;
  if (sub === "tag") return args.length === 0 ||
    allReadOnlyOptionTokens(args, GIT_TAG_READONLY_FLAGS, GIT_TAG_READONLY_PREFIXES);
  if (sub === "branch") return args.length === 0 ||
    allReadOnlyOptionTokens(args, GIT_BRANCH_READONLY_FLAGS, GIT_BRANCH_READONLY_PREFIXES);
  if (sub === "remote") {
    if (args.length === 0 || allReadOnlyOptionTokens(args, new Set(["-v", "--verbose"]), [])) return true;
    const action = args.find((a) => !a.startsWith("-"));
    return action === "show" || action === "get-url";
  }
  if (sub === "reflog") {
    if (args.length === 0) return true;
    const action = args.find((a) => !a.startsWith("-")) || "show";
    return action === "show";
  }
  if (sub === "config") {
    if (args.length === 0) return false;
    if (args.length === 1 && !args[0].startsWith("-")) return true;
    return hasToken(args, "-l", "--list") ||
      hasTokenPrefix(args, "--get", "--get-regexp", "--show-origin", "--show-scope");
  }
  return GIT_READONLY.has(sub);
}

function isReadOnlyPackageCommand(tokens: string[]): boolean {
  const sub = (tokens[1] || "").toLowerCase();
  const args = tokens.slice(2).map((t) => t.toLowerCase());
  if (!PKG_READONLY.has(sub)) return false;
  if (sub === "audit" && (hasToken(args, "fix") || hasTokenPrefix(args, "--fix"))) return false;
  return true;
}

/** One pipeline stage: read-only iff its head token is a known read-only program. */
function isReadOnlyStage(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/);
  if (!tokens[0]) return false;
  const head = tokens[0].toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  if (head === "git") {
    return isReadOnlyGit(lowerTokens);
  }
  if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
    return isReadOnlyPackageCommand(lowerTokens);
  }
  if (head === "node" || head === "python" || head === "python3" || head === "deno") {
    // Only allow trivially read-only invocations like `node --version`.
    return tokens.length >= 2 && /^(-v|--version|--help|-h)$/.test(tokens[1]);
  }
  if (head === "sips") return isReadOnlySips(lowerTokens);
  if (head === "sed" && hasSedInPlace(lowerTokens.slice(1))) return false;
  if (head === "find" && hasToken(lowerTokens.slice(1), "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls")) return false;
  if (head === "fd" && hasToken(lowerTokens.slice(1), "-x", "--exec", "--exec-batch")) return false;
  if ((head === "sort" || head === "tree") && hasOutputOption(lowerTokens.slice(1))) return false;
  return READONLY_HEADS.has(head);
}

/**
 * `sips` (macOS image tool): allow property queries only (`-g` / `--getProperty`).
 * Resample/set/format/out forms rewrite image files and stay blocked.
 */
function isReadOnlySips(tokens: string[]): boolean {
  const args = tokens.slice(1);
  if (args.length === 0) return false;
  let sawGet = false;
  for (const t of args) {
    if (t === "-g" || t === "--getproperty") {
      sawGet = true;
      continue;
    }
    if (
      t === "-s" || t.startsWith("--set") ||
      t === "-z" || t.startsWith("--resample") ||
      t === "-r" || t.startsWith("--rotate") ||
      t === "-f" || t.startsWith("--format") ||
      t === "-o" || t.startsWith("--out") ||
      t === "-d" || t.startsWith("--delete") ||
      t.startsWith("--crop") || t.startsWith("--pad") ||
      t === "--addicon" || t === "--optimizecolorforsharing"
    ) {
      return false;
    }
  }
  return sawGet;
}

/**
 * Drop redirects that cannot write workspace state (`2>/dev/null`, `>/dev/null`,
 * `2>&1`). Agents often silence noise on inspect commands; those must not flip
 * the whole chain to "unsafe" while real `> out.txt` redirects still block.
 */
function stripNullRedirects(cmd: string): string {
  return cmd
    .replace(/(?:\d+)?\s*>\s*\/dev\/null\b/gi, " ")
    .replace(/&\s*>\s*\/dev\/null\b/gi, " ")
    .replace(/(?:\d+)?\s*>&\s*\d+/g, " ");
}

/**
 * Conservative classifier: a command is "read-only" (safe to run while
 * planning) only if it has no redirection/substitution/script-block
 * metacharacters or backgrounding `&`, AND every segment — split on the
 * sequencing operators `&&`, `||`, `;`, `|` — is itself a known read-only
 * program (with a read-only subcommand for git/npm/pnpm/yarn). So
 * `cd repo && git status` and `Get-ChildItem | Select-Object` pass, but
 * `cd repo && npm install`, `git status; rm -rf x`, and `cat x | iex` do not.
 * Harmless `2>/dev/null` redirects are stripped first. Everything else is
 * blocked. Errs toward blocking.
 */
export function isReadOnlyCommand(command: string): boolean {
  const raw = String(command || "").trim();
  if (!raw) return false;
  // Newlines are shell statement separators — refuse before we collapse
  // whitespace (otherwise `ls\nrm -rf x` would look like `ls rm -rf x`).
  if (/[\r\n]/.test(raw)) return false;
  const cmd = stripNullRedirects(raw).replace(/[ \t]+/g, " ").trim();
  if (!cmd) return false;
  if (UNSAFE_SHELL.test(cmd)) return false;
  if (cmd.replace(/&&/g, "").includes("&")) return false; // lone & = backgrounding
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(isReadOnlyStage);
}

export interface PlanGateContext {
  active: boolean;
  workspaceRoot: string;
  grokHome?: string;
}

/** Should `fs/write_text_file` to `path` be refused right now? */
export function shouldBlockWrite(path: string, ctx: PlanGateContext): boolean {
  const isOwnPlanFile = isPlanFileWrite(path) &&
    (!ctx.grokHome || isInsideWorkspace(path, ctx.grokHome));
  return ctx.active && !isOwnPlanFile && isInsideWorkspace(path, ctx.workspaceRoot);
}

/**
 * True if the command's workspace root literally appears in it — a cheap "does
 * this reach into the user's project?" check. Case-insensitive, both slash
 * styles. Grok's plan-file path url-encodes the cwd (`c%3A%5C…`), so a real
 * `C:\…` root string never accidentally matches inside a plan path.
 */
function referencesWorkspace(command: string, root: string): boolean {
  if (!root) return false;
  const c = command.toLowerCase();
  const r = String(root).replace(/[\\/]+$/, "").toLowerCase();
  return c.includes(r) || c.includes(r.replace(/\\/g, "/")) || c.includes(r.replace(/\//g, "\\"));
}

/**
 * True if `command` is grok persisting its OWN plan by shelling out to write
 * `~/.grok/sessions/<cwd>/<id>/plan.md` — sometimes done on Windows via a
 * PowerShell here-string piped to `Set-Content`/`Out-File` instead of the
 * `fs/write_text_file` tool. That write lands OUTSIDE the workspace, so it's the
 * same mutation `shouldBlockWrite` already allows on the fs path (`isPlanFileWrite`)
 * and must not be blocked here. Deliberately simple + conservative: it exempts a
 * command only when (a) it targets grok's plan file, (b) that path resolves
 * outside the workspace (and inside grok's home when we know it), and (c) the
 * command doesn't also reference the workspace root. Anything unrecognized stays
 * blocked, so grok simply falls back to the fs-write path as before.
 */
export function isGrokPlanWriteCommand(command: string, ctx: PlanGateContext): boolean {
  const cmd = String(command || "");
  const m = cmd.match(/[^\s"'|;&]*[\\/]\.grok[\\/]sessions[\\/][^\s"'|;&]*[\\/]plan\.md/i);
  if (!m) return false;
  const planPath = m[0];
  if (isInsideWorkspace(planPath, ctx.workspaceRoot)) return false; // never a workspace write
  if (ctx.grokHome && !isInsideWorkspace(planPath, ctx.grokHome)) return false; // must be grok's own
  if (referencesWorkspace(cmd, ctx.workspaceRoot)) return false; // also reaches into the project
  return true;
}

/** Should `terminal/create` of `command` be refused right now? */
export function shouldBlockTerminal(command: string, ctx: PlanGateContext): boolean {
  if (!ctx.active) return false;
  if (isReadOnlyCommand(command)) return false;
  if (isGrokPlanWriteCommand(command, ctx)) return false; // grok writing its own plan.md
  return true;
}

export interface PlanPermissionInput {
  /** ACP tool-call kind (`edit` / `execute` / `read` / …). */
  kind?: string;
  /**
   * Shell command when `kind` is `execute` (from `toolCall.rawInput.command`).
   * Used so read-only exploration is not auto-rejected during planning.
   */
  command?: string;
}

/**
 * Notice when plan mode auto-rejects a mutating permission. Deliberately does
 * **not** say only "approve the plan first" — users often just answered an
 * `ask_user_question` card and think that counted as approval. Answering
 * questions is not plan approval; the plan review card is.
 */
export const PLAN_PERMISSION_BLOCKED_MSG =
  "Plan mode is still active — that action was blocked. Answering questions is not plan approval; wait for the plan review card, then Approve to implement.";

/**
 * Should a `session/request_permission` be auto-rejected while planning?
 *
 * - `edit` / `delete` / `move` / `write` → always reject (implementation).
 * - `execute` → reject unless the command is known read-only (same allowlist as
 *   `shouldBlockTerminal`). Missing/unknown command errs toward reject.
 * - other kinds → allow through (read/search/fetch/etc.).
 */
export function shouldRejectPermission(
  toolKind: string | undefined,
  ctx: PlanGateContext,
  input?: PlanPermissionInput,
): boolean {
  if (!ctx.active) return false;
  const kind = String(toolKind ?? input?.kind ?? "").toLowerCase();
  if (kind === "execute") {
    const cmd = input?.command;
    return !cmd || !isReadOnlyCommand(cmd);
  }
  return isMutatingKind(kind);
}

/**
 * Should a permission be auto-allowed while planning (no card, no notice)?
 * Mirrors the terminal gate: only read-only `execute` commands.
 */
export function shouldAutoAllowPermission(
  toolKind: string | undefined,
  ctx: PlanGateContext,
  input?: PlanPermissionInput,
): boolean {
  if (!ctx.active) return false;
  const kind = String(toolKind ?? input?.kind ?? "").toLowerCase();
  if (kind !== "execute") return false;
  const cmd = input?.command;
  return !!cmd && isReadOnlyCommand(cmd);
}

/** Pull the shell command out of an ACP permission toolCall, if present. */
export function commandFromPermissionToolCall(toolCall: {
  rawInput?: unknown;
} | undefined): string | undefined {
  const ri = toolCall?.rawInput;
  if (!ri || typeof ri !== "object") return undefined;
  const cmd = (ri as { command?: unknown }).command;
  return typeof cmd === "string" && cmd.trim() ? cmd : undefined;
}

export interface PermissionOptionLike {
  optionId: string;
  kind: string;
  name?: string;
}

/**
 * Pick the option that means "no" from a permission request's options. Prefers
 * an explicit `reject_once`, then any reject/deny kind; returns undefined if the
 * request offers no way to decline (caller should then fall back to the user).
 */
export function pickRejectOption(options: PermissionOptionLike[]): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const exact = options.find((o) => o.kind === "reject_once");
  if (exact) return exact.optionId;
  const anyReject = options.find((o) => /reject|deny|cancel|no/i.test(o.kind));
  return anyReject?.optionId;
}

/**
 * Pick the option that means "yes". Prefers `allow_always`, then `allow_once`,
 * then any allow/accept kind.
 */
export function pickAllowOption(options: PermissionOptionLike[]): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const always = options.find((o) => o.kind === "allow_always");
  if (always) return always.optionId;
  const once = options.find((o) => o.kind === "allow_once");
  if (once) return once.optionId;
  const anyAllow = options.find((o) => /allow|accept|yes/i.test(o.kind));
  return anyAllow?.optionId;
}

/**
 * True if `path` is grok's own plan file (`.grok/sessions/.../plan.md`). We
 * snoop the content of that write to populate the plan-review card, since
 * `exit_plan_mode` itself arrives with `planContent: null`.
 */
export function isPlanFileWrite(path: string): boolean {
  return /[\\/]\.grok[\\/]sessions[\\/].*[\\/]plan\.md$/i.test(String(path || ""));
}
