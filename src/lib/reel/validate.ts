import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_WASABI_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const REEL_ROOT = join(TOOL_WASABI_ROOT, 'reel');

export type ValidateScriptResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Validate script.json via reel CLI — avoids importing Remotion/Zod schema in Next. */
export function validateReelScriptPath(
  scriptPath: string,
): Promise<ValidateScriptResult> {
  const abs = resolve(scriptPath);
  return new Promise((res) => {
    const child = spawn(
      'pnpm',
      ['exec', 'tsx', 'scripts/validate-script.ts', abs],
      {
        cwd: REEL_ROOT,
        env: process.env,
        shell: process.platform === 'win32',
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      res({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
      });
    });
    child.on('error', (err) => {
      res({
        ok: false,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
      });
    });
  });
}
