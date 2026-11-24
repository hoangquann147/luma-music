import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../../shared/types';
import { mediaUrl } from '../../shared/types';
import { shuffledQueue, type RepeatMode } from '../audio/queue-order';
import {
  defaultEqualizer, effectivePreampDb as calculatePreamp, EqualizerGraph, loadEqualizer,
  normalizeEqualizer, saveEqualizer, type EqualizerSettings,
} from '../audio/equalizer';

export function useBrowserPlayer(tracks: Track[], onError: (message: string) => void) {
  const audio = useRef<HTMLAudioElement | null>(null);
  if (!audio.current) {
    audio.current = new Audio(); audio.current.preload = 'metadata';
    // The custom media protocol sends ACAO; this must precede setting any source URL.
    audio.current.crossOrigin = 'anonymous';
  }
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(.7);
  const [equalizer, setEqualizerState] = useState<EqualizerSettings>(loadEqualizer);
  const [eqStatus, setEqStatus] = useState(equalizer.enabled ? 'Equalizer sẵn sàng khi phát nhạc.' : 'Equalizer đang tắt · phát trực tiếp.');
  const [contextRate, setContextRate] = useState(48000);
  const graph = useRef<EqualizerGraph | null>(null);
  const context = useRef<AudioContext | null>(null);
  const source = useRef<MediaElementAudioSourceNode | null>(null);
  const equalizerRef = useRef(equalizer); equalizerRef.current = equalizer;
  const volumeRef = useRef(volume); volumeRef.current = volume;
  const errorRef = useRef(onError); errorRef.current = onError;
  const tracksRef = useRef(tracks); tracksRef.current = tracks;
  const [queueIds, setQueueIds] = useState<string[] | null>(null);
  const queueIdsRef = useRef<string[] | null>(queueIds);
  const [shuffle,setShuffle]=useState(false);
  const [repeatMode,setRepeatMode]=useState<RepeatMode>('off');
  const shuffleRef=useRef(false), repeatRef=useRef<RepeatMode>('off');
  const [shuffledIds,setShuffledIds]=useState<string[]>([]);
  const shuffledRef=useRef<string[]>([]);
  const getBaseQueue = useCallback(() => {
    const ids = queueIdsRef.current;
    if (ids === null) return tracksRef.current;
    const byId = new Map(tracksRef.current.map(item => [item.id, item]));
    return ids.flatMap(id => { const item = byId.get(id); return item ? [item] : []; });
  }, []);
  const getQueue=useCallback(()=>{
    const base=getBaseQueue();if(!shuffleRef.current)return base;
    const byId=new Map(base.map(item=>[item.id,item]));
    return shuffledRef.current.flatMap(id=>{const item=byId.get(id);return item?[item]:[]});
  },[getBaseQueue]);
  const reshuffle=useCallback((anchor?:string|null)=>{
    const ids=shuffledQueue(getBaseQueue().map(item=>item.id),anchor);
    shuffledRef.current=ids;setShuffledIds(ids);
  },[getBaseQueue]);
  const queueTracks = useMemo(() => {
    if(shuffle){const byId=new Map(tracks.map(item=>[item.id,item]));return shuffledIds.flatMap(id=>{const item=byId.get(id);return item?[item]:[]})}
    if (queueIds === null) return tracks;
    const byId = new Map(tracks.map(item => [item.id, item]));
    return queueIds.flatMap(id => { const item = byId.get(id); return item ? [item] : []; });
  }, [tracks, queueIds,shuffle,shuffledIds]);
  const currentRef = useRef(currentId); currentRef.current = currentId;
  const toggleShuffle=useCallback(()=>{
    const next=!shuffleRef.current;shuffleRef.current=next;setShuffle(next);
    if(next)reshuffle(currentRef.current);
  },[reshuffle]);
  const cycleRepeat=useCallback(()=>{
    const mode=repeatRef.current;const next=mode==='off'?'all':mode==='all'?'one':'off';
    repeatRef.current=next;setRepeatMode(next);
  },[]);
  const libraryIds=tracks.map(item=>item.id).join('\0');
  useEffect(()=>{if(shuffleRef.current)reshuffle(currentRef.current)},[libraryIds,reshuffle]);
  const mounted = useRef(true);
  const disposeTimer = useRef<number | undefined>(undefined);
  const generation = useRef(0), wantPlay = useRef(false);
  const compatibilityUsed = useRef(false), compatibilityPending = useRef<number | null>(null);
  const reportedError = useRef(-1);
  const track = tracks.find(item => item.id === currentId);

  const refreshEqStatus = useCallback(() => {
    const ctx = context.current;
    setEqStatus(ctx
      ? (equalizerRef.current.enabled ? 'Equalizer đang bật' : 'Equalizer bypass') + ' · Web Audio ' + (ctx.sampleRate / 1000) + ' kHz' + (ctx.state === 'suspended' ? ' · chờ phát' : '')
      : equalizerRef.current.enabled ? 'Equalizer sẵn sàng khi phát nhạc.' : 'Equalizer đang tắt · phát trực tiếp.');
  }, []);
  const ensureGraph = useCallback(() => {
    if (graph.current) return graph.current;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    let processor: EqualizerGraph | null = null;
    try {
      processor = new EqualizerGraph(ctx, equalizerRef.current, volumeRef.current);
      const mediaSource = ctx.createMediaElementSource(audio.current!);
      mediaSource.connect(processor.input);
      context.current = ctx; graph.current = processor; source.current = mediaSource;
      // Master volume is applied once by the graph, instead of twice by HTMLAudio + GainNode.
      audio.current!.volume = 1;
      ctx.addEventListener('statechange', refreshEqStatus);
      setContextRate(ctx.sampleRate); refreshEqStatus();
      return processor;
    } catch (error) { processor?.dispose(); void ctx.close().catch(() => undefined); throw error; }
  }, [refreshEqStatus]);
  const resumeGraph = useCallback(async () => {
    if (equalizerRef.current.enabled || graph.current) {
      const processor = ensureGraph();
      if (processor.context.state === 'suspended') await (processor.context as AudioContext).resume();
      refreshEqStatus();
    }
  }, [ensureGraph, refreshEqStatus]);

  const reportFailure = useCallback((token: number, message: string) => {
    if (!mounted.current || generation.current !== token || reportedError.current === token) return;
    reportedError.current = token; wantPlay.current = false; setPlaying(false); errorRef.current(message);
  }, []);
  const startCompatibility = useCallback((token: number): boolean => {
    const selected = tracksRef.current.find(item => item.id === currentRef.current);
    const element = audio.current!;
    // ALAC already uses the compatibility decoder on its normal media URL.
    if (!selected || selected.codec === 'ALAC' || !/\.m4a$/i.test(selected.path) || compatibilityUsed.current || !wantPlay.current || token !== generation.current) return false;
    compatibilityUsed.current = true; compatibilityPending.current = token;
    const oldPosition = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    element.src = mediaUrl(selected.id) + '?compat=1';
    const restorePosition = () => {
      if (generation.current === token && oldPosition > 0 && Number.isFinite(element.duration)) element.currentTime = Math.min(oldPosition, Math.max(0, element.duration - .01));
    };
    element.addEventListener('loadedmetadata', restorePosition, { once: true });
    element.load();
    void (async () => {
      await resumeGraph();
      if (generation.current === token && wantPlay.current) await element.play();
    })().catch(error => {
      if (generation.current !== token || !wantPlay.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      reportFailure(token, 'Không phát được M4A này, kể cả chế độ tương thích. Kiểm tra file và FFmpeg trong Settings.');
    }).finally(() => { if (compatibilityPending.current === token) compatibilityPending.current = null; });
    return true;
  }, [resumeGraph, reportFailure]);

  const playCurrent = useCallback(async (next: Track) => {
    const element = audio.current!, token = ++generation.current;
    wantPlay.current = true; compatibilityPending.current = null;
    const reload = currentRef.current !== next.id || Boolean(element.error);
    compatibilityUsed.current = !reload && element.src.includes('?compat=1');
    if (reload) {
      currentRef.current = next.id; setCurrentId(next.id); setPosition(0); setDuration(next.duration);
      element.src = mediaUrl(next.id);
    }
    try {
      await resumeGraph();
      if (generation.current !== token || !wantPlay.current) return;
      await element.play();
    } catch (error) {
      if (generation.current !== token || !wantPlay.current || compatibilityPending.current === token) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if ((element.error?.code === 3 || element.error?.code === 4 || (error instanceof DOMException && error.name === 'NotSupportedError')) && startCompatibility(token)) return;
      reportFailure(token, 'Không thể phát file này. Kiểm tra file FLAC/M4A còn tồn tại và chứa âm thanh hợp lệ.');
    }
  }, [resumeGraph, startCompatibility, reportFailure]);
  const playRef = useRef(playCurrent); playRef.current = playCurrent;
  const play = useCallback(async (next: Track) => {
    queueIdsRef.current = null; setQueueIds(null);
    if(shuffleRef.current)reshuffle(next.id);
    await playRef.current(next);
  }, [reshuffle]);
  const playAlbum = useCallback(async (albumTracks: Track[], startId?: string) => {
    const known = new Map(tracksRef.current.map(item => [item.id, item]));
    const ids = [...new Set(albumTracks.map(item => item.id))].filter(id => known.has(id));
    if (!ids.length) return;
    queueIdsRef.current = ids; setQueueIds(ids);
    if(shuffleRef.current)reshuffle(startId&&ids.includes(startId)?startId:ids[0]);
    const selected = known.get(startId && ids.includes(startId) ? startId : ids[0]);
    if (selected) await playRef.current(selected);
  }, [reshuffle]);
  const playQueued = useCallback(async (selected: Track) => {
    const queued = getQueue().find(item => item.id === selected.id);
    if (queued) await playRef.current(queued);
  }, [getQueue]);
  const pause = useCallback(() => {
    wantPlay.current = false; ++generation.current; compatibilityPending.current = null; audio.current!.pause(); setPlaying(false);
  }, []);
  const toggle = useCallback(() => {
    if (wantPlay.current || !audio.current!.paused) pause();
    else {
      const items = getQueue();
      const selected = items.find(item => item.id === currentRef.current) ?? items[0];
      if (selected) void playRef.current(selected);
    }
  }, [pause, getQueue]);
  const next = useCallback(() => {
    const items = getQueue(), index = items.findIndex(item => item.id === currentRef.current);
    if (items.length) void playRef.current(items[(index + 1) % items.length]);
  }, [getQueue]);
  const previous = useCallback(() => {
    if (audio.current!.currentTime > 3) { audio.current!.currentTime = 0; setPosition(0); return; }
    const items = getQueue(), index = items.findIndex(item => item.id === currentRef.current);
    if (items.length) void playRef.current(items[index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length]);
  }, [getQueue]);
  const seek = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    const element = audio.current!, bounded = Math.max(0, Number.isFinite(element.duration) ? Math.min(value, element.duration) : value);
    if (Number.isFinite(element.duration)) element.currentTime = bounded;
    setPosition(bounded);
  }, []);
  const setVolume = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    const bounded = Math.max(0, Math.min(1, value)); volumeRef.current = bounded; setVolumeState(bounded);
    if (graph.current) graph.current.setVolume(bounded); else audio.current!.volume = bounded;
  }, []);
  const setEqualizer = useCallback((patch: Partial<EqualizerSettings>) => {
    const updated = normalizeEqualizer({ ...equalizerRef.current, ...patch });
    equalizerRef.current = updated; setEqualizerState(updated); saveEqualizer(updated);
    try {
      if (updated.enabled || graph.current) {
        ensureGraph().update(updated);
        if (updated.enabled) void resumeGraph().catch(() => setEqStatus('Equalizer đang chờ quyền phát âm thanh. Nhấn Phát để tiếp tục.'));
      }
      refreshEqStatus();
    } catch { setEqStatus('Chưa khởi tạo được Equalizer trên thiết bị này.'); }
  }, [ensureGraph, resumeGraph, refreshEqStatus]);
  const resetEqualizer = useCallback(() => setEqualizer({ ...defaultEqualizer(), enabled: equalizerRef.current.enabled }), [setEqualizer]);
  const effectivePreampDb = useMemo(() => calculatePreamp(equalizer, contextRate), [equalizer, contextRate]);

  useEffect(() => {
    mounted.current = true;
    if (disposeTimer.current !== undefined) { window.clearTimeout(disposeTimer.current); disposeTimer.current = undefined; }
    // StrictMode immediately replays setup after cleanup. Defer irreversible context
    // closure until a genuine unmount, keeping one MediaElementAudioSource per element.
    return () => {
      mounted.current = false;
      disposeTimer.current = window.setTimeout(() => {
        if (mounted.current) return;
        wantPlay.current = false; ++generation.current;
        audio.current!.pause(); audio.current!.removeAttribute('src'); audio.current!.load();
        source.current?.disconnect(); graph.current?.dispose();
        const ctx = context.current;
        if (ctx) { ctx.removeEventListener('statechange', refreshEqStatus); void ctx.close().catch(() => undefined); }
      }, 0);
    };
  }, [refreshEqStatus]);
  useEffect(() => {
    const element = audio.current!;
    const time = () => setPosition(element.currentTime);
    const metadata = () => { if (Number.isFinite(element.duration)) setDuration(element.duration); };
    const started = () => { if (!wantPlay.current) { element.pause(); return; } setPlaying(true); };
    const paused = () => setPlaying(false);
    const error = () => {
      if (!element.error) return; // Ignore a queued failure belonging to the replaced source.
      const token = generation.current;
      if (startCompatibility(token)) return;
      const selected = tracksRef.current.find(item => item.id === currentRef.current);
      reportFailure(token, compatibilityUsed.current || selected?.codec === 'ALAC'
        ? 'Không phát được M4A ở chế độ tương thích. Kiểm tra file và FFmpeg trong Settings.'
        : 'Không đọc được âm thanh. File có thể đã bị di chuyển hoặc không được hỗ trợ.');
    };
    const ended = () => {
      const items = getQueue(), index = items.findIndex(item => item.id === currentRef.current);
      if(repeatRef.current==='one'&&index>=0){element.currentTime=0;void playRef.current(items[index])}
      else if (index >= 0 && index < items.length - 1) void playRef.current(items[index + 1]);
      else if(repeatRef.current==='all'&&items.length)void playRef.current(items[0]);
      else { wantPlay.current = false; setPlaying(false); }
    };
    element.addEventListener('timeupdate', time); element.addEventListener('loadedmetadata', metadata);
    element.addEventListener('play', started); element.addEventListener('pause', paused);
    element.addEventListener('ended', ended); element.addEventListener('error', error);
    return () => {
      element.removeEventListener('timeupdate', time); element.removeEventListener('loadedmetadata', metadata);
      element.removeEventListener('play', started); element.removeEventListener('pause', paused);
      element.removeEventListener('ended', ended); element.removeEventListener('error', error);
    };
  }, [startCompatibility, reportFailure, getQueue]);
  useEffect(() => {
    if (graph.current) graph.current.setVolume(volume); else audio.current!.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (currentId && !tracks.some(item => item.id === currentId)) {
      pause(); audio.current!.removeAttribute('src'); audio.current!.load();
      currentRef.current = null; setCurrentId(null); setDuration(0); setPosition(0);
    }
  }, [tracks, currentId, pause]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable) return;
      if (event.code === 'Space') { event.preventDefault(); toggle(); }
      if (event.code === 'MediaTrackNext') next();
      if (event.code === 'MediaTrackPrevious') previous();
      if (event.code === 'MediaPlayPause') toggle();
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [toggle, next, previous]);
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = track ? new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album,
      artwork: track.coverDataUrl ? [{ src: track.coverDataUrl }] : [],
    }) : null;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => {
      const items = getQueue();
      const selected = items.find(item => item.id === currentRef.current) ?? items[0];
      if (selected) void playRef.current(selected);
    });
    navigator.mediaSession.setActionHandler('pause', pause);
    navigator.mediaSession.setActionHandler('previoustrack', previous);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('seekto', details => { if (details.seekTime !== undefined) seek(details.seekTime); });
    return () => { ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'].forEach(action => navigator.mediaSession.setActionHandler(action as MediaSessionAction, null)); };
  }, [track, playing, previous, next, seek, pause, getQueue]);
  return { track, playing, position, duration, volume, setVolume, play, playAlbum, playQueued, queueTracks, toggle, next, previous, seek, equalizer, setEqualizer, resetEqualizer, eqStatus, effectivePreampDb,shuffle,repeatMode,toggleShuffle,cycleRepeat };
}


