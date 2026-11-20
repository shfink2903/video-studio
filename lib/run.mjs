import { spawn } from "node:child_process";

/**
 * Run a command, resolve with { code, stdout, stderr }.
 * Rejects (with the tail of stderr) when the exit code is not 0, unless allowFail.
 */
export function run(cmd, args, { cwd, input, onStdout, onStderr, allowFail = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      onStdout && onStdout(s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      onStderr && onStderr(s);
    });
    child.on("error", (err) => reject(new Error(`Impossible de lancer ${cmd} : ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && !allowFail) {
        const tail = (stderr || stdout).trim().split("\n").slice(-6).join("\n");
        reject(new Error(`${cmd.split("/").pop()} a échoué (code ${code})\n${tail}`));
      } else resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
