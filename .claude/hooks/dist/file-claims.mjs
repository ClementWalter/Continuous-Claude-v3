// src/file-claims.ts
import { readFileSync } from "fs";

// src/shared/db-utils-pg.ts
import { spawnSync } from "child_process";

// src/shared/opc-path.ts
import { existsSync } from "fs";
import { join } from "path";
function getOpcDir() {
  const envOpcDir = process.env.CLAUDE_OPC_DIR;
  if (envOpcDir && existsSync(envOpcDir)) {
    return envOpcDir;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const localOpc = join(projectDir, "opc");
  if (existsSync(localOpc)) {
    return localOpc;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    const globalClaude = join(homeDir, ".claude");
    const globalScripts = join(globalClaude, "scripts", "core");
    if (existsSync(globalScripts)) {
      return globalClaude;
    }
  }
  return null;
}
function requireOpcDir() {
  const opcDir = getOpcDir();
  if (!opcDir) {
    console.log(JSON.stringify({ result: "continue" }));
    process.exit(0);
  }
  return opcDir;
}

// src/shared/db-utils-pg.ts
function log(_operation, _details = {}) {
}
function getPgConnectionString() {
  const envVar = process.env.OPC_POSTGRES_URL ? "OPC_POSTGRES_URL" : process.env.DATABASE_URL ? "DATABASE_URL" : "default";
  const connString = process.env.OPC_POSTGRES_URL || process.env.DATABASE_URL || "postgresql://claude:claude_dev@localhost:5432/continuous_claude";
  const maskedConn = connString.replace(/:([^:@]+)@/, ":***@");
  log("getPgConnectionString", { source: envVar, connection: maskedConn });
  return connString;
}
function runPgQuery(pythonCode, args = []) {
  const opcDir = requireOpcDir();
  const operationMatch = pythonCode.match(
    /async def (\w+)|CREATE TABLE.*?(\w+)|INSERT INTO (\w+)|SELECT.*?FROM (\w+)/i
  );
  const operation = operationMatch?.[1] || operationMatch?.[2] || operationMatch?.[3] || operationMatch?.[4] || "unknown";
  log("runPgQuery:start", {
    operation,
    opcDir,
    argsCount: args.length,
    args: args.map((a) => a.length > 50 ? a.slice(0, 50) + "..." : a)
  });
  const wrappedCode = `
import sys
import os
import asyncio
import json

# Add opc to path for imports
sys.path.insert(0, '${opcDir}')
os.chdir('${opcDir}')

${pythonCode}
`;
  try {
    const connString = getPgConnectionString();
    log("runPgQuery:spawning", {
      command: "uv run python -c <code>",
      cwd: opcDir
    });
    const startTime = Date.now();
    const result = spawnSync(
      "uv",
      ["run", "python", "-c", wrappedCode, ...args],
      {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        cwd: opcDir,
        env: {
          ...process.env,
          OPC_POSTGRES_URL: connString
        }
      }
    );
    const duration = Date.now() - startTime;
    const queryResult = {
      success: result.status === 0,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr || ""
    };
    log("runPgQuery:complete", {
      operation,
      success: queryResult.success,
      exitCode: result.status,
      durationMs: duration,
      stdoutLength: queryResult.stdout.length,
      stderrLength: queryResult.stderr.length,
      ...queryResult.stderr && { stderr: queryResult.stderr.slice(0, 200) }
    });
    return queryResult;
  } catch (err) {
    log("runPgQuery:error", {
      operation,
      error: String(err)
    });
    return {
      success: false,
      stdout: "",
      stderr: String(err)
    };
  }
}
function checkFileClaim(filePath, project, mySessionId) {
  const pythonCode = `
import asyncpg
import os
import json

file_path = sys.argv[1]
project = sys.argv[2]
my_session_id = sys.argv[3]
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Create table if not exists
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS file_claims (
                file_path TEXT,
                project TEXT,
                session_id TEXT,
                claimed_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (file_path, project)
            )
        ''')

        row = await conn.fetchrow('''
            SELECT session_id, claimed_at FROM file_claims
            WHERE file_path = $1 AND project = $2 AND session_id != $3
        ''', file_path, project, my_session_id)

        if row:
            print(json.dumps({
                'claimed': True,
                'claimedBy': row['session_id'],
                'claimedAt': row['claimed_at'].isoformat() if row['claimed_at'] else None
            }))
        else:
            print(json.dumps({'claimed': False}))
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [filePath, project, mySessionId]);
  if (!result.success) {
    return { claimed: false };
  }
  try {
    return JSON.parse(result.stdout || '{"claimed": false}');
  } catch {
    return { claimed: false };
  }
}
function claimFile(filePath, project, sessionId) {
  const pythonCode = `
import asyncpg
import os

file_path = sys.argv[1]
project = sys.argv[2]
session_id = sys.argv[3]
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        await conn.execute('''
            INSERT INTO file_claims (file_path, project, session_id, claimed_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (file_path, project) DO UPDATE SET
                session_id = EXCLUDED.session_id,
                claimed_at = NOW()
        ''', file_path, project, session_id)
        print('ok')
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [filePath, project, sessionId]);
  return { success: result.success && result.stdout === "ok" };
}

// src/file-claims.ts
function getSessionId() {
  return process.env.COORDINATION_SESSION_ID || process.env.BRAINTRUST_SPAN_ID?.slice(0, 8) || `s-${Date.now().toString(36)}`;
}
function getProject() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function main() {
  let input;
  try {
    const stdinContent = readFileSync(0, "utf-8");
    input = JSON.parse(stdinContent);
  } catch {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  if (input.tool_name !== "Edit") {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const filePath = input.tool_input?.file_path;
  if (!filePath) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const sessionId = getSessionId();
  const project = getProject();
  const claimCheck = checkFileClaim(filePath, project, sessionId);
  let output;
  if (claimCheck.claimed) {
    const fileName = filePath.split("/").pop() || filePath;
    output = {
      result: "continue",
      // Allow edit, just warn
      message: `\u26A0\uFE0F **File Conflict Warning**
\`${fileName}\` is being edited by Session ${claimCheck.claimedBy}
Consider coordinating with the other session to avoid conflicts.`
    };
  } else {
    claimFile(filePath, project, sessionId);
    output = { result: "continue" };
  }
  console.log(JSON.stringify(output));
}
main();
export {
  main
};
