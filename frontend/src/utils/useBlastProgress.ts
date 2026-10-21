import { useEffect, useRef, useState } from 'react';

/** A BLAST run's progress bar: NCBI reports no progress, so after
 * `start()` it creeps towards 95% (~2 minutes) until `finish()`. */
export function useBlastProgress() {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  return {
    progress,
    start() {
      stop();
      setProgress(0);
      timer.current = setInterval(() => setProgress((p) => Math.min(p + 1, 95)), 1200);
    },
    finish() {
      stop();
      setProgress(100);
    },
  };
}
