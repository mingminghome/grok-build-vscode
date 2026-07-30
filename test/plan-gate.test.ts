import { describe, it, expect } from "vitest";
import {
  isInsideWorkspace,
  isMutatingKind,
  isReadOnlyCommand,
  isPlanFileWrite,
  isGrokPlanWriteCommand,
  pickAllowOption,
  pickRejectOption,
  shouldBlockWrite,
  shouldBlockTerminal,
  shouldAutoAllowPermission,
  shouldRejectPermission,
  commandFromPermissionToolCall,
  PLAN_PERMISSION_BLOCKED_MSG,
  PlanGateContext,
} from "../src/plan-gate";

// Real paths captured from the grok 0.2.3 plan-mode probe (research/plan-probe.cjs).
const WIN_ROOT = "C:\\Users\\Dell\\AppData\\Local\\Temp\\grok-plan-exp-GyuZ1W";
const WIN_WORKSPACE_WRITE = "\\\\?\\C:\\Users\\Dell\\AppData\\Local\\Temp\\grok-plan-exp-GyuZ1W\\app.js";
const WIN_PLAN_FILE =
  "\\\\?\\C:\\Users\\Dell\\.grok\\sessions\\C%3A%5CUsers%5CDell%5CAppData%5CLocal%5CTemp%5Cgrok-plan-exp-GyuZ1W\\019e6b7e\\plan.md";

const active = (root: string, grokHome?: string): PlanGateContext => ({ active: true, workspaceRoot: root, grokHome });
const off = (root: string): PlanGateContext => ({ active: false, workspaceRoot: root });

describe("isInsideWorkspace", () => {
  it("treats a write inside the workspace as inside — even with the \\\\?\\ long-path prefix", () => {
    expect(isInsideWorkspace(WIN_WORKSPACE_WRITE, WIN_ROOT)).toBe(true);
  });

  it("treats grok's own ~/.grok/.../plan.md as OUTSIDE the workspace (the key case)", () => {
    expect(isInsideWorkspace(WIN_PLAN_FILE, WIN_ROOT)).toBe(false);
  });

  it("is case-insensitive for Windows drive paths", () => {
    expect(isInsideWorkspace("c:\\Proj\\src\\a.ts", "C:\\proj")).toBe(true);
  });

  it("is case-sensitive for POSIX paths", () => {
    expect(isInsideWorkspace("/Work/src/a.ts", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/src/a.ts", "/work")).toBe(true);
  });

  it("does not treat a sibling dir with a shared prefix as inside", () => {
    expect(isInsideWorkspace("/work2/a.ts", "/work")).toBe(false);
    expect(isInsideWorkspace("C:\\proj-other\\a.ts", "C:\\proj")).toBe(false);
  });

  it("does not treat an absolute UNC path as workspace-relative", () => {
    expect(isInsideWorkspace("\\\\server\\share\\file.ts", "C:\\proj")).toBe(false);
  });

  it("resolves .. traversal that escapes the workspace as outside", () => {
    expect(isInsideWorkspace("/work/../etc/passwd", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/sub/../keep.ts", "/work")).toBe(true);
  });

  it("returns false on empty inputs", () => {
    expect(isInsideWorkspace("", "/work")).toBe(false);
    expect(isInsideWorkspace("/work/a", "")).toBe(false);
  });
});

describe("shouldBlockWrite", () => {
  it("blocks a workspace write while planning", () => {
    expect(shouldBlockWrite(WIN_WORKSPACE_WRITE, active(WIN_ROOT))).toBe(true);
  });

  it("ALLOWS grok writing its own plan.md while planning (outside workspace)", () => {
    expect(shouldBlockWrite(WIN_PLAN_FILE, active(WIN_ROOT, "C:\\Users\\Dell\\.grok"))).toBe(false);
  });

  it("ALLOWS grok writing its own plan.md even when the home dir is the workspace", () => {
    const posixHomePlan = "/home/u/.grok/sessions/%2Fhome%2Fu/019e7608/plan.md";
    expect(isPlanFileWrite(posixHomePlan)).toBe(true);
    expect(isInsideWorkspace(posixHomePlan, "/home/u")).toBe(true);
    expect(shouldBlockWrite(posixHomePlan, active("/home/u", "/home/u/.grok"))).toBe(false);

    expect(isPlanFileWrite(WIN_PLAN_FILE)).toBe(true);
    expect(isInsideWorkspace(WIN_PLAN_FILE, "C:\\Users\\Dell")).toBe(true);
    expect(shouldBlockWrite(WIN_PLAN_FILE, active("C:\\Users\\Dell", "C:\\Users\\Dell\\.grok"))).toBe(false);
  });

  it("does not treat an arbitrary project-local .grok/sessions plan file as grok's own plan.md", () => {
    const projectPlan = "/home/u/proj/.grok/sessions/%2Fhome%2Fu%2Fproj/019e7608/plan.md";
    expect(isPlanFileWrite(projectPlan)).toBe(true);
    expect(isInsideWorkspace(projectPlan, "/home/u/proj")).toBe(true);
    expect(shouldBlockWrite(projectPlan, active("/home/u/proj", "/home/u/.grok"))).toBe(true);
  });

  it("allows any write when the gate is off (normal Agent mode never blocks)", () => {
    expect(shouldBlockWrite(WIN_WORKSPACE_WRITE, off(WIN_ROOT))).toBe(false);
  });

  it("allows a scratch write to /tmp while planning", () => {
    expect(shouldBlockWrite("/tmp/scratch.txt", active("/home/u/proj"))).toBe(false);
  });

  it("blocks a workspace write addressed with forward slashes on Windows", () => {
    expect(shouldBlockWrite("C:/proj/src/a.ts", active("C:\\proj"))).toBe(true);
  });

  it("blocks a nested workspace file while planning", () => {
    expect(shouldBlockWrite("/home/u/proj/src/deep/nested/x.ts", active("/home/u/proj"))).toBe(true);
  });

  it("blocks a relative workspace write while planning", () => {
    expect(shouldBlockWrite("src/file.ts", active("/home/u/proj"))).toBe(true);
  });
});

describe("isReadOnlyCommand", () => {
  it("allows common read-only exploration commands", () => {
    for (const c of ["ls -la", "git status", "git diff HEAD~1", "git log --oneline",
                     "grep -rn foo src", "rg pattern", "cat package.json", "find . -name *.ts",
                     "npm ls", "pnpm outdated", "node --version", "git rev-parse HEAD",
                     "git branch -vv", "git remote -v", "git remote show origin",
                     "git config --get user.name", "git tag --list", "git reflog show"]) {
      expect(isReadOnlyCommand(c), c).toBe(true);
    }
  });

  it("blocks mutating commands", () => {
    for (const c of ["npm install", "rm -rf build", "git commit -m x", "git push",
                     "git checkout -b feat", "node build.js", "yarn add lodash",
                     "mkdir out", "mv a b", "touch new.txt"]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks mutating forms of otherwise read-only command heads", () => {
    for (const c of ["sed -i s/a/b/ src/file.ts", "sed -Ei s/a/b/ src/file.ts",
                     "sed --in-place=.bak s/a/b/ src/file.ts",
                     "find . -delete", "find . -fprint out.txt", "find . -fprintf out.txt %p",
                     "fd -x touch src/pwned", "fd --exec-batch touch src/pwned",
                     "sort -o out.txt input.txt", "tree -o tree.txt",
                     "git diff --output=patch.diff", "git diff --ext-diff",
                     "git config user.name x", "git branch newbranch",
                     "git branch --unset-upstream", "git remote add origin example",
                     "git remote set-url origin example", "git reflog expire --expire=now --all",
                     "git tag -d v1.0.0", "npm audit --fix"]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks read-only heads when a chained segment mutates, or on redirection", () => {
    expect(isReadOnlyCommand("git diff && rm -rf x")).toBe(false);
    expect(isReadOnlyCommand("echo ok&touch src/pwned")).toBe(false); // lone & = backgrounding
    expect(isReadOnlyCommand("ls\nrm -rf src")).toBe(false);
    expect(isReadOnlyCommand("cat secrets > out.txt")).toBe(false);
    expect(isReadOnlyCommand("ls | xargs rm")).toBe(false);
    expect(isReadOnlyCommand("echo $(rm x)")).toBe(false);
  });

  it("allows chains where every segment is read-only (#36)", () => {
    expect(isReadOnlyCommand("cd repo && git status")).toBe(true); // the exact #36 shape
    expect(isReadOnlyCommand("cd src && ls -la && git diff")).toBe(true);
    expect(isReadOnlyCommand("git status; git log --oneline")).toBe(true);
    expect(isReadOnlyCommand("cat a.txt || echo missing")).toBe(true);
    expect(isReadOnlyCommand("cd repo && git log --oneline | head -5")).toBe(true); // chain + pipe mix
    expect(isReadOnlyCommand("git status;")).toBe(true); // trailing separator is harmless
  });

  it("still blocks chains where ANY segment mutates or backgrounds", () => {
    expect(isReadOnlyCommand("cd repo && npm install")).toBe(false);
    expect(isReadOnlyCommand("git status; rm -rf x")).toBe(false);
    expect(isReadOnlyCommand("ls || touch x")).toBe(false);
    expect(isReadOnlyCommand("cd repo && git commit -m x")).toBe(false);
    expect(isReadOnlyCommand("ls && cat x &")).toBe(false); // trailing background
    expect(isReadOnlyCommand("ls & cat x")).toBe(false); // cmd.exe-style single & stays blocked
    expect(isReadOnlyCommand("cd repo && cat x > out.txt")).toBe(false); // redirect anywhere blocks all
    expect(isReadOnlyCommand("gci; Remove-Item x")).toBe(false); // PowerShell ; chain
  });

  it("blocks read-only-looking commands that can execute arbitrary commands", () => {
    expect(isReadOnlyCommand("env touch src/pwned")).toBe(false);
    expect(isReadOnlyCommand("awk 'BEGIN { system(\"touch src/pwned\") }'")).toBe(false);
    expect(isReadOnlyCommand("sed '1e touch src/pwned' file.ts")).toBe(false);
  });

  it("allows read-only PowerShell pipelines (the common plan-mode listing)", () => {
    // The exact shape grok 0.2.3 issues at the start of a plan on native Windows.
    expect(isReadOnlyCommand(
      "Get-ChildItem -Force -Recurse | Select-Object -First 50 Name, FullName, Length, LastWriteTime")).toBe(true);
    expect(isReadOnlyCommand(
      "Get-ChildItem -Path . -Recurse -Force | Select-Object FullName, Name | Format-Table -Auto")).toBe(true);
    expect(isReadOnlyCommand("gci | select Name")).toBe(true);
    expect(isReadOnlyCommand("Get-Content package.json")).toBe(true);
    expect(isReadOnlyCommand("Test-Path app.js")).toBe(true);
    expect(isReadOnlyCommand("cat app.js | sls TODO")).toBe(true);
  });

  it("still blocks a pipeline if ANY stage can write or execute", () => {
    expect(isReadOnlyCommand("Get-ChildItem | Out-File listing.txt")).toBe(false);
    expect(isReadOnlyCommand("Get-Content x | Set-Content y")).toBe(false);
    expect(isReadOnlyCommand("cat secrets.txt | iex")).toBe(false);
    expect(isReadOnlyCommand("Get-ChildItem | ForEach-Object { Remove-Item $_ }")).toBe(false); // braces blocked
    expect(isReadOnlyCommand("Select-Object @{n='x';e={ Remove-Item y }}")).toBe(false); // script-block smuggling
    expect(isReadOnlyCommand("Get-ChildItem | Where-Object { $_.Length -gt 0 } | Remove-Item")).toBe(false);
  });

  it("blocks bare git tag with an argument (can create a tag) but allows the listing form", () => {
    expect(isReadOnlyCommand("git tag")).toBe(true);
    expect(isReadOnlyCommand("git tag v1.0.0")).toBe(false);
  });

  it("treats .exe/.cmd suffixed heads the same", () => {
    expect(isReadOnlyCommand("git.exe status")).toBe(true);
  });

  it("blocks Windows cmd/PowerShell mutating builtins", () => {
    for (const c of ["del file.txt", "copy a b", "move a b", "rd /s build",
                     "Remove-Item x", "New-Item y", "rmdir out"]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks interpreters running a script but allows their --version", () => {
    expect(isReadOnlyCommand("python script.py")).toBe(false);
    expect(isReadOnlyCommand("python3 -m build")).toBe(false);
    expect(isReadOnlyCommand("python --version")).toBe(true);
    expect(isReadOnlyCommand("deno --version")).toBe(true);
  });

  it("blocks build tooling that has side effects", () => {
    for (const c of ["npm run build", "tsc", "make", "cargo build", "docker build ."]) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });

  it("blocks an empty or whitespace command", () => {
    expect(isReadOnlyCommand("")).toBe(false);
    expect(isReadOnlyCommand("   ")).toBe(false);
  });
});

describe("shouldBlockTerminal", () => {
  it("blocks a mutating command while planning", () => {
    expect(shouldBlockTerminal("npm install", active("/p"))).toBe(true);
  });
  it("allows a read-only command while planning", () => {
    expect(shouldBlockTerminal("git diff", active("/p"))).toBe(false);
  });
  it("never blocks when the gate is off", () => {
    expect(shouldBlockTerminal("rm -rf /", off("/p"))).toBe(false);
  });

  // grok sometimes persists its OWN plan by shelling out to write plan.md
  // (PowerShell here-string → Set-Content) instead of fs/write_text_file. That
  // write is outside the workspace and must not be blocked (the notice + retry
  // the user hit). The exemption below is what makes these pass.
  it("ALLOWS grok writing its own plan.md via a Set-Content command while planning", () => {
    const ws = "C:\\GitHub\\grok-build-vscode";
    const home = "C:\\Users\\Dell\\.grok";
    const plan = "C:\\Users\\Dell\\.grok\\sessions\\c%3A%5CGitHub%5Cgrok-build-vscode\\019f9240\\plan.md";
    const cmd = `@'\n# No-op plan\n\n## Goal\nChange nothing.\n'@ | Set-Content -Encoding utf8 "${plan}"`;
    expect(shouldBlockTerminal(cmd, active(ws, home))).toBe(false);
    // Other plan-write shapes grok emits.
    expect(shouldBlockTerminal(`"plan text" | Out-File "${plan}"`, active(ws, home))).toBe(false);
    expect(shouldBlockTerminal(`Set-Content -Path "${plan}" -Value @'\nx\n'@`, active(ws, home))).toBe(false);
  });

  it("still BLOCKS a command that also reaches into the workspace, even if it names plan.md", () => {
    const ws = "C:\\GitHub\\grok-build-vscode";
    const home = "C:\\Users\\Dell\\.grok";
    const plan = "C:\\Users\\Dell\\.grok\\sessions\\enc\\019f9240\\plan.md";
    // Writes plan.md AND a workspace file (absolute) → the workspace reference blocks it.
    const evil = `Set-Content "${plan}" x; Set-Content "C:\\GitHub\\grok-build-vscode\\src\\app.ts" y`;
    expect(shouldBlockTerminal(evil, active(ws, home))).toBe(true);
  });

  it("does not exempt a non-plan file write, or a plan path that resolves inside the workspace", () => {
    const ws = "C:\\GitHub\\grok-build-vscode";
    const home = "C:\\Users\\Dell\\.grok";
    // No plan.md target at all.
    expect(isGrokPlanWriteCommand(`Set-Content "notes.txt" x`, active(ws, home))).toBe(false);
    // A ".grok/sessions/.../plan.md" that actually lives inside the workspace is not grok's own home plan.
    const wsPlan = "C:\\GitHub\\grok-build-vscode\\.grok\\sessions\\enc\\id\\plan.md";
    expect(isGrokPlanWriteCommand(`Set-Content "${wsPlan}" x`, active(ws, home))).toBe(false);
    // Right shape but grok home is elsewhere → not grok's own plan.
    const foreignPlan = "D:\\other\\.grok\\sessions\\enc\\id\\plan.md";
    expect(isGrokPlanWriteCommand(`Set-Content "${foreignPlan}" x`, active(ws, home))).toBe(false);
  });
});

describe("permission gating", () => {
  it("isMutatingKind classifies edit/execute as mutating and read/search as not", () => {
    expect(isMutatingKind("edit")).toBe(true);
    expect(isMutatingKind("execute")).toBe(true);
    expect(isMutatingKind("delete")).toBe(true);
    expect(isMutatingKind("read")).toBe(false);
    expect(isMutatingKind("fetch")).toBe(false);
    expect(isMutatingKind(undefined)).toBe(false);
  });

  it("auto-rejects edit/delete while planning; leaves read alone", () => {
    expect(shouldRejectPermission("edit", active("/p"))).toBe(true);
    expect(shouldRejectPermission("delete", active("/p"))).toBe(true);
    expect(shouldRejectPermission("read", active("/p"))).toBe(false);
    expect(shouldRejectPermission("edit", off("/p"))).toBe(false);
  });

  it("execute: rejects mutating/unknown commands, allows read-only while planning", () => {
    // No command (or missing) → reject (can't prove read-only).
    expect(shouldRejectPermission("execute", active("/p"))).toBe(true);
    expect(shouldRejectPermission("execute", active("/p"), {})).toBe(true);
    expect(shouldRejectPermission("execute", active("/p"), { command: "npm install" })).toBe(true);
    // Read-only exploration (incl. the logo/PWA inspect shape) → do NOT reject.
    expect(shouldRejectPermission("execute", active("/p"), { command: "git status" })).toBe(false);
    expect(shouldRejectPermission("execute", active("/p"), {
      command: "file frontend/public/logo.png && sips -g pixelWidth -g pixelHeight frontend/public/logo.png; ls -la frontend/public",
    })).toBe(false);
    // Gate off → never reject.
    expect(shouldRejectPermission("execute", off("/p"), { command: "rm -rf x" })).toBe(false);
  });

  it("shouldAutoAllowPermission only for read-only execute while planning", () => {
    expect(shouldAutoAllowPermission("execute", active("/p"), { command: "ls -la" })).toBe(true);
    expect(shouldAutoAllowPermission("execute", active("/p"), { command: "npm install" })).toBe(false);
    expect(shouldAutoAllowPermission("edit", active("/p"))).toBe(false);
    expect(shouldAutoAllowPermission("execute", off("/p"), { command: "ls" })).toBe(false);
  });

  it("commandFromPermissionToolCall reads rawInput.command", () => {
    expect(commandFromPermissionToolCall({ rawInput: { command: "git status" } })).toBe("git status");
    expect(commandFromPermissionToolCall({ rawInput: {} })).toBeUndefined();
    expect(commandFromPermissionToolCall(undefined)).toBeUndefined();
  });

  it("notice text clarifies that answering questions is not plan approval", () => {
    expect(PLAN_PERMISSION_BLOCKED_MSG.toLowerCase()).toContain("answering questions is not plan approval");
    expect(PLAN_PERMISSION_BLOCKED_MSG.toLowerCase()).toContain("plan review");
  });

  it("pickRejectOption prefers reject_once, falls back, and bails when none", () => {
    expect(pickRejectOption([
      { optionId: "a", kind: "allow_once" },
      { optionId: "r", kind: "reject_once" },
    ])).toBe("r");
    expect(pickRejectOption([
      { optionId: "x", kind: "allow_always" },
      { optionId: "y", kind: "deny" },
    ])).toBe("y");
    expect(pickRejectOption([{ optionId: "x", kind: "allow_once" }])).toBeUndefined();
    expect(pickRejectOption([])).toBeUndefined();
  });

  it("pickAllowOption prefers allow_always, then allow_once", () => {
    expect(pickAllowOption([
      { optionId: "r", kind: "reject_once" },
      { optionId: "a", kind: "allow_once" },
      { optionId: "aa", kind: "allow_always" },
    ])).toBe("aa");
    expect(pickAllowOption([
      { optionId: "r", kind: "reject_once" },
      { optionId: "a", kind: "allow_once" },
    ])).toBe("a");
    expect(pickAllowOption([{ optionId: "r", kind: "reject_once" }])).toBeUndefined();
  });
});

describe("isReadOnlyCommand — sips + null redirects", () => {
  it("allows property queries (-g) used for PWA icon sizing", () => {
    expect(isReadOnlyCommand("sips -g pixelWidth -g pixelHeight frontend/public/logo.png")).toBe(true);
    // Exact command from a live banking-session plan turn (incl. 2>/dev/null).
    expect(isReadOnlyCommand(
      "file frontend/public/logo.png frontend/public/logo.svg && sips -g pixelWidth -g pixelHeight frontend/public/logo.png 2>/dev/null; ls -la frontend/public/",
    )).toBe(true);
  });

  it("blocks mutating sips forms", () => {
    expect(isReadOnlyCommand("sips -z 192 192 logo.png --out icon-192.png")).toBe(false);
    expect(isReadOnlyCommand("sips -s format jpeg logo.png")).toBe(false);
    expect(isReadOnlyCommand("sips logo.png")).toBe(false); // no -g → not a query
  });

  it("allows >/dev/null noise redirects but still blocks real file redirects", () => {
    expect(isReadOnlyCommand("ls 2>/dev/null")).toBe(true);
    expect(isReadOnlyCommand("git status >/dev/null 2>&1")).toBe(true);
    expect(isReadOnlyCommand("cat secrets > out.txt")).toBe(false);
    expect(isReadOnlyCommand("ls 2>/tmp/err.txt")).toBe(false);
  });
});

describe("isPlanFileWrite", () => {
  it("matches grok's plan.md under .grok/sessions", () => {
    expect(isPlanFileWrite(WIN_PLAN_FILE)).toBe(true);
    expect(isPlanFileWrite("/home/u/.grok/sessions/abc/def/plan.md")).toBe(true);
  });
  it("does not match an ordinary workspace file", () => {
    expect(isPlanFileWrite(WIN_WORKSPACE_WRITE)).toBe(false);
    expect(isPlanFileWrite("/home/u/proj/plan.md")).toBe(false);
  });
});
