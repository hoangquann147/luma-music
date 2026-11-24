import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativePlaybackCommand, NativePlaybackState, Track } from '../../shared/types';
import { defaultEqualizer, effectivePreampDb as calculatePreamp, loadEqualizer, normalizeEqualizer, saveEqualizer, type EqualizerSettings } from '../audio/equalizer';
import { useBrowserPlayer } from './useBrowserPlayer';

const nativeBackend = '__TAURI_INTERNALS__' in window;
const initialState: NativePlaybackState = {
  shuffle: false, repeatMode: 'off',
  playing: false, position: 0, duration: 0, volume: .7, queueIds: [],
  requestedMode: 'shared', outputMode: 'shared', bitPerfect: false,
  sampleRate: 0, bitsPerSample: 0, channels: 0, crossfading: false,
};

function useNativePlayer(tracks: Track[], onError: (message: string) => void) {
  const [state, setState] = useState<NativePlaybackState>(initialState);
  const [equalizer, setEqualizerState] = useState<EqualizerSettings>(loadEqualizer);
  const [queueIds, setQueueIds] = useState<string[] | null>(null);
  const tracksRef = useRef(tracks); tracksRef.current = tracks;
  const queueRef = useRef<string[] | null>(null);
  const equalizerRef = useRef(equalizer); equalizerRef.current = equalizer;
  const stateRef = useRef(state); stateRef.current = state;
  const errorRef = useRef(onError); errorRef.current = onError;
  const mounted = useRef(false);
  const reported = useRef('');
  const lastEvent = useRef(0);

  const accept = useCallback((next: NativePlaybackState) => {
    if (!mounted.current) return;
    stateRef.current = next;
    setState(next);
    const issue = next.error || (next.requestedMode === 'exclusive' && next.outputMode === 'shared' ? next.notice : '') || '';
    if (issue && issue !== reported.current) errorRef.current(issue);
    reported.current = issue;
  }, []);
  const send = useCallback(async (input: NativePlaybackCommand) => {
    const startedAtEvent = lastEvent.current;
    try {
      const next = await window.music!.audioCommand(input);
      // A newer engine event is authoritative when commands and events overlap.
      if (startedAtEvent === lastEvent.current) accept(next);
    } catch (error) {
      if (!mounted.current) return;
      const text = error instanceof Error ? error.message : String(error);
      if (reported.current !== text) errorRef.current(text);
      reported.current = text;
    }
  }, [accept]);
  const getQueueIds = useCallback(() => {
    const known = new Set(tracksRef.current.map(track => track.id));
    return (queueRef.current ?? tracksRef.current.map(track => track.id)).filter(id => known.has(id));
  }, []);
  const play = useCallback(async (track: Track) => {
    queueRef.current = null; setQueueIds(null);
    await send({ op: 'play', trackId: track.id, queueIds: tracksRef.current.map(item => item.id) });
  }, [send]);
  const playAlbum = useCallback(async (items: Track[], startId?: string) => {
    const known = new Set(tracksRef.current.map(track => track.id));
    const ids = [...new Set(items.map(track => track.id))].filter(id => known.has(id));
    if (!ids.length) return;
    queueRef.current = ids; setQueueIds(ids);
    await send({ op: 'play', trackId: startId && ids.includes(startId) ? startId : ids[0], queueIds: ids });
  }, [send]);
  const playQueued = useCallback(async (track: Track) => {
    const ids = getQueueIds();
    if (ids.includes(track.id)) await send({ op: 'play', trackId: track.id, queueIds: ids });
  }, [send, getQueueIds]);
  const toggle = useCallback(() => {
    const current = stateRef.current;
    const ids = getQueueIds();
    if (!current.trackId && ids.length) void send({ op: 'play', trackId: ids[0], queueIds: ids });
    else void send({ op: 'toggle' });
  }, [send, getQueueIds]);
  const next = useCallback(() => { void send({ op: 'next' }); }, [send]);
  const previous = useCallback(() => { void send({ op: 'previous' }); }, [send]);
  const toggleShuffle = useCallback(() => { void send({ op: 'shuffle', enabled: !stateRef.current.shuffle }); }, [send]);
  const cycleRepeat = useCallback(() => {
    const mode=stateRef.current.repeatMode;
    void send({ op:'repeat', mode:mode==='off'?'all':mode==='all'?'one':'off' });
  }, [send]);
  const seek = useCallback((position: number) => {
    if (!Number.isFinite(position)) return;
    void send({ op: 'seek', position: Math.max(0, Math.min(position, stateRef.current.duration || position)) });
  }, [send]);
  const setVolume = useCallback((volume: number) => {
    if (!Number.isFinite(volume)) return;
    const bounded = Math.max(0, Math.min(1, volume));
    setState(previous => ({ ...previous, volume: bounded }));
    void send({ op: 'volume', volume: bounded });
  }, [send]);
  const setEqualizer = useCallback((patch: Partial<EqualizerSettings>) => {
    const settings = normalizeEqualizer({ ...equalizerRef.current, ...patch });
    equalizerRef.current = settings; setEqualizerState(settings); saveEqualizer(settings);
    void send({ op: 'equalizer', settings });
  }, [send]);
  const resetEqualizer = useCallback(() => setEqualizer({ ...defaultEqualizer(), enabled: equalizerRef.current.enabled }), [setEqualizer]);

  useEffect(() => {
    mounted.current = true;
    const off = window.music!.onPlaybackState(next => { ++lastEvent.current; accept(next); });
    const eventAtRead = lastEvent.current;
    void window.music!.audioState().then(next => { if (lastEvent.current === eventAtRead) accept(next); }).catch(error => {
      if (mounted.current) errorRef.current(String(error));
    });
    void send({ op: 'equalizer', settings: equalizerRef.current });
    // Unmounting the view must never stop native background audio.
    return () => { mounted.current = false; off(); };
  }, [accept, send]);
  const libraryIds = tracks.map(track => track.id).join('\0');
  useEffect(() => {
    const ids = getQueueIds();
    if (queueRef.current !== null) {
      queueRef.current = ids; setQueueIds(ids);
    }
    void send({ op: 'setQueue', queueIds: ids });
  }, [libraryIds, getQueueIds, send]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable)) return;
      if (event.code === 'Space') { event.preventDefault(); toggle(); }
      // Media keys belong to SMTC in native mode, avoiding a double toggle.
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  const queueTracks = useMemo(() => {
    const known = new Map(tracks.map(track => [track.id, track]));
    const ids=state.queueIds.length?state.queueIds:queueIds;
    return ids===null?tracks:ids.flatMap(id => { const track = known.get(id); return track ? [track] : []; });
  }, [tracks, queueIds, state.queueIds]);
  const exclusive = state.outputMode === 'exclusive';
  const eqStatus = exclusive
    ? 'WASAPI Exclusive · bỏ qua EQ, âm lượng phần mềm và chuyển tiếp để giữ tín hiệu gốc.'
    : `${equalizer.enabled ? 'Equalizer Rust đang bật' : 'Equalizer đang tắt'} · WASAPI Shared${state.sampleRate ? ` · ${state.sampleRate / 1000} kHz` : ''}`;
  const effectivePreampDb = useMemo(() => exclusive ? 0 : calculatePreamp(equalizer, state.sampleRate || 48000), [equalizer, exclusive, state.sampleRate]);
  return {
    track: tracks.find(track => track.id === state.trackId), playing: state.playing,
    position: state.position, duration: state.duration, volume: state.volume,
    setVolume, play, playAlbum, playQueued, queueTracks, toggle, next, previous, seek,
    equalizer, setEqualizer, resetEqualizer, eqStatus, effectivePreampDb,
    nativeState: state, nativeBackend: true,
    shuffle: state.shuffle, repeatMode: state.repeatMode, toggleShuffle, cycleRepeat,
  };
}

export function usePlayer(tracks: Track[], onError: (message: string) => void) {
  // The backend is fixed for the lifetime of this document, so hook order is stable.
  if (nativeBackend) return useNativePlayer(tracks, onError);
  const browser = useBrowserPlayer(tracks, onError);
  return { ...browser, nativeState: null, nativeBackend: false };
}
export type PlayerState = ReturnType<typeof usePlayer>;
