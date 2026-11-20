import { run } from "./run.mjs";
import { BIN, CLAUDE_MODEL } from "./config.mjs";

/**
 * Ask Claude (through the local Claude Code CLI) for a JSON answer that matches `schema`.
 * Throws a readable error when the CLI is missing, not logged in, or returns invalid JSON.
 * No silent fallback: the caller decides what to show.
 */
export async function askJSON(prompt, schema) {
  const args = [
    "-p",
    "--model", CLAUDE_MODEL,
    "--tools", "",
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--json-schema", JSON.stringify(schema),
  ];
  const { stdout } = await run(BIN.claude, args, { input: prompt, allowFail: true });
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error("Claude n'a pas répondu (sortie illisible du CLI).");
  }
  if (envelope.is_error) {
    const msg = String(envelope.result || envelope.terminal_reason || "erreur inconnue");
    if (/log ?in/i.test(msg)) throw new Error("Claude n'est pas connecté sur ce Mac. Lance `claude` dans un terminal et fais /login.");
    throw new Error("Claude a renvoyé une erreur : " + msg);
  }
  const out = envelope.structured_output ?? envelope.result;
  if (out && typeof out === "object") return out;
  try {
    const text = String(out).trim().replace(/^```(json)?/, "").replace(/```$/, "");
    return JSON.parse(text);
  } catch {
    throw new Error("Claude a répondu dans un format inattendu.");
  }
}
