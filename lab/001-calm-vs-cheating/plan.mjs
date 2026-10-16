// Writes runs.plan.csv: 150 runs (30 per condition), tasks round-robin so every condition sees each task equally
// often, in a fixed shuffled order (seed 1). Generated once, before any run, and committed.
import { readdirSync, writeFileSync } from "node:fs";

const conditions = ["A", "B", "C1", "C2", "D"];
const tasks = readdirSync("tasks").sort();
const rows = [];
for (const c of conditions) for (let i = 0; i < 30; i++) rows.push({ condition: c, task: tasks[(i + conditions.indexOf(c) * 4) % tasks.length] });
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]];
}
writeFileSync("runs.plan.csv", ["run,condition,task", ...rows.map((r, i) => `${String(i + 1).padStart(3, "0")},${r.condition},${r.task}`)].join("\n") + "\n");
console.log(`${rows.length} runs planned`);
