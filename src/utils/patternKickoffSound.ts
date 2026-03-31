/** Short celebratory chime on user-initiated pattern generation (Web Audio API). */
export function playPatternKickoffChime(): void {
  if (typeof window === 'undefined') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return

  const ctx = new Ctor()
  const resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
  void resume.then(() => {
    const t0 = ctx.currentTime
    // Light major arpeggio — soft, “magpie sparkle”
    const notes = [
      { freq: 392.0, at: 0, d: 0.28, vol: 0.055 },
      { freq: 493.88, at: 0.06, d: 0.32, vol: 0.065 },
      { freq: 587.33, at: 0.12, d: 0.38, vol: 0.052 },
      { freq: 783.99, at: 0.2, d: 0.42, vol: 0.038 },
    ]

    for (const { freq, at, d, vol } of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 2800
      filter.Q.value = 0.7
      osc.connect(gain)
      gain.connect(filter)
      filter.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = t0 + at
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(vol, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0008, start + d)
      osc.start(start)
      osc.stop(start + d + 0.05)
    }

    window.setTimeout(() => {
      void ctx.close()
    }, 900)
  })
}
