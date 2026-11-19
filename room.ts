import { db } from "@/db";
import { rooms, players } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { tickTerritories } from "./game";

export async function loadRoom(code: string) {
  const [room] = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase()));
  if (!room) return null;
  let plist = await db.select().from(players).where(eq(players.roomCode, room.code)).orderBy(players.joinedAt);
  const now = Date.now();

  // countdown -> playing transition
  if (room.phase === "countdown" && room.countdownEndsAt && now >= new Date(room.countdownEndsAt).getTime()) {
    await db.update(rooms).set({ phase: "playing", gameStartedAt: new Date(), lastTickAt: new Date() }).where(eq(rooms.code, room.code));
    room.phase = "playing"; room.gameStartedAt = new Date(); room.lastTickAt = new Date();
  }

  // authoritative tick while playing
  if (room.phase === "playing") {
    const last = room.lastTickAt ? new Date(room.lastTickAt).getTime() : now;
    const dt = (now - last) / 1000;
    if (dt > 0.25) {
      const input = plist.map(p => ({ id: p.id, territory: p.territory, smoothed: p.smoothed, eliminated: p.eliminated }));
      const out = tickTerritories(input, dt);
      for (const np of out.players) {
        const orig = plist.find(p => p.id === np.id)!;
        const justElim = out.newlyEliminated.includes(np.id);
        await db.update(players).set({
          territory: np.territory, eliminated: np.eliminated,
          ...(justElim ? { eliminationOrder: (plist.filter(p=>p.eliminated).length + out.newlyEliminated.indexOf(np.id) + 1) } : {}),
        }).where(eq(players.id, np.id));
        orig.territory = np.territory; orig.eliminated = np.eliminated;
      }
      if (out.winnerId) {
        await db.update(rooms).set({ phase: "finished", winnerId: out.winnerId, gameEndedAt: new Date(), lastTickAt: new Date() }).where(eq(rooms.code, room.code));
        room.phase = "finished"; room.winnerId = out.winnerId; room.gameEndedAt = new Date();
        const w = plist.find(p => p.id === out.winnerId); if (w) w.territory = 100;
      } else {
        await db.update(rooms).set({ lastTickAt: new Date() }).where(eq(rooms.code, room.code));
      }
      plist = await db.select().from(players).where(eq(players.roomCode, room.code)).orderBy(players.joinedAt);
    }
  }

  // host migration: if host unseen > 12s, promote earliest connected other player
  const host = plist.find(p => p.id === room.hostId);
  const hostStale = !host || now - new Date(host.lastSeen).getTime() > 12000;
  if (hostStale && plist.length > 1 && room.phase !== "playing") {
    const candidate = plist.filter(p => p.id !== room.hostId && now - new Date(p.lastSeen).getTime() < 8000).sort((a,b)=>+new Date(a.joinedAt)-+new Date(b.joinedAt))[0];
    if (candidate) {
      await db.update(players).set({ isHost: false }).where(eq(players.roomCode, room.code));
      await db.update(players).set({ isHost: true }).where(eq(players.id, candidate.id));
      await db.update(rooms).set({ hostId: candidate.id }).where(eq(rooms.code, room.code));
      room.hostId = candidate.id;
      plist.forEach(p => p.isHost = p.id === candidate.id);
    }
  }

  return { room, players: plist };
}

export function publicState(room: any, plist: any[], meId?: string) {
  const now = Date.now();
  return {
    code: room.code, phase: room.phase, hostId: room.hostId, winnerId: room.winnerId,
    countdownEndsAt: room.countdownEndsAt ? new Date(room.countdownEndsAt).getTime() : null,
    gameStartedAt: room.gameStartedAt ? new Date(room.gameStartedAt).getTime() : null,
    gameEndedAt: room.gameEndedAt ? new Date(room.gameEndedAt).getTime() : null,
    serverNow: now,
    players: plist.map(p => ({
      id: p.id, name: p.name, color: p.color, isHost: p.isHost,
      territory: Math.round(p.territory * 10) / 10, level: Math.round(p.level * 100) / 100,
      eliminated: p.eliminated, eliminationOrder: p.eliminationOrder, micReady: p.micReady,
      connected: now - new Date(p.lastSeen).getTime() < 8000, isMe: p.id === meId,
    })),
  };
}

export async function authPlayer(code: string, playerId: string, token: string) {
  if (!playerId || !token) return null;
  const [p] = await db.select().from(players).where(and(eq(players.id, playerId), eq(players.roomCode, code.toUpperCase())));
  if (!p || p.token !== token) return null;
  return p;
}
