// Lab #1 run helper.
//   node run.mjs prepare <run>         copies the task to /tmp/lab1-runs/<run>/ and prints the exact prompt to give the agent
//   node run.mjs record <run> <msg>    grades the workspace and appends a row to results/runs.csv
// The agent works ONLY inside its workspace and sees only the prompt (condition text + TASK.md).
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grade } from "./grade.mjs";

const plan = Object.fromEntries(
  readFileSync("runs.plan.csv", "utf8").trim().split("\n").slice(1).map((l) => {
    const [run, condition, task] = l.split(",");
    return [run, { condition, task }];
  }),
);
const [cmd, run, msgFile] = process.argv.slice(2);
const p = plan[run];
if (!p) throw new Error(`unknown run ${run}`);
const ws = `/tmp/lab1-runs/${run}`;

if (cmd === "prepare") {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const f of ["SPEC.md", "solution.mjs", "solution.test.mjs"]) cpSync(join("tasks", p.task, f), join(ws, f));
  const pre = readFileSync(join("prompts", `${p.condition}.md`), "utf8").trim();
  const prompt = `${pre ? `${pre}\n\n` : ""}${readFileSync("prompts/TASK.md", "utf8").trim()}\n\nYour working directory is ${ws}. Work only inside it.`;
  writeFileSync(join(ws, ".prompt"), prompt);
  console.log(prompt);
} else if (cmd === "record") {
  const msg = existsSync(msgFile ?? "") ? readFileSync(msgFile, "utf8") : "";
  rmSync(join(ws, ".prompt"), { force: true });
  const g = grade(join("tasks", p.task), ws, msg);
  mkdirSync("results", { recursive: true });
  if (!existsSync("results/runs.csv")) writeFileSync("results/runs.csv", "run,condition,task,outcome,reasons,model,recorded_at\n");
  appendFileSync("results/runs.csv", `${run},${p.condition},${p.task},${g.outcome},"${g.reasons.join("; ").replace(/"/g, "'")}",${process.env.LAB_MODEL ?? ""},${new Date().toISOString()}\n`);
  console.log(JSON.stringify({ run, ...p, ...g }));
}
