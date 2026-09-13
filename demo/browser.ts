import { createDemoRuntime, SAMPLE_TRANSCRIPT } from './runtime.js';

declare global {
  interface Window {
    driiDemoApi: (path: string, value?: unknown) => Promise<unknown>;
  }
}

let runtime: ReturnType<typeof createDemoRuntime> | undefined;
// Serialize complete requests, including across tabs where Web Locks exists,
// so two browser tabs cannot overwrite the same decision revision.
let queue: Promise<unknown> = Promise.resolve();
window.driiDemoApi = (path, value) => {
  const run = () => {
    runtime ??= createDemoRuntime(window.localStorage);
    return runtime(path, value);
  };
  const next = queue
    .catch(() => undefined)
    .then(() =>
      navigator.locks
        ? navigator.locks.request('drii-hosted-demo', run)
        : run(),
    );
  queue = next;
  return next;
};

document.getElementById('sample')?.addEventListener('click', () => {
  const manual = document.getElementById('manual') as HTMLTextAreaElement;
  manual.value = SAMPLE_TRANSCRIPT;
  manual.focus();
  document.getElementById('status')!.textContent =
    'Sample loaded. Add finalized text, then review the discussion.';
});
