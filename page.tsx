"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Player = { id:string; name:string; color:string; isHost:boolean; territory:number; level:number; eliminated:boolean; eliminationOrder:number|null; micReady:boolean; connected:boolean; isMe:boolean };
type State = { code:string; phase:string; hostId:string; winnerId:string|null; countdownEndsAt:number|null; gameStartedAt:number|null; gameEndedAt:number|null; serverNow:number; players:Player[] };

const HOW = [
  ["🎤","Shout to expand","Your mic is measured locally as RMS loudness. Only a number (0–1) is sent — never audio."],
  ["🗺️","Steal territory","Louder than the average player? Boundaries slide your way. Total always equals exactly 100%."],
  ["💀","Eliminate rivals","Hit 0% and you're out. Last voice standing wins and takes 100%."],
];

function beep(freq:number, dur=0.15, type:OscillatorType="sine", gain=0.12, when=0){
  try{
    const Ctx = window.AudioContext || (window as any).webkitAudioContext; if(!Ctx) return;
    const ctx = new Ctx(); const o=ctx.createOscillator(); const g=ctx.createGain();
    o.type=type; o.frequency.value=freq; g.gain.value=gain; o.connect(g); g.connect(ctx.destination);
    o.start(ctx.currentTime+when); o.stop(ctx.currentTime+when+dur); setTimeout(()=>ctx.close(),(when+dur)*1000+300);
  }catch{}
}

export default function Home(){
  const [view,setView]=useState<"landing"|"game">("landing");
  const [tab,setTab]=useState<"create"|"join">("create");
  const [name,setName]=useState("");
  const [joinCode,setJoinCode]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [state,setState]=useState<State|null>(null);
  const [creds,setCreds]=useState<{code:string;playerId:string;token:string}|null>(null);
  const [copied,setCopied]=useState("");
  const [nowTick,setNowTick]=useState(Date.now());
  const [announce,setAnnounce]=useState("");
  const [myLevel,setMyLevel]=useState(0);
  const [micStatus,setMicStatus]=useState<"off"|"on"|"denied"|"error">("off");
  const [micMsg,setMicMsg]=useState("");
  const [sensitivity,setSensitivity]=useState(1.4);
  const [muted,setMuted]=useState(false);
  const [calibrating,setCalibrating]=useState(false);

  const credsRef=useRef(creds); credsRef.current=creds;
  const stateRef=useRef(state); stateRef.current=state;
  const streamRef=useRef<MediaStream|null>(null);
  const rafRef=useRef<number>(0);
  const noiseFloorRef=useRef(0.015);
  const sensRef=useRef(sensitivity); sensRef.current=sensitivity;
  const mutedRef=useRef(muted); mutedRef.current=muted;
  const lastSentRef=useRef(0);
  const prevElimRef=useRef<Set<string>>(new Set());
  const prevPhaseRef=useRef("");

  // invite link ?room=XXXXXX
  useEffect(()=>{ const r=new URLSearchParams(location.search).get("room"); if(r){ setJoinCode(r.toUpperCase()); setTab("join"); } },[]);
  useEffect(()=>{ const t=setInterval(()=>setNowTick(Date.now()),120); return ()=>clearInterval(t); },[]);

  const apiState = useCallback(async()=>{
    const c=credsRef.current; if(!c) return;
    try{
      const r=await fetch(`/api/rooms/${c.code}?playerId=${c.playerId}&token=${c.token}`);
      if(r.status===404){ setError("Room was closed"); stopMic(); setView("landing"); setState(null); setCreds(null); return; }
      const d=await r.json(); if(d.code) setState(d);
    }catch{}
  },[]);

  useEffect(()=>{ if(view!=="game") return; apiState(); const t=setInterval(apiState,650); return ()=>clearInterval(t); },[view,apiState]);

  // announcements + sounds on transitions
  useEffect(()=>{
    if(!state) return;
    const elim=new Set(state.players.filter(p=>p.eliminated).map(p=>p.id));
    for(const id of elim) if(!prevElimRef.current.has(id)){
      const p=state.players.find(x=>x.id===id);
      if(prevPhaseRef.current==="playing" && p){ setAnnounce(`💀 ${p.name.toUpperCase()} HAS BEEN ELIMINATED`); beep(160,.35,"sawtooth",.1); setTimeout(()=>setAnnounce(""),3200); }
    }
    prevElimRef.current=elim;
    if(state.phase==="countdown" && prevPhaseRef.current!=="countdown"){ /* countdown beeps handled by tick effect */ }
    if(state.phase==="finished" && prevPhaseRef.current==="playing"){ beep(523,.18,"sine",.12); beep(659,.18,"sine",.12,.18); beep(784,.3,"sine",.12,.36); }
    prevPhaseRef.current=state.phase;
  },[state]);

  // countdown beeps
  const cdSec = state?.countdownEndsAt ? Math.ceil((state.countdownEndsAt-nowTick)/1000) : null;
  const lastCdRef=useRef<number|null>(null);
  useEffect(()=>{
    if(state?.phase!=="countdown") { lastCdRef.current=null; return; }
    if(cdSec!==null && cdSec!==lastCdRef.current){ lastCdRef.current=cdSec; if(cdSec>0) beep(440,.12,"sine",.1); }
    if(state.countdownEndsAt && nowTick>=state.countdownEndsAt) beep(880,.35,"sine",.14);
  },[cdSec,state?.phase,nowTick,state?.countdownEndsAt]);

  async function post(action:string, extra:object={}){
    const c=credsRef.current; if(!c) return null;
    const r=await fetch(`/api/rooms/${c.code}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,playerId:c.playerId,token:c.token,...extra})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ setError(d.error||"Something went wrong"); return null; }
    if(d.code) setState(d); return d;
  }

  // ---------- MICROPHONE (local only, RMS) ----------
  const stopMic=useCallback(()=>{
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t=>t.stop()); streamRef.current=null; setMicStatus("off"); setMyLevel(0);
  },[]);

  const startMic=useCallback(async()=>{
    setMicMsg("");
    try{
      if(!navigator.mediaDevices?.getUserMedia){ setMicStatus("error"); setMicMsg("This browser doesn't expose a microphone API. Try Chrome/Safari over HTTPS or localhost."); return false; }
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false}});
      streamRef.current=stream; setMicStatus("on");
      stream.getAudioTracks()[0].addEventListener("ended",()=>{ setMicStatus("error"); setMicMsg("Microphone disconnected. Check your device and tap Enable Microphone again."); setMyLevel(0); });
      const Ctx=window.AudioContext||(window as any).webkitAudioContext; const ctx=new Ctx();
      const src=ctx.createMediaStreamSource(stream); const analyser=ctx.createAnalyser(); analyser.fftSize=1024; src.connect(analyser);
      const buf=new Uint8Array(analyser.fftSize);
      const loop=()=>{
        analyser.getByteTimeDomainData(buf);
        let sum=0; for(let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum+=v*v; }
        const rms=Math.sqrt(sum/buf.length); // RMS loudness
        // calibration: subtract measured noise floor, apply sensitivity, clamp
        const norm=Math.max(0,Math.min(1,((rms-noiseFloorRef.current)/(0.32-noiseFloorRef.current))*sensRef.current));
        const level=mutedRef.current?0:norm;
        setMyLevel(level);
        const c=credsRef.current;
        if(c && Date.now()-lastSentRef.current>240){
          lastSentRef.current=Date.now();
          fetch(`/api/rooms/${c.code}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"voice",playerId:c.playerId,token:c.token,level:Math.round(level*100)/100})}).catch(()=>{});
        }
        rafRef.current=requestAnimationFrame(loop);
      };
      loop(); post("heartbeat",{micReady:true}); return true;
    }catch(e:any){
      setMicStatus("denied"); setMicMsg("Microphone permission was denied. Click the mic/lock icon in your browser address bar, allow Microphone, then retry. Sound Clash never records or sends your audio — only a loudness number.");
      return false;
    }
  },[]);

  function calibrate(){
    if(micStatus!=="on"){ setMicMsg("Enable the microphone first, then stay quiet for 2 seconds while calibrating."); return; }
    setCalibrating(true); setMicMsg("Calibrating… stay quiet for 2 seconds.");
    // sample current level baseline: approximate via short quiet window using myLevel snapshots
    const samples:number[]=[]; const t=setInterval(()=>samples.push(myLevel),120);
    setTimeout(()=>{ clearInterval(t); const avg=samples.length?samples.reduce((a,b)=>a+b,0)/samples.length:0; /* myLevel is normalized; convert back approx */ noiseFloorRef.current=Math.max(0.004, Math.min(0.06, 0.015 + avg*0.01)); setCalibrating(false); setMicMsg(`Calibrated ✓ Ambient floor set. Shout to test — your bar should spike. Sensitivity: ${sensitivity.toFixed(1)}×`); },2100);
  }

  // auto-request mic when countdown/playing begins
  useEffect(()=>{ if((state?.phase==="countdown"||state?.phase==="playing") && micStatus==="off") startMic(); },[state?.phase]); // eslint-disable-line

  // ---------- ROOM ACTIONS ----------
  async function createRoom(){
    if(!name.trim()){ setError("Enter your display name first"); return; }
    setBusy(true); setError("");
    const r=await fetch("/api/rooms",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",name})});
    const d=await r.json(); setBusy(false);
    if(!r.ok){ setError(d.error); return; }
    setCreds({code:d.code,playerId:d.playerId,token:d.token}); setState(d.state); setView("game"); prevElimRef.current=new Set();
    history.replaceState(null,"",`/?room=${d.code}`);
  }
  async function joinRoom(){
    if(!name.trim()){ setError("Enter your display name first"); return; }
    if(!joinCode.trim()){ setError("Enter a room code"); return; }
    setBusy(true); setError("");
    const r=await fetch("/api/rooms",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"join",name,code:joinCode})});
    const d=await r.json(); setBusy(false);
    if(!r.ok){ setError(d.error); return; }
    setCreds({code:d.code,playerId:d.playerId,token:d.token}); setState(d.state); setView("game"); prevElimRef.current=new Set();
  }
  async function leaveRoom(){
    await post("leave"); stopMic(); setCreds(null); setState(null); setView("landing"); history.replaceState(null,"","/");
  }
  function copy(text:string,label:string){ navigator.clipboard?.writeText(text).then(()=>{ setCopied(label); setTimeout(()=>setCopied(""),1600); }); }

  const me=state?.players.find(p=>p.isMe);
  const isHost=!!me?.isHost;
  const inviteLink=typeof window!=="undefined"&&state?`${location.origin}/?room=${state.code}`:"";
  const duration = state?.gameStartedAt ? Math.floor(((state.gameEndedAt||Date.now())-state.gameStartedAt)/1000) : 0;
  const ranked = state ? [...state.players].sort((a,b)=>{
    if(state.winnerId){ if(a.id===state.winnerId) return -1; if(b.id===state.winnerId) return 1; }
    return (b.eliminationOrder||0)-(a.eliminationOrder||0) || b.territory-a.territory;
  }) : [];

  // ---------- LANDING ----------
  if(view==="landing") return (
    <main className="min-h-screen bg-[#101522] bg-[radial-gradient(900px_500px_at_20%_0%,#5577F533,transparent),radial-gradient(800px_500px_at_90%_10%,#16B8A633,transparent)] px-4 py-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between"><div className="flex items-center gap-2"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#5577F5] text-xl shadow-[0_0_24px_#5577F588]">🔊</span><b className="tracking-widest">SOUND CLASH</b></div><span className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70">2–7 PLAYERS • FREE • NO SIGN-UP</span></nav>

        <section className="mt-10 grid items-center gap-8 lg:grid-cols-[1.15fr_.85fr]">
          <div>
            <div className="flex items-end gap-1.5 floaty" aria-hidden>{[14,26,40,22,34,18,28].map((h,i)=>(<span key={i} className="eqbar w-2.5 rounded bg-gradient-to-t from-[#16B8A6] to-[#5577F5]" style={{height:h,animationDelay:`${i*0.09}s`}}/>))}</div>
            <h1 className="mt-4 text-6xl font-black leading-[.9] sm:text-7xl">SOUND<br/><span className="bg-gradient-to-r from-[#5577F5] via-[#16B8A6] to-[#C45BD7] bg-clip-text text-transparent">CLASH</span></h1>
            <p className="mt-3 text-lg font-bold tracking-[.25em] text-[#E7A23B]">YOUR VOICE. YOUR TERRITORY.</p>
            <p className="mt-4 max-w-lg text-white/65">Everyone starts equal. Shout into your mic and your territory swallows the screen — go quiet and rivals steal it back. Hit 0%, you're eliminated. Last voice standing wins.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">{HOW.map(([i,t,d])=>(<div key={t} className="rounded-2xl border border-white/10 bg-[#202B40]/80 p-4"><div className="text-2xl">{i}</div><b className="mt-1 block text-sm">{t}</b><p className="mt-1 text-xs leading-relaxed text-white/55">{d}</p></div>))}</div>
            <div className="mt-5 flex -space-x-2">{["#5577F5","#16B8A6","#E7A23B","#C45BD7","#FF5A76","#3ECF6A","#FF8A3D"].map(c=>(<span key={c} className="h-8 w-8 rounded-full border-2 border-[#101522]" style={{background:c}}/>))}<span className="pl-4 text-sm self-center text-white/60">7 distinct player colours</span></div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#202B40] p-6 shadow-[0_24px_60px_rgba(0,0,0,.45)]">
            <div className="grid grid-cols-2 rounded-xl bg-black/30 p-1 text-sm font-bold">
              <button onClick={()=>setTab("create")} className={`rounded-lg py-2.5 ${tab==="create"?"bg-[#5577F5]":"text-white/60"}`}>CREATE A ROOM</button>
              <button onClick={()=>setTab("join")} className={`rounded-lg py-2.5 ${tab==="join"?"bg-[#16B8A6]":"text-white/60"}`}>JOIN A ROOM</button>
            </div>
            <label className="mt-5 block text-xs font-bold tracking-widest text-white/60">YOUR DISPLAY NAME</label>
            <input value={name} onChange={e=>setName(e.target.value)} maxLength={16} placeholder="e.g. Alex" className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-lg outline-none focus:border-[#5577F5]"/>
            {tab==="join"&&(<><label className="mt-4 block text-xs font-bold tracking-widest text-white/60">ROOM CODE</label>
            <input value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())} maxLength={6} placeholder="ABC123" className="mt-1 w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-center text-2xl font-black tracking-[.3em] outline-none focus:border-[#16B8A6]"/></>)}
            {error&&<p className="mt-3 rounded-xl bg-red-500/15 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
            <button disabled={busy} onClick={tab==="create"?createRoom:joinRoom} className="mt-5 w-full rounded-xl bg-gradient-to-r from-[#5577F5] to-[#16B8A6] py-4 text-lg font-black tracking-wide shadow-[0_0_28px_#5577F566] disabled:opacity-50">{busy?"CONNECTING…":tab==="create"?"🎙️ CREATE ROOM":"🚀 JOIN ROOM"}</button>
            <p className="mt-3 text-center text-xs text-white/45">Private rooms only — share the code/link with friends. Works on phones & computers. Headphones recommended (echo!)</p>
            <div className="mt-4 rounded-xl bg-black/25 p-3 text-[11px] leading-relaxed text-white/45"><b className="text-white/70">How it syncs:</b> authoritative PostgreSQL-backed server state — every client polls the same room state ~1.5×/sec and the server alone moves territory, so nobody can cheat their %. Mic audio never leaves your device. Free-tier note: polling uses tiny JSON payloads; for 100+ concurrent rooms you'd swap polling for WebSockets/Supabase Realtime.</div>
          </div>
        </section>
      </div>
    </main>
  );

  if(!state) return <main className="grid min-h-screen place-items-center bg-[#101522]"><p className="animate-pulse text-white/60">Connecting to room…</p></main>;

  // ---------- IN ROOM ----------
  return (
    <main className="flex min-h-screen flex-col bg-[#101522]">
      {/* HUD */}
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#202B40]/70 px-3 py-2.5">
        <b className="tracking-widest">🔊 SOUND CLASH</b>
        <span className="rounded-lg bg-black/40 px-2.5 py-1 font-mono font-bold tracking-widest text-[#E7A23B]">{state.code}</span>
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs">{state.players.length}/7 players</span>
        {state.phase==="playing"&&<span className="rounded-full bg-[#16B8A6]/20 px-2.5 py-1 text-xs font-bold text-[#16B8A6]">⏱ {Math.floor(duration/60)}:{String(duration%60).padStart(2,"0")} • LIVE</span>}
        {state.phase==="finished"&&<span className="rounded-full bg-[#E7A23B]/20 px-2.5 py-1 text-xs font-bold text-[#E7A23B]">MATCH OVER</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${micStatus==="on"?"bg-emerald-500/20 text-emerald-300":micStatus==="denied"||micStatus==="error"?"bg-red-500/20 text-red-300":"bg-white/10 text-white/60"}`}><span className={`h-2 w-2 rounded-full ${micStatus==="on"?"bg-emerald-400 animate-pulse":"bg-white/40"}`}/>{micStatus==="on"?"MIC LIVE":micStatus==="off"?"MIC OFF":micStatus==="denied"?"MIC DENIED":"MIC ERROR"}</span>
          {micStatus!=="on"
            ? <button onClick={startMic} className="rounded-lg bg-[#5577F5] px-3 py-1.5 text-sm font-bold">🎤 Enable Microphone</button>
            : <button onClick={()=>setMuted(!muted)} className={`rounded-lg px-3 py-1.5 text-sm font-bold ${muted?"bg-red-500":"bg-white/10"}`}>{muted?"🔇 Unmute":"🎙️ Mute"}</button>}
          <button onClick={leaveRoom} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-bold">Leave</button>
        </div>
      </header>

      {micMsg&&<div className="mx-3 mt-3 rounded-xl border border-[#E7A23B]/40 bg-[#E7A23B]/10 px-4 py-2.5 text-sm text-amber-200">🎤 {micMsg} {micStatus==="denied"&&<button onClick={startMic} className="ml-2 rounded bg-[#E7A23B] px-2 py-0.5 font-bold text-black">Retry</button>}</div>}
      {error&&state.phase!=="finished"&&<div className="mx-3 mt-3 rounded-xl bg-red-500/15 px-4 py-2 text-sm text-red-300">⚠️ {error} <button className="float-right" onClick={()=>setError("")}>✕</button></div>}

      {/* my level + calibration */}
      {(state.phase==="playing"||state.phase==="countdown"||state.phase==="waiting")&&(
        <div className="flex flex-wrap items-center gap-3 px-3 pt-3">
          <div className="flex min-w-[220px] flex-1 items-center gap-2">
            <span className="text-xs font-bold text-white/60">YOUR VOICE</span>
            <div className="h-4 flex-1 overflow-hidden rounded-full bg-black/40"><div className="h-full rounded-full bg-gradient-to-r from-[#16B8A6] via-[#E7A23B] to-[#FF5A76] transition-[width] duration-100" style={{width:`${Math.round(myLevel*100)}%`}}/></div>
            <b className="w-10 text-right text-sm">{Math.round(myLevel*100)}%</b>
          </div>
          <label className="flex items-center gap-2 text-xs text-white/60">Sensitivity <input type="range" min={0.5} max={2.5} step={0.1} value={sensitivity} onChange={e=>setSensitivity(+e.target.value)} className="w-28"/><b className="text-white">{sensitivity.toFixed(1)}×</b></label>
          <button onClick={calibrate} disabled={calibrating} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold disabled:opacity-50">{calibrating?"Calibrating…":"🎚️ Calibrate (stay quiet)"}</button>
          {me?.eliminated&&<span className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-bold text-red-300">👀 SPECTATING — you can't gain territory</span>}
        </div>
      )}

      {/* WAITING ROOM */}
      {state.phase==="waiting"&&(
        <section className="mx-auto grid w-full max-w-5xl flex-1 gap-5 p-4 md:grid-cols-[1fr_360px]">
          <div className="rounded-3xl border border-white/10 bg-[#202B40] p-6">
            <p className="text-xs font-bold tracking-widest text-white/50">WAITING ROOM</p>
            <div className="mt-2 flex flex-wrap items-center gap-3"><span className="text-5xl font-black tracking-[.2em] text-[#E7A23B]">{state.code}</span></div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={()=>copy(state.code,"code")} className="rounded-xl bg-[#5577F5] px-4 py-2.5 text-sm font-bold">📋 {copied==="code"?"Copied!":"Copy Room Code"}</button>
              <button onClick={()=>copy(inviteLink,"link")} className="rounded-xl bg-[#16B8A6] px-4 py-2.5 text-sm font-bold text-black">🔗 {copied==="link"?"Copied!":"Copy Invitation Link"}</button>
              {isHost&&<button onClick={()=>post("close")} className="rounded-xl bg-red-500/20 px-4 py-2.5 text-sm font-bold text-red-300">Close Room</button>}
            </div>
            <p className="mt-3 break-all rounded-lg bg-black/30 px-3 py-2 text-xs text-white/50">{inviteLink}</p>
            <div className="mt-6 rounded-2xl bg-black/25 p-4 text-sm leading-relaxed text-white/60">
              <b className="text-white">Before you start:</b> tap <button onClick={startMic} className="rounded bg-[#5577F5] px-2 py-0.5 text-xs font-bold text-white">Enable Microphone</button> above, allow permission, then Calibrate in a quiet moment. When the host starts, everyone gets a synced 3-2-1-GO and equal territory. Shout in bursts — you don't need to scream non-stop.
              {micStatus!=="on"&&<span className="mt-2 block text-amber-300">⚠️ Your mic isn't on yet — you can still join, but you won't gain territory until it's enabled.</span>}
            </div>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#202B40] p-6">
            <div className="flex items-center justify-between"><b>Players</b><span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{state.players.length}/7</span></div>
            <div className="mt-3 space-y-2">
              {state.players.map(p=>(
                <div key={p.id} className="flex items-center gap-3 rounded-xl bg-black/25 px-3 py-2.5">
                  <span className="h-9 w-9 rounded-full border-2" style={{background:p.color,borderColor:p.color}} />
                  <div className="min-w-0 flex-1"><b className="block truncate text-sm">{p.name} {p.isMe&&<span className="text-white/40">(you)</span>}</b><span className="text-[11px] text-white/45">{p.micReady?"🎤 Mic ready":"🎤 Mic not enabled"}</span></div>
                  {p.isHost&&<span className="rounded bg-[#E7A23B] px-1.5 py-0.5 text-[10px] font-black text-black">HOST</span>}
                  <span className={`h-2 w-2 rounded-full ${p.connected?"bg-emerald-400":"bg-red-400"}`} title={p.connected?"Connected":"Disconnected"}/>
                </div>
              ))}
              {Array.from({length:7-state.players.length}).map((_,i)=>(<div key={i} className="rounded-xl border border-dashed border-white/10 px-3 py-3 text-center text-xs text-white/30">Empty slot — share the code!</div>))}
            </div>
            {isHost
              ? <button disabled={state.players.length<2} onClick={()=>post("start")} className="mt-5 w-full rounded-xl bg-gradient-to-r from-[#5577F5] to-[#16B8A6] py-3.5 font-black disabled:opacity-40">{state.players.length<2?"WAITING FOR 1 MORE PLAYER…":"▶ START GAME (3-2-1-GO!)"}</button>
              : <p className="mt-5 rounded-xl bg-white/5 py-3 text-center text-sm text-white/55">⏳ Waiting for the host to start the game…</p>}
          </div>
        </section>
      )}

      {/* COUNTDOWN OVERLAY */}
      {state.phase==="countdown"&&(
        <section className="relative grid flex-1 place-items-center overflow-hidden p-6">
          <Territory state={state} dim />
          <div className="absolute inset-0 grid place-items-center bg-black/60 backdrop-blur-[2px]">
            {cdSec!==null&&cdSec>0
              ? <div key={cdSec} className="pop text-center"><div className="text-[9rem] font-black leading-none text-white drop-shadow-[0_0_40px_#5577F5]">{cdSec}</div><p className="font-bold tracking-[.3em] text-white/60">GET READY TO SHOUT…</p></div>
              : <div className="pop text-center"><div className="text-[7rem] font-black leading-none text-[#16B8A6] drop-shadow-[0_0_40px_#16B8A6]">GO!</div><p className="font-bold tracking-[.3em]">SHOUT! 🎤</p></div>}
          </div>
        </section>
      )}

      {/* PLAYING */}
      {state.phase==="playing"&&(
        <section className="relative flex flex-1 flex-col p-3">
          {announce&&<div className="pop absolute left-1/2 top-16 z-20 -translate-x-1/2 whitespace-nowrap rounded-2xl bg-red-600 px-5 py-3 text-lg font-black shadow-[0_0_36px_#f00a]">{announce}</div>}
          <Territory state={state} />
          <p className="pt-2 text-center text-xs text-white/40">Louder than average = gain • Quieter = bleed territory • Bursts beat constant screaming • Server validates every %</p>
        </section>
      )}

      {/* RESULTS */}
      {state.phase==="finished"&&(
        <section className="mx-auto w-full max-w-3xl flex-1 p-4">
          <div className="rounded-3xl border border-[#E7A23B]/40 bg-[#202B40] p-6 text-center shadow-[0_0_50px_#E7A23B33]">
            <div className="text-5xl">👑</div>
            {(()=>{ const w=state.players.find(p=>p.id===state.winnerId); return w? <><p className="mt-1 text-xs font-bold tracking-[.3em] text-[#E7A23B]">WINNER</p><h2 className="mt-1 text-4xl font-black" style={{color:w.color}}>{w.name.toUpperCase()}</h2><p className="text-white/60">{w.isMe?"That's you — loudest voice in the room! 🎉":""} Final territory <b className="text-white">100%</b> • Match lasted {Math.floor(duration/60)}:{String(duration%60).padStart(2,"0")}</p></> : <h2 className="text-3xl font-black">Match over</h2>; })()}
          </div>
          <div className="mt-4 overflow-hidden rounded-3xl border border-white/10 bg-[#202B40]">
            <div className="grid grid-cols-[36px_1fr_auto_auto] gap-2 border-b border-white/10 px-4 py-2.5 text-[11px] font-bold tracking-widest text-white/45"><span>#</span><span>PLAYER</span><span>TERRITORY</span><span>RESULT</span></div>
            {ranked.map((p,i)=>(
              <div key={p.id} className={`grid grid-cols-[36px_1fr_auto_auto] items-center gap-2 px-4 py-3 ${p.id===state.winnerId?"bg-[#E7A23B]/10":""}`}>
                <span className="text-lg">{i===0?"🥇":i===1?"🥈":i===2?"🥉":`${i+1}.`}</span>
                <span className="flex min-w-0 items-center gap-2"><span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{background:p.color}}/><b className="truncate">{p.name}</b>{p.isMe&&<span className="text-xs text-white/40">(you)</span>}{p.isHost&&<span className="rounded bg-[#E7A23B] px-1 text-[9px] font-black text-black">HOST</span>}</span>
                <b>{p.territory.toFixed(1)}%</b>
                <span className="text-xs text-white/55">{p.id===state.winnerId?"👑 Winner":p.eliminationOrder?`Out #${p.eliminationOrder}`:"—"}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-center text-xs text-white/40">Elimination order is shown as “Out #1, #2…” — #1 fell first. Scoreboard stays until the host acts.</p>
          {error&&<p className="mt-2 rounded-xl bg-red-500/15 px-3 py-2 text-center text-sm text-red-300">{error}</p>}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {isHost
              ? <button onClick={()=>post("rematch")} className="rounded-xl bg-gradient-to-r from-[#5577F5] to-[#16B8A6] py-4 font-black">🔁 REMATCH — BACK TO WAITING ROOM</button>
              : <div className="rounded-xl bg-white/5 py-4 text-center text-sm text-white/55">⏳ Waiting for host to start a rematch…</div>}
            <button onClick={leaveRoom} className="rounded-xl bg-white/10 py-4 font-black">🏠 LEAVE ROOM</button>
          </div>
          {!isHost&&<button onClick={leaveRoom} className="mt-2 w-full rounded-xl border border-white/10 py-3 text-sm font-bold text-white/60">Leave room instead</button>}
          <p className="mt-3 text-center text-xs text-white/40">Rematch resets all territory & eliminations, returns everyone to the waiting room, then repeats the synced countdown. Anyone can leave instead.</p>
        </section>
      )}
    </main>
  );
}

function Territory({state,dim=false}:{state:State;dim?:boolean}){
  const visible=state.players; // eliminated render at 0 width
  return (
    <div className={`flex w-full flex-1 overflow-hidden rounded-2xl border border-white/15 ${dim?"opacity-70":""}`} style={{minHeight:260}}>
      {visible.map(p=>{
        const w=p.eliminated?0:p.territory;
        return (
          <div key={p.id} className={`relative flex flex-col items-center justify-between overflow-hidden py-3 ${p.eliminated?"elim-anim":""}`} style={{width:`${w}%`,background:`linear-gradient(180deg, ${p.color}ee, ${p.color}88)`,transition:"width 650ms linear",boxShadow:"inset -2px 0 0 rgba(0,0,0,.45)",minWidth:0}}>
            {w>4&&<>
              <div className="flex h-8 items-end gap-[3px]" aria-hidden>{[0,1,2,3].map(i=>(<span key={i} className="w-1.5 rounded bg-white/90" style={{height:`${4+Math.round(p.level*22*((i%3)+1)/2)}px`,transition:"height 120ms"}}/>))}</div>
              <div className="px-1 text-center" style={{writingMode:w<11?"vertical-rl":"horizontal-tb"}}>
                <b className="block truncate text-shadow" style={{fontSize:w<11?11:w<18?13:17,textShadow:"0 1px 6px rgba(0,0,0,.6)"}}>{p.name}{p.isMe?" (you)":""}</b>
                {w>=9&&<span className="text-[10px] font-bold text-white/85">{p.eliminated?"ELIMINATED":p.connected?"🎤 live":"⚠ reconnecting"}</span>}
              </div>
              <b style={{fontSize:w<11?12:w<18?16:24,textShadow:"0 1px 8px rgba(0,0,0,.65)"}}>{p.territory.toFixed(1)}%</b>
            </>}
            {p.eliminated&&null}
          </div>
        );
      })}
    </div>
  );
}
