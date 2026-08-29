import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  openLocalDatabase,
  type SqliteMigration,
} from "../packages/server/src/sqlite/database";

const directories: string[] = [];
const now = new Date("2026-08-29T12:34:56.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cloudframe-sqlite-"));
  directories.push(directory);
  return directory;
}

describe("local SQLite database", () => {
  it("opens with durable pragmas, applies all migrations, and creates data paths", async () => {
    const dataDir = await temporaryDataDirectory();

    const local = await openLocalDatabase({ dataDir, now: () => now });
    try {
      expect(local.connection.prepare("PRAGMA journal_mode").get())
        .toMatchObject({ journal_mode: "wal" });
      expect(local.connection.prepare("PRAGMA foreign_keys").get())
        .toMatchObject({ foreign_keys: 1 });
      expect(local.connection.prepare("PRAGMA busy_timeout").get())
        .toMatchObject({ timeout: 5_000 });
      expect(local.connection.prepare("PRAGMA synchronous").get())
        .toMatchObject({ synchronous: 2 });
      expect(local.connection.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all()).toEqual([{ version: 1 }, { version: 2 }]);
      expect(existsSync(join(dataDir, "transcodes"))).toBe(true);
      expect(existsSync(join(dataDir, "staging"))).toBe(true);
      expect(existsSync(join(dataDir, "backups"))).toBe(true);
    } finally {
      local.close();
    }
  });

  it("backs up and verifies the existing database before applying a new migration", async () => {
    const dataDir = await temporaryDataDirectory();
    const first = await openLocalDatabase({ dataDir, now: () => now });
    first.close();

    const migrations: SqliteMigration[] = [
      {
        version: 1,
        sql: "",
      },
      {
        version: 2,
        sql: "",
      },
      {
        version: 3,
        sql: "CREATE TABLE migration_three_marker (value TEXT NOT NULL);",
      },
    ];
    const second = await openLocalDatabase({
      dataDir,
      now: () => now,
      migrations,
    });
    try {
      expect(second.connection.prepare(
        "SELECT version FROM schema_migrations ORDER BY version",
      ).all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(second.connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_three_marker'",
      ).get()).toMatchObject({ name: "migration_three_marker" });

      const backupNames = (await readdir(second.backupDir))
        .filter((name) => name.endsWith(".sqlite"));
      expect(backupNames).toHaveLength(1);
      const backup = new DatabaseSync(join(second.backupDir, backupNames[0]!));
      try {
        expect(backup.prepare(
          "SELECT version FROM schema_migrations ORDER BY version",
        ).all()).toEqual([{ version: 1 }, { version: 2 }]);
        expect(backup.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_three_marker'",
        ).get()).toBeUndefined();
      } finally {
        backup.close();
      }
    } finally {
      second.close();
    }
  });

  it("retains only the newest five automatic migration backups", async () => {
    const dataDir = await temporaryDataDirectory();
    const first = await openLocalDatabase({ dataDir, now: () => now });
    first.close();

    const backupDir = join(dataDir, "backups");
    await mkdir(backupDir, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      await writeFile(
        join(backupDir, `auto-20260828T12000${index}.000Z-v0.sqlite`),
        "old backup",
      );
    }

    const migrated = await openLocalDatabase({
      dataDir,
      now: () => now,
      migrations: [
        { version: 1, sql: "" },
        { version: 2, sql: "" },
        { version: 3, sql: "CREATE TABLE retention_marker (value TEXT);" },
      ],
    });
    migrated.close();

    const names = (await readdir(backupDir))
      .filter((name) => name.startsWith("auto-") && name.endsWith(".sqlite"))
      .sort();
    expect(names).toHaveLength(5);
    expect(names.at(-1)).toContain("20260829T123456.000Z-v2");
    expect(names).not.toContain("auto-20260828T120000.000Z-v0.sqlite");
    expect(names).not.toContain("auto-20260828T120001.000Z-v0.sqlite");
  });
});
