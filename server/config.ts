import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

export interface AppConfig {
  /** Port for the local server. */
  port: number;
  /** Host to bind. Defaults to loopback so the memo never leaves this machine. */
  host: string;
  /** SQLite database file. */
  dbPath: string;
  /** Site short name shown at the top-left of the header (Moodle "MS"). */
  siteShortName: string;
  /** Initials shown in the avatar circle at the top-right. */
  userInitials: string;
  /** Default course name for breadcrumbs when a test file does not provide one. */
  courseName: string;
  /** Default section name for breadcrumbs when a test file does not provide one. */
  sectionName: string;
  /**
   * UI scale. The reference screenshots were taken with Moodle rendered at 80 %,
   * so 0.8 reproduces them pixel-for-pixel at 100 % browser zoom. Use 1 for Moodle's native size.
   */
  uiScale: number;
  /** BCP-47 locale for dates. */
  locale: string;
  /** IANA time zone for displayed dates; empty = this computer's zone. */
  timeZone: string;
}

const DEFAULTS: AppConfig = {
  port: 3000,
  host: '127.0.0.1',
  dbPath: path.join(ROOT, 'data', 'app.db'),
  siteShortName: 'MS',
  userInitials: 'BK',
  courseName: 'COMS3010A-OS-SM2-2026',
  sectionName: 'Practice tests',
  uiScale: 0.8,
  locale: 'en-GB',
  timeZone: '',
};

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  let fileCfg: Partial<AppConfig> = {};
  const file = path.join(ROOT, 'config.json');
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn(`config.json ignored: ${(e as Error).message}`);
    }
  }
  const env: Partial<AppConfig> = {};
  if (process.env.PORT) env.port = Number(process.env.PORT);
  if (process.env.HOST) env.host = process.env.HOST;
  if (process.env.DB_PATH) env.dbPath = path.resolve(process.env.DB_PATH);
  const cfg = { ...DEFAULTS, ...fileCfg, ...env, ...overrides };
  if (cfg.dbPath !== ':memory:' && !path.isAbsolute(cfg.dbPath)) cfg.dbPath = path.join(ROOT, cfg.dbPath);
  return cfg;
}
