import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rooms, players } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { loadRoom, publicState, authPlayer } from "@/lib/room";

export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const sp = req.nextUrl.searchParams;
  const playerId = sp.get("playerId") || "", token = sp.get("token") || "";
  const me = await authPlayer(code, playerId, token);
  if (me) await db.update(players).set({ lastSeen: new Date() }).where(eq(players.id, me.id));
  const loaded = await loadRoom(code);
  if (!loaded) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  return NextResponse.json(publicState(loaded.room, loaded.players, playerId));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const body = await req.json().catch(() => ({}));
  const { action, playerId, token } = body as any;
  const me = await authPlayer(code, playerId, token);
  if (!me && action !== "ping") return NextResponse.json({ error: "Unauthorized — invalid player session" }, { status: 401 });
  const loaded = await loadRoom(code);
  if (!loaded) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  const { room } = loaded;
  const isHost = me && room.hostId === me.id;

  if (action === "heartbeat") {
    await db.update(players).set({ lastSeen: new Date(), ...(typeof body.micReady === "boolean" ? { micReady: body.micReady } : {}) }).where(eq(players.id, me!.id));
  }
  else if (action === "voice") {
    // Only numerical level accepted; clamped & validated. Raw audio never leaves device.
    const raw = Number(body.level);
    if (!Number.isFinite(raw)) return NextResponse.json({ error: "Invalid level" }, { status: 400 });
    const level = Math.max(0, Math.min(1, raw));
    if (room.phase === "playing" && !me!.eliminated) {
      const smoothed = me!.smoothed * 0.55 + level * 0.45; // server-side smoothing, anti-spike
      await db.update(players).set({ level, smoothed, lastSeen: new Date() }).where(eq(players.id, me!.id));
    } else {
      await db.update(players).set({ level, lastSeen: new Date() }).where(eq(players.id, me!.id));
    }
  }
  else if (action === "start") {
    if (!isHost) return NextResponse.json({ error: "Only the host can start the game" }, { status: 403 });
    if (room.phase !== "waiting" && room.phase !== "finished") return NextResponse.json({ error: "Game already in progress" }, { status: 400 });
    const plist = loaded.players;
    if (plist.length < 2) return NextResponse.json({ error: "Need at least 2 players to start" }, { status: 400 });
    const share = 100 / plist.length;
    for (const p of plist) await db.update(players).set({ territory: share, eliminated: false, eliminationOrder: null, smoothed: 0, level: 0 }).where(eq(players.id, p.id));
    await db.update(rooms).set({ phase: "countdown", countdownEndsAt: new Date(Date.now() + 3600), winnerId: null, gameEndedAt: null, gameStartedAt: null, lastTickAt: new Date() }).where(eq(rooms.code, room.code));
  }
  else if (action === "rematch") {
    if (!isHost) return NextResponse.json({ error: "Only the host can start a rematch" }, { status: 403 });
    if (room.phase !== "finished") return NextResponse.json({ error: "Rematch is only available after a match finishes" }, { status: 400 });
    for (const p of loaded.players) await db.update(players).set({ territory: 0, eliminated: false, eliminationOrder: null, smoothed: 0, level: 0 }).where(eq(players.id, p.id));
    await db.update(rooms).set({ phase: "waiting", winnerId: null, gameEndedAt: null, gameStartedAt: null, countdownEndsAt: null }).where(eq(rooms.code, room.code));
  }
  else if (action === "leave") {
    await db.delete(players).where(eq(players.id, me!.id));
    const remaining = loaded.players.filter(p => p.id !== me!.id);
    if (remaining.length === 0) {
      await db.delete(rooms).where(eq(rooms.code, room.code));
      return NextResponse.json({ ok: true, closed: true });
    }
    if (isHost) {
      const next = remaining[0];
      await db.update(players).set({ isHost: false }).where(eq(players.roomCode, room.code));
      await db.update(players).set({ isHost: true }).where(eq(players.id, next.id));
      await db.update(rooms).set({ hostId: next.id }).where(eq(rooms.code, room.code));
    }
    // if leaving during play leaves 1 active player, finish
    if (room.phase === "playing") {
      const active = remaining.filter(p => !p.eliminated);
      if (active.length === 1) await db.update(rooms).set({ phase: "finished", winnerId: active[0].id, gameEndedAt: new Date() }).where(eq(rooms.code, room.code));
      if (active.length === 0) await db.update(rooms).set({ phase: "waiting" }).where(eq(rooms.code, room.code));
    }
    return NextResponse.json({ ok: true });
  }
  else if (action === "close") {
    if (!isHost) return NextResponse.json({ error: "Only the host can close the room" }, { status: 403 });
    await db.delete(players).where(eq(players.roomCode, room.code));
    await db.delete(rooms).where(eq(rooms.code, room.code));
    return NextResponse.json({ ok: true, closed: true });
  }
  else return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const after = await loadRoom(code);
  if (!after) return NextResponse.json({ ok: true, closed: true });
  return NextResponse.json(publicState(after.room, after.players, playerId));
}
