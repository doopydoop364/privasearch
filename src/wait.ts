/** Wait for work, a deadline, or shutdown; release the losing timer/listener. */
export async function waitForWake(work: Iterable<Promise<unknown>>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: () => void = () => {};
  const timeout = new Promise<void>(resolve => {
    wake = resolve;
    timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', wake, { once: true });
  });
  try { await Promise.race([...work, timeout]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', wake); }
}
