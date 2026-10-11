const MAX_WORKERS = 4;

const originalArgv = process.argv;
const maxWorkersFlag = "--maxWorkers";
const maxWorkersValue = /^\d+(?:\.\d+)?%?$/u;
const isVitestEntry = originalArgv.some((argument) =>
  argument === "vitest" || /(?:^|[/\\])vitest(?:\.m?js)?$/u.test(argument),
);

if (isVitestEntry) {
  const argv = [];
  for (let index = 0; index < originalArgv.length; index += 1) {
    const argument = originalArgv[index];
    if (argument === maxWorkersFlag) {
      if (maxWorkersValue.test(originalArgv[index + 1] ?? "")) index += 1;
      continue;
    }
    if (argument.startsWith(`${maxWorkersFlag}=`)) continue;
    argv.push(argument);
  }
  argv.splice(2, 0, `${maxWorkersFlag}=${MAX_WORKERS}`);
  process.argv = argv;
}
