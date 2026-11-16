import React, { useEffect, useRef } from 'react'
import {
  EditorProvider, Timeline, useTimelineEngine, useTracksStore, usePlaybackStore,
  useSelectionStore, splitClipAtPlayhead,
} from '@elah/editor'
import '@elah/timeline/styles.css'
import '@elah/editor/styles.css'
import '@elah/editor/styles/tokens.css'
import './island.css'

const FPS = 30

// ── BRIDGE ───────────────────────────────────────────────────────────────────
// Vanilla side (index.html) exposes window.__inkTimeline:
//   snapshot() -> {tracks:[{name,kind}], clips:[{id,track,type,startSec,durSec,name,src}]}
//                 `id` is the vanilla cut id (a "ref"); the engine mints its own
//                 clip ids, so this side keeps a ref↔clip map.
//   apply(clips)   — timeline edits land back in the project's cuts[];
//                    returns [{clipId, refId}] for clips the vanilla side
//                    adopted (split right-halves) so the map stays complete.
//   seek(sec)      — scrub from the timeline ruler
//   isPlaying()    — guard so the playback clock isn't echoed back on itself
// This component exposes window.__elahPush { resync, seek, zoomFit } and pushes
// engine changes back.
function Bridge({ tlRef }) {
  const engine = useTimelineEngine()

  useEffect(() => {
    if (!engine) return

    // ref ↔ engine-clip-id maps (engine ids are minted internally)
    const byRef = new Map()   // refId (vanilla cut id as string) -> clipId
    const byClip = new Map()  // clipId -> refId
    const setMap = (refId, clipId) => {
      byRef.set(String(refId), clipId)
      byClip.set(clipId, String(refId))
    }

    const trackOfClip = (clipId) => {
      const hit = engine.findClip(clipId)
      if (hit && hit.trackId) return hit.trackId
      for (const t of useTracksStore.getState().tracks) {
        if (engine.getClipsOnTrack(t.id)?.some(c => c.id === clipId)) return t.id
      }
      return null
    }

    const collectClips = () => {
      const out = []
      for (const tr of useTracksStore.getState().tracks) {
        for (const c of (engine.getClipsOnTrack(tr.id) || [])) {
          out.push({
            id: byClip.get(c.id) || c.id,   // ref id when mapped, engine id otherwise
            engineId: c.id,
            track: tr.name, type: c.type,
            startSec: c.startFrame / FPS, durSec: c.durationFrames / FPS,
            name: c.name || '',
          })
        }
      }
      return out
    }

    // diff the engine against a snapshot from the vanilla side (one undo step)
    let lastResyncRev = -1
    try { window.__elahDbgLog = [] } catch (e) {}
    const dbg = (m) => {
      try { window.__elahDbgLog.push((performance.now() / 1000).toFixed(2) + ' ' + m) } catch (e) {}
      try { console.debug('[elah]', m) } catch (e) {}
    }
    const applySnapshot = (snap) => {
      dbg('resync in: ' + (snap.clips || []).map(c => c.id + '@' + (+c.startSec.toFixed(2)) + '+' + (+c.durSec.toFixed(2))).join(' | '))
      try {
        const wantTracks = snap.tracks || []
        const wantById = new Map((snap.clips || []).map(c => [String(c.id), c]))
        engine.batch(() => {
          // 1. remove engine clips the snapshot no longer contains
          for (const live of collectClips()) {
            if (!wantById.has(String(live.id))) {
              dbg('remove stale: ' + String(live.id))
              const tid = trackOfClip(live.engineId)
              if (tid) { try { engine.removeClip(live.engineId, tid) } catch (e) {} }
            }
          }
          // 2. track diff (by name) — remove extras, add missing
          const tss = useTracksStore.getState().tracks
          for (const t of tss) {
            if (!wantTracks.some(w => w.name === t.name)) {
              try { engine.removeTrack(t.id) } catch (e) { /* non-empty; ignore */ }
            }
          }
          for (const w of wantTracks) {
            if (!useTracksStore.getState().tracks.some(t => t.name === w.name)) {
              try { engine.addTrack(w.kind || 'video', { name: w.name, protected: true }) } catch (e) {}
            }
          }
          // 3. add/update snapshot clips (idempotent: recreate on any mismatch,
          //    and clear stale overlapping clips before adding)
          const addedNow = new Set()
          for (const w of (snap.clips || [])) {
            const ref = String(w.id)
            const tr = useTracksStore.getState().tracks.find(t => t.name === w.track)
            if (!tr) continue
            // frame mapping rounds ENDPOINTS (not each duration) so adjacent
            // cuts stay contiguous — independent rounding creates 1-frame overlaps
            const sf = Math.round(w.startSec * FPS)
            const f1 = Math.round((w.startSec + w.durSec) * FPS)
            const df = Math.max(1, f1 - sf)
            const mkOpts = () => ({
              type: w.type === 'audio' ? 'audio' : 'image',
              trackId: tr.id, startFrame: sf, durationFrames: df,
              name: w.name || '', src: w.src || 'data:,',
            })
            const addOne = () => {
              const created = engine.addClip(mkOpts())
              if (created && created.id) { setMap(ref, created.id); addedNow.add(ref) }
            }
            const mapped = byRef.get(ref)
            if (mapped && engine.findClip(mapped)) {
              const found = engine.findClip(mapped)
              const clip = found.clip
              if (found.trackId === tr.id && clip.startFrame === sf && clip.durationFrames === df) continue
              // timing or track changed on our side — recreate cleanly
              dbg('recreate: ' + ref + ' (had ' + clip.startFrame + '+' + clip.durationFrames + ' want ' + sf + '+' + df + ')')
              try { engine.removeClip(mapped, found.trackId) } catch (e) {}
              byRef.delete(ref); byClip.delete(mapped)
            }
            try {
              addOne()
              dbg('added: ' + ref)
            } catch (e) {
              // a stale clip (e.g. from a previous project) blocks this span —
              // clear everything overlapping on this track, then retry once
              let cleared = false
              for (const live of collectClips()) {
                if (live.track !== w.track || addedNow.has(String(live.id))) continue
                const ls = Math.round(live.startSec * FPS)
                const le = ls + Math.max(1, Math.round(live.durSec * FPS))
                if (ls < sf + df && le > sf) {
                  const tid = trackOfClip(live.engineId)
                  if (tid) {
                    try {
                      engine.removeClip(live.engineId, tid)
                      const staleRef = byClip.get(live.engineId)
                      if (staleRef) { byRef.delete(staleRef); byClip.delete(live.engineId) }
                      cleared = true
                      dbg('overlap-clear: ' + String(live.id))
                    } catch (e2) {}
                  }
                }
              }
              if (cleared) {
                try { addOne() } catch (e2) { console.warn('addClip failed after clear', ref, e2) }
              } else {
                console.warn('addClip failed', ref, e)
              }
            }
          }
        }, 'Sync timeline')
      } catch (e) { console.error('elah resync failed', e) }
      // everything the engine just committed belonged to this resync — the
      // debounced echoes of those changes must NOT be pushed back to vanilla
      lastResyncRev = engine._revision ?? -1
    }

    window.__elahPush = {
      resync: applySnapshot,
      seek: (sec) => {
        const f = Math.round(sec * FPS)
        const pb = usePlaybackStore.getState()
        if (pb.currentFrame !== f) { try { pb.setCurrentFrame(f) } catch (e) {} }
      },
      zoomFit: () => { try { tlRef.current?.fitToWindow?.() } catch (e) {} },
    }

    // Keep the white play line centered in the strip: during autoplay (and when
    // the vanilla ◀ ▶ nudge buttons move the play line) the lane scrolls left
    // under the needle at whatever pace the play line moves. Mouse scrubs are
    // never hijacked — vanilla only calls this while playing or on nudges.
    window.__elahCenter = () => {
      try {
        const root = document.querySelector('#elah-mount [data-elah-timeline-root]')
        if (!root) return
        const sc = [...root.children].find(c => c.tagName === 'DIV' && c.style.overflow === 'auto')
        if (!sc) return
        const pb = usePlaybackStore.getState()
        const sidebar = 110                      // island sidebarWidth (matches <Timeline sidebarWidth>)
        const laneW = sc.clientWidth - sidebar   // visible lane area
        if (laneW <= 0) return
        // center of the lane in viewport coords; the sidebar term cancels out:
        // scrollLeft = (sidebar + f·zoom) − (sidebar + laneW/2)
        const target = Math.round(pb.currentFrame * pb.zoom - laneW / 2)
        const max = sc.scrollWidth - sc.clientWidth
        const clamped = Math.max(0, Math.min(target, max))
        if (Math.abs(sc.scrollLeft - clamped) > 1) sc.scrollLeft = clamped
      } catch (e) {}
    }

    // debug/automation hook (also used by tests)
    window.__elahDebug = {
      engine: () => engine,
      clips: () => collectClips(),
      selectRef: (refId) => {
        const clipId = byRef.get(String(refId))
        if (!clipId) return false
        try { useSelectionStore.getState().selectClip(clipId) } catch (e) { return false }
        return true
      },
      selection: () => [...useSelectionStore.getState().selectedClipIds],
      split: () => {
        try { return splitClipAtPlayhead(engine) } catch (e) { return { ok: false, reason: String(e) } }
      },
    }

    // initial data — vanilla may still be loading the project; poll briefly
    let n = 0
    const boot = setInterval(() => {
      const snap = window.__inkTimeline && window.__inkTimeline.snapshot && window.__inkTimeline.snapshot()
      if (snap || ++n > 40) {
        clearInterval(boot)
        if (snap && snap.clips && snap.clips.length) applySnapshot(snap)
        window.__elahReady = true
        window.dispatchEvent(new Event('elah-ready'))
        try { tlRef.current?.fitToWindow?.() } catch (e) {}
      }
    }, 250)

    // engine edits → vanilla cuts (with remapping for adopted new clips)
    let t = null
    const onChange = () => {
      const rev = engine._revision ?? -1
      clearTimeout(t)
      t = setTimeout(() => {
        const gate = rev <= lastResyncRev ? 'GATED' : 'push'
        dbg('change rev=' + rev + ' lastResync=' + lastResyncRev + ' -> ' + gate + ' clips=' + collectClips().map(c => c.id).join(','))
        if (rev <= lastResyncRev) return
        try {
          const clips = collectClips()
          const remap = (window.__inkTimeline && window.__inkTimeline.apply && window.__inkTimeline.apply(clips)) || []
          for (const r of remap) { if (r && r.clipId && r.refId) setMap(r.refId, r.clipId) }
        } catch (e) { console.error('island → vanilla failed', e) }
      }, 80)
    }
    engine.on('change', onChange)

    // scrub on the ruler (paused) → move the vanilla playhead; the playback
    // clock never echoes back because vanilla guards with isPlaying()
    const unsub = usePlaybackStore.subscribe((s, prev) => {
      if (s.currentFrame !== prev.currentFrame) {
        const playing = window.__inkTimeline && window.__inkTimeline.isPlaying && window.__inkTimeline.isPlaying()
        if (!playing) {
          try { window.__inkTimeline && window.__inkTimeline.seek && window.__inkTimeline.seek(s.currentFrame / FPS) } catch (e) {}
        }
      }
    })

    return () => {
      clearInterval(boot); clearTimeout(t)
      try { engine.off('change', onChange) } catch (e) {}
      try { unsub() } catch (e) {}
    }
  }, [engine])

  return null
}

// ── TOOLBAR ──────────────────────────────────────────────────────────────────
function Toolbar({ tlRef }) {
  const engine = useTimelineEngine()
  const canUndo = useTracksStore(s => s.canUndo)
  const canRedo = useTracksStore(s => s.canRedo)
  const selSize = useSelectionStore(s => s.selectedClipIds.size)
  const zoom = usePlaybackStore(s => s.zoom)

  const split = () => {
    try {
      const r = splitClipAtPlayhead(engine)
      if (!r || !r.ok) console.warn('split failed:', r && r.reason)
    } catch (e) { console.error(e) }
  }
  const del = () => {
    const sel = useSelectionStore.getState().selectedClipIds
    if (!sel.size) return
    engine.batch(() => {
      for (const id of sel) {
        const tid = trackOfClipId(id)
        if (tid) { try { engine.removeClip(id, tid) } catch (e) {} }
      }
    }, 'Delete clips')
  }
  const trackOfClipId = (clipId) => {
    const hit = engine.findClip(clipId)
    if (hit && hit.trackId) return hit.trackId
    for (const t of useTracksStore.getState().tracks) {
      if (engine.getClipsOnTrack(t.id)?.some(c => c.id === clipId)) return t.id
    }
    return null
  }
  const zoomBy = (f) => { try { tlRef.current?.zoomAtAnchor?.(zoom * f) } catch (e) {} }

  return (
    <div className="elah-toolbar">
      <button title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => engine.undo()}>↩</button>
      <button title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => engine.redo()}>↪</button>
      <span className="elah-sep" />
      <button title="Split the selected clip at the play line" disabled={selSize !== 1} onClick={split}>✂ Split</button>
      <button title="Delete the selected clip" disabled={!selSize} onClick={del}>🗑 Delete</button>
      <span className="elah-sep" />
      <button title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>−</button>
      <button title="Zoom in" onClick={() => zoomBy(1.3)}>＋</button>
      <button title="Fit the whole project" onClick={() => tlRef.current?.fitToWindow?.()}>⊡ Fit</button>
      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--elah-text-muted, #7e7996)' }}>
        drag to move · drag an edge to trim · select a clip, park the play line, press Split
      </span>
    </div>
  )
}

// ── ROOT ─────────────────────────────────────────────────────────────────────
export default function Island() {
  const tlRef = useRef(null)
  const stage = (window.__inkTimeline && window.__inkTimeline.stage && window.__inkTimeline.stage()) || { width: 1280, height: 720 }

  return (
    <EditorProvider
      fps={FPS}
      stage={{ width: stage.width || 1280, height: stage.height || 720 }}
      maxHistorySize={100}
      defaultTrackHeight={34}
      initialTracks={[
        { kind: 'video', name: 'Scenes', protected: true },
        { kind: 'audio', name: 'Voiceover', protected: true },
        { kind: 'audio', name: 'Recordings', protected: true },
        { kind: 'audio', name: 'Music', protected: true },
      ]}
    >
      <div className="elah-root elah-ink">
        <Bridge tlRef={tlRef} />
        <Toolbar tlRef={tlRef} />
        <Timeline ref={tlRef} fps={FPS} sidebarWidth={110} compactSidebar={true} style={{ height: '100%' }} />
      </div>
    </EditorProvider>
  )
}
