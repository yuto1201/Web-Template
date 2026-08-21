"use client";

export default function DeliberateClientLeak() {
  function revealCanary() {
    document.body.dataset.deliberateClientLeak = process.env.NEXT_PUBLIC_LEAK_CANARY;
  }

  return <button onClick={revealCanary}>Client positive control</button>;
}
