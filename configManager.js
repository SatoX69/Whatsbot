'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function createConfigManager({ root, logger, globalConfig }) {
  const paths = {
    main: path.join(root, 'config.json'),
    commands: path.join(root, 'configCommand.json'),
    events: path.join(root, 'configEvent.json')
  };
  const timers = new Map();
  const watchers = new Map();

  function reloadMain() {
    const next = readJson(paths.main);
    for (const key of Object.keys(globalConfig)) delete globalConfig[key];
    Object.assign(globalConfig, next);
    global.client && (global.client.configVersion = Date.now());
    logger.info('CONFIG', 'config.json hot reloaded');
    return globalConfig;
  }

  function readCommands() {
    try { return readJson(paths.commands); }
    catch (error) { logger.error('CONFIG', 'Could not read configCommand.json', error); return { unloadedCommands: [], overrides: {} }; }
  }

  function readEvents() {
    try { return readJson(paths.events); }
    catch (error) { logger.error('CONFIG', 'Could not read configEvent.json', error); return { enabled: true, eventByMe: true, unloadedEvents: [], overrides: {} }; }
  }

  function watchFile(file, key, callback) {
    if (watchers.has(key)) return;
    const directory = path.dirname(file);
    const wanted = path.basename(file);
    let debounce = null;
    const watcher = fs.watch(directory, { persistent: true }, (_eventType, filename) => {
      if (filename && filename.toString() !== wanted) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try { callback(); }
        catch (error) { logger.error('CONFIG', `${key} hot reload failed`, error); }
      }, Number(globalConfig.autoReload?.debounceMs || 350));
      timers.set(key, debounce);
    });
    watchers.set(key, watcher);
  }

  function start(onMainReload) {
    watchFile(paths.main, 'main', () => {
      reloadMain();
      onMainReload?.(globalConfig);
    });
  }

  function watchCommandConfig(callback) {
    if (globalConfig.autoReload?.enabled !== true) return;
    watchFile(paths.commands, 'commands', callback);
  }

  function watchEventConfig(callback) {
    if (globalConfig.autoReload?.enabled !== true) return;
    watchFile(paths.events, 'events', callback);
  }

  function stop() {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    paths,
    get config() { return globalConfig; },
    readCommands,
    readEvents,
    writeCommands: value => writeJson(paths.commands, value),
    writeEvents: value => writeJson(paths.events, value),
    reloadMain,
    start,
    watchCommandConfig,
    watchEventConfig,
    stop
  };
}

module.exports = createConfigManager;
