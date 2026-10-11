const MAX_WORKERS = 4;

const originalArgv = process.argv;
const maxWorkersFlag = "--maxWorkers";
const maxWorkersEquals = /^--maxWorkers=(\d+)$/u;
const isVitestEntry = originalArgv.some((argument) =>
  argument === "vitest" || /(?:^|[/\\])vitest(?:\.m?js)?$/u.test(argument),
);

if (isVitestEntry) {
  const argv = [...originalArgv];
  let foundMaxWorkers = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equalsMatch = maxWorkersEquals.exec(argument);
    if (equalsMatch) {
      const requested = Number.parseInt(equalsMatch[1], 10);
      argv[index] = `--maxWorkers=${Math.min(requested, MAX_WORKERS)}`;
      foundMaxWorkers = true;
      continue;
    }
    if (argument === maxWorkersFlag) {
      const requested = Number.parseInt(argv[index + 1] ?? String(MAX_WORKERS), 10);
      argv[index + 1] = String(Math.min(requested, MAX_WORKERS));
      foundMaxWorkers = true;
    }
  }
  if (!foundMaxWorkers) {
    argv.splice(2, 0, `${maxWorkersFlag}=${MAX_WORKERS}`);
  }
  process.argv = argv;
}
