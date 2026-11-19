import { pgTable, text, real, boolean, timestamp, integer } from "drizzle-orm/pg-core";

export const rooms = pgTable("rooms", {
  code: text("code").primaryKey(),
  hostId: text("host_id").notNull(),
  phase: text("phase").notNull().default("waiting"), // waiting | countdown | playing | finished
  countdownEndsAt: timestamp("countdown_ends_at"),
  gameStartedAt: timestamp("game_started_at"),
  gameEndedAt: timestamp("game_ended_at"),
  winnerId: text("winner_id"),
  lastTickAt: timestamp("last_tick_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const players = pgTable("players", {
  id: text("id").primaryKey(),
  roomCode: text("room_code").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  token: text("token").notNull(),
  isHost: boolean("is_host").notNull().default(false),
  territory: real("territory").notNull().default(0),
  level: real("level").notNull().default(0), // latest normalized 0..1
  smoothed: real("smoothed").notNull().default(0),
  eliminated: boolean("eliminated").notNull().default(false),
  eliminationOrder: integer("elimination_order"), // 1 = first out
  micReady: boolean("mic_ready").notNull().default(false),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});
