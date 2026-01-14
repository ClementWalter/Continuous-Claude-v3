// src/session-register.ts
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
function registerSession(sessionId, project, workingOn = "") {
  log("registerSession:start", {
    sessionId,
    project,
    workingOn: workingOn || "(empty)"
  });
  const pythonCode = `
import asyncpg
import os
from datetime import datetime

session_id = sys.argv[1]
project = sys.argv[2]
working_on = sys.argv[3] if len(sys.argv) > 3 else ''
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Create table if not exists
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                working_on TEXT,
                started_at TIMESTAMP DEFAULT NOW(),
                last_heartbeat TIMESTAMP DEFAULT NOW()
            )
        ''')

        # Upsert session
        await conn.execute('''
            INSERT INTO sessions (id, project, working_on, started_at, last_heartbeat)
            VALUES ($1, $2, $3, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
                working_on = EXCLUDED.working_on,
                last_heartbeat = NOW()
        ''', session_id, project, working_on)

        print('ok')
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [sessionId, project, workingOn]);
  if (!result.success || result.stdout !== "ok") {
    const error = result.stderr || result.stdout || "Unknown error";
    log("registerSession:failed", { sessionId, error });
    return {
      success: false,
      error
    };
  }
  log("registerSession:success", { sessionId });
  return { success: true };
}
function getActiveSessions(project) {
  log("getActiveSessions:start", { project: project || "(all projects)" });
  const pythonCode = `
import asyncpg
import os
import json
from datetime import datetime, timedelta

project_filter = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'null' else None
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Get sessions active in last 5 minutes
        cutoff = datetime.utcnow() - timedelta(minutes=5)

        if project_filter:
            rows = await conn.fetch('''
                SELECT id, project, working_on, started_at, last_heartbeat
                FROM sessions
                WHERE project = $1 AND last_heartbeat > $2
                ORDER BY started_at DESC
            ''', project_filter, cutoff)
        else:
            rows = await conn.fetch('''
                SELECT id, project, working_on, started_at, last_heartbeat
                FROM sessions
                WHERE last_heartbeat > $1
                ORDER BY started_at DESC
            ''', cutoff)

        sessions = []
        for row in rows:
            sessions.append({
                'id': row['id'],
                'project': row['project'],
                'working_on': row['working_on'],
                'started_at': row['started_at'].isoformat() if row['started_at'] else None,
                'last_heartbeat': row['last_heartbeat'].isoformat() if row['last_heartbeat'] else None
            })

        print(json.dumps(sessions))
    except Exception as e:
        print(json.dumps([]))
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [project || "null"]);
  if (!result.success) {
    log("getActiveSessions:failed", {
      project: project || "(all)",
      error: result.stderr
    });
    return { success: false, sessions: [] };
  }
  try {
    const sessions = JSON.parse(result.stdout || "[]");
    log("getActiveSessions:success", {
      project: project || "(all)",
      sessionCount: sessions.length,
      sessionIds: sessions.map((s) => s.id)
    });
    return { success: true, sessions };
  } catch (e) {
    log("getActiveSessions:parseError", {
      project: project || "(all)",
      error: String(e),
      stdout: result.stdout
    });
    return { success: false, sessions: [] };
  }
}

// src/session-register.ts
function log2(_operation, _details = {}) {
}
function getSessionId() {
  const spanId = process.env.BRAINTRUST_SPAN_ID;
  if (spanId) {
    return spanId.slice(0, 8);
  }
  return `s-${Date.now().toString(36)}`;
}
function getProject() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function main() {
  log2("main:start", { pid: process.pid });
  let input;
  try {
    const stdinContent = readFileSync(0, "utf-8");
    input = JSON.parse(stdinContent);
    log2("main:inputParsed", { inputKeys: Object.keys(input) });
  } catch (e) {
    log2("main:inputError", { error: String(e) });
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const sessionId = getSessionId();
  const project = getProject();
  const projectName = project.split("/").pop() || "unknown";
  log2("main:sessionInfo", { sessionId, project, projectName });
  process.env.COORDINATION_SESSION_ID = sessionId;
  log2("main:registeringSession", { sessionId, project });
  const registerResult = registerSession(sessionId, project, "");
  log2("main:registerResult", {
    success: registerResult.success,
    error: registerResult.error
  });
  log2("main:fetchingActiveSessions", { project });
  const sessionsResult = getActiveSessions(project);
  const otherSessions = sessionsResult.sessions.filter(
    (s) => s.id !== sessionId
  );
  log2("main:activeSessions", {
    total: sessionsResult.sessions.length,
    others: otherSessions.length,
    otherIds: otherSessions.map((s) => s.id)
  });
  let awarenessMessage = `
<system-reminder>
MULTI-SESSION COORDINATION ACTIVE

Session: ${sessionId}
Project: ${projectName}
`;
  if (otherSessions.length > 0) {
    awarenessMessage += `
Active peer sessions (${otherSessions.length}):
${otherSessions.map((s) => `  - ${s.id}: ${s.working_on || "working..."}`).join("\n")}

Coordination features:
- File edits are tracked to prevent conflicts
- Research findings are shared automatically
- Use Task tool normally - coordination happens via hooks
`;
  } else {
    awarenessMessage += `
No other sessions active on this project.
You are the only session currently working here.
`;
  }
  awarenessMessage += `</system-reminder>`;
  const output = {
    result: "continue",
    message: awarenessMessage
  };
  log2("main:complete", {
    sessionId,
    otherSessionsCount: otherSessions.length,
    messageLength: awarenessMessage.length
  });
  console.log(JSON.stringify(output));
}
main();
export {
  main
};
