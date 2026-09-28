import { asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  googleDriveConnections,
  InsertGoogleDriveConnection,
  InsertSharedLink,
  InsertUser,
  SharedLink,
  GoogleDriveConnection,
  users,
  sharedLinks,
} from "../drizzle/schema";
import { getWorkerBindings, type D1DatabaseBinding } from "./cloudflare-runtime";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

interface D1GoogleDriveConnectionRow {
  id: number;
  connectionKey: string;
  accountEmail: string | null;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: number | string;
  createdAt: number | string;
  updatedAt: number | string;
}

interface D1SharedLinkRow {
  id: number;
  title: string;
  url: string;
  category: string;
  notes: string | null;
  createdBy: string;
  createdAt: number | string;
  updatedAt: number | string;
}

function d1Database(): D1DatabaseBinding | undefined {
  return getWorkerBindings()?.DB;
}

function fromD1Date(value: number | string | Date): Date {
  return value instanceof Date ? value : new Date(Number(value));
}

function mapD1Connection(row: D1GoogleDriveConnectionRow): GoogleDriveConnection {
  return {
    ...row,
    expiresAt: fromD1Date(row.expiresAt),
    createdAt: fromD1Date(row.createdAt),
    updatedAt: fromD1Date(row.updatedAt),
  } as GoogleDriveConnection;
}

function mapD1SharedLink(row: D1SharedLinkRow): SharedLink {
  return {
    ...row,
    createdAt: fromD1Date(row.createdAt),
    updatedAt: fromD1Date(row.updatedAt),
  } as SharedLink;
}

// Lazily create the Drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;

  textFields.forEach(field => {
    const value = user[field];
    if (value === undefined) return;
    values[field] = value ?? null;
    updateSet[field] = value ?? null;
  });

  values.lastSignedIn = user.lastSignedIn ?? new Date();
  updateSet.lastSignedIn = values.lastSignedIn;
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getGoogleDriveConnection(connectionKey = "imira") {
  const d1 = d1Database();
  if (d1) {
    const row = await d1
      .prepare("SELECT id, connectionKey, accountEmail, accessToken, refreshToken, scope, expiresAt, createdAt, updatedAt FROM google_drive_connections WHERE connectionKey = ? LIMIT 1")
      .bind(connectionKey)
      .first<D1GoogleDriveConnectionRow>();
    return row ? mapD1Connection(row) : undefined;
  }

  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(googleDriveConnections)
    .where(eq(googleDriveConnections.connectionKey, connectionKey))
    .limit(1);

  return result[0];
}

export async function saveGoogleDriveConnection(connection: InsertGoogleDriveConnection) {
  const d1 = d1Database();
  if (d1) {
    const now = Date.now();
    await d1
      .prepare(`INSERT INTO google_drive_connections
        (connectionKey, accountEmail, accessToken, refreshToken, scope, expiresAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connectionKey) DO UPDATE SET
          accountEmail = excluded.accountEmail,
          accessToken = excluded.accessToken,
          refreshToken = excluded.refreshToken,
          scope = excluded.scope,
          expiresAt = excluded.expiresAt,
          updatedAt = excluded.updatedAt`)
      .bind(
        connection.connectionKey,
        connection.accountEmail ?? null,
        connection.accessToken,
        connection.refreshToken ?? null,
        connection.scope ?? null,
        connection.expiresAt.getTime(),
        connection.createdAt?.getTime() ?? now,
        now,
      )
      .run();
    return;
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  await db.insert(googleDriveConnections).values(connection).onDuplicateKeyUpdate({
    set: {
      accountEmail: connection.accountEmail,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      scope: connection.scope,
      expiresAt: connection.expiresAt,
      updatedAt: new Date(),
    },
  });
}

export async function listSharedLinks() {
  const d1 = d1Database();
  if (d1) {
    const result = await d1
      .prepare("SELECT id, title, url, category, notes, createdBy, createdAt, updatedAt FROM shared_links ORDER BY category ASC, updatedAt DESC")
      .all<D1SharedLinkRow>();
    return result.results.map(mapD1SharedLink);
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  return db.select().from(sharedLinks).orderBy(asc(sharedLinks.category), desc(sharedLinks.updatedAt));
}

export async function getSharedLink(id: number) {
  const d1 = d1Database();
  if (d1) {
    const row = await d1
      .prepare("SELECT id, title, url, category, notes, createdBy, createdAt, updatedAt FROM shared_links WHERE id = ? LIMIT 1")
      .bind(id)
      .first<D1SharedLinkRow>();
    return row ? mapD1SharedLink(row) : undefined;
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  const result = await db.select().from(sharedLinks).where(eq(sharedLinks.id, id)).limit(1);
  return result[0];
}

export async function createSharedLink(link: InsertSharedLink) {
  const d1 = d1Database();
  if (d1) {
    const now = Date.now();
    await d1
      .prepare("INSERT INTO shared_links (title, url, category, notes, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(link.title, link.url, link.category, link.notes ?? null, link.createdBy, now, now)
      .run();
    return;
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  await db.insert(sharedLinks).values(link);
}

export async function createSharedLinks(links: InsertSharedLink[]) {
  if (links.length === 0) return;

  const d1 = d1Database();
  if (d1) {
    const now = Date.now();
    const statements = links.map(link =>
      d1
        .prepare("INSERT INTO shared_links (title, url, category, notes, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(link.title, link.url, link.category, link.notes ?? null, link.createdBy, now, now),
    );
    await d1.batch(statements);
    return;
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  await db.insert(sharedLinks).values(links);
}

export async function updateSharedLink(
  id: number,
  link: Pick<InsertSharedLink, "title" | "url" | "category" | "notes">,
) {
  const d1 = d1Database();
  if (d1) {
    await d1
      .prepare("UPDATE shared_links SET title = ?, url = ?, category = ?, notes = ?, updatedAt = ? WHERE id = ?")
      .bind(link.title, link.url, link.category, link.notes ?? null, Date.now(), id)
      .run();
    return;
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  await db.update(sharedLinks).set({ ...link, updatedAt: new Date() }).where(eq(sharedLinks.id, id));
}

export async function deleteSharedLink(id: number) {
  const d1 = d1Database();
  if (d1) {
    await d1.prepare("DELETE FROM shared_links WHERE id = ?").bind(id).run();
    return;
  }

  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");

  await db.delete(sharedLinks).where(eq(sharedLinks.id, id));
}
