/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Settings, 
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
  const [showSettings, setShowSettings] = useState(false);
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
    <div className="min-h-screen bg-[#151619] text-white font-sans selection:bg-orange-500/30 overflow-hidden flex flex-col">
      {/* --- UI Header --- */}
      <header className="p-4 border-b border-white/5 flex items-center justify-between bg-[#1a1b1e] z-20">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isStreaming ? (isHealthy ? 'bg-red-500 animate-pulse' : 'bg-orange-500 animate-bounce') : 'bg-white/20'}`} />
          <h1 className="text-[10px] font-mono uppercase tracking-[0.2em] font-bold text-white/50">
            {isStreaming ? (isHealthy ? 'Live Broadcast' : 'Connection Unstable') : 'System Idle'}
          </h1>
        </div>
        
        <div className="flex gap-2">
          <button 
            onClick={toggleCamera}
            className="p-2.5 bg-white/5 hover:bg-white/10 rounded-xl transition-all active:scale-90"
            title="Switch Camera"
          >
            <SwitchCamera size={18} className="text-white/70" />
          </button>
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className="p-2.5 bg-white/5 hover:bg-white/10 rounded-xl transition-all"
          >
            <Settings size={18} className={showSettings ? 'text-orange-500' : 'text-white/40'} />
          </button>
        </div>
      </header>

      {/* --- Viewport --- */}
      <main className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
        <video 
          ref={videoRef}
          autoPlay 
          playsInline 
          muted 
          className="w-full h-full object-cover"
          id="preview-video"
        />

        {/* --- Network Alert --- */}
        <AnimatePresence>
          {!isHealthy && isStreaming && (
            <motion.div 
               initial={{ opacity: 0, scale: 0.9 }}
               animate={{ opacity: 1, scale: 1 }}
               exit={{ opacity: 0 }}
               className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/80 backdrop-blur-xl border border-orange-500/50 p-6 rounded-3xl flex flex-col items-center gap-3 z-30 pointer-events-none"
            >
              <WifiOff size={32} className="text-orange-500" />
              <p className="text-sm font-bold uppercase tracking-widest text-orange-200">Poor Connection</p>
              <p className="text-[10px] text-white/40 text-center max-w-[200px]">Check your 4G signal. Video may be lagging or frozen at 0 kbps.</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* --- Stats HUD --- */}
        <AnimatePresence>
          {isStreaming && (
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="absolute top-4 left-4 z-10"
            >
              <div className="bg-black/40 backdrop-blur-md border border-white/10 p-3 rounded-2xl flex flex-col gap-2.5 min-w-[150px]">
                <div className="flex items-center justify-between gap-6">
                  <div className="flex items-center gap-2 opacity-50">
                    <Radio size={12} className="text-blue-400" />
                    <span className="text-[10px] font-mono uppercase">Bitrate</span>
                  </div>
                  <span className={`text-xs font-mono font-bold ${stats.bitrate < 100 ? 'text-red-500 animate-pulse' : 'text-green-400'}`}>
                    {stats.bitrate} <span className="text-[8px] opacity-40">kbps</span>
                  </span>
                </div>

                <div className="flex items-center justify-between gap-6">
                  <div className="flex items-center gap-2 opacity-50">
                    <Video size={12} />
                    <span className="text-[10px] font-mono uppercase">FPS</span>
                  </div>
                  <span className="text-xs font-mono font-bold">
                    {stats.fps}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-6">
                  <div className="flex items-center gap-2 opacity-50">
                    <Activity size={12} className="text-purple-400" />
                    <span className="text-[10px] font-mono uppercase">RTT</span>
                  </div>
                  <span className="text-xs font-mono font-bold text-white/80">
                    {stats.latency}<span className="text-[8px] opacity-20">ms</span>
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* --- Error Overlay --- */}
        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-28 left-4 right-4 bg-red-600 p-4 rounded-2xl flex flex-col gap-2 shadow-2xl z-50 border border-white/20"
            >
              <div className="flex items-center gap-3">
                <AlertCircle size={20} />
                <p className="text-sm font-bold uppercase tracking-tight">Broadcast Failed</p>
              </div>
              <p className="text-xs opacity-80 leading-relaxed font-mono">{error}</p>
              <button onClick={() => setError(null)} className="mt-2 w-full py-2 bg-black/20 rounded-lg text-[10px] uppercase font-bold hover:bg-black/30">Tutup Notifikasi</button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* --- Footer Controls --- */}
      <footer className="bg-[#1a1b1e] p-6 pb-10 border-t border-white/5 space-y-6 z-20">
        
        <AnimatePresence>
          {showSettings && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden space-y-5"
            >
              <div className="space-y-4">
                 <div className="space-y-2">
                   <label className="text-[10px] font-mono uppercase text-white/30 tracking-widest pl-1">WHIP Publish URL</label>
                   <input 
                     type="text" 
                     value={streamUrl}
                     onChange={(e) => setStreamUrl(e.target.value)}
                     placeholder="https://.../webRTC/publish"
                     className="w-full bg-black/60 border border-white/5 p-4 rounded-2xl text-sm font-mono placeholder:text-white/10 focus:border-orange-500/40 outline-none transition-all shadow-inner"
                   />
                 </div>

                 <div className="space-y-4">
                   <div className="flex justify-between items-center px-1">
                      <label className="text-[10px] font-mono uppercase text-white/30 tracking-widest">Max Bitrate</label>
                      <span className="text-sm font-mono font-bold text-orange-500">{bitrateLimit} <span className="text-[10px] opacity-40">kbps</span></span>
                   </div>
                   <div className="px-1">
                    <input 
                      type="range" 
                      min="300" 
                      max="5000" 
                      step="100"
                      value={bitrateLimit}
                      onChange={(e) => setBitrateLimit(parseInt(e.target.value))}
                      className="w-full accent-orange-500 bg-white/5 h-2 rounded-full appearance-none cursor-pointer"
                    />
                   </div>
                 </div>

                 <div className="flex items-center gap-4 bg-orange-500/5 p-4 rounded-2xl border border-orange-500/10">
                    <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center text-orange-500">
                      <Video size={18} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase text-orange-400">Fixed Resolution</p>
                      <p className="text-[11px] font-mono text-white/40 tracking-tight text-white/60">360p @ 30fps | Cloudflare-compatible codecs</p>
                    </div>
                 </div>
              </div>
              <div className="h-px bg-white/5 w-full" />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-4">
          {!isStreaming ? (
            <button 
              onClick={() => startStreaming()}
              disabled={!streamUrl}
              className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:bg-white/5 disabled:text-white/10 text-black font-black h-16 rounded-3xl flex items-center justify-center gap-4 transition-all active:scale-95 group shadow-2xl shadow-orange-500/20"
            >
              <Play size={22} fill="currentColor" />
              <span className="uppercase tracking-widest text-sm">Mulai Siaran</span>
            </button>
          ) : (
            <button 
              onClick={stopStreaming}
              className="flex-1 bg-white text-black font-black h-16 rounded-3xl flex items-center justify-center gap-4 transition-all active:scale-95 group shadow-2xl"
            >
              <Square size={22} fill="currentColor" />
              <span className="uppercase tracking-widest text-sm">Akhiri Sesi</span>
            </button>
          )}

          <button 
             onClick={() => window.location.reload()}
             className="w-16 h-16 bg-white/5 border border-white/5 rounded-3xl flex items-center justify-center hover:bg-white/10 transition-all active:scale-90"
          >
            <RefreshCw size={22} className="text-white/30" />
          </button>
        </div>
      </footer>
    </div>
  );
}
