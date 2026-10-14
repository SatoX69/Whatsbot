'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const chalk = require('chalk');
const config = require('../config.json');

const saveLogs = false;

const levels = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50, silent: 99 };
const initialLoggerConfig = config.logger || {};
const initialLogDir = path.resolve(__dirname, '..', initialLoggerConfig.directory || './logger/logs');
if (initialLoggerConfig.enabled) fs.mkdirSync(initialLogDir, { recursive: true });

function liveConfig() { return global.config?.logger || initialLoggerConfig; }
function logDirectory() { return path.resolve(__dirname, '..', liveConfig().directory || './logger/logs'); }
function isEnabled() { return Boolean(liveConfig().enabled); }
function threshold() { const level = String(liveConfig().level || 'info').toLowerCase(); return levels[level] ?? levels.info; }

function timestamp() { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }
function normalizeError(value) {
  if (!value) return '';
  if (value instanceof Error) return value.stack || value.message;
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function formatMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (meta instanceof Error) return `\n${normalizeError(meta)}`;
  try {
    const json = JSON.stringify(meta, (_key, value) => value instanceof Error ? (value.stack || value.message) : value);
    return json && json !== '{}' ? ` ${json}` : '';
  } catch { return ` ${String(meta)}`; }
}
function consoleColor(level) {
  if (level === 'debug') return chalk.gray;
  if (level === 'warn') return chalk.yellow;
  if (level === 'error' || level === 'fatal') return chalk.red;
  return chalk.cyan;
}

function write(level, scope, message, meta) {
  const cfg = liveConfig();
  if (!isEnabled() || levels[level] < threshold()) return;
  const line = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${message}${formatMeta(meta)}`;
  if (cfg.console) console.log(consoleColor(level)(line));
  if (cfg.file) {
    // if (!saveLogs) return;
    try {
      const dir = logDirectory();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
    } catch {}
  }
}

function cleanupLogs() {
  try {
    const cfg = liveConfig();
    if (!cfg.file) return;
    const dir = logDirectory();
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort().reverse();
    for (const old of files.slice(Number(cfg.maxFiles || 7))) { try { fs.unlinkSync(path.join(dir, old)); } catch {} }
  } catch {}
}

cleanupLogs();

const api = {
  get enabled() { return isEnabled(); },
  baileys: pino({ level: 'silent' }),
  info: (scope, message, meta) => write('info', scope, message, meta),
  success: (scope, message, meta) => write('info', scope, message, meta),
  debug: (scope, message, meta) => write('debug', scope, message, meta),
  warn: (scope, message, meta) => write('warn', scope, message, meta),
  error: (scope, message, meta) => write('error', scope, message, meta),
  err: (scope, error, meta) => write('error', scope, error instanceof Error ? (error.message || 'Error') : String(error), error instanceof Error ? error : meta),
  fatal: (scope, message, meta) => write('fatal', scope, message, meta),
  child: bindings => ({
    info: (message, meta) => write('info', bindings.scope || 'CHILD', message, meta),
    debug: (message, meta) => write('debug', bindings.scope || 'CHILD', message, meta),
    warn: (message, meta) => write('warn', bindings.scope || 'CHILD', message, meta),
    error: (message, meta) => write('error', bindings.scope || 'CHILD', message, meta)
  }),
  chalk: {
    title: value => chalk.bold.cyan(value),
    ok: value => chalk.green(value),
    warn: value => chalk.yellow(value),
    error: value => chalk.red(value),
    dim: value => chalk.dim(value),
    accent: value => chalk.magenta(value)
  }
};

module.exports = api;
