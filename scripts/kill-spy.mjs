import { appendFileSync } from "node:fs";

const kill = process.kill.bind(process);
process.kill = (pid, signal = "SIGTERM") => {
  if (Number(pid) === process.pid) return kill(pid, signal);
  appendFileSync(process.env.SAGE_TEST_KILLS, `${pid} ${signal}\n`);
  return true;
};
