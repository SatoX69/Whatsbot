'use strict';

const fs = require('node:fs');
const path = require('node:path');

function commandNameFromFile(file) {
  return path.basename(file, '.js').toLowerCase();
}

function normalizeCommand(exported, file, config, mainConfig) {
  const command = exported?.default || exported;
  if (!command || typeof command !== 'object') throw new Error('default export must be an object');
  const meta = command.config && typeof command.config === 'object' ? command.config : {};
  const name = String(meta.name || command.name || commandNameFromFile(file)).trim().toLowerCase();
  const execute = command.onStart || command.execute;
  if (typeof execute !== 'function') throw new Error('onStart/execute function missing');

  if (meta.aliases !== undefined) {
    if (!Array.isArray(meta.aliases) || meta.aliases.length === 0) {
      throw new Error(`Command ${name}: aliases exists but is empty; omit aliases entirely or provide at least one alias`);
    }
  }

  const defaults = mainConfig.commandDefaults || {};
  const globalPrefix = mainConfig.prefix || '!';
  const override = config.overrides?.[name] || {};
  return {
    ...command,
    fileName: path.basename(file),
    config: {
      ...meta,
      name,
      aliases: meta.aliases?.map(String).map(s => s.toLowerCase()) || [],
      role: Number.isInteger(meta.role) ? meta.role : 0,
      countDown: meta.countDown === undefined ? Number(defaults.countDown ?? 5) : Number(meta.countDown),
      description: meta.description || '',
      usage: meta.usage || `${globalPrefix}${name}`,
      category: meta.category || 'General',
      ...override
    },
    execute
  };
}

function createCommandManager({ directory, configPath, logger, getConfig }) {
  let registry = new Map();
  let unloaded = new Set();
  let watcher = null;
  let reloadTimer = null;

  function readCommandConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { logger.error('COMMANDS', `Could not read ${path.basename(configPath)}`, error); return { unloadedCommands: [], overrides: {} }; }
  }

  function writeCommandConfig(next) {
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, configPath);
  }

  async function reloadAll() {
    const commandConfig = readCommandConfig();
    unloaded = new Set((commandConfig.unloadedCommands || []).map(name => name.toLowerCase()));
    const next = new Map();
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.js')).sort((a, b) => a.localeCompare(b));

    let loadedCount = 0;
    for (const fileName of files) {
      if (unloaded.has(fileName.toLowerCase()) || unloaded.has(path.basename(fileName, '.js').toLowerCase())) continue;
      const file = path.join(directory, fileName);
      try {
        delete require.cache[require.resolve(file)];
        const command = normalizeCommand(require(file), file, commandConfig, getConfig());
        if (typeof command?.onLoad === "function") await command.onLoad();
        const keys = [command.config.name, ...command.config.aliases];
        for (const key of keys) {
          if (next.has(key)) throw new Error(`duplicate command/alias: ${key}`);
          next.set(key, command);
        }
        loadedCount++;
        logger.info('COMMANDS', `[${String(loadedCount).padStart(2, '0')}] Loaded ${command.config.name}`, { file: fileName });
      } catch (error) {
        logger.error('COMMANDS', `Failed to load ${fileName}`, error);
      }
    }

    registry = next;
    logger.info('COMMANDS', `Registry ready: ${loadedCount} commands`);
    if (global.client) {
      global.client.commands = registry;
      global.client.commandConfig = commandConfig;
    }
    return registry;
  }

  async function reloadOne(filename) { return reloadAll(filename); }

  function unload(filename) {
    const supplied = String(filename || '').trim();
    const base = path.basename(supplied, '.js').toLowerCase();
    if (!/^[a-z0-9_-]+$/i.test(base) || supplied.includes('/') || supplied.includes('\\')) throw new Error('Invalid command filename.');
    if (!fs.existsSync(path.join(directory, `${base}.js`))) throw new Error(`Command file not found: ${base}.js`);
    const cfg = readCommandConfig();
    const list = new Set((cfg.unloadedCommands || []).map(v => String(v).toLowerCase()));
    list.add(base);
    cfg.unloadedCommands = [...list].sort();
    writeCommandConfig(cfg);
    unloaded = list;
    registry = new Map([...registry].filter(([, command]) => command.fileName !== `${base}.js`));
    if (global.client) global.client.commands = registry;
    return base;
  }

  async function load(filename) {
    const supplied = String(filename || '').trim();
    const base = path.basename(supplied, '.js').toLowerCase();
    if (!/^[a-z0-9_-]+$/i.test(base) || supplied.includes('/') || supplied.includes('\\')) throw new Error('Invalid command filename.');
    const actual = path.join(directory, `${base}.js`);
    if (!fs.existsSync(actual)) throw new Error(`Command file not found: ${base}.js`);
    const cfg = readCommandConfig();
    cfg.unloadedCommands = (cfg.unloadedCommands || []).filter(v => String(v).toLowerCase() !== base);
    writeCommandConfig(cfg);
    await reloadAll();
    const command = [...new Set(registry.values())].find(item => item.fileName === `${base}.js`);
    if (!command) throw new Error(`Command ${base}.js could not be loaded.`);
    return base;
  }

  function startWatch() {
    if (!getConfig().autoReload.enabled || watcher) return;
    watcher = fs.watch(directory, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reloadAll().catch(error => logger.error('COMMANDS', 'Hot reload failed', error)), getConfig().autoReload.debounceMs);
    });
  }

  function stopWatch() { watcher?.close(); watcher = null; if (reloadTimer) clearTimeout(reloadTimer); }

  function list() { return [...new Set(registry.values())].sort((a, b) => a.config.name.localeCompare(b.config.name)); }

  return {
    reloadAll,
    reloadOne,
    unload,
    load,
    startWatch,
    stopWatch,
    list,
    get commands() { return registry; },
    get count() { return list().length; },
    get config() { return readCommandConfig(); },
    persistConfig: writeCommandConfig
  };
}

module.exports = createCommandManager;
