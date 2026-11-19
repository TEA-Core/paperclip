import { EventEmitter } from "node:events";

type ExecFileMock = (
  file: string,
  args: string[],
  options: unknown,
  callback: (error: Error | null, stdout?: string) => void,
) => void;

/**
 * A `spawn` stand-in answered by a callback-style `execFile` mock. The guard's
 * git probes run through `runHardenedGit`, which spawns; a suite that stubs git
 * with an `execFile` mock must stub `spawn` the same way or the probes reach the
 * real process runner and fail open.
 */
export function spawnFromExecFile(execFile: ExecFileMock) {
  return (file: string, args: string[], options: unknown) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { end: () => {} }),
    });
    // Listeners attach after spawn returns, so answer on the next tick.
    setImmediate(() =>
      execFile(file, args, options, (error, stdout = "") => {
        if (error) {
          child.emit("close", 1);
          return;
        }
        child.stdout.emit("data", Buffer.from(stdout));
        child.emit("close", 0);
      }),
    );
    return child;
  };
}
