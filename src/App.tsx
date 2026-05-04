/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Camera, 
  Settings, 
  Activity, 
  Radio, 
  Wifi, 
  WifiOff, 
  AlertCircle,
  Play,
  Square,
  ChevronDown,
  RefreshCw,
  Video
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants & Types ---
const RESOLUTION_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 30 }
};

interface NetworkStats {
  bitrate: number; // in kbps
  packetLoss: number;
  latency: number;
  fps: number;
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
        // Calculate bitrate
        const now = performance.now();
        const bytesSent = outboundRtp.bytesSent;
        const framesEncoded = outboundRtp.framesEncoded;
        
        // Simple delta calculation (this would be better with stored previous values)
        // For simplicity, we just show current total and state
        const lastBytes = (pcRef.current as any)._lastBytes || 0;
        const lastTime = (pcRef.current as any)._lastTime || now;
        
        const bitrate = ((bytesSent - lastBytes) * 8) / (now - lastTime); // kbps
        const fps = (framesEncoded - ((pcRef.current as any)._lastFrames || 0)) / ((now - lastTime) / 1000);

        setStats(prev => ({
          ...prev,
          bitrate: Math.round(bitrate),
          fps: Math.round(fps),
          packetLoss: outboundRtp.packetsLost || 0,
          latency: candidatePair ? Math.round(candidatePair.currentRoundTripTime * 1000) : 0
        }));

        (pcRef.current as any)._lastBytes = bytesSent;
        (pcRef.current as any)._lastFrames = framesEncoded;
        (pcRef.current as any)._lastTime = now;

        // Health Check
        const healthy = bitrate > 200 && (outboundRtp.packetsLost / outboundRtp.packetsSent < 0.1);
        setIsHealthy(healthy);
      }
    } catch (err) {
      console.error('Failed to get stats', err);
    }
  }, []);

  // --- WebRTC Logic ---
  const stopStreaming = useCallback(() => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
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
  }, []);

  const startStreaming = async () => {
    if (!streamUrl) {
      setError('Please input a WebRTC (WHIP) URL');
      return;
    }

    setError(null);
    try {
      // 1. Get User Media - Locked to 360p
      const stream = await navigator.mediaDevices.getUserMedia({
        video: RESOLUTION_CONSTRAINTS,
        audio: true
      });
      
      localStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      // 2. Setup PeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pcRef.current = pc;

      // 3. Add tracks
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // 4. Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 5. Wait for ICE gathering complete (WHIP requirement)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') resolve();
        else {
          const check = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', check);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', check);
        }
      });

      // 6. POST to WHIP endpoint
      const response = await fetch(streamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
        },
        body: pc.localDescription?.sdp
      });

      if (!response.ok) {
        throw new Error(`WHIP server returned ${response.status}: ${await response.text()}`);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // 7. Apply Bitrate Limit
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track?.kind === 'video');
      if (videoSender) {
        const params = videoSender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = bitrateLimit * 1000;
        await videoSender.setParameters(params);
      }

      setIsStreaming(true);
      statsIntervalRef.current = window.setInterval(updateStats, 1000);

    } catch (err: any) {
      setError(err.message || 'Failed to start stream');
      stopStreaming();
    }
  };

  useEffect(() => {
    return () => stopStreaming();
  }, [stopStreaming]);

  return (
    <div className="min-h-screen bg-[#151619] text-white font-sans selection:bg-orange-500/30 overflow-hidden flex flex-col">
      {/* --- UI Header / Status Bar --- */}
      <header className="p-4 border-b border-white/5 flex items-center justify-between bg-[#1a1b1e]">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isStreaming ? (isHealthy ? 'bg-red-500 animate-pulse' : 'bg-orange-500') : 'bg-white/20'}`} />
          <h1 className="text-xs font-mono uppercase tracking-widest font-bold text-white/70">
            {isStreaming ? 'Live Broadcast' : 'System Ready'}
          </h1>
        </div>
        
        <div className="flex gap-4">
          <AnimatePresence>
            {!isHealthy && isStreaming && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="bg-orange-950/50 border border-orange-500/50 px-2 py-1 rounded flex items-center gap-2"
              >
                <AlertCircle size={14} className="text-orange-500" />
                <span className="text-[10px] uppercase font-bold text-orange-200">Poor Connection</span>
              </motion.div>
            )}
          </AnimatePresence>
          
          <button 
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 hover:bg-white/5 rounded-full transition-colors"
          >
            <Settings size={20} className={showSettings ? 'text-orange-500' : 'text-white/40'} />
          </button>
        </div>
      </header>

      {/* --- Viewport Container --- */}
      <main className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
        <video 
          ref={videoRef}
          autoPlay 
          playsInline 
          muted 
          className="w-full h-full object-cover grayscale-[0.2]"
          id="preview-video"
        />

        {/* --- Stats Overlay (Floating) --- */}
        <AnimatePresence>
          {isStreaming && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute top-4 left-4 z-10 space-y-1"
            >
              <div className="bg-black/60 backdrop-blur-md border border-white/10 p-3 rounded-xl flex flex-col gap-2 min-w-[140px]">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-1.5 opacity-60">
                    <Radio size={12} />
                    <span className="text-[10px] font-mono uppercase tracking-tighter">Bitrate</span>
                  </div>
                  <span className={`text-xs font-mono font-bold ${stats.bitrate < 300 ? 'text-orange-500' : 'text-white'}`}>
                    {stats.bitrate} <span className="opacity-40 font-normal">kbps</span>
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-1.5 opacity-60">
                    <Video size={12} />
                    <span className="text-[10px] font-mono uppercase tracking-tighter">FPS</span>
                  </div>
                  <span className="text-xs font-mono font-bold">
                    {stats.fps}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-1.5 opacity-60">
                    <Activity size={12} />
                    <span className="text-[10px] font-mono uppercase tracking-tighter">Latency</span>
                  </div>
                  <span className="text-xs font-mono font-bold">
                    {stats.latency}<span className="opacity-40 font-normal">ms</span>
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* --- No Signal Placeholder --- */}
        {!isStreaming && !videoRef.current?.srcObject && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0e10]">
             <div className="w-16 h-16 border border-white/5 rounded-full flex items-center justify-center text-white/10 mb-4">
                <Camera size={32} />
             </div>
             <p className="text-white/20 font-mono text-[10px] uppercase tracking-widest">No Active Input</p>
          </div>
        )}

        {/* --- Error Toast --- */}
        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-24 left-4 right-4 bg-red-500 text-white p-4 rounded-xl flex items-center gap-3 shadow-2xl z-50"
            >
              <AlertCircle size={20} />
              <p className="text-sm font-medium">{error}</p>
              <button onClick={() => setError(null)} className="ml-auto opacity-70 hover:opacity-100 uppercase text-[10px] font-bold">Dismiss</button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* --- Control Panel (BottomSheet feel) --- */}
      <footer className="bg-[#1a1b1e] p-6 pb-10 border-t border-white/5 space-y-6">
        
        <AnimatePresence>
          {showSettings && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden space-y-4"
            >
              <div className="space-y-4">
                 <div className="space-y-2">
                   <label className="text-[10px] font-mono uppercase text-white/40 tracking-wider">WHIP Endpoint URL</label>
                   <div className="relative">
                     <input 
                       id="stream-url-input"
                       type="text" 
                       value={streamUrl}
                       onChange={(e) => setStreamUrl(e.target.value)}
                       placeholder="https://customer-xxx.cloudflarestream.com/webRTC/..."
                       className="w-full bg-black/40 border border-white/10 p-3 rounded-xl text-sm font-mono placeholder:text-white/10 focus:border-orange-500/50 outline-none transition-all pr-12"
                     />
                     <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20">
                        <ChevronDown size={16} />
                     </div>
                   </div>
                 </div>

                 <div className="space-y-3">
                   <div className="flex justify-between items-end">
                      <label className="text-[10px] font-mono uppercase text-white/40 tracking-wider">Target Bitrate</label>
                      <span className="text-xs font-mono font-bold text-orange-500">{bitrateLimit} KBPS</span>
                   </div>
                   <input 
                     id="bitrate-slider"
                     type="range" 
                     min="100" 
                     max="4000" 
                     step="100"
                     value={bitrateLimit}
                     onChange={(e) => setBitrateLimit(parseInt(e.target.value))}
                     className="w-full accent-orange-500 bg-white/10 h-1.5 rounded-lg appearance-none cursor-pointer"
                   />
                   <div className="flex justify-between text-[8px] font-mono text-white/20 uppercase tracking-tighter">
                      <span>Low Bandwidth</span>
                      <span>High Quality</span>
                   </div>
                 </div>

                 <div className="flex items-center gap-4 bg-white/5 p-3 rounded-xl border border-white/5">
                    <div className="p-2 bg-black/40 rounded-lg text-white/40">
                      <Video size={16} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase text-white/70">Resolution Locked</p>
                      <p className="text-[10px] font-mono text-white/30">360p (640x360) @ 30 FPS</p>
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
              id="start-stream-btn"
              onClick={startStreaming}
              disabled={!streamUrl}
              className="flex-1 bg-orange-500 hover:bg-orange-600 disabled:bg-white/5 disabled:text-white/10 text-black font-bold h-14 rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95 group shadow-[0_0_20px_rgba(249,115,22,0.2)]"
            >
              <Play size={20} fill="currentColor" />
              <span className="uppercase tracking-tight">Go Live</span>
            </button>
          ) : (
            <button 
              id="stop-stream-btn"
              onClick={stopStreaming}
              className="flex-1 bg-white text-black font-bold h-14 rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95 group shadow-xl"
            >
              <Square size={20} fill="currentColor" />
              <span className="uppercase tracking-tight">Stop Stream</span>
            </button>
          )}

          <button 
             id="reset-btn"
             onClick={() => window.location.reload()}
             className="w-14 h-14 border border-white/10 rounded-2xl flex items-center justify-center hover:bg-white/5 transition-colors group"
          >
            <RefreshCw size={20} className="text-white/40 group-hover:rotate-45 transition-transform" />
          </button>
        </div>
      </footer>
    </div>
  );
}
