// Allow React's committed layout to settle before exposing the native window.
export function scheduleWindowReveal(reveal: () => void): () => void {
  let finished = false;
  let frame = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    reveal();
  };
  // Hidden WebViews may throttle or suspend requestAnimationFrame entirely.
  const timer = setTimeout(finish, 200);
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(finish);
  });
  return () => {
    finished = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}
