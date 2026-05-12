/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Activity, 
  Radio, 
  WifiOff, 
  AlertCircle,
  Play,
  Square,
  RefreshCw,
  Video,
  SwitchCamera
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants & Types ---
interface NetworkStats {
  bitrate: number; // in kbps
  packetLoss: number;
  latency: number;
  fps: number;
}

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

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

  const preferred = [
    ...codecs.filter(isBaselineH264),
    ...codecs.filter(codec => isH264(codec) && !isBaselineH264(codec)),
    ...codecs.filter(isVp8OrVp9),
    ...codecs.filter(codec => !isH264(codec) && !isVp8OrVp9(codec)),
  ];

  transceiver.setCodecPreferences(preferred);
}

function waitForIceCandidates(pc: RTCPeerConnection) {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    let hasCandidate = (pc.localDescription?.sdp || '').includes('a=candidate:');

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

    const candidateGraceTimer = window.setTimeout(() => {
      if (hasCandidate) finish();
    }, 2500);

    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) hasCandidate = true;
      if (!event.candidate || pc.iceGatheringState === 'complete') finish();
    };

    const onGatheringStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    };

    pc.addEventListener('icecandidate', onCandidate);
    pc.addEventListener('icegatheringstatechange', onGatheringStateChange);
  });
}

// --- App Component ---
export default function App() {
  const [streamUrl, setStreamUrl] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [bitrateLimit, setBitrateLimit] = useState(1500); // kbps
  const [stats, setStats] = useState<NetworkStats>({ bitrate: 0, packetLoss: 0, latency: 0, fps: 0 });
  const [isHealthy, setIsHealthy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment'); // Default ke belakang
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const statsIntervalRef = useRef<number | null>(null);

  // --- Network Monitoring ---
  const updateStats = useCallback(async () => {
    if (!pcRef.current) return;
    
    try {
      const reports = await pcRef.current.getStats();
      let outboundRtp: any = null;
      let candidatePair: any = null;

      reports.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          outboundRtp = report;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          candidatePair = report;
        }
      });

      if (outboundRtp) {
        const now = performance.now();
        const bytesSent = outboundRtp.bytesSent;
        const framesEncoded = outboundRtp.framesEncoded;
        
        const lastBytes = (pcRef.current as any)._lastBytes || bytesSent;
        const lastFrames = (pcRef.current as any)._lastFrames || framesEncoded;
        const lastTime = (pcRef.current as any)._lastTime || now;
        
        const duration = (now - lastTime) / 1000; // seconds
        if (duration > 0) {
          const bitrate = ((bytesSent - lastBytes) * 8) / (duration * 1000); // kbps
          const fps = (framesEncoded - lastFrames) / duration;

          setStats(prev => ({
            ...prev,
            bitrate: Math.round(bitrate),
            fps: Math.round(fps),
            packetLoss: outboundRtp.packetsLost || 0,
            latency: candidatePair ? Math.round(candidatePair.currentRoundTripTime * 1000) : 0
          }));

          // Health Check - Jika bitrate 0 tapi streaming jalan, tandai tidak sehat
          setIsHealthy(bitrate > 100);
        }

        (pcRef.current as any)._lastBytes = bytesSent;
        (pcRef.current as any)._lastFrames = framesEncoded;
        (pcRef.current as any)._lastTime = now;
      }
    } catch (err) {
      console.error('Failed to get stats', err);
    }
  }, []);

  // --- WebRTC Logic ---
  const stopStreaming = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    setIsStreaming(false);
    setIsHealthy(true);
    setStats({ bitrate: 0, packetLoss: 0, latency: 0, fps: 0 });
  }, []);

  const toggleCamera = async () => {
    const newMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(newMode);
    
    if (isStreaming) {
      // Re-initialize stream if already streaming
      stopStreaming();
      setTimeout(() => startStreaming(newMode), 500);
    } else {
      // Just update preview
      try {
        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(t => t.stop());
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: newMode, width: 640, height: 360 },
          audio: true
        });
        localStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (e) {
        console.error("Gagal ganti kamera preview", e);
      }
    }
  };

  const startStreaming = async (mode = facingMode) => {
    const whipUrl = streamUrl.trim();
    if (!whipUrl) {
      setError('Masukkan URL WebRTC (WHIP) dari Cloudflare');
      return;
    }

    setError(null);
    try {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }

      // 1. Get User Media - Locked to 360p
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 30 }
        },
        audio: true
      });
      
      localStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      // 2. Setup PeerConnection dengan STUN yang lebih kuat
      const pc = new RTCPeerConnection({
        iceServers: STUN_SERVERS,
        iceCandidatePoolSize: 10
      });
      pcRef.current = pc;

      // 3. Add tracks
      stream.getAudioTracks().forEach(track => pc.addTrack(track, stream));
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error('Kamera tidak mengirim video track. Periksa izin kamera Android.');
      }

      const videoTransceiver = pc.addTransceiver(videoTrack, {
        direction: 'sendonly',
        streams: [stream],
      });
      preferCloudflareVideoCodecs(videoTransceiver);

      const videoSender = videoTransceiver.sender;
      const params = videoSender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = bitrateLimit * 1000;
      // @ts-ignore - Some browsers support this before it appears in TS DOM types.
      params.degradationPreference = 'maintain-framerate';
      try {
        await videoSender.setParameters(params);
      } catch (err) {
        console.warn('Unable to apply video sender parameters', err);
      }

      // 4. Create Offer
      const offer = await pc.createOffer();

      await pc.setLocalDescription(offer);

      // 5. Wait briefly for ICE candidates before sending the WHIP offer.
      await waitForIceCandidates(pc);

      // 6. POST to WHIP endpoint
      const response = await fetch(whipUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
        },
        body: pc.localDescription?.sdp
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Cloudflare Error (${response.status}): ${errText}`);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      setIsStreaming(true);
      statsIntervalRef.current = window.setInterval(updateStats, 1000);

    } catch (err: any) {
      setError(err.message || 'Gagal memulai streaming');
      stopStreaming();
    }
  };

  useEffect(() => {
    // Initial preview setup
    const setupPreview = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: 640, height: 360 },
          audio: true
        });
        localStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (e) {
        console.warn("Kamera tidak ditemukan atau ditolak", e);
      }
    };
    setupPreview();
    return () => stopStreaming();
  }, [stopStreaming]);

  return (
    <div className="min-h-screen bg-[#f3f4f6] text-[#111214] font-sans selection:bg-blue-500/20">
      <main className="w-full px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <section className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-7xl flex-col gap-5 rounded-[8px] bg-[#d9d9d9] p-5 shadow-sm sm:p-8 lg:min-h-[calc(100vh-5rem)] lg:p-12">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-4xl font-normal tracking-normal text-black sm:text-5xl">
                Cloudflare WHIP Streamer
              </h1>
              <div className="mt-3 flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${isStreaming ? (isHealthy ? 'bg-red-500 animate-pulse' : 'bg-orange-500 animate-bounce') : 'bg-black/20'}`} />
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-black/45">
                  {isStreaming ? (isHealthy ? 'Live Broadcast' : 'Connection Unstable') : 'System Idle'}
                </p>
              </div>
            </div>

            <div className="flex gap-2 self-start sm:self-auto">
              <button
                onClick={toggleCamera}
                className="flex h-11 w-11 items-center justify-center rounded-[6px] bg-white/70 text-black/65 shadow-sm transition-all hover:bg-white active:scale-95"
                title="Switch Camera"
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

          <div className="grid flex-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(320px,430px)] xl:gap-12">
            <section className="relative overflow-hidden bg-black shadow-sm">
              <div className="aspect-video w-full">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover"
                  id="preview-video"
                />
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
                      <p className="text-xs leading-relaxed text-white/55">Check your 4G signal. Video may be lagging or frozen at 0 kbps.</p>
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
                      <p className="text-sm font-bold uppercase tracking-tight">Broadcast Failed</p>
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
                  <p className="font-mono text-2xl font-bold leading-none text-black">
                    {stats.fps}
                  </p>
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
                    onChange={(e) => setStreamUrl(e.target.value)}
                    placeholder="https://.../webRTC/publish"
                    className="w-full rounded-[6px] border border-black/10 bg-white px-4 py-3 font-mono text-sm text-black outline-none transition-all placeholder:text-black/25 focus:border-blue-500"
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <label className="text-[11px] font-bold uppercase tracking-[0.16em] text-black/45">Max Bitrate</label>
                    <span className="font-mono text-sm font-bold text-blue-600">{bitrateLimit} <span className="text-xs text-black/35">kbps</span></span>
                  </div>
                  <input
                    type="range"
                    min="300"
                    max="5000"
                    step="100"
                    value={bitrateLimit}
                    onChange={(e) => setBitrateLimit(parseInt(e.target.value))}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-black/10 accent-blue-600"
                  />
                </div>

                <div className="flex items-center gap-3 rounded-[6px] border border-blue-500/15 bg-blue-500/5 p-4 text-black/65">
                  <Video size={18} className="shrink-0 text-blue-600" />
                  <p className="text-xs leading-relaxed">
                    <span className="font-bold uppercase tracking-[0.12em] text-blue-700">Fixed Resolution</span>
                    <br />
                    <span className="font-mono">360p @ 30fps | Cloudflare-compatible codecs</span>
                  </p>
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
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}
