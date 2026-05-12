/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  Radio,
  WifiOff,
  AlertCircle,
  Play,
  Square,
  RefreshCw,
  Video,
  SwitchCamera,
  MonitorPlay,
  Camera,
  Mic,
  Settings2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface NetworkStats {
  bitrate: number;
  packetLoss: number;
  latency: number;
  fps: number;
}

type SourceMode = 'playback' | 'browser';
type LiveStatus = 'unknown' | 'live' | 'idle' | 'error';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

const DEFAULT_STATS: NetworkStats = { bitrate: 0, packetLoss: 0, latency: 0, fps: 0 };
const DEFAULT_PLAYBACK_URL = import.meta.env.VITE_CLOUDFLARE_PLAYBACK_URL || '';
const DEFAULT_WHIP_URL = import.meta.env.VITE_CLOUDFLARE_WHIP_URL || '';

function preferCloudflareVideoCodecs(transceiver: RTCRtpTransceiver) {
  if (!RTCRtpSender.getCapabilities || !transceiver.setCodecPreferences) return;

  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities) return;

  const codecs = capabilities.codecs;
  type CodecCapability = (typeof codecs)[number];
  const isH264 = (codec: CodecCapability) => codec.mimeType.toLowerCase() === 'video/h264';
  const isBaselineH264 = (codec: CodecCapability) =>
    isH264(codec) && /profile-level-id=42e01f/i.test(codec.sdpFmtpLine || '');
  const isVp8OrVp9 = (codec: CodecCapability) =>
    codec.mimeType.toLowerCase() === 'video/vp8' || codec.mimeType.toLowerCase() === 'video/vp9';

  transceiver.setCodecPreferences([
    ...codecs.filter(isBaselineH264),
    ...codecs.filter((codec) => isH264(codec) && !isBaselineH264(codec)),
    ...codecs.filter(isVp8OrVp9),
    ...codecs.filter((codec) => !isH264(codec) && !isVp8OrVp9(codec)),
  ]);
}

function waitForIceCandidates(pc: RTCPeerConnection) {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    let hasCandidate = (pc.localDescription?.sdp || '').includes('a=candidate:');
    let candidateGraceTimer = 0;

    const finish = () => {
      window.clearTimeout(timer);
      window.clearTimeout(candidateGraceTimer);
      pc.removeEventListener('icecandidate', onCandidate);
      pc.removeEventListener('icegatheringstatechange', onGatheringStateChange);
      resolve();
    };

    const timer = window.setTimeout(() => {
      console.warn('ICE gathering did not complete; publishing with available candidates.');
      finish();
    }, 8000);

    candidateGraceTimer = window.setTimeout(() => {
      if (hasCandidate) finish();
    }, 2500);

    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) hasCandidate = true;
      if (!event.candidate || pc.iceGatheringState === 'complete') finish();
    };

    const onGatheringStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    pc.addEventListener('icecandidate', onCandidate);
    pc.addEventListener('icegatheringstatechange', onGatheringStateChange);
  });
}

function normalizeCloudflarePlayerUrl(value: string) {
  const raw = value.trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/iframe')) return url.toString();
    if (path.endsWith('/manifest/video.m3u8')) {
      url.pathname = path.replace('/manifest/video.m3u8', '/iframe');
      url.search = '';
      return url.toString();
    }
    if (/^\/[a-zA-Z0-9_-]+$/.test(path)) {
      url.pathname = `${path}/iframe`;
      return url.toString();
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function getLifecycleUrl(playerUrl: string) {
  try {
    const url = new URL(playerUrl);
    const inputId = url.pathname.split('/').filter(Boolean)[0];
    if (!inputId) return '';
    return `${url.origin}/${inputId}/lifecycle`;
  } catch {
    return '';
  }
}

export default function App() {
  const [sourceMode, setSourceMode] = useState<SourceMode>(() => {
    return (localStorage.getItem('stream.sourceMode') as SourceMode) || (DEFAULT_PLAYBACK_URL ? 'playback' : 'browser');
  });
  const [playbackUrl, setPlaybackUrl] = useState(() => localStorage.getItem('stream.playbackUrl') || DEFAULT_PLAYBACK_URL);
  const [streamUrl, setStreamUrl] = useState(() => localStorage.getItem('stream.whipUrl') || DEFAULT_WHIP_URL);
  const [isStreaming, setIsStreaming] = useState(false);
  const [bitrateLimit, setBitrateLimit] = useState(1500);
  const [stats, setStats] = useState<NetworkStats>(DEFAULT_STATS);
  const [isHealthy, setIsHealthy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState('');
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState('');
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('unknown');

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const statsIntervalRef = useRef<number | null>(null);

  const playerUrl = useMemo(() => normalizeCloudflarePlayerUrl(playbackUrl), [playbackUrl]);
  const lifecycleUrl = useMemo(() => getLifecycleUrl(playerUrl), [playerUrl]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setVideoDevices(devices.filter((device) => device.kind === 'videoinput'));
    setAudioDevices(devices.filter((device) => device.kind === 'audioinput'));
  }, []);

  const stopLocalTracks = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const buildMediaConstraints = useCallback(
    (mode = facingMode): MediaStreamConstraints => ({
      video: selectedVideoDeviceId
        ? {
            deviceId: { exact: selectedVideoDeviceId },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
          }
        : {
            facingMode: mode,
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
      audio: selectedAudioDeviceId
        ? { deviceId: { exact: selectedAudioDeviceId }, echoCancellation: false, noiseSuppression: false }
        : { echoCancellation: false, noiseSuppression: false },
    }),
    [facingMode, selectedAudioDeviceId, selectedVideoDeviceId],
  );

  const setupPreview = useCallback(
    async (mode = facingMode) => {
      stopLocalTracks();
      const stream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints(mode));
      localStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      await refreshDevices();
      return stream;
    },
    [buildMediaConstraints, facingMode, refreshDevices, stopLocalTracks],
  );

  const updateStats = useCallback(async () => {
    if (!pcRef.current) return;

    try {
      const reports = await pcRef.current.getStats();
      let outboundRtp: any = null;
      let candidatePair: any = null;

      reports.forEach((report) => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') outboundRtp = report;
        if (report.type === 'candidate-pair' && report.state === 'succeeded') candidatePair = report;
      });

      if (!outboundRtp) return;

      const now = performance.now();
      const bytesSent = outboundRtp.bytesSent || 0;
      const framesEncoded = outboundRtp.framesEncoded || 0;
      const lastBytes = (pcRef.current as any)._lastBytes ?? bytesSent;
      const lastFrames = (pcRef.current as any)._lastFrames ?? framesEncoded;
      const lastTime = (pcRef.current as any)._lastTime ?? now;
      const duration = (now - lastTime) / 1000;

      if (duration > 0) {
        const bitrate = ((bytesSent - lastBytes) * 8) / (duration * 1000);
        const fps = (framesEncoded - lastFrames) / duration;

        setStats({
          bitrate: Math.max(0, Math.round(bitrate)),
          fps: Math.max(0, Math.round(fps)),
          packetLoss: outboundRtp.packetsLost || 0,
          latency: candidatePair?.currentRoundTripTime
            ? Math.round(candidatePair.currentRoundTripTime * 1000)
            : 0,
        });
        setIsHealthy(bitrate > 100 && pcRef.current.connectionState !== 'failed');
      }

      (pcRef.current as any)._lastBytes = bytesSent;
      (pcRef.current as any)._lastFrames = framesEncoded;
      (pcRef.current as any)._lastTime = now;
    } catch (err) {
      console.error('Failed to get stats', err);
    }
  }, []);

  const stopStreaming = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    stopLocalTracks();
    setIsStreaming(false);
    setIsHealthy(true);
    setStats(DEFAULT_STATS);
  }, [stopLocalTracks]);

  const toggleCamera = async () => {
    const newMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(newMode);
    setSelectedVideoDeviceId('');

    if (sourceMode !== 'browser') return;
    if (isStreaming) {
      stopStreaming();
      window.setTimeout(() => startStreaming(newMode), 500);
      return;
    }

    try {
      await setupPreview(newMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengganti kamera');
    }
  };

  const startStreaming = async (mode = facingMode) => {
    const whipUrl = streamUrl.trim();
    if (!whipUrl) {
      setError('Masukkan URL WebRTC publish/WHIP dari Cloudflare');
      return;
    }

    setSourceMode('browser');
    setError(null);

    try {
      const stream = await setupPreview(mode);
      const pc = new RTCPeerConnection({
        iceServers: STUN_SERVERS,
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      pcRef.current = pc;

      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setIsHealthy(false);
        }
      });

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('Kamera tidak mengirim video track.');

      const videoTransceiver = pc.addTransceiver(videoTrack, {
        direction: 'sendonly',
        streams: [stream],
      });
      preferCloudflareVideoCodecs(videoTransceiver);

      const videoSender = videoTransceiver.sender;
      const params = videoSender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = bitrateLimit * 1000;
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scaleResolutionDownBy = 1;
      // @ts-ignore - Browser support is ahead of the TypeScript DOM lib here.
      params.degradationPreference = 'maintain-framerate';
      await videoSender.setParameters(params).catch((err) => {
        console.warn('Unable to apply video sender parameters', err);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceCandidates(pc);

      const response = await fetch(whipUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription?.sdp,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Cloudflare Error (${response.status}): ${errText}`);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      setIsStreaming(true);
      statsIntervalRef.current = window.setInterval(updateStats, 1000);
      window.setTimeout(updateStats, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memulai streaming');
      stopStreaming();
    }
  };

  useEffect(() => {
    localStorage.setItem('stream.sourceMode', sourceMode);
    localStorage.setItem('stream.playbackUrl', playbackUrl);
    localStorage.setItem('stream.whipUrl', streamUrl);
  }, [playbackUrl, sourceMode, streamUrl]);

  useEffect(() => {
    refreshDevices().catch(console.warn);
  }, [refreshDevices]);

  useEffect(() => {
    if (sourceMode !== 'browser' || isStreaming) {
      if (sourceMode === 'playback') stopStreaming();
      return;
    }

    setupPreview().catch((err) => {
      console.warn('Camera preview unavailable', err);
    });

    return () => {
      if (!isStreaming) stopLocalTracks();
    };
  }, [isStreaming, setupPreview, sourceMode, stopLocalTracks, stopStreaming]);

  useEffect(() => {
    if (!lifecycleUrl || sourceMode !== 'playback') {
      setLiveStatus('unknown');
      return;
    }

    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch(lifecycleUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Lifecycle ${response.status}`);
        const data = await response.json();
        if (!cancelled) setLiveStatus(data.live ? 'live' : 'idle');
      } catch {
        if (!cancelled) setLiveStatus('error');
      }
    };

    check();
    const timer = window.setInterval(check, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [lifecycleUrl, sourceMode]);

  useEffect(() => () => stopStreaming(), [stopStreaming]);

  const statusLabel = sourceMode === 'playback'
    ? liveStatus === 'live'
      ? 'Cloudflare Live'
      : liveStatus === 'idle'
        ? 'Waiting for OBS'
        : 'Monitor Ready'
    : isStreaming
      ? isHealthy ? 'Live Broadcast' : 'Connection Unstable'
      : 'Browser Publisher Idle';

  return (
    <div className="min-h-screen bg-[#f3f4f6] text-[#111214] font-sans selection:bg-blue-500/20">
      <main className="w-full px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <section className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-7xl flex-col gap-5 rounded-[8px] bg-[#d9d9d9] p-5 shadow-sm sm:p-8 lg:min-h-[calc(100vh-5rem)] lg:p-12">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-4xl font-normal tracking-normal text-black sm:text-5xl">
                Cloudflare Stream Monitor
              </h1>
              <div className="mt-3 flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${
                  sourceMode === 'playback'
                    ? liveStatus === 'live' ? 'animate-pulse bg-red-500' : 'bg-black/20'
                    : isStreaming ? (isHealthy ? 'animate-pulse bg-red-500' : 'animate-bounce bg-orange-500') : 'bg-black/20'
                }`} />
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-black/45">
                  {statusLabel}
                </p>
              </div>
            </div>

            <div className="flex gap-2 self-start sm:self-auto">
              <button
                onClick={toggleCamera}
                className="flex h-11 w-11 items-center justify-center rounded-[6px] bg-white/70 text-black/65 shadow-sm transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                title="Switch Camera"
                disabled={sourceMode !== 'browser'}
              >
                <SwitchCamera size={19} />
              </button>
              <button
                onClick={() => window.location.reload()}
                className="flex h-11 w-11 items-center justify-center rounded-[6px] bg-white/70 text-black/65 shadow-sm transition-all hover:bg-white active:scale-95"
                title="Reload"
              >
                <RefreshCw size={19} />
              </button>
            </div>
          </header>

          <div className="grid flex-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(340px,460px)] xl:gap-12">
            <section className="relative overflow-hidden bg-black shadow-sm">
              <div className="aspect-video w-full">
                {sourceMode === 'playback' ? (
                  playerUrl ? (
                    <iframe
                      key={playerUrl}
                      src={playerUrl}
                      title="Cloudflare Stream Player"
                      allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      className="h-full w-full border-0"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center p-6 text-center text-white/55">
                      <div>
                        <MonitorPlay className="mx-auto mb-4 text-white/30" size={44} />
                        <p className="text-sm font-bold uppercase tracking-[0.16em]">Masukkan Cloudflare Player URL</p>
                        <p className="mt-2 text-xs text-white/40">Gunakan embed/player URL dari Live Input, bukan RTMPS URL atau stream key.</p>
                      </div>
                    </div>
                  )
                ) : (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-cover"
                    id="preview-video"
                  />
                )}
              </div>

              <AnimatePresence>
                {!isHealthy && isStreaming && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/35 p-6"
                  >
                    <div className="flex max-w-[260px] flex-col items-center gap-3 rounded-[8px] border border-orange-400/50 bg-black/85 p-5 text-center text-white shadow-2xl backdrop-blur-xl">
                      <WifiOff size={32} className="text-orange-400" />
                      <p className="text-sm font-bold uppercase tracking-widest text-orange-100">Poor Connection</p>
                      <p className="text-xs leading-relaxed text-white/55">Bitrate rendah atau koneksi WebRTC terputus.</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 16 }}
                    className="absolute bottom-4 left-4 right-4 z-40 rounded-[8px] border border-white/20 bg-red-600 p-4 text-white shadow-2xl"
                  >
                    <div className="flex items-center gap-3">
                      <AlertCircle size={20} />
                      <p className="text-sm font-bold uppercase tracking-tight">Stream Error</p>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed opacity-85">{error}</p>
                    <button onClick={() => setError(null)} className="mt-3 w-full rounded-[6px] bg-black/20 py-2 text-xs font-bold uppercase hover:bg-black/30">
                      Tutup Notifikasi
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            <aside className="flex h-full min-h-[320px] flex-col justify-center gap-5 lg:py-8">
              <div className="grid grid-cols-2 gap-2 rounded-[6px] bg-white/75 p-2 shadow-sm">
                <button
                  onClick={() => setSourceMode('playback')}
                  className={`flex h-11 items-center justify-center gap-2 rounded-[5px] text-xs font-bold uppercase tracking-[0.12em] transition ${
                    sourceMode === 'playback' ? 'bg-[#111214] text-white' : 'text-black/50 hover:bg-black/5'
                  }`}
                >
                  <MonitorPlay size={16} />
                  OBS Monitor
                </button>
                <button
                  onClick={() => setSourceMode('browser')}
                  className={`flex h-11 items-center justify-center gap-2 rounded-[5px] text-xs font-bold uppercase tracking-[0.12em] transition ${
                    sourceMode === 'browser' ? 'bg-[#111214] text-white' : 'text-black/50 hover:bg-black/5'
                  }`}
                >
                  <Camera size={16} />
                  Browser WHIP
                </button>
              </div>

              {sourceMode === 'playback' ? (
                <div className="space-y-5 rounded-[6px] bg-white/75 p-5 shadow-sm">
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">Cloudflare Player / Embed URL</label>
                    <input
                      type="text"
                      value={playbackUrl}
                      onChange={(event) => setPlaybackUrl(event.target.value)}
                      placeholder="https://customer-...cloudflarestream.com/<LIVE_INPUT_UID>/iframe"
                      className="w-full rounded-[6px] border border-black/10 bg-white px-4 py-3 font-mono text-sm text-black outline-none transition-all placeholder:text-black/25 focus:border-blue-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-[6px] border border-black/10 bg-white p-4">
                      <div className="mb-3 flex items-center gap-2 text-black/45">
                        <Activity size={15} className="text-emerald-600" />
                        <span className="text-[11px] font-bold uppercase tracking-[0.16em]">Status</span>
                      </div>
                      <p className="font-mono text-xl font-bold leading-none text-black">
                        {liveStatus === 'live' ? 'LIVE' : liveStatus === 'idle' ? 'IDLE' : liveStatus === 'error' ? 'CHECK' : '-'}
                      </p>
                    </div>
                    <div className="rounded-[6px] border border-black/10 bg-white p-4">
                      <div className="mb-3 flex items-center gap-2 text-black/45">
                        <MonitorPlay size={15} className="text-blue-600" />
                        <span className="text-[11px] font-bold uppercase tracking-[0.16em]">Input</span>
                      </div>
                      <p className="font-mono text-xl font-bold leading-none text-black">OBS</p>
                    </div>
                  </div>

                  <div className="rounded-[6px] border border-blue-500/15 bg-blue-500/5 p-4 text-black/65">
                    <p className="text-xs leading-relaxed">
                      Untuk alur DSLR → USB → OBS → Cloudflare, gunakan mode ini. OBS harus mengirim ke RTMPS/SRT Cloudflare, lalu player memakai URL `/iframe` dari Live Input.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-[6px] bg-white/75 p-4 shadow-sm">
                      <div className="mb-3 flex items-center gap-2 text-black/45">
                        <Radio size={15} className="text-blue-600" />
                        <span className="text-[11px] font-bold uppercase tracking-[0.16em]">Bitrate</span>
                      </div>
                      <p className={`font-mono text-2xl font-bold leading-none ${isStreaming && stats.bitrate < 100 ? 'text-red-600' : 'text-black'}`}>
                        {stats.bitrate}
                        <span className="ml-1 text-xs font-semibold text-black/35">kbps</span>
                      </p>
                    </div>

                    <div className="rounded-[6px] bg-white/75 p-4 shadow-sm">
                      <div className="mb-3 flex items-center gap-2 text-black/45">
                        <Video size={15} className="text-emerald-600" />
                        <span className="text-[11px] font-bold uppercase tracking-[0.16em]">FPS</span>
                      </div>
                      <p className="font-mono text-2xl font-bold leading-none text-black">{stats.fps}</p>
                    </div>

                    <div className="rounded-[6px] bg-white/75 p-4 shadow-sm">
                      <div className="mb-3 flex items-center gap-2 text-black/45">
                        <Activity size={15} className="text-violet-600" />
                        <span className="text-[11px] font-bold uppercase tracking-[0.16em]">RTT</span>
                      </div>
                      <p className="font-mono text-2xl font-bold leading-none text-black">
                        {stats.latency}
                        <span className="ml-1 text-xs font-semibold text-black/35">ms</span>
                      </p>
                    </div>
                  </div>

                  <div className="space-y-5 rounded-[6px] bg-white/75 p-5 shadow-sm">
                    <div className="space-y-2">
                      <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">WHIP Publish URL</label>
                      <input
                        type="text"
                        value={streamUrl}
                        onChange={(event) => setStreamUrl(event.target.value)}
                        placeholder="https://.../webRTC/publish"
                        className="w-full rounded-[6px] border border-black/10 bg-white px-4 py-3 font-mono text-sm text-black outline-none transition-all placeholder:text-black/25 focus:border-blue-500"
                      />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-2">
                        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">
                          <Camera size={14} /> Camera
                        </span>
                        <select
                          value={selectedVideoDeviceId}
                          onChange={(event) => setSelectedVideoDeviceId(event.target.value)}
                          className="h-11 w-full rounded-[6px] border border-black/10 bg-white px-3 text-sm text-black outline-none focus:border-blue-500"
                        >
                          <option value="">Auto / facing mode</option>
                          {videoDevices.map((device, index) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label || `Camera ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="space-y-2">
                        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">
                          <Mic size={14} /> Audio
                        </span>
                        <select
                          value={selectedAudioDeviceId}
                          onChange={(event) => setSelectedAudioDeviceId(event.target.value)}
                          className="h-11 w-full rounded-[6px] border border-black/10 bg-white px-3 text-sm text-black outline-none focus:border-blue-500"
                        >
                          <option value="">Default microphone</option>
                          {audioDevices.map((device, index) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label || `Microphone ${index + 1}`}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-4">
                        <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">
                          <Settings2 size={14} /> Max Bitrate
                        </label>
                        <span className="font-mono text-sm font-bold text-blue-600">{bitrateLimit} <span className="text-xs text-black/35">kbps</span></span>
                      </div>
                      <input
                        type="range"
                        min="800"
                        max="8000"
                        step="100"
                        value={bitrateLimit}
                        onChange={(event) => setBitrateLimit(parseInt(event.target.value, 10))}
                        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-black/10 accent-blue-600"
                      />
                    </div>
                  </div>

                  {!isStreaming ? (
                    <button
                      onClick={() => startStreaming()}
                      disabled={!streamUrl}
                      className="flex h-20 w-full items-center justify-center gap-4 rounded-none bg-[#438bd3] text-4xl font-normal uppercase tracking-normal text-white shadow-sm transition-all hover:bg-[#347fcb] active:scale-[0.99] disabled:bg-black/10 disabled:text-black/20 sm:h-24 sm:text-5xl"
                    >
                      <Play size={30} fill="currentColor" />
                      <span>Stream</span>
                    </button>
                  ) : (
                    <button
                      onClick={stopStreaming}
                      className="flex h-20 w-full items-center justify-center gap-4 rounded-none bg-[#111214] text-3xl font-normal uppercase tracking-normal text-white shadow-sm transition-all hover:bg-black active:scale-[0.99] sm:h-24 sm:text-4xl"
                    >
                      <Square size={28} fill="currentColor" />
                      <span>End Stream</span>
                    </button>
                  )}
                </>
              )}
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}
