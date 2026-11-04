import { describe, expect, it } from 'vitest';
import { runProcess } from '../electron/main/downloader';

describe('external tool process lifecycle', () => {
  it('passes shell syntax as a literal argument and captures streamed lines', async () => {
    const literal = '$(touch unsafe) & echo "hello"';
    const lines: string[] = [];
    const result = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1]); console.error("diagnostic")', literal], { onLine: line => lines.push(line) });
    expect(result.stdout.trim()).toBe(literal);
    expect(lines).toEqual([literal]);
    expect(result.stderr.trim()).toBe('diagnostic');
  });
  it('rejects process failures with a useful diagnostic', async () => {
    await expect(runProcess(process.execPath, ['-e', 'console.error("fixture failure");process.exit(7)'])).rejects.toThrow('fixture failure');
  });
  it('stops a running process on cancellation', async () => {
    const controller = new AbortController();
    const promise = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(promise).rejects.toThrow('Đã hủy');
  });
  it('rejects an already cancelled job before spawning', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runProcess('missing-tool', [], { signal: controller.signal })).rejects.toThrow('Đã hủy');
  });
  it('times out hung tools', async () => {
    await expect(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 })).rejects.toThrow('quá thời gian');
  });
});
